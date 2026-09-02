import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OfflinePersonalAccountCoordinator,
  conversationEngineRequestSchema,
  deriveConversationTriggerId,
  deriveReplyDeliveryKey,
  targetBindingSchema,
  inboundSourceStatusSchema,
  normalizedInboundMessageSchema,
  replyIntentSchema,
  type ConversationEngine,
  type ConversationEngineRequest,
  type ConversationEngineResponse,
  type InboundMessageSource,
  type NormalizedInboundMessage,
} from "../../src/conversation/personal-account-contract.js";
import type { ContactId } from "../../src/contacts/contact-schema.js";
import { ContactDirectory } from "../../src/contacts/contact-directory.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { WechatIdentityEnrollmentRepository } from "../../src/storage/wechat-identity-enrollment-repository.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

const sourceEpoch = "epoch-2026-08-31";
const targetSessionId = "session-example-contact";
const fengBindingHash = "a".repeat(64);
const testContactId = "contact-0123456789abcdef0123456789abcdef" as const satisfies ContactId;
const testBindingHash = "b".repeat(64);

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

let contactRoot: string;
let directory: ContactDirectory;
let registry: ContactRegistryRepository;

function featureSample(byte: number): string {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

beforeEach(async () => {
  contactRoot = await mkdtemp(path.join(os.tmpdir(), "task-3-contract-"));
  await initializeTestKernelLockCatalog(contactRoot);
  const store = new EncryptedStore(contactRoot, new FixedKeyProvider(randomBytes(32)));
  registry = new ContactRegistryRepository(store);
  const enrollments = new WechatIdentityEnrollmentRepository(store);
  await enrollments.enrollSupervised({
    version: 1,
    conversationId: "example-contact",
    visibleName: "示例联系人",
    fingerprintVersion: "vision-featureprint-v1",
    referenceSamples: [featureSample(1), featureSample(2), featureSample(3)],
    enrolledAt: "2026-08-31T00:00:00.000Z",
  });
  const samples = [featureSample(4), featureSample(5), featureSample(6)];
  const fingerprint = createHash("sha256").update([
    "2",
    testContactId,
    "我",
    "vision-featureprint-v1",
    "0.18",
    ...samples,
  ].join("\0")).digest("hex");
  await enrollments.enrollSupervised({
    version: 2,
    contactId: testContactId,
    displayName: "我",
    fingerprintVersion: "vision-featureprint-v1",
    referenceSamples: samples,
    enrolledAt: "2026-08-31T00:00:00.000Z",
  });
  await registry.createConfirmed({
    contactId: testContactId,
    displayName: "我",
    identityBinding: {
      fingerprintVersion: "vision-featureprint-v1",
      enrollmentFingerprint: fingerprint,
      leftPaneProofHash: "a".repeat(64),
      headerProofHash: "b".repeat(64),
      confidence: 0.99,
      confirmedAt: "2026-08-31T00:00:00.000Z",
    },
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  directory = new ContactDirectory(registry, enrollments);
});

afterEach(async () => {
  await rm(contactRoot, { recursive: true, force: true });
});

function message(
  sequence: number,
  overrides: Partial<NormalizedInboundMessage> = {},
): NormalizedInboundMessage {
  return {
    contractVersion: 1,
    source: "native-ocr",
    sourceEpoch,
    sessionId: targetSessionId,
    conversationId: "example-contact",
    messageId: sequence.toString(16).padStart(64, "0"),
    sequence,
    occurredAt: `2026-08-31T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    direction: "incoming",
    kind: "text",
    text: `消息 ${sequence}`,
    ...overrides,
  };
}

function readyStatus() {
  return {
    contractVersion: 1 as const,
    source: "native-ocr" as const,
    sourceEpoch,
    state: "waiting" as const,
    lastEventAt: null,
    reason: null,
  };
}

async function harness(response: unknown = { status: "reply", text: "收到，我在。" }) {
  const calls: ConversationEngineRequest[] = [];
  const engine: ConversationEngine = {
    generate(request) {
      calls.push(request);
      return Promise.resolve(response as ConversationEngineResponse);
    },
  };
  const coordinator = await OfflinePersonalAccountCoordinator.create({
    engine,
    directory,
    contactId: "example-contact",
    expectedRevision: 1,
    source: "native-ocr",
    sourceEpoch,
    sessionId: targetSessionId,
  });
  coordinator.updateSourceStatus(readyStatus());
  return { calls, coordinator };
}

async function coordinatorFor(contactId: ContactId, displayName: string) {
  const calls: ConversationEngineRequest[] = [];
  const coordinator = await OfflinePersonalAccountCoordinator.create({
    engine: {
      generate(request) {
        calls.push(request);
        return Promise.resolve({ status: "reply", text: "收到，我在。" });
      },
    },
    directory,
    contactId,
    expectedRevision: 1,
    source: "native-ocr",
    sourceEpoch,
    sessionId: targetSessionId,
  });
  coordinator.updateSourceStatus(readyStatus());
  expect(displayName).toBe(contactId === testContactId ? "我" : "示例联系人");
  return { calls, coordinator };
}

describe("personal-account boundary contracts", () => {
  it("requires a complete authorized contact binding", () => {
    const binding = {
      contactId: testContactId,
      contactRevision: 2,
      displayName: "我",
      source: "native-ocr" as const,
      sourceEpoch,
      sessionId: targetSessionId,
      bindingHash: testBindingHash,
    };

    expect(targetBindingSchema.parse(binding)).toEqual(binding);
    expect(targetBindingSchema.safeParse({ ...binding, displayName: " " }).success).toBe(false);
    expect(targetBindingSchema.safeParse({ ...binding, capability: "free-target" }).success).toBe(false);
  });

  it("keeps the normalized inbound payload strict and explicit", () => {
    const valid = message(1);

    expect(normalizedInboundMessageSchema.parse(valid)).toEqual(valid);
    expect(normalizedInboundMessageSchema.safeParse({ ...valid, debug: true }).success).toBe(false);
    expect(normalizedInboundMessageSchema.safeParse({ ...valid, sessionId: " " }).success).toBe(false);
    expect(normalizedInboundMessageSchema.safeParse({ ...valid, occurredAt: "today" }).success).toBe(false);
    expect(normalizedInboundMessageSchema.safeParse({ ...valid, messageId: "unstable" }).success).toBe(false);
  });

  it("keeps source status and reply intent strict", () => {
    expect(inboundSourceStatusSchema.parse(readyStatus())).toEqual(readyStatus());
    expect(inboundSourceStatusSchema.safeParse({ ...readyStatus(), debug: true }).success).toBe(false);

    const triggerId = deriveConversationTriggerId({
      contactId: "example-contact",
      contactRevision: 1,
      bindingHash: fengBindingHash,
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
      sourceMessageIds: ["1".repeat(64)],
    });
    const intent = {
      contractVersion: 1 as const,
      status: "prepared" as const,
      triggerId,
      conversationId: "example-contact" as const,
      contactId: "example-contact" as const,
      contactRevision: 1,
      bindingHash: fengBindingHash,
      source: "native-ocr" as const,
      sourceEpoch,
      sessionId: targetSessionId,
      replyText: "收到，我在。",
      sourceMessageIds: ["1".repeat(64)],
      deliveryKey: deriveReplyDeliveryKey({
        triggerId,
        contactId: "example-contact",
        contactRevision: 1,
        bindingHash: fengBindingHash,
        replyText: "收到，我在。",
      }),
    };
    expect(replyIntentSchema.parse(intent)).toEqual(intent);
    expect(replyIntentSchema.safeParse({ ...intent, submit: true }).success).toBe(false);
    expect(replyIntentSchema.safeParse({ ...intent, deliveryKey: "short" }).success).toBe(false);
    expect(replyIntentSchema.safeParse({ ...intent, deliveryKey: "f".repeat(64) }).success).toBe(false);
    const request = {
      contractVersion: 1 as const,
      triggerId,
      conversationId: "example-contact" as const,
      contactId: "example-contact" as const,
      contactRevision: 1,
      bindingHash: fengBindingHash,
      source: "native-ocr" as const,
      sourceEpoch,
      sessionId: targetSessionId,
      latestIncomingMessageId: "1".repeat(64),
      messages: [{
        messageId: "1".repeat(64), direction: "incoming" as const, kind: "text" as const,
        text: "你好", occurredAt: "2026-08-31T00:00:00.000Z",
      }],
    };
    expect(conversationEngineRequestSchema.parse(request)).toEqual(request);
    expect(conversationEngineRequestSchema.safeParse({
      ...request,
      contactId: testContactId,
    }).success).toBe(false);

    const outgoingOnly = {
      ...request,
      triggerId: deriveConversationTriggerId({
        contactId: "example-contact",
        contactRevision: 1,
        bindingHash: fengBindingHash,
        source: "native-ocr",
        sourceEpoch,
        sessionId: targetSessionId,
        sourceMessageIds: ["2".repeat(64)],
      }),
      latestIncomingMessageId: "2".repeat(64),
      messages: [{
        messageId: "2".repeat(64), direction: "outgoing" as const, kind: "text" as const,
        text: "我先回复", occurredAt: "2026-08-31T00:00:01.000Z",
      }],
    };
    expect(conversationEngineRequestSchema.safeParse(outgoingOnly).success).toBe(false);

    const incomingThenOutgoing = {
      ...request,
      triggerId: deriveConversationTriggerId({
        contactId: "example-contact",
        contactRevision: 1,
        bindingHash: fengBindingHash,
        source: "native-ocr",
        sourceEpoch,
        sessionId: targetSessionId,
        sourceMessageIds: ["3".repeat(64), "4".repeat(64)],
      }),
      latestIncomingMessageId: "4".repeat(64),
      messages: [
        { messageId: "3".repeat(64), direction: "incoming" as const, kind: "text" as const,
          text: "先来的", occurredAt: "2026-08-31T00:00:02.000Z" },
        { messageId: "4".repeat(64), direction: "outgoing" as const, kind: "text" as const,
          text: "后出的", occurredAt: "2026-08-31T00:00:03.000Z" },
      ],
    };
    expect(conversationEngineRequestSchema.safeParse(incomingThenOutgoing).success).toBe(false);

    const twoIncoming = {
      ...incomingThenOutgoing,
      triggerId: deriveConversationTriggerId({
        contactId: "example-contact",
        contactRevision: 1,
        bindingHash: fengBindingHash,
        source: "native-ocr",
        sourceEpoch,
        sessionId: targetSessionId,
        sourceMessageIds: ["5".repeat(64), "6".repeat(64)],
      }),
      latestIncomingMessageId: "5".repeat(64),
      messages: [
        { messageId: "5".repeat(64), direction: "incoming" as const, kind: "text" as const,
          text: "较早", occurredAt: "2026-08-31T00:00:04.000Z" },
        { messageId: "6".repeat(64), direction: "incoming" as const, kind: "text" as const,
          text: "最新", occurredAt: "2026-08-31T00:00:05.000Z" },
      ],
    };
    expect(conversationEngineRequestSchema.safeParse(twoIncoming).success).toBe(false);
    expect(conversationEngineRequestSchema.safeParse({
      ...twoIncoming,
      latestIncomingMessageId: "6".repeat(64),
    }).success).toBe(true);
  });

  it("defines a source lifecycle without requiring a real transport", async () => {
    const events: string[] = [];
    const source: InboundMessageSource = {
      getStatus: () => readyStatus(),
      async start(handlers) {
        events.push("start");
        await handlers.onStatus(readyStatus());
        await handlers.onMessage(message(1));
      },
      stop() {
        events.push("stop");
        return Promise.resolve();
      },
      close() {
        events.push("close");
        return Promise.resolve();
      },
    };

    await source.start({
      onMessage: (value) => {
        events.push(`message:${value.messageId}`);
      },
      onStatus: (value) => {
        events.push(`status:${value.state}`);
      },
    });
    await source.stop();
    await source.close();

    expect(events).toEqual([
      "start",
      "status:waiting",
      `message:${message(1).messageId}`,
      "stop",
      "close",
    ]);
  });
});

describe("OfflinePersonalAccountCoordinator", () => {
  it("creates a coordinator only after ContactDirectory authorizes the requested revision", async () => {
    const coordinator = await OfflinePersonalAccountCoordinator.create({
      directory,
      contactId: "example-contact",
      expectedRevision: 1,
      engine: { generate: () => Promise.resolve({ status: "refused", reason: "NO_REPLY_NEEDED" }) },
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
    });

    coordinator.updateSourceStatus(readyStatus());
    await expect(coordinator.process([message(1)])).resolves.toEqual({
      status: "ignored",
      reason: "ENGINE_REFUSED",
    });
    await expect(OfflinePersonalAccountCoordinator.create({
      directory,
      contactId: "example-contact",
      expectedRevision: 2,
      engine: { generate: () => Promise.resolve({ status: "refused", reason: "NO_REPLY_NEEDED" }) },
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
    })).rejects.toThrowError("CONTACT_REVISION_MISMATCH");
  });

  it("routes two contacts without sharing pending state", async () => {
    const first = await coordinatorFor("example-contact", "示例联系人");
    const second = await coordinatorFor(testContactId, "我");

    const firstResult = await first.coordinator.process([message(1)]);
    const secondResult = await second.coordinator.process([message(1, {
      conversationId: testContactId,
    })]);

    expect(firstResult.status).toBe("reply-intent");
    expect(secondResult.status).toBe("reply-intent");
    expect(first.calls[0]).toMatchObject({
      conversationId: "example-contact",
      contactRevision: 1,
    });
    expect(second.calls[0]).toMatchObject({
      conversationId: testContactId,
      contactRevision: 1,
    });
  });

  it("rejects a mixed-contact batch before it creates a reply intent", async () => {
    const { calls, coordinator } = await harness();

    const result = await coordinator.process([
      message(1),
      message(2, { conversationId: testContactId }),
    ]);

    expect(result).toEqual({ status: "ignored", reason: "TARGET_NOT_ALLOWED" });
    expect(calls).toHaveLength(0);
  });

  it("serializes concurrent batches before the engine can resolve", async () => {
    let release: (response: ConversationEngineResponse) => void = () => {
      throw new Error("ENGINE_NOT_WAITING");
    };
    const calls: ConversationEngineRequest[] = [];
    const coordinator = await OfflinePersonalAccountCoordinator.create({
      directory,
      contactId: "example-contact",
      expectedRevision: 1,
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
      engine: {
        generate(request) {
          calls.push(request);
          return new Promise((resolve) => { release = resolve; });
        },
      },
    });
    coordinator.updateSourceStatus(readyStatus());

    const first = coordinator.process([message(1)]);
    const second = coordinator.process([message(2)]);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    release({ status: "reply", text: "收到，我在。" });

    await expect(first).resolves.toMatchObject({ status: "reply-intent" });
    await expect(second).resolves.toEqual({ status: "blocked", reason: "PENDING_REPLY_EXISTS" });
    expect(calls).toHaveLength(1);
  });

  it("binds trigger and delivery keys to the contact revision and binding hash", async () => {
    const current = await coordinatorFor("example-contact", "示例联系人");
    await expect(OfflinePersonalAccountCoordinator.create({
      engine: { generate: () => Promise.resolve({ status: "reply", text: "收到，我在。" }) },
      directory,
      contactId: "example-contact",
      expectedRevision: 2,
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
    })).rejects.toThrowError("CONTACT_REVISION_MISMATCH");
    await registry.update("example-contact", 1, {}, new Date("2026-08-31T00:00:01.000Z"));
    const replacement = await OfflinePersonalAccountCoordinator.create({
      engine: { generate: () => Promise.resolve({ status: "reply", text: "收到，我在。" }) },
      directory,
      contactId: "example-contact",
      expectedRevision: 2,
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
    });
    replacement.updateSourceStatus(readyStatus());

    const first = await current.coordinator.process([message(1)]);
    const second = await replacement.process([message(1)]);

    if (first.status !== "reply-intent" || second.status !== "reply-intent") {
      throw new Error("EXPECTED_REPLY_INTENTS");
    }
    expect(first.intent.triggerId).not.toBe(second.intent.triggerId);
    expect(first.intent.deliveryKey).not.toBe(second.intent.deliveryKey);
    expect(second.intent).toMatchObject({
      contactId: "example-contact",
      contactRevision: 2,
    });
  });

  it("turns one new target incoming message into one reply intent", async () => {
    const { calls, coordinator } = await harness();

    const result = await coordinator.process([message(1)]);

    expect(result.status).toBe("reply-intent");
    if (result.status !== "reply-intent") throw new Error("EXPECTED_REPLY_INTENT");
    expect(replyIntentSchema.parse(result.intent)).toEqual(result.intent);
    expect(result.intent).toMatchObject({
      conversationId: "example-contact",
      replyText: "收到，我在。",
      sourceMessageIds: [message(1).messageId],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      contractVersion: 1,
      conversationId: "example-contact",
      latestIncomingMessageId: message(1).messageId,
    });
    expect(calls[0]).toMatchObject({ source: "native-ocr", sourceEpoch, sessionId: targetSessionId });
  });

  it("ignores a duplicate without calling the engine twice", async () => {
    const { calls, coordinator } = await harness();
    const incoming = message(1);

    await coordinator.process([incoming]);
    const replay = await coordinator.process([incoming]);

    expect(replay).toEqual({ status: "ignored", reason: "DUPLICATE_MESSAGE" });
    expect(calls).toHaveLength(1);
  });

  it("rejects an unseen out-of-order message", async () => {
    const { calls, coordinator } = await harness();

    await coordinator.process([message(2)]);
    const stale = await coordinator.process([message(1)]);

    expect(stale).toEqual({ status: "ignored", reason: "OUT_OF_ORDER_MESSAGE" });
    expect(calls).toHaveLength(1);
  });

  it("blocks while the source is disconnected", async () => {
    const { calls, coordinator } = await harness();
    coordinator.updateSourceStatus({
      ...readyStatus(),
      state: "degraded",
      reason: "SOURCE_DISCONNECTED",
    });

    const result = await coordinator.process([message(1)]);

    expect(result).toEqual({ status: "blocked", reason: "SOURCE_NOT_READY" });
    expect(calls).toHaveLength(0);
  });

  it("drops another contact before the engine boundary", async () => {
    const { calls, coordinator } = await harness();

    const result = await coordinator.process([message(1, {
      conversationId: testContactId,
      sessionId: "other-session",
    })]);

    expect(result).toEqual({ status: "ignored", reason: "TARGET_NOT_ALLOWED" });
    expect(calls).toHaveLength(0);
  });

  it("does not generate when the latest message is owner outgoing", async () => {
    const { calls, coordinator } = await harness();

    const result = await coordinator.process([
      message(1),
      message(2, { direction: "outgoing", text: "我已经人工回复" }),
    ]);

    expect(result).toEqual({ status: "ignored", reason: "LATEST_OUTGOING" });
    expect(calls).toHaveLength(0);
  });

  it("cancels a prepared intent when the owner replies before submission", async () => {
    const { calls, coordinator } = await harness();
    const prepared = await coordinator.process([message(1)]);
    if (prepared.status !== "reply-intent") throw new Error("EXPECTED_REPLY_INTENT");

    const result = await coordinator.process([
      message(2, { direction: "outgoing", text: "我来回复了" }),
    ]);

    expect(result).toEqual({
      status: "cancelled",
      reason: "OWNER_REPLIED",
      triggerId: prepared.intent.triggerId,
    });
    expect(calls).toHaveLength(1);
  });

  it("converts an explicit engine refusal into a no-send result", async () => {
    const { calls, coordinator } = await harness({
      status: "refused",
      reason: "POLICY_BLOCKED",
    });

    const result = await coordinator.process([message(1)]);

    expect(result).toEqual({ status: "ignored", reason: "ENGINE_REFUSED" });
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed engine response at runtime", async () => {
    const { coordinator } = await harness({ status: "reply", text: " ", debug: true });

    await expect(coordinator.process([message(1)])).rejects.toThrowError(
      "ENGINE_RESPONSE_INVALID",
    );
  });
});
