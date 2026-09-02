import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContactDirectory } from "../../src/contacts/contact-directory.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import type { ChatMessage } from "../../src/domain/types.js";
import type { MemoryEntry } from "../../src/memory/schema.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import {
  WechatIdentityEnrollmentRepository,
  wechatIdentityEnrollmentFingerprint,
} from "../../src/storage/wechat-identity-enrollment-repository.js";
import { planConversationResponse } from "../../src/conversation/response-planner.js";
import { buildTextResponseRequest } from "../../src/conversation/text-response-request.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}

  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

const contactId = "example-contact" as const;
const now = new Date("2026-08-31T03:00:00.000Z");
let rootDir: string;
let directory: ContactDirectory;

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "empathy-response-planning-"));
  await initializeTestKernelLockCatalog(rootDir);
  const store = new EncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32)));
  const registry = new ContactRegistryRepository(store);
  const enrollments = new WechatIdentityEnrollmentRepository(store);
  const enrollment = {
    version: 2 as const,
    contactId,
    displayName: "示例联系人",
    fingerprintVersion: "vision-featureprint-v1" as const,
    referenceSamples: [featureSample(1), featureSample(2), featureSample(3)],
    enrolledAt: now.toISOString(),
  };
  await enrollments.enrollSupervised(enrollment);
  await registry.createConfirmed({
    contactId,
    displayName: "示例联系人",
    identityBinding: {
      fingerprintVersion: "vision-featureprint-v1",
      enrollmentFingerprint: wechatIdentityEnrollmentFingerprint(enrollment),
      leftPaneProofHash: "a".repeat(64),
      headerProofHash: "b".repeat(64),
      confidence: 0.99,
      confirmedAt: now.toISOString(),
    },
    now,
  });
  directory = new ContactDirectory(registry, enrollments);
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function featureSample(byte: number): string {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

function incoming(id: string, text: string): ChatMessage {
  return {
    id,
    conversationId: contactId,
    direction: "incoming",
    kind: "text",
    text,
    occurredAt: "2026-08-20T09:00:00.000Z",
    source: "wechat",
    confidence: 0.99,
  };
}

function voiceExample(id: string, sourceMessageId: string, summary: string): MemoryEntry {
  return {
    id,
    kind: "style-example",
    subject: "user",
    summary,
    sourceType: "wechat-message",
    sourceMessageIds: [sourceMessageId],
    observedAt: "2026-08-20T09:00:00.000Z",
    confidence: "high",
    sensitivity: "normal",
    status: "active",
    supersedes: [],
  };
}

describe("empathy response planning", () => {
  it("turns an open negative message into a gentle user-voice generation request", async () => {
    const current = incoming("m2", "今天碰到个特别离谱的人");
    const voiceExamples = [
      voiceExample("voice-1", "outgoing-7", "短句，习惯用咋啦自然接话"),
    ];
    const plan = planConversationResponse({
      current,
      recentMessages: [],
      voiceExamples,
      interactionRules: [],
    });
    const request = await buildTextResponseRequest({
      directory,
      contactId,
      expectedRevision: 1,
      effectiveStyle: {
        salutation: null,
        tone: "natural",
        preferredLength: "medium",
        emojiPolicy: "none",
        bannedTopics: [],
        appendSignature: false,
      },
      current,
      plan,
      voiceExamples,
      interactionRules: [],
      hardRules: ["禁止使用哈哈", "最多一个问题"],
    });

    expect(request.plan.orderedActs.map(({ kind }) => kind)).toEqual([
      "colloquial-connect",
      "open-invite",
    ]);
    expect(request.constraints).toContainEqual(
      expect.objectContaining({ id: "gentle", priority: "equal" }),
    );
    expect(request.voiceEvidence[0]?.sourceMessageIds).toEqual(["outgoing-7"]);
  });
});
