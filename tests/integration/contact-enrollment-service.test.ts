import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OCRLine, WindowDescriptor } from "../../src/adapters/native-bridge.js";
import {
  ContactEnrollmentService,
  NativeContactEnrollmentEvidenceReader,
  type ContactEnrollmentEvidence,
  type ContactEnrollmentEvidenceReader,
} from "../../src/contacts/contact-enrollment-service.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { ContactCandidateRepository } from "../../src/storage/contact-candidate-repository.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { WechatIdentityEnrollmentRepository } from "../../src/storage/wechat-identity-enrollment-repository.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

function sample(byte: number, length = 64): string {
  const value = Buffer.alloc(length, byte);
  value.write("bplist00", 0, "ascii");
  return value.toString("base64");
}

function line(text: string, x: number, y: number, confidence = 0.99): OCRLine {
  return { text, confidence, bounds: { x, y, width: 0.08, height: 0.02 } };
}

const window: WindowDescriptor = {
  windowID: 42,
  processID: 100,
  bundleID: "com.tencent.xinWeChat",
  title: "微信",
  ownerName: "微信",
  bounds: { x: 0, y: 0, width: 700, height: 600 },
};
const revision = createHash("sha256").update([
  window.windowID, window.processID, window.bundleID, window.title, window.ownerName,
].join("\0")).digest("hex");
const previewText = "候选预览";
const previewHash = createHash("sha256").update([
  "wechat-conversation-preview-v1", previewText,
].join("\0")).digest("hex");
const now = new Date("2026-08-31T04:00:00.000Z");

class EvidenceDriver {
  public lines: OCRLine[] = [
    line("我", 0.10, 0.78),
    line(previewText, 0.10, 0.73),
    line("我", 0.50, 0.90),
  ];
  public currentWindow = window;
  public distance = 0.05;
  public captureCount = 0;
  public ocrCount = 0;
  public matchCount = 0;
  public proofSeed = "a";
  public referenceSamples: string[] = [];

  public listWindows(): Promise<WindowDescriptor[]> { return Promise.resolve([this.currentWindow]); }
  public capture(): Promise<string> { this.captureCount += 1; return Promise.resolve("/tmp/evidence.png"); }
  public ocr(): Promise<OCRLine[]> { this.ocrCount += 1; return Promise.resolve(this.lines); }
  public matchWechatIdentityRows() {
    this.matchCount += 1;
    return Promise.resolve([{
      normalizedY: 0.79,
      distance: this.distance,
      observedFingerprint: "f".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
      selected: true,
      selectedRowTitle: "我",
      selectedRowNormalizedY: 0.79,
      selectionProofHash: "e".repeat(64),
    }]);
  }
  public captureWechatIdentitySamples(request: { conversationTitle: string }) {
    this.captureCount += 2;
    this.ocrCount += 2;
    const left = this.lines.filter((candidate) => candidate.text.normalize("NFC").trim() === request.conversationTitle &&
      candidate.confidence >= 0.9 && candidate.bounds.x < 0.31);
    const headers = this.lines.filter((candidate) => candidate.text.normalize("NFC").trim() === request.conversationTitle &&
      candidate.confidence >= 0.9 && candidate.bounds.x >= 0.32 && candidate.bounds.y >= 0.86);
    if (left.length !== 1 || headers.length !== 1) {
      return Promise.reject(new Error("CONTACT_ENROLLMENT_IDENTITY_AMBIGUOUS"));
    }
    return Promise.resolve({
      fingerprintVersion: "vision-featureprint-v1" as const,
      windowRevision: revision,
      leftPaneProofHash: this.proofSeed.repeat(64),
      headerProofHash: this.proofSeed === "a" ? "b".repeat(64) : "c".repeat(64),
      referenceSamples: [...this.referenceSamples],
      observedFingerprints: this.referenceSamples.map((_, index) => String(index + 1).repeat(64)),
      maximumPairwiseDistance: this.distance,
    });
  }
}

describe("ContactEnrollmentService", () => {
  let root: string;
  let store: EncryptedStore;
  let candidates: ContactCandidateRepository;
  let enrollments: WechatIdentityEnrollmentRepository;
  let registry: ContactRegistryRepository;
  let candidate: Awaited<ReturnType<ContactCandidateRepository["observe"]>>;
  let samples: string[];
  let driver: EvidenceDriver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "contact-enrollment-service-"));
    await initializeTestKernelLockCatalog(root);
    store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
    candidates = new ContactCandidateRepository(store, () => now);
    enrollments = new WechatIdentityEnrollmentRepository(store);
    registry = new ContactRegistryRepository(store);
    candidate = await candidates.observe({ displayName: "我", previewHash, windowRevision: revision, now });
    samples = [sample(1), sample(2), sample(3)];
    driver = new EvidenceDriver();
    driver.referenceSamples = samples;
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  function nativeReader(): NativeContactEnrollmentEvidenceReader {
    return new NativeContactEnrollmentEvidenceReader({ driver });
  }

  function service(
    reader: ContactEnrollmentEvidenceReader = nativeReader(),
    registryOverride: ConstructorParameters<typeof ContactEnrollmentService>[0]["registry"] = registry,
  ) {
    return new ContactEnrollmentService({ candidates, enrollments, registry: registryOverride, evidenceReader: reader });
  }

  it("requires explicit confirmation, unique exact evidence, and the same revision", async () => {
    const unsafe = {
      candidateId: candidate.candidateId, expectedWindowRevision: revision,
      confirmedByUser: false, now,
    } as unknown as Parameters<ContactEnrollmentService["confirmCandidate"]>[0];
    await expect(service().confirmCandidate(unsafe)).rejects.toThrow("CONTACT_ENROLLMENT_CONFIRMATION_REQUIRED");

    driver.lines.push(line("我", 0.12, 0.60), line(previewText, 0.12, 0.55));
    await expect(service().confirmCandidate({
      candidateId: candidate.candidateId, expectedWindowRevision: revision, confirmedByUser: true, now,
    })).rejects.toThrow("CONTACT_ENROLLMENT_IDENTITY_AMBIGUOUS");
    driver.lines.splice(3);
    driver.currentWindow = { ...window, ownerName: "漂移" };
    await expect(service().confirmCandidate({
      candidateId: candidate.candidateId, expectedWindowRevision: revision, confirmedByUser: true, now,
    })).rejects.toThrow("CONTACT_ENROLLMENT_WINDOW_REVISION_MISMATCH");
    expect(await registry.list()).toEqual([]);
  });

  it("natively verifies every untrusted sample and rejects malformed or unstable sets", async () => {
    const created = await service().confirmCandidate({
      candidateId: candidate.candidateId, expectedWindowRevision: revision, confirmedByUser: true, now,
    });
    expect(created).toMatchObject({ autoReplyEnabled: true, scheduledCareEnabled: false });
    expect(driver.captureCount).toBe(2);
    expect(driver.ocrCount).toBe(2);
    expect(driver.matchCount).toBe(0);

    // A fresh candidate proves count and distance failures before registry mutation.
    candidate = await candidates.observe({
      displayName: "另一个", previewHash, windowRevision: revision,
      now: new Date(now.getTime() + 1),
    });
    driver.lines = [line("另一个", 0.10, 0.78), line(previewText, 0.10, 0.73), line("另一个", 0.5, 0.9)];
    samples = [sample(1), sample(2)];
    driver.referenceSamples = samples;
    await expect(service().confirmCandidate({
      candidateId: candidate.candidateId, expectedWindowRevision: revision, confirmedByUser: true, now,
    })).rejects.toThrow("CONTACT_ENROLLMENT_SAMPLES_INVALID");
    samples = [sample(1), sample(2), sample(3)];
    driver.referenceSamples = samples;
    driver.distance = 0.19;
    await expect(service().confirmCandidate({
      candidateId: candidate.candidateId, expectedWindowRevision: revision, confirmedByUser: true, now,
    })).rejects.toThrow("CONTACT_ENROLLMENT_SAMPLES_UNSTABLE");
  });

  it("rejects arbitrary evidence objects without native attestation", async () => {
    const arbitrary: ContactEnrollmentEvidence = {
      displayName: "我", previewHash, windowRevision: revision,
      leftPaneExactMatches: 1, headerExactMatches: 1,
      leftPaneProofHash: "c".repeat(64), headerProofHash: "d".repeat(64), confidence: 0.99,
      fingerprintVersion: "vision-featureprint-v1", referenceSamples: samples,
      maximumPairwiseDistance: 0.01,
    };
    const reader: ContactEnrollmentEvidenceReader = {
      readEnrollmentEvidence: () => Promise.resolve(arbitrary),
    };
    await expect(service(reader).confirmCandidate({
      candidateId: candidate.candidateId, expectedWindowRevision: revision, confirmedByUser: true, now,
    })).rejects.toThrow("CONTACT_ENROLLMENT_EVIDENCE_UNVERIFIED");
    expect(await registry.list()).toEqual([]);
  });

  it("recovers enrollment-first crash with fresh stable samples having different bytes", async () => {
    const crashingRegistry = {
      get: registry.get.bind(registry),
      createConfirmed: () => Promise.reject(new Error("SIMULATED_REGISTRY_CRASH")),
    };
    await expect(service(nativeReader(), crashingRegistry).confirmCandidate({
      candidateId: candidate.candidateId, expectedWindowRevision: revision, confirmedByUser: true, now,
    })).rejects.toThrow("SIMULATED_REGISTRY_CRASH");
    await expect(enrollments.requireContact(candidate.proposedContactId)).resolves.toMatchObject({ displayName: "我" });

    samples = [sample(4), sample(5), sample(6)];
    driver.referenceSamples = samples;
    await expect(service().confirmCandidate({
      candidateId: candidate.candidateId,
      expectedWindowRevision: revision,
      confirmedByUser: true,
      now: new Date(now.getTime() + 1_000),
    })).resolves.toMatchObject({
      contactId: candidate.proposedContactId,
      lifecycle: "active",
      autoReplyEnabled: true,
      scheduledCareEnabled: false,
    });
    await expect(candidates.getFresh(candidate.candidateId, now)).rejects.toThrow("CONTACT_CANDIDATE_NOT_FOUND");
  });

  it("finishes a registry-first retry when fresh OCR proof confidence or bounds drift", async () => {
    const consume = vi.spyOn(candidates, "consume")
      .mockRejectedValueOnce(new Error("SIMULATED_CONSUME_CRASH"));
    await expect(service().confirmCandidate({
      candidateId: candidate.candidateId,
      expectedWindowRevision: revision,
      confirmedByUser: true,
      now,
    })).rejects.toThrow("SIMULATED_CONSUME_CRASH");
    expect(await registry.get(candidate.proposedContactId)).not.toBeNull();

    consume.mockRestore();
    driver.proofSeed = "d";
    driver.lines = [
      line("我", 0.105, 0.775, 0.97),
      line(previewText, 0.105, 0.725, 0.96),
      line("我", 0.505, 0.895, 0.98),
    ];
    await expect(service().confirmCandidate({
      candidateId: candidate.candidateId,
      expectedWindowRevision: revision,
      confirmedByUser: true,
      now: new Date(now.getTime() + 1_000),
    })).resolves.toMatchObject({ contactId: candidate.proposedContactId, lifecycle: "active" });
  });
});
