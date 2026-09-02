import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AstrBotOneBotEngine,
  OneBotReverseWebSocketTransport,
  oneBotActionRequestSchema,
  oneBotApiResponseSchema,
  oneBotDeliveryReceiptSchema,
  oneBotPrivateMessageEventSchema,
  stableOneBotId,
  type OneBotReverseTransport,
  type OneBotReverseTransportHandlers,
  type OneBotWebSocketClient,
} from "../../src/conversation/akasha-onebot-engine.js";
import {
  OfflinePersonalAccountCoordinator,
  deriveConversationTriggerId,
  type NormalizedInboundMessage,
} from "../../src/conversation/personal-account-contract.js";
import type { ContactId } from "../../src/contacts/contact-schema.js";
import { ContactDirectory } from "../../src/contacts/contact-directory.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { WechatIdentityEnrollmentRepository } from "../../src/storage/wechat-identity-enrollment-repository.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

const sourceEpoch = "epoch-onebot-m2";
const targetSessionId = "session-example-contact";
const fengBindingHash = "c".repeat(64);
const testContactId = "contact-0123456789abcdef0123456789abcdef" as const satisfies ContactId;
const testBindingHash = "d".repeat(64);

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

let contactRoot: string;
let directory: ContactDirectory;
const createdEngines: AstrBotOneBotEngine[] = [];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (resolve === null || reject === null) throw new Error("TEST_DEFERRED_INVALID");
  return { promise, resolve, reject };
}

function featureSample(byte: number): string {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

beforeEach(async () => {
  contactRoot = await mkdtemp(path.join(os.tmpdir(), "task-3-onebot-"));
  await initializeTestKernelLockCatalog(contactRoot);
  const store = new EncryptedStore(contactRoot, new FixedKeyProvider(randomBytes(32)));
  const registry = new ContactRegistryRepository(store);
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
    "2", testContactId, "我", "vision-featureprint-v1", "0.18", ...samples,
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
  await Promise.all(createdEngines.splice(0).map((engine) => engine.close().catch(() => undefined)));
  await rm(contactRoot, { recursive: true, force: true });
});

class FakeOneBotReverseTransport implements OneBotReverseTransport {
  public readonly sent: unknown[] = [];
  public connectCount = 0;
  public disconnectCount = 0;
  public closeCount = 0;
  public engineStoppedSendCount = 0;
  public disconnectFailure: Error | null = null;
  public disconnectSyncFailure: Error | null = null;
  public closeFailure: Error | null = null;
  public failEngineStoppedResponse = false;
  public throwEngineStoppedResponse = false;
  public deferDisconnectCloseCallback = false;
  public openBeforeDeferredConnectSettlement = false;
  private handlers: OneBotReverseTransportHandlers | null = null;
  private readonly connectionHandlers: OneBotReverseTransportHandlers[] = [];
  private nextConnect: Deferred<void> | null = null;
  private nextDisconnect: Deferred<void> | null = null;
  private nextSend: Deferred<void> | null = null;

  public deferNextConnect(): Deferred<void> {
    const deferred = createDeferred<void>();
    this.nextConnect = deferred;
    return deferred;
  }

  public deferNextSend(): Deferred<void> {
    const deferred = createDeferred<void>();
    this.nextSend = deferred;
    return deferred;
  }

  public deferNextDisconnect(): Deferred<void> {
    const deferred = createDeferred<void>();
    this.nextDisconnect = deferred;
    return deferred;
  }

  public async connect(handlers: OneBotReverseTransportHandlers): Promise<void> {
    this.connectCount += 1;
    this.handlers = handlers;
    this.connectionHandlers.push(handlers);
    const deferred = this.nextConnect;
    this.nextConnect = null;
    if (this.openBeforeDeferredConnectSettlement) await handlers.onOpen();
    if (deferred !== null) await deferred.promise;
    if (!this.openBeforeDeferredConnectSettlement) await handlers.onOpen();
  }

  public send(payload: unknown): Promise<void> {
    const isEngineStoppedResponse = (
      typeof payload === "object"
      && payload !== null
      && "message" in payload
      && payload.message === "ENGINE_STOPPED"
    );
    if (isEngineStoppedResponse) this.engineStoppedSendCount += 1;
    if (this.throwEngineStoppedResponse && isEngineStoppedResponse) {
      throw new Error("TEST_ENGINE_STOPPED_RESPONSE_THROW");
    }
    if (
      this.failEngineStoppedResponse
      && isEngineStoppedResponse
    ) {
      this.failEngineStoppedResponse = false;
      return Promise.reject(new Error("TEST_ENGINE_STOPPED_RESPONSE_FAILED"));
    }
    this.sent.push(payload);
    const deferred = this.nextSend;
    this.nextSend = null;
    if (deferred !== null) return deferred.promise;
    return Promise.resolve();
  }

  public disconnect(): Promise<void> {
    this.disconnectCount += 1;
    if (this.disconnectSyncFailure !== null) throw this.disconnectSyncFailure;
    const deferred = this.nextDisconnect;
    this.nextDisconnect = null;
    return (deferred?.promise ?? Promise.resolve()).then(async () => {
      if (this.disconnectFailure !== null) throw this.disconnectFailure;
      if (!this.deferDisconnectCloseCallback) {
        await this.handlers?.onClose("TEST_DISCONNECT");
      }
    });
  }

  public close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeFailure !== null) return Promise.reject(this.closeFailure);
    this.handlers = null;
    return Promise.resolve();
  }

  public async deliver(payload: unknown): Promise<void> {
    if (this.handlers === null) throw new Error("TRANSPORT_NOT_CONNECTED");
    await this.handlers.onMessage(payload);
  }

  public async breakConnection(): Promise<void> {
    if (this.handlers === null) throw new Error("TRANSPORT_NOT_CONNECTED");
    await this.handlers.onClose("TEST_CONNECTION_LOST");
  }

  public async triggerConnectionOpen(connectionIndex: number): Promise<void> {
    const handlers = this.connectionHandlers[connectionIndex];
    if (handlers === undefined) throw new Error("TRANSPORT_CONNECTION_NOT_FOUND");
    await handlers.onOpen();
  }

  public async triggerConnectionMessage(connectionIndex: number, payload: unknown): Promise<void> {
    const handlers = this.connectionHandlers[connectionIndex];
    if (handlers === undefined) throw new Error("TRANSPORT_CONNECTION_NOT_FOUND");
    await handlers.onMessage(payload);
  }

  public async triggerConnectionClose(connectionIndex: number, reason = "TEST_DELAYED_CLOSE"): Promise<void> {
    const handlers = this.connectionHandlers[connectionIndex];
    if (handlers === undefined) throw new Error("TRANSPORT_CONNECTION_NOT_FOUND");
    await handlers.onClose(reason);
  }
}

class FakeWebSocketClient implements OneBotWebSocketClient {
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onclose: ((event: { reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly sent: string[] = [];
  public closeCount = 0;

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closeCount += 1;
  }

  public open(): void {
    this.onopen?.();
  }

  public message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  public finishClose(reason = "TEST_SOCKET_CLOSED"): void {
    this.onclose?.({ reason });
  }
}

function inbound(
  sequence = 1,
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
    occurredAt: "2026-08-31T08:00:00.000+08:00",
    direction: "incoming",
    kind: "text",
    text: "今天还好吗？",
    ...overrides,
  };
}

async function makeHarness(responseTimeoutMs = 200) {
  const transport = new FakeOneBotReverseTransport();
  const engine = await AstrBotOneBotEngine.create({
    transport,
    directory,
    contactId: "example-contact",
    expectedRevision: 1,
    ownerIdentity: "wechat-owner-account",
    source: "native-ocr",
    sourceEpoch,
    sessionId: targetSessionId,
    responseTimeoutMs,
    now: () => new Date("2026-08-31T08:00:01.000+08:00"),
  });
  createdEngines.push(engine);
  const coordinator = await OfflinePersonalAccountCoordinator.create({
    engine,
    directory,
    contactId: "example-contact",
    expectedRevision: 1,
    source: "native-ocr",
    sourceEpoch,
    sessionId: targetSessionId,
  });
  coordinator.updateSourceStatus({
    contractVersion: 1,
    source: "native-ocr",
    sourceEpoch,
    state: "waiting",
    lastEventAt: null,
    reason: null,
  });
  return { coordinator, engine, transport };
}

async function makeDynamicHarness(responseTimeoutMs = 200) {
  const transport = new FakeOneBotReverseTransport();
  const engine = await AstrBotOneBotEngine.create({
    transport,
    directory,
    contactId: testContactId,
    expectedRevision: 1,
    ownerIdentity: "wechat-owner-account",
    source: "native-ocr",
    sourceEpoch,
    sessionId: targetSessionId,
    responseTimeoutMs,
    now: () => new Date("2026-08-31T08:00:01.000+08:00"),
  });
  createdEngines.push(engine);
  const coordinator = await OfflinePersonalAccountCoordinator.create({
    engine,
    directory,
    contactId: testContactId,
    expectedRevision: 1,
    source: "native-ocr",
    sourceEpoch,
    sessionId: targetSessionId,
  });
  coordinator.updateSourceStatus({
    contractVersion: 1,
    source: "native-ocr",
    sourceEpoch,
    state: "waiting",
    lastEventAt: null,
    reason: null,
  });
  return { coordinator, engine, transport };
}

function privateReply(
  userId: number,
  echo: string,
  text = "挺好的，也想听听你今天怎么样。",
  triggerId = "a".repeat(64),
) {
  return {
    action: "send_msg" as const,
    params: {
      message_type: "private" as const,
      user_id: userId,
      trigger_id: triggerId,
      message: [{ type: "text" as const, data: { text } }],
    },
    echo,
  };
}

async function startReplyIntent(harness: Awaited<ReturnType<typeof makeHarness>>, echo: string) {
  await harness.engine.start();
  const resultPromise = harness.coordinator.process([inbound()]);
  await Promise.resolve();
  expect(harness.transport.sent).toHaveLength(1);
  const triggerId = oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id;
  await harness.transport.deliver(privateReply(harness.engine.targetUserId, echo, undefined, triggerId));
  const result = await resultPromise;
  if (result.status !== "reply-intent") throw new Error("EXPECTED_REPLY_INTENT");
  return result.intent;
}

function deliveryReceipt(
  intent: {
    triggerId: string;
    contactId: ContactId;
    contactRevision: number;
    bindingHash: string;
    deliveryKey: string;
  },
  status: "verified" | "uncertain" | "failed",
) {
  return {
    contractVersion: 1 as const,
    triggerId: intent.triggerId,
    contactId: intent.contactId,
    contactRevision: intent.contactRevision,
    bindingHash: intent.bindingHash,
    deliveryKey: intent.deliveryKey,
    status,
  };
}

describe("Akasha OneBot canonical contracts", () => {
  it("derives repeatable positive OneBot IDs without process-random hash state", () => {
    const first = stableOneBotId("session-example-contact");

    expect(first).toBe(stableOneBotId("session-example-contact"));
    expect(first).not.toBe(stableOneBotId("wechat-owner-account"));
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
  });

  it("implements a bounded reverse WebSocket connect/message/disconnect lifecycle", async () => {
    const socket = new FakeWebSocketClient();
    const received: unknown[] = [];
    const closes: string[] = [];
    const socketInputs: Array<{
      url: string;
      headers: Readonly<Record<string, string>>;
    }> = [];
    const transport = new OneBotReverseWebSocketTransport({
      url: "ws://127.0.0.1:6199/ws",
      selfId: 123_456,
      accessToken: "fixture-token",
      createSocket: (input) => {
        socketInputs.push(input);
        return socket;
      },
      lifecycleTimeoutMs: 50,
    });
    const connectPromise = transport.connect({
      onOpen: () => undefined,
      onMessage: (payload) => {
        received.push(payload);
      },
      onClose: (reason) => {
        closes.push(reason);
      },
    });
    socket.open();
    await connectPromise;
    expect(socketInputs).toEqual([{
      url: "ws://127.0.0.1:6199/ws",
      headers: {
        "X-Self-ID": "123456",
        "X-Client-Role": "Universal",
        "User-Agent": "OneBot/11",
        Authorization: "Bearer fixture-token",
      },
    }]);

    await transport.send({ action: "fixture" });
    socket.message({ action: "reply" });
    await Promise.resolve();
    expect(socket.sent).toEqual([JSON.stringify({ action: "fixture" })]);
    expect(received).toEqual([{ action: "reply" }]);

    const disconnectPromise = transport.disconnect();
    expect(socket.closeCount).toBe(1);
    socket.finishClose();
    await disconnectPromise;
    expect(closes).toEqual(["TEST_SOCKET_CLOSED"]);
    await transport.close();
    await expect(transport.connect({
      onOpen: () => undefined,
      onMessage: () => undefined,
      onClose: () => undefined,
    })).rejects.toThrowError("ONEBOT_TRANSPORT_CLOSED");
  });

  it("rejects a non-loopback reverse WebSocket endpoint", () => {
    expect(() => new OneBotReverseWebSocketTransport({
      url: "wss://example.com/ws",
      selfId: 123,
      createSocket: () => new FakeWebSocketClient(),
    })).toThrowError("ONEBOT_URL_MUST_BE_LOOPBACK");
  });

  it("returns to idle after socket factory or open-handler failure", async () => {
    const socket = new FakeWebSocketClient();
    let factoryAttempts = 0;
    const transport = new OneBotReverseWebSocketTransport({
      url: "ws://localhost:6199/ws",
      selfId: 123,
      createSocket: () => {
        factoryAttempts += 1;
        if (factoryAttempts === 1) throw new Error("TEST_FACTORY_FAILED");
        return socket;
      },
      lifecycleTimeoutMs: 50,
    });
    const handlers = {
      onOpen: () => undefined,
      onMessage: () => undefined,
      onClose: () => undefined,
    };

    await expect(transport.connect(handlers)).rejects.toThrowError("TEST_FACTORY_FAILED");
    const connectPromise = transport.connect({
      ...handlers,
      onOpen: () => {
        throw new Error("TEST_OPEN_HANDLER_FAILED");
      },
    });
    socket.open();
    await expect(connectPromise).rejects.toThrowError("TEST_OPEN_HANDLER_FAILED");
    expect(socket.closeCount).toBe(1);
  });

  it("keeps event, action, receipt, and API response payloads strict", () => {
    const event = {
      time: 1_788_138_001,
      self_id: 100,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: "a".repeat(64),
      user_id: 200,
      message: [{ type: "text", data: { text: "你好" } }],
      raw_message: "你好",
      sender: { user_id: 200, nickname: "示例联系人" },
    };
    const action = privateReply(200, "echo-contract", "你好");
    const receipt = {
      contractVersion: 1,
      triggerId: "b".repeat(64),
      contactId: "example-contact",
      contactRevision: 1,
      bindingHash: fengBindingHash,
      deliveryKey: "c".repeat(64),
      status: "verified",
    };
    const response = {
      status: "ok",
      retcode: 0,
      data: { message_id: "c".repeat(64) },
      message: "DELIVERY_VERIFIED",
      echo: "echo-contract",
    };

    expect(oneBotPrivateMessageEventSchema.parse(event)).toEqual(event);
    expect(oneBotActionRequestSchema.parse(action)).toEqual(action);
    expect(oneBotActionRequestSchema.parse({
      ...action,
      echo: { seq: 17 },
    })).toMatchObject({ echo: { seq: 17 } });
    expect(oneBotDeliveryReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(oneBotApiResponseSchema.parse(response)).toEqual(response);
    expect(oneBotPrivateMessageEventSchema.safeParse({ ...event, wxid: "secret" }).success).toBe(false);
    expect(oneBotActionRequestSchema.safeParse({ ...action, triggerId: "caller-controlled" }).success).toBe(false);
    expect(oneBotActionRequestSchema.safeParse({
      ...action,
      params: { ...action.params, contactId: testContactId },
    }).success).toBe(false);
    expect(oneBotDeliveryReceiptSchema.safeParse({ ...receipt, status: "sent" }).success).toBe(false);
    expect(oneBotApiResponseSchema.safeParse({ ...response, success: true }).success).toBe(false);
  });
});

describe("AstrBotOneBotEngine offline integration", () => {
  it("derives distinct OneBot user IDs for distinct authorized contact bindings", async () => {
    const feng = await makeHarness();
    const dynamic = await makeDynamicHarness();

    expect(feng.engine.selfId).toBe(dynamic.engine.selfId);
    expect(feng.engine.targetUserId).not.toBe(dynamic.engine.targetUserId);
  });

  it.each(["disconnect", "close"] as const)(
    "releases its mapping exactly once when transport %s fails during close",
    async (failure) => {
      const harness = await makeHarness();
      await harness.engine.start();
      if (failure === "disconnect") harness.transport.disconnectFailure = new Error("TEST_DISCONNECT_FAILED");
      else harness.transport.closeFailure = new Error("TEST_CLOSE_FAILED");

      await expect(harness.engine.close()).rejects.toThrowError(
        failure === "disconnect" ? "TEST_DISCONNECT_FAILED" : "TEST_CLOSE_FAILED",
      );
      await expect(harness.engine.close()).resolves.toBeUndefined();
      expect(harness.transport.disconnectCount).toBe(1);
      expect(harness.transport.closeCount).toBe(1);
    },
  );

  it("closes exactly once when transport disconnect throws synchronously", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    harness.transport.disconnectSyncFailure = new Error("TEST_DISCONNECT_SYNC_THROW");

    await expect(harness.engine.close()).rejects.toThrowError("TEST_DISCONNECT_SYNC_THROW");

    expect(harness.transport.disconnectCount).toBe(1);
    expect(harness.transport.closeCount).toBe(1);
    expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
  });

  it("retains an active mapping across stop and restart until close", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    await harness.engine.stop();
    await harness.engine.start();

    expect(harness.engine.getStatus().state).toBe("ready");
    await harness.engine.close();
    await expect(harness.engine.close()).resolves.toBeUndefined();
  });

  it("clears an awaiting-delivery pending reply without sending ENGINE_STOPPED during close", async () => {
    const harness = await makeHarness();
    const intent = await startReplyIntent(harness, "echo-close-pending");
    harness.transport.failEngineStoppedResponse = true;

    await expect(harness.engine.close()).resolves.toBeUndefined();
    expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
    await expect(harness.engine.completeDelivery(deliveryReceipt(intent, "verified")))
      .rejects.toThrowError("ONEBOT_ENGINE_CLOSED");
    expect(harness.engine.getStatus().state).toBe("closed");
    expect(harness.transport.sent).toHaveLength(1);
  });

  it("ignores residual transport callbacks after transport.close fails", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    harness.transport.closeFailure = new Error("TEST_CLOSE_HANDLER_RETAINED");

    await expect(harness.engine.close()).rejects.toThrowError("TEST_CLOSE_HANDLER_RETAINED");
    const sentBeforeCallbacks = harness.transport.sent.length;
    await harness.transport.deliver({ action: "send_msg", params: { user_id: "bad" } });
    await harness.transport.deliver(privateReply(harness.engine.targetUserId, "echo-residual"));

    expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
    expect(harness.transport.sent).toHaveLength(sentBeforeCallbacks);
  });

  it("shares one close operation across concurrent close callers", async () => {
    const harness = await makeHarness();
    await harness.engine.start();

    const results = await Promise.allSettled([harness.engine.close(), harness.engine.close()]);

    expect(results).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
    expect(harness.transport.disconnectCount).toBe(1);
    expect(harness.transport.closeCount).toBe(1);
    expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
  });

  it("shares one rejected close promise and releases its transport lifecycle once", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    harness.transport.disconnectFailure = new Error("TEST_CONCURRENT_DISCONNECT_FAILED");

    const first = harness.engine.close();
    const second = harness.engine.close();
    void first.catch(() => undefined);
    void second.catch(() => undefined);

    expect(second).toBe(first);
    await expect(first).rejects.toThrowError("TEST_CONCURRENT_DISCONNECT_FAILED");
    await expect(second).rejects.toThrowError("TEST_CONCURRENT_DISCONNECT_FAILED");
    expect(harness.transport.disconnectCount).toBe(1);
    expect(harness.transport.closeCount).toBe(1);
    expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
  });

  it.each(["resolve", "reject"] as const)(
    "shares a deferred disconnect between close and a concurrent stop when it %ss",
    async (outcome) => {
      const harness = await makeHarness();
      await harness.engine.start();
      const deferredDisconnect = harness.transport.deferNextDisconnect();
      const close = harness.engine.close();
      await Promise.resolve();
      const stop = harness.engine.stop();
      const results = Promise.allSettled([close, stop]);

      expect(harness.transport.disconnectCount).toBe(1);
      if (outcome === "resolve") deferredDisconnect.resolve();
      else deferredDisconnect.reject(new Error("TEST_SHARED_DISCONNECT_FAILED"));

      expect((await results).map(({ status }) => status)).toEqual(
        outcome === "resolve" ? ["fulfilled", "fulfilled"] : ["rejected", "rejected"],
      );
      expect(harness.transport.disconnectCount).toBe(1);
      expect(harness.transport.closeCount).toBe(1);
      expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
    },
  );

  it.each(["resolve", "reject"] as const)(
    "joins an ordinary deferred stop disconnect when close starts and it %ss",
    async (outcome) => {
      const harness = await makeHarness();
      await harness.engine.start();
      const deferredDisconnect = harness.transport.deferNextDisconnect();
      const stop = harness.engine.stop();
      await Promise.resolve();
      await expect(harness.engine.start()).rejects.toThrowError("ONEBOT_DISCONNECT_IN_PROGRESS");
      expect(harness.transport.connectCount).toBe(1);
      const close = harness.engine.close();
      const results = Promise.allSettled([stop, close]);

      expect(harness.transport.disconnectCount).toBe(1);
      await expect(harness.engine.start()).rejects.toThrowError("ONEBOT_ENGINE_CLOSED");
      expect(harness.transport.connectCount).toBe(1);
      if (outcome === "resolve") deferredDisconnect.resolve();
      else deferredDisconnect.reject(new Error("TEST_ORDINARY_DISCONNECT_FAILED"));

      expect((await results).map(({ status }) => status)).toEqual(
        outcome === "resolve" ? ["fulfilled", "fulfilled"] : ["rejected", "rejected"],
      );
      expect(harness.transport.disconnectCount).toBe(1);
      expect(harness.transport.closeCount).toBe(1);
      expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
    },
  );

  it("disconnects once for each sequential stop-start-stop connection", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    await harness.engine.stop();
    await harness.engine.start();
    await harness.engine.stop();

    expect(harness.transport.disconnectCount).toBe(2);
    expect(harness.transport.connectCount).toBe(2);
    expect(harness.engine.getStatus().state).toBe("stopped");
  });

  it.each(["resolve", "reject"] as const)(
    "keeps the shared stop current until its pending notification %ss",
    async (outcome) => {
      const harness = await makeHarness();
      await startReplyIntent(harness, `echo-shared-ordinary-stop-${outcome}`);
      const deferredNotification = harness.transport.deferNextSend();
      const firstStop = harness.engine.stop();
      void firstStop.catch(() => undefined);

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(harness.transport.sent).toHaveLength(2);
      expect(harness.transport.engineStoppedSendCount).toBe(1);
      expect(harness.transport.disconnectCount).toBe(1);
      expect(harness.engine.getStatus()).toMatchObject({
        state: "processing",
        pendingTriggerId: null,
      });

      const secondStop = harness.engine.stop();
      void secondStop.catch(() => undefined);
      expect(secondStop).toBe(firstStop);
      await expect(harness.engine.start()).rejects.toThrowError("ONEBOT_DISCONNECT_IN_PROGRESS");
      const close = harness.engine.close();
      void close.catch(() => undefined);
      const closeBeforeNotification = await Promise.race([
        close.then(() => "settled", () => "settled"),
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      expect(closeBeforeNotification).toBe("pending");
      expect(harness.transport.closeCount).toBe(0);

      if (outcome === "resolve") deferredNotification.resolve();
      else deferredNotification.reject(new Error("TEST_SHARED_NOTIFICATION_REJECT"));
      const stopResults = await Promise.allSettled([firstStop, secondStop]);
      expect(stopResults.map(({ status }) => status)).toEqual(
        outcome === "resolve" ? ["fulfilled", "fulfilled"] : ["rejected", "rejected"],
      );
      if (outcome === "resolve") await expect(close).resolves.toBeUndefined();
      else await expect(close).rejects.toThrowError("TEST_SHARED_NOTIFICATION_REJECT");

      expect(harness.transport.disconnectCount).toBe(1);
      expect(harness.transport.closeCount).toBe(1);
      expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
    },
  );

  it.each(["reject", "throw"] as const)(
    "disconnects and clears pending when an ordinary stop notification %ss",
    async (outcome) => {
      const harness = await makeHarness();
      await startReplyIntent(harness, `echo-stop-notification-${outcome}`);
      const deferredNotification = outcome === "reject"
        ? harness.transport.deferNextSend()
        : null;
      harness.transport.throwEngineStoppedResponse = outcome === "throw";

      const firstStop = harness.engine.stop();
      const secondStop = harness.engine.stop();
      void firstStop.catch(() => undefined);
      void secondStop.catch(() => undefined);
      expect(secondStop).toBe(firstStop);
      if (deferredNotification !== null) {
        deferredNotification.reject(new Error("TEST_ENGINE_STOPPED_RESPONSE_REJECT"));
      }

      const results = await Promise.allSettled([firstStop, secondStop]);
      expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
      expect(harness.transport.engineStoppedSendCount).toBe(1);
      expect(harness.transport.disconnectCount).toBe(1);
      expect(harness.engine.getStatus()).toMatchObject({ state: "stopped", pendingTriggerId: null });
    },
  );

  it.each([
    { notificationFails: false, expectedError: "TEST_STOP_DISCONNECT_FAILED" },
    { notificationFails: true, expectedError: "TEST_STOP_NOTIFICATION_FAILED" },
  ] as const)(
    "finalizes a failed disconnect with deterministic stop error $expectedError",
    async ({ notificationFails, expectedError }) => {
      const harness = await makeHarness();
      await startReplyIntent(harness, `echo-stop-double-failure-${String(notificationFails)}`);
      const deferredNotification = notificationFails
        ? harness.transport.deferNextSend()
        : null;
      harness.transport.disconnectFailure = new Error("TEST_STOP_DISCONNECT_FAILED");

      const stop = harness.engine.stop();
      void stop.catch(() => undefined);
      deferredNotification?.reject(new Error("TEST_STOP_NOTIFICATION_FAILED"));

      await expect(stop).rejects.toThrowError(expectedError);
      expect(harness.transport.engineStoppedSendCount).toBe(1);
      expect(harness.transport.disconnectCount).toBe(1);
      expect(harness.engine.getStatus()).toMatchObject({ state: "stopped", pendingTriggerId: null });
    },
  );

  it("ignores a delayed expected close callback after ordinary stop and can restart", async () => {
    const harness = await makeHarness();
    harness.transport.deferDisconnectCloseCallback = true;
    await harness.engine.start();
    await harness.engine.stop();

    expect(harness.engine.getStatus().state).toBe("stopped");
    await harness.transport.triggerConnectionClose(0);
    expect(harness.engine.getStatus().state).toBe("stopped");
    await harness.engine.start();
    expect(harness.transport.connectCount).toBe(2);
    expect(harness.engine.getStatus().state).toBe("ready");
  });

  it("keeps a restarted connection ready when its old lease closes late", async () => {
    const harness = await makeHarness();
    harness.transport.deferDisconnectCloseCallback = true;
    await harness.engine.start();
    await harness.engine.stop();
    await harness.engine.start();

    await harness.transport.triggerConnectionClose(0);

    expect(harness.engine.getStatus()).toMatchObject({ state: "ready", pendingTriggerId: null });
  });

  it("ignores delayed open and message callbacks from an old connection lease", async () => {
    const harness = await makeHarness();
    harness.transport.deferDisconnectCloseCallback = true;
    await harness.engine.start();
    await harness.engine.stop();
    await harness.engine.start();
    void harness.coordinator.process([inbound()]);
    await Promise.resolve();
    const pendingBefore = harness.engine.getStatus();
    const sentBefore = harness.transport.sent.length;

    await harness.transport.triggerConnectionOpen(0);
    await harness.transport.triggerConnectionMessage(
      0,
      privateReply(harness.engine.targetUserId, "echo-old-generation"),
    );

    expect(harness.engine.getStatus()).toMatchObject({
      state: "processing",
      pendingTriggerId: pendingBefore.pendingTriggerId,
    });
    expect(harness.transport.sent).toHaveLength(sentBefore);
  });

  it("degrades and clears pending for a non-expected current connection close", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    const processing = harness.coordinator.process([inbound()]);
    await Promise.resolve();

    await harness.transport.breakConnection();

    await expect(processing).resolves.toEqual({ status: "ignored", reason: "ENGINE_REFUSED" });
    expect(harness.engine.getStatus()).toMatchObject({
      state: "degraded",
      reason: "ONEBOT_CONNECTION_CLOSED",
      pendingTriggerId: null,
    });

    const sentBeforeLateCallbacks = harness.transport.sent.length;
    await harness.transport.triggerConnectionOpen(0);
    await harness.transport.triggerConnectionMessage(
      0,
      privateReply(harness.engine.targetUserId, "echo-after-unexpected-close"),
    );
    await harness.transport.triggerConnectionClose(0);

    expect(harness.engine.getStatus()).toMatchObject({
      state: "degraded",
      reason: "ONEBOT_CONNECTION_CLOSED",
      pendingTriggerId: null,
    });
    expect(harness.transport.sent).toHaveLength(sentBeforeLateCallbacks);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a lease 1 connect %s after lease 2 is ready",
    async (outcome) => {
      const harness = await makeHarness();
      harness.transport.deferDisconnectCloseCallback = true;
      const oldConnect = harness.transport.deferNextConnect();
      const oldStart = harness.engine.start();
      await Promise.resolve();

      await harness.engine.stop();
      await harness.engine.start();
      expect(harness.engine.getStatus()).toMatchObject({ state: "ready", reason: null });

      if (outcome === "resolve") oldConnect.resolve();
      else oldConnect.reject(new Error("TEST_OLD_CONNECT_REJECTED"));

      if (outcome === "resolve") await expect(oldStart).resolves.toBeUndefined();
      else await expect(oldStart).rejects.toThrowError("ONEBOT_CONNECT_FAILED");
      expect(harness.engine.getStatus()).toMatchObject({ state: "ready", reason: null });
    },
  );

  it("invalidates pending generate work when connect rejects after onOpen", async () => {
    const harness = await makeHarness();
    harness.transport.openBeforeDeferredConnectSettlement = true;
    const deferredConnect = harness.transport.deferNextConnect();
    const start = harness.engine.start();
    await Promise.resolve();
    expect(harness.engine.getStatus().state).toBe("ready");

    const processing = harness.coordinator.process([inbound()]);
    await Promise.resolve();
    expect(harness.engine.getStatus()).toMatchObject({ state: "processing" });
    deferredConnect.reject(new Error("TEST_CONNECT_REJECT_AFTER_OPEN"));

    await expect(start).rejects.toThrowError("ONEBOT_CONNECT_FAILED");
    const processingOutcome = await Promise.race([
      processing,
      new Promise<"still-pending">((resolve) => setImmediate(() => resolve("still-pending"))),
    ]);
    expect(processingOutcome).toEqual({ status: "ignored", reason: "ENGINE_REFUSED" });
    expect(harness.engine.getStatus()).toMatchObject({
      state: "degraded",
      reason: "ONEBOT_TRANSPORT_FAILED",
      pendingTriggerId: null,
    });
  });

  it("retries repeated connect failures with one explicit current lease", async () => {
    const harness = await makeHarness();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failedConnect = harness.transport.deferNextConnect();
      const start = harness.engine.start();
      failedConnect.reject(new Error(`TEST_CONNECT_FAILURE_${String(attempt)}`));
      await expect(start).rejects.toThrowError("ONEBOT_CONNECT_FAILED");
      expect(harness.engine.getStatus().state).toBe("degraded");
      await harness.engine.stop();
      expect(harness.engine.getStatus().state).toBe("stopped");
    }

    await harness.engine.start();
    expect(harness.engine.getStatus().state).toBe("ready");
    const source = await readFile(
      path.join(process.cwd(), "src/conversation/akasha-onebot-engine.ts"),
      "utf8",
    );
    expect(source).toContain("private currentLease: ConnectionLease | null");
    expect(source).toContain(
      'type ConnectionPhase = "connecting" | "ready" | "disconnecting" | "disconnected"',
    );
    expect(source).not.toMatch(
      /expectedDisconnectGenerations|activeConnectionGeneration|connectionGeneration|disconnectGeneration|disconnectSettled/u,
    );
  });

  it.each(["resolve", "reject"] as const)(
    "keeps closed after an in-flight generate send %ss",
    async (outcome) => {
      const harness = await makeHarness();
      await harness.engine.start();
      const deferredSend = harness.transport.deferNextSend();
      const processing = harness.coordinator.process([inbound()]);
      await Promise.resolve();

      await harness.engine.close();
      if (outcome === "resolve") deferredSend.resolve();
      else deferredSend.reject(new Error("TEST_GENERATE_SEND_FAILED"));

      await expect(processing).resolves.toEqual({ status: "ignored", reason: "ENGINE_REFUSED" });
      expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps closed after an in-flight delivery response send %ss",
    async (outcome) => {
      const harness = await makeHarness();
      const intent = await startReplyIntent(harness, `echo-delivery-${outcome}`);
      const deferredSend = harness.transport.deferNextSend();
      const delivery = harness.engine.completeDelivery(deliveryReceipt(intent, "verified"));
      await Promise.resolve();
      expect(harness.transport.sent).toHaveLength(2);

      await harness.engine.close();
      if (outcome === "resolve") deferredSend.resolve();
      else deferredSend.reject(new Error("TEST_DELIVERY_RESPONSE_FAILED"));

      await expect(delivery).rejects.toThrowError("ONEBOT_ENGINE_CLOSED");
      expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
      const laterMessageId = "e".repeat(64);
      await expect(harness.engine.generate({
        contractVersion: 1,
        triggerId: deriveConversationTriggerId({
          contactId: intent.contactId,
          contactRevision: intent.contactRevision,
          bindingHash: intent.bindingHash,
          source: intent.source,
          sourceEpoch: intent.sourceEpoch,
          sessionId: intent.sessionId,
          sourceMessageIds: [laterMessageId],
        }),
        conversationId: intent.conversationId,
        contactId: intent.contactId,
        contactRevision: intent.contactRevision,
        bindingHash: intent.bindingHash,
        source: intent.source,
        sourceEpoch: intent.sourceEpoch,
        sessionId: intent.sessionId,
        latestIncomingMessageId: laterMessageId,
        messages: [{
          messageId: laterMessageId,
          direction: "incoming",
          kind: "text",
          text: "关闭后不得发送",
          occurredAt: "2026-08-31T08:00:00.000+08:00",
        }],
      })).resolves.toEqual({ status: "refused", reason: "MODEL_UNAVAILABLE" });
      expect(harness.transport.sent).toHaveLength(2);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps closed when an in-flight connect %ss after close",
    async (outcome) => {
      const harness = await makeHarness();
      const deferredConnect = harness.transport.deferNextConnect();
      const start = harness.engine.start();
      await Promise.resolve();
      expect(harness.engine.getStatus().state).toBe("starting");

      await harness.engine.close();
      if (outcome === "resolve") deferredConnect.resolve();
      else deferredConnect.reject(new Error("TEST_CONNECT_FAILED_AFTER_CLOSE"));

      if (outcome === "resolve") await expect(start).resolves.toBeUndefined();
      else await expect(start).rejects.toThrowError("ONEBOT_CONNECT_FAILED");
      expect(harness.engine.getStatus()).toMatchObject({ state: "closed", pendingTriggerId: null });
    },
  );

  it("rejects an OneBot user id not present in the bound mapping", async () => {
    const harness = await makeDynamicHarness();
    await harness.engine.start();
    const resultPromise = harness.coordinator.process([inbound(1, {
      conversationId: testContactId,
    })]);
    await Promise.resolve();

    expect(oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0])).toMatchObject({
      user_id: harness.engine.targetUserId,
      sender: { nickname: "我" },
    });

    await harness.transport.deliver({
      action: "send_private_msg",
      params: {
        user_id: 2_147_483_000,
        trigger_id: oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id,
        message: [{ type: "text", data: { text: "错误目标" } }],
      },
      echo: "echo-unbound-user",
    });

    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "failed",
      message: "TARGET_NOT_ALLOWED",
    });
    expect(harness.transport.sent).toHaveLength(2);
    await harness.transport.deliver(privateReply(
      harness.engine.targetUserId,
      "echo-current-mapping",
      undefined,
      oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id,
    ));
    await expect(resultPromise).resolves.toMatchObject({ status: "reply-intent" });
  });

  it("refuses a stale revision before emitting an OneBot event", async () => {
    const harness = await makeDynamicHarness();
    await harness.engine.start();

    const triggerId = deriveConversationTriggerId({
      contactId: testContactId,
      contactRevision: 2,
      bindingHash: testBindingHash,
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
      sourceMessageIds: ["b".repeat(64)],
    });
    const response = await harness.engine.generate({
      contractVersion: 1,
      triggerId,
      conversationId: testContactId,
      contactId: testContactId,
      contactRevision: 2,
      bindingHash: testBindingHash,
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
      latestIncomingMessageId: "b".repeat(64),
      messages: [{
        messageId: "b".repeat(64),
        direction: "incoming",
        kind: "text",
        text: "旧版本触发",
        occurredAt: "2026-08-31T08:00:00.000+08:00",
      }],
    });

    expect(response).toEqual({ status: "refused", reason: "MODEL_UNAVAILABLE" });
    expect(harness.transport.sent).toHaveLength(0);
  });

  it("rejects a delayed T1 action while T2 is pending and preserves T2", async () => {
    const harness = await makeHarness(10);
    await harness.engine.start();
    const first = harness.coordinator.process([inbound(1)]);
    await Promise.resolve();
    const firstTrigger = oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id;
    await expect(first).resolves.toEqual({ status: "ignored", reason: "ENGINE_REFUSED" });

    const second = harness.coordinator.process([inbound(2)]);
    await Promise.resolve();
    const secondTrigger = oneBotPrivateMessageEventSchema.parse(harness.transport.sent[1]).message_id;
    await harness.transport.deliver(privateReply(
      harness.engine.targetUserId,
      "echo-late-t1",
      undefined,
      firstTrigger,
    ));
    expect(oneBotApiResponseSchema.parse(harness.transport.sent[2])).toMatchObject({
      status: "failed",
      message: "STALE_TRIGGER",
      echo: "echo-late-t1",
    });

    await harness.transport.deliver(privateReply(
      harness.engine.targetUserId,
      "echo-t2",
      undefined,
      secondTrigger,
    ));
    await expect(second).resolves.toMatchObject({ status: "reply-intent" });
    expect(harness.transport.sent).toHaveLength(3);
  });

  it("converts one inbound trigger to an event and delays success until verified delivery", async () => {
    const harness = await makeHarness();
    const intent = await startReplyIntent(harness, "echo-happy");

    const event = oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]);
    expect(event).toMatchObject({
      self_id: harness.engine.selfId,
      user_id: harness.engine.targetUserId,
      raw_message: "今天还好吗？",
      message_id: intent.triggerId,
    });
    expect(intent).toMatchObject({
      conversationId: "example-contact",
      replyText: "挺好的，也想听听你今天怎么样。",
    });
    expect(harness.transport.sent).toHaveLength(1);

    await harness.engine.completeDelivery(deliveryReceipt(intent, "verified"));

    expect(harness.transport.sent).toHaveLength(2);
    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toEqual({
      status: "ok",
      retcode: 0,
      data: { message_id: intent.deliveryKey },
      message: "DELIVERY_VERIFIED",
      echo: "echo-happy",
    });
  });

  it("rejects a receipt whose delivery key is not bound to the accepted reply", async () => {
    const harness = await makeHarness();
    const intent = await startReplyIntent(harness, "echo-wrong-delivery-key");

    await expect(harness.engine.completeDelivery({
      contractVersion: 1,
      triggerId: intent.triggerId,
      contactId: intent.contactId,
      contactRevision: intent.contactRevision,
      bindingHash: intent.bindingHash,
      deliveryKey: "f".repeat(64),
      status: "verified",
    })).rejects.toThrowError("DELIVERY_KEY_MISMATCH");
    expect(harness.transport.sent).toHaveLength(1);

    await harness.engine.completeDelivery(deliveryReceipt(intent, "verified"));
    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "ok",
      echo: "echo-wrong-delivery-key",
    });
  });

  it("rejects an arbitrary or unmapped contact before creating a reply intent", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    const resultPromise = harness.coordinator.process([inbound()]);
    await Promise.resolve();

    await harness.transport.deliver(privateReply(
      stableOneBotId("some-other-contact"),
      "echo-wrong-target",
      undefined,
      oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id,
    ));

    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "failed",
      data: null,
      message: "TARGET_NOT_ALLOWED",
      echo: "echo-wrong-target",
    });
    await harness.transport.deliver(privateReply(
      harness.engine.targetUserId,
      "echo-correct",
      undefined,
      oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id,
    ));
    await expect(resultPromise).resolves.toMatchObject({ status: "reply-intent" });
  });

  it("accepts AstrBot's current send_private_msg action shape", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    const resultPromise = harness.coordinator.process([inbound()]);
    await Promise.resolve();

    await harness.transport.deliver({
      action: "send_private_msg",
      params: {
        self_id: harness.engine.selfId,
        user_id: harness.engine.targetUserId,
        trigger_id: oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id,
        message: [{ type: "text", data: { text: "这是 private action 回复。" } }],
      },
      echo: { seq: 17 },
    });

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: "reply-intent",
      intent: { replyText: "这是 private action 回复。" },
    });
    if (result.status !== "reply-intent") throw new Error("EXPECTED_REPLY_INTENT");
    await harness.engine.completeDelivery(deliveryReceipt(result.intent, "failed"));
    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "failed",
      echo: { seq: 17 },
    });
  });

  it("rejects a private action routed to a different OneBot self identity", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    const resultPromise = harness.coordinator.process([inbound()]);
    await Promise.resolve();

    await harness.transport.deliver({
      action: "send_private_msg",
      params: {
        self_id: stableOneBotId("different-owner"),
        user_id: harness.engine.targetUserId,
        trigger_id: oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id,
        message: [{ type: "text", data: { text: "错误路由" } }],
      },
      echo: { seq: 18 },
    });

    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "failed",
      message: "SELF_ID_MISMATCH",
      echo: { seq: 18 },
    });
    await harness.transport.deliver(privateReply(
      harness.engine.targetUserId,
      "echo-after-self-id",
      undefined,
      oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id,
    ));
    await expect(resultPromise).resolves.toMatchObject({ status: "reply-intent" });
  });

  it("rejects proactive group send commands and keeps waiting for the bound private reply", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    const resultPromise = harness.coordinator.process([inbound()]);
    await Promise.resolve();

    await harness.transport.deliver({
      action: "send_group_msg",
      params: {
        group_id: 123,
        message: [{ type: "text", data: { text: "主动群发" } }],
      },
      echo: "echo-group",
    });

    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "failed",
      message: "GROUP_SEND_FORBIDDEN",
      echo: "echo-group",
    });
    await harness.transport.deliver(privateReply(
      harness.engine.targetUserId,
      "echo-after-group",
      undefined,
      oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]).message_id,
    ));
    await expect(resultPromise).resolves.toMatchObject({ status: "reply-intent" });
  });

  it("rejects stale commands when no trigger is waiting", async () => {
    const harness = await makeHarness();
    await harness.engine.start();

    await harness.transport.deliver(privateReply(harness.engine.targetUserId, "echo-stale"));

    expect(oneBotApiResponseSchema.parse(harness.transport.sent[0])).toMatchObject({
      status: "failed",
      message: "STALE_TRIGGER",
      echo: "echo-stale",
    });
  });

  it("rejects duplicate echo without resolving or acknowledging twice", async () => {
    const harness = await makeHarness();
    const intent = await startReplyIntent(harness, "echo-duplicate");

    await harness.transport.deliver(privateReply(harness.engine.targetUserId, "echo-duplicate", "第二份"));
    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "failed",
      message: "DUPLICATE_ECHO",
    });

    await harness.engine.completeDelivery(deliveryReceipt(intent, "verified"));
    expect(oneBotApiResponseSchema.parse(harness.transport.sent[2])).toMatchObject({
      status: "ok",
      echo: "echo-duplicate",
    });
  });

  it.each([
    ["uncertain", "SEND_RESULT_UNCERTAIN"],
    ["failed", "SEND_FAILED"],
  ] as const)("reports %s delivery as failure instead of a false success", async (status, message) => {
    const harness = await makeHarness();
    const intent = await startReplyIntent(harness, `echo-${status}`);

    await harness.engine.completeDelivery(deliveryReceipt(intent, status));

    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "failed",
      data: null,
      message,
      echo: `echo-${status}`,
    });
  });

  it("fails closed on timeout and then treats a late action as stale", async () => {
    const harness = await makeHarness(10);
    await harness.engine.start();

    const result = await harness.coordinator.process([inbound()]);
    expect(result).toEqual({ status: "ignored", reason: "ENGINE_REFUSED" });

    await harness.transport.deliver(privateReply(harness.engine.targetUserId, "echo-late"));
    expect(oneBotApiResponseSchema.parse(harness.transport.sent[1])).toMatchObject({
      status: "failed",
      message: "STALE_TRIGGER",
    });
  });

  it("records malformed payloads as degraded without inventing an echo or success", async () => {
    const harness = await makeHarness();
    await harness.engine.start();

    await harness.transport.deliver({ action: "send_msg", params: { user_id: "not-a-number" } });

    expect(harness.transport.sent).toHaveLength(0);
    expect(harness.engine.getStatus()).toMatchObject({
      state: "degraded",
      reason: "ONEBOT_ACTION_INVALID",
    });
  });

  it("refuses pending work on connection loss and provides stop/close lifecycle", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    const resultPromise = harness.coordinator.process([inbound()]);
    await Promise.resolve();

    await harness.transport.breakConnection();

    await expect(resultPromise).resolves.toEqual({ status: "ignored", reason: "ENGINE_REFUSED" });
    expect(harness.engine.getStatus()).toMatchObject({
      state: "degraded",
      reason: "ONEBOT_CONNECTION_CLOSED",
    });
    await harness.engine.stop();
    await harness.engine.close();
    expect(harness.transport.disconnectCount).toBe(1);
    expect(harness.transport.closeCount).toBe(1);
    expect(harness.engine.getStatus().state).toBe("closed");
  });

  it("uses a versioned SHA-256 trigger as the OneBot message ID", async () => {
    const harness = await makeHarness();
    await harness.engine.start();
    void harness.coordinator.process([inbound()]);
    await Promise.resolve();

    const event = oneBotPrivateMessageEventSchema.parse(harness.transport.sent[0]);
    const target = await directory.requireTextTarget("example-contact", 1);
    const expected = deriveConversationTriggerId({
      contactId: target.contactId,
      contactRevision: target.revision,
      bindingHash: target.bindingHash,
      source: "native-ocr",
      sourceEpoch,
      sessionId: targetSessionId,
      sourceMessageIds: [inbound().messageId],
    });
    expect(event.message_id).toBe(expected);
    await harness.engine.stop();
    await harness.engine.close();
  });
});
