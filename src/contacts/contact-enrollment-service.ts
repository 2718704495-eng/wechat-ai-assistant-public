import { createHash } from "node:crypto";

import { z } from "zod";

import type { WindowDescriptor } from "../adapters/native-bridge.js";
import type { NativeWechatDriver } from "../adapters/native-wechat-surface.js";
import type { ContactRecord, CreateConfirmedContact } from "./contact-schema.js";
import type { ContactRegistryRepository } from "./contact-registry-repository.js";
import type {
  ContactCandidate,
  ContactCandidateRepository,
} from "../storage/contact-candidate-repository.js";
import {
  type WechatContactIdentityEnrollment,
  WechatIdentityEnrollmentRepository,
  wechatIdentityEnrollmentFingerprint,
} from "../storage/wechat-identity-enrollment-repository.js";

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export interface ContactEnrollmentEvidence {
  readonly displayName: string;
  readonly previewHash: string;
  readonly windowRevision: string;
  readonly leftPaneExactMatches: number;
  readonly headerExactMatches: number;
  readonly leftPaneProofHash: string;
  readonly headerProofHash: string;
  readonly confidence: number;
  readonly fingerprintVersion: "vision-featureprint-v1";
  readonly referenceSamples: readonly string[];
  readonly maximumPairwiseDistance: number;
}

export interface ContactEnrollmentEvidenceReader {
  readEnrollmentEvidence(input: {
    readonly candidate: ContactCandidate;
    readonly expectedWindowRevision: string;
    readonly existingEnrollment: WechatContactIdentityEnrollment | null;
  }): Promise<ContactEnrollmentEvidence>;
}

const verifiedEvidence = new WeakMap<object, {
  readonly candidateId: string;
  readonly windowRevision: string;
  readonly expiresAt: number;
}>();
const wechatBundleId = "com.tencent.xinWeChat";
const wechatWindowTitle = "微信";

/**
 * Delegates capture, OCR binding, archive generation and pairwise distance checks
 * to the framed, read-only native command.
 */
export class NativeContactEnrollmentEvidenceReader implements ContactEnrollmentEvidenceReader {
  public constructor(private readonly dependencies: {
    readonly driver: Pick<NativeWechatDriver,
      "listWindows" | "captureWechatIdentitySamples" | "matchWechatIdentityRows">;
  }) {}

  public async readEnrollmentEvidence(input: {
    readonly candidate: ContactCandidate;
    readonly expectedWindowRevision: string;
    readonly existingEnrollment: WechatContactIdentityEnrollment | null;
  }): Promise<ContactEnrollmentEvidence> {
    const window = await this.uniqueWindow();
    if (windowRevision(window) !== input.expectedWindowRevision ||
        input.candidate.windowRevision !== input.expectedWindowRevision) {
      throw new Error("CONTACT_ENROLLMENT_WINDOW_REVISION_MISMATCH");
    }
    const receipt = await this.dependencies.driver.captureWechatIdentitySamples({
      windowID: window.windowID,
      bundleID: wechatBundleId,
      title: wechatWindowTitle,
      conversationTitle: input.candidate.displayName,
      expectedPreviewHash: input.candidate.previewHash,
      expectedWindowRevision: input.expectedWindowRevision,
      sampleCount: 3,
    });
    if (input.existingEnrollment !== null) {
      await this.verifySamples(window, input.candidate, input.existingEnrollment.referenceSamples);
    }
    if (receipt.windowRevision !== input.expectedWindowRevision) {
      throw new Error("CONTACT_ENROLLMENT_WINDOW_REVISION_MISMATCH");
    }
    const evidence: ContactEnrollmentEvidence = Object.freeze({
      displayName: input.candidate.displayName,
      previewHash: input.candidate.previewHash,
      windowRevision: input.expectedWindowRevision,
      leftPaneExactMatches: 1,
      headerExactMatches: 1,
      leftPaneProofHash: receipt.leftPaneProofHash,
      headerProofHash: receipt.headerProofHash,
      confidence: 1,
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: Object.freeze([...receipt.referenceSamples]),
      maximumPairwiseDistance: receipt.maximumPairwiseDistance,
    });
    verifiedEvidence.set(evidence, {
      candidateId: input.candidate.candidateId,
      windowRevision: input.expectedWindowRevision,
      expiresAt: Date.now() + 5_000,
    });
    return evidence;
  }

  private async verifySamples(
    window: WindowDescriptor,
    candidate: ContactCandidate,
    samples: readonly string[],
  ): Promise<number> {
    const matches = await this.dependencies.driver.matchWechatIdentityRows({
      windowID: window.windowID,
      bundleID: wechatBundleId,
      title: wechatWindowTitle,
      conversationTitle: candidate.displayName,
      enrollment: {
        version: 2,
        contactId: candidate.proposedContactId,
        displayName: candidate.displayName,
        fingerprintVersion: "vision-featureprint-v1",
        referenceSamples: [...samples],
        enrolledAt: candidate.observedAt,
      },
    });
    const accepted = matches.filter((match) =>
      match.fingerprintVersion === "vision-featureprint-v1" &&
      Number.isFinite(match.distance) &&
      match.distance <= WechatIdentityEnrollmentRepository.maximumDistance
    );
    if (matches.length !== 1 || accepted.length !== 1) {
      throw new Error("CONTACT_ENROLLMENT_SAMPLES_UNSTABLE");
    }
    const match = accepted[0];
    if (match === undefined) throw new Error("CONTACT_ENROLLMENT_SAMPLES_UNSTABLE");
    return match.distance;
  }

  private async uniqueWindow(): Promise<WindowDescriptor> {
    const windows = (await this.dependencies.driver.listWindows(wechatBundleId)).filter((window) =>
      window.bundleID === wechatBundleId && window.title === wechatWindowTitle
    );
    if (windows.length !== 1 || windows[0] === undefined) {
      throw new Error("CONTACT_ENROLLMENT_WINDOW_AMBIGUOUS");
    }
    return windows[0];
  }
}

interface EnrollmentRegistry {
  createConfirmed(input: CreateConfirmedContact): Promise<ContactRecord>;
  get(contactId: ContactCandidate["proposedContactId"]): Promise<ContactRecord | null>;
}

export class ContactEnrollmentService {
  public constructor(private readonly dependencies: {
    readonly candidates: ContactCandidateRepository;
    readonly enrollments: WechatIdentityEnrollmentRepository;
    readonly registry: EnrollmentRegistry | ContactRegistryRepository;
    readonly evidenceReader: ContactEnrollmentEvidenceReader;
  }) {}

  public async confirmCandidate(input: {
    readonly candidateId: string;
    readonly expectedWindowRevision: string;
    readonly confirmedByUser: true;
    readonly now: Date;
  }): Promise<ContactRecord> {
    if (input.confirmedByUser !== true) throw new Error("CONTACT_ENROLLMENT_CONFIRMATION_REQUIRED");
    const expectedWindowRevision = hex64Schema.parse(input.expectedWindowRevision);
    const timestamp = validTimestamp(input.now);
    const candidate = await this.dependencies.candidates.getFresh(input.candidateId, input.now);
    if (candidate.windowRevision !== expectedWindowRevision) {
      throw new Error("CONTACT_CANDIDATE_WINDOW_REVISION_MISMATCH");
    }
    const existingEnrollment = await this.findExistingEnrollment(candidate);
    const evidence = await this.dependencies.evidenceReader.readEnrollmentEvidence({
      candidate,
      expectedWindowRevision,
      existingEnrollment,
    });
    consumeEvidenceAttestation(evidence, candidate, expectedWindowRevision);
    const samples = validateEvidence(candidate, evidence, expectedWindowRevision);
    const requestedEnrollment: WechatContactIdentityEnrollment = {
      version: 2,
      contactId: candidate.proposedContactId,
      displayName: candidate.displayName,
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: samples,
      enrolledAt: timestamp,
    };
    const enrollment = existingEnrollment ?? await this.requireOrCreateEnrollment(
      requestedEnrollment,
      candidate,
      expectedWindowRevision,
    );
    const enrollmentFingerprint = wechatIdentityEnrollmentFingerprint(enrollment);
    const createInput: CreateConfirmedContact = {
      contactId: candidate.proposedContactId,
      displayName: candidate.displayName,
      identityBinding: {
        fingerprintVersion: "vision-featureprint-v1",
        enrollmentFingerprint,
        leftPaneProofHash: hex64Schema.parse(evidence.leftPaneProofHash),
        headerProofHash: hex64Schema.parse(evidence.headerProofHash),
        confidence: evidence.confidence,
        confirmedAt: enrollment.enrolledAt,
      },
      now: new Date(enrollment.enrolledAt),
    };
    const contact = await this.createOrRequireMatching(createInput);
    await this.dependencies.candidates.consume(
      candidate.candidateId,
      expectedWindowRevision,
      input.now,
    );
    return structuredClone(contact);
  }

  private async requireOrCreateEnrollment(
    requested: WechatContactIdentityEnrollment,
    candidate: ContactCandidate,
    expectedWindowRevision: string,
  ): Promise<WechatContactIdentityEnrollment> {
    try {
      const existing = await this.dependencies.enrollments.requireContact(requested.contactId);
      assertSameEnrollmentEvidence(existing, requested);
      const evidence = await this.dependencies.evidenceReader.readEnrollmentEvidence({
        candidate,
        expectedWindowRevision,
        existingEnrollment: existing,
      });
      consumeEvidenceAttestation(evidence, candidate, expectedWindowRevision);
      return existing;
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== "WECHAT_IDENTITY_ENROLLMENT_REQUIRED") {
        throw error;
      }
    }
    await this.dependencies.enrollments.enrollSupervised(requested);
    return this.dependencies.enrollments.requireContact(requested.contactId);
  }

  private async findExistingEnrollment(
    candidate: ContactCandidate,
  ): Promise<WechatContactIdentityEnrollment | null> {
    try {
      const existing = await this.dependencies.enrollments.requireContact(candidate.proposedContactId);
      if (existing.displayName.normalize("NFC") !== candidate.displayName.normalize("NFC") ||
          existing.fingerprintVersion !== "vision-featureprint-v1") {
        throw new Error("CONTACT_ENROLLMENT_EXISTING_EVIDENCE_CONFLICT");
      }
      return existing;
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "WECHAT_IDENTITY_ENROLLMENT_REQUIRED") return null;
      throw error;
    }
  }

  private async createOrRequireMatching(input: CreateConfirmedContact): Promise<ContactRecord> {
    try {
      return await this.dependencies.registry.createConfirmed(input);
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== "CONTACT_ALREADY_EXISTS") throw error;
      const existing = await this.dependencies.registry.get(input.contactId);
      if (existing === null || existing.displayName.normalize("NFC") !== input.displayName.normalize("NFC") ||
          existing.identityBinding.fingerprintVersion !== input.identityBinding.fingerprintVersion ||
          existing.identityBinding.enrollmentFingerprint !== input.identityBinding.enrollmentFingerprint) {
        throw new Error("CONTACT_ENROLLMENT_REGISTRY_CONFLICT");
      }
      return existing;
    }
  }
}

function validateEvidence(
  candidate: ContactCandidate,
  evidence: ContactEnrollmentEvidence,
  expectedWindowRevision: string,
): string[] {
  if (evidence.displayName.normalize("NFC").trim() !== candidate.displayName.normalize("NFC")) {
    throw new Error("CONTACT_ENROLLMENT_DISPLAY_NAME_MISMATCH");
  }
  if (evidence.previewHash !== candidate.previewHash) {
    throw new Error("CONTACT_ENROLLMENT_PREVIEW_MISMATCH");
  }
  if (evidence.windowRevision !== expectedWindowRevision) {
    throw new Error("CONTACT_ENROLLMENT_WINDOW_REVISION_MISMATCH");
  }
  if (evidence.leftPaneExactMatches !== 1 || evidence.headerExactMatches !== 1) {
    throw new Error("CONTACT_ENROLLMENT_IDENTITY_AMBIGUOUS");
  }
  if (evidence.fingerprintVersion !== "vision-featureprint-v1" ||
      !Number.isFinite(evidence.confidence) || evidence.confidence < 0.95 || evidence.confidence > 1) {
    throw new Error("CONTACT_ENROLLMENT_EVIDENCE_INVALID");
  }
  hex64Schema.parse(evidence.leftPaneProofHash);
  hex64Schema.parse(evidence.headerProofHash);
  if (evidence.referenceSamples.length < 3 || evidence.referenceSamples.length > 5) {
    throw new Error("CONTACT_ENROLLMENT_SAMPLES_INVALID");
  }
  const decoded = evidence.referenceSamples.map((sample) => {
    const bytes = Buffer.from(sample, "base64");
    if (bytes.length < 32 || bytes.length > 24_576 ||
        bytes.subarray(0, 8).toString("ascii") !== "bplist00" ||
        bytes.toString("base64") !== sample) {
      throw new Error("CONTACT_ENROLLMENT_SAMPLES_INVALID");
    }
    return bytes;
  });
  if (new Set(decoded.map(({ length }) => length)).size !== 1) {
    throw new Error("CONTACT_ENROLLMENT_SAMPLES_INVALID");
  }
  if (!Number.isFinite(evidence.maximumPairwiseDistance) ||
      evidence.maximumPairwiseDistance < 0 ||
      evidence.maximumPairwiseDistance > WechatIdentityEnrollmentRepository.maximumDistance) {
    throw new Error("CONTACT_ENROLLMENT_SAMPLES_UNSTABLE");
  }
  return [...evidence.referenceSamples];
}

function assertSameEnrollmentEvidence(
  existing: WechatContactIdentityEnrollment,
  requested: WechatContactIdentityEnrollment,
): void {
  if (existing.contactId !== requested.contactId ||
      existing.displayName.normalize("NFC") !== requested.displayName.normalize("NFC") ||
      existing.fingerprintVersion !== requested.fingerprintVersion) {
    throw new Error("CONTACT_ENROLLMENT_EXISTING_EVIDENCE_CONFLICT");
  }
}

function consumeEvidenceAttestation(
  evidence: ContactEnrollmentEvidence,
  candidate: ContactCandidate,
  expectedWindowRevision: string,
): void {
  const attestation = verifiedEvidence.get(evidence);
  verifiedEvidence.delete(evidence);
  if (attestation === undefined || attestation.candidateId !== candidate.candidateId ||
      attestation.windowRevision !== expectedWindowRevision || attestation.expiresAt < Date.now()) {
    throw new Error("CONTACT_ENROLLMENT_EVIDENCE_UNVERIFIED");
  }
}

function windowRevision(window: WindowDescriptor): string {
  return sha256([String(window.windowID), String(window.processID), window.bundleID,
    window.title, window.ownerName]);
}

function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function validTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("CONTACT_ENROLLMENT_TIMESTAMP_INVALID");
  return now.toISOString();
}
