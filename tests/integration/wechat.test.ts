import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ChatMessage, ConversationId, IdentityEvidence } from "../../src/domain/types.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { StateRepository } from "../../src/storage/repositories.js";
import type { OCRLine } from "../../src/adapters/native-bridge.js";
import { parseVisibleWechatMessages } from "../../src/adapters/native-wechat-surface.js";
import {
  WeChatAdapter,
  type ConversationSnapshot,
  type IdentityProfile,
  type WeChatSurface,
} from "../../src/adapters/wechat.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}

  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

class FailOnceEncryptedStore extends EncryptedStore {
  private failure: { relativePath: string; remainingMatches: number } | null = null;

  public failWriteOnce(relativePath: string, matchNumber = 1): void {
    this.failure = { relativePath, remainingMatches: matchNumber };
  }

  public override write<T>(relativePath: string, value: T): Promise<void> {
    if (this.failure?.relativePath === relativePath) {
      this.failure.remainingMatches -= 1;
      if (this.failure.remainingMatches === 0) {
        this.failure = null;
        return Promise.reject(new Error(`INJECTED_WRITE_FAILURE:${relativePath}`));
      }
    }
    return super.write(relativePath, value);
  }
}

const identities: Record<ConversationId, IdentityProfile> = {
  "example-contact": {
    visibleName: "示例联系人",
    avatarFingerprint: "avatar-feng-v1",
    recentMessageFingerprint: "recent-feng-v1",
  },
  "file-transfer": {
    visibleName: "文件传输助手",
    avatarFingerprint: "avatar-file-transfer-v1",
    recentMessageFingerprint: "recent-file-transfer-v1",
  },
};

function chatMessage(
  id: string,
  text: string,
  direction: ChatMessage["direction"] = "incoming",
  conversationId: ConversationId = "example-contact",
): ChatMessage {
  return {
    id,
    conversationId,
    direction,
    kind: "text",
    text,
    occurredAt: "2026-08-19T01:00:00.000Z",
    source: "wechat",
    confidence: 0.99,
  };
}

function ocrLine(text: string, y: number): OCRLine {
  return {
    text,
    confidence: 1,
    bounds: { x: 0.76, y, width: 0.08, height: 0.02 },
  };
}

function snapshot(
  conversationId: ConversationId,
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  const profile = identities[conversationId];
  const draftText = overrides.draftText ?? "";
  const identity: IdentityEvidence = {
    conversationId,
    visibleName: profile.visibleName,
    avatarFingerprint: profile.avatarFingerprint,
    recentMessageFingerprint: profile.recentMessageFingerprint,
    confidence: 0.99,
  };
  return {
    conversationId,
    identity,
    messages: [],
    draftText,
    composerEvidence:
      overrides.composerEvidence ??
      (draftText.length === 0 ? "proven-empty" : "meaningful-content"),
    unreadIndicator: null,
    windowRevision: "window-v1",
    ...overrides,
  };
}

class FakeWeChatSurface implements WeChatSurface {
  public targetReadCount = 0;
  public fileTransferReadCount = 0;
  public submitCount = 0;
  public clearCount = 0;
  public replaceCount = 0;
  public clearError: Error | null = null;
  public appendSubmittedMessage = true;
  public controlBoundaryMessage: ChatMessage | null = null;
  private readonly queues = new Map<ConversationId, ConversationSnapshot[]>();
  private readonly drafts = new Map<ConversationId, string>();

  public setSnapshots(id: ConversationId, values: ConversationSnapshot[]): void {
    const withBoundary = id === "file-transfer" && this.controlBoundaryMessage !== null
      ? values.map((value) => ({
          ...value,
          messages: value.messages.some((message) =>
            message.id === this.controlBoundaryMessage?.id
          )
            ? value.messages
            : [this.controlBoundaryMessage as ChatMessage, ...value.messages],
        }))
      : values;
    this.queues.set(id, [...withBoundary]);
  }

  public setRawSnapshots(id: ConversationId, values: ConversationSnapshot[]): void {
    this.queues.set(id, [...values]);
  }

  public locateConversation(id: ConversationId): Promise<ConversationSnapshot> {
    if (id === "example-contact") this.targetReadCount += 1;
    if (id === "file-transfer") this.fileTransferReadCount += 1;
    const queue = this.queues.get(id);
    if (queue === undefined || queue.length === 0) {
      return Promise.reject(new Error("FAKE_SNAPSHOT_MISSING"));
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) return Promise.reject(new Error("FAKE_SNAPSHOT_MISSING"));
    return Promise.resolve({
      ...next,
      draftText: this.drafts.get(id) ?? next.draftText,
      messages: [...next.messages],
    });
  }

  public focusConversation(): Promise<void> {
    return Promise.resolve();
  }

  public replaceDraft(id: ConversationId, text: string): Promise<void> {
    this.replaceCount += 1;
    this.drafts.set(id, text);
    return Promise.resolve();
  }

  public clearDraft(id: ConversationId): Promise<void> {
    this.clearCount += 1;
    if (this.clearError !== null) return Promise.reject(this.clearError);
    this.drafts.set(id, "");
    return Promise.resolve();
  }

  public submitDraft(id: ConversationId): Promise<void> {
    this.submitCount += 1;
    if (this.appendSubmittedMessage) {
      const queue = this.queues.get(id);
      const current = queue?.at(-1);
      if (current !== undefined) {
        current.messages.push(
          chatMessage(`sent-${this.submitCount}`, this.drafts.get(id) ?? "", "outgoing", id),
        );
      }
    }
    this.drafts.set(id, "");
    return Promise.resolve();
  }
}

describe("WeChatAdapter", () => {
  let rootDir: string;
  let store: FailOnceEncryptedStore;
  let state: StateRepository;
  let surface: FakeWeChatSurface;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "chat-wechat-adapter-"));
    store = new FailOnceEncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32)));
    state = new StateRepository(
      store,
      () => new Date("2026-08-19T01:00:00.000Z"),
    );
    surface = new FakeWeChatSurface();
    const issued = await state.issueControlBoundary();
    await state.activateControlBoundary({
      expectedEpoch: issued.epoch,
      boundaryMessageId: issued.boundaryMessageId,
      markerOccurrenceCount: 1,
    });
    surface.controlBoundaryMessage = chatMessage(
      issued.boundaryMessageId,
      issued.markerText,
      "outgoing",
      "file-transfer",
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("reads only after name, avatar, recent message and confidence all match", async () => {
    surface.setSnapshots("example-contact", [
      snapshot("example-contact", { messages: [chatMessage("m1", "今天夜班")] }),
    ]);
    const adapter = new WeChatAdapter(surface, state, identities);

    await expect(adapter.readConversation("example-contact")).resolves.toMatchObject({
      messages: [{ id: "m1" }],
    });

    surface.setSnapshots("example-contact", [
      snapshot("example-contact", {
        identity: {
          ...snapshot("example-contact").identity,
          avatarFingerprint: "same-name-wrong-avatar",
        },
      }),
    ]);
    await expect(adapter.readConversation("example-contact")).rejects.toThrow(
      "IDENTITY_VERIFICATION_FAILED",
    );

    surface.setSnapshots("example-contact", [
      snapshot("example-contact", {
        identity: { ...snapshot("example-contact").identity, confidence: 0.94 },
      }),
    ]);
    await expect(adapter.readConversation("example-contact")).rejects.toThrow(
      "IDENTITY_VERIFICATION_FAILED",
    );
  });

  test("accepts the Native unique-title identity fingerprint bound to the live window", async () => {
    const nativeIdentityFingerprint = "ab".repeat(32);
    surface.setSnapshots("example-contact", [
      snapshot("example-contact", {
        identity: {
          ...snapshot("example-contact").identity,
          avatarFingerprint: nativeIdentityFingerprint,
          recentMessageFingerprint: nativeIdentityFingerprint,
        },
        messages: [chatMessage("m-native", "给你发消息吗")],
      }),
    ]);
    const adapter = new WeChatAdapter(surface, state, identities);

    await expect(adapter.readConversation("example-contact")).resolves.toMatchObject({
      messages: [{ id: "m-native" }],
    });
  });

  test("rejects a runtime conversation id outside the two-item allowlist", async () => {
    const adapter = new WeChatAdapter(surface, state, identities);

    await expect(adapter.readConversation("other-contact" as ConversationId)).rejects.toThrow(
      "CONVERSATION_NOT_ALLOWED",
    );
  });

  test("persists a stop command, clears the target draft and avoids reading the target", async () => {
    const control = snapshot("file-transfer", {
      messages: [chatMessage("control-1", "停止继续生成", "incoming", "file-transfer")],
    });
    surface.setSnapshots("file-transfer", [control]);
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);
    const adapter = new WeChatAdapter(surface, state, identities);

    await expect(adapter.readControlCommand()).resolves.toEqual({
      command: "stop",
      messageId: "control-1",
    });
    await expect(state.getControlState()).resolves.toMatchObject({ stopped: true });
    await expect(adapter.readConversation("example-contact")).rejects.toThrow("SYSTEM_STOPPED");
    expect(surface.targetReadCount).toBe(1);
    expect(surface.clearCount).toBe(1);

    const restartedAdapter = new WeChatAdapter(surface, state, identities);
    await expect(restartedAdapter.readControlCommand()).resolves.toBeNull();
  });

  test("returns the control result and its validated snapshot from one file-transfer read", async () => {
    surface.setSnapshots("file-transfer", [
      snapshot("file-transfer", {
        messages: [chatMessage("control-combined", "停止继续生成", "incoming", "file-transfer")],
      }),
    ]);
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);
    const adapter = new WeChatAdapter(surface, state, identities);

    const result = await adapter.readControlConversation();

    expect(result.control).toEqual({ command: "stop", messageId: "control-combined" });
    expect(result.snapshot).toMatchObject({
      conversationId: "file-transfer",
    });
    expect(result.snapshot.messages.some((message) => message.id === "control-combined"))
      .toBe(true);
    expect(surface.fileTransferReadCount).toBe(1);
    expect(surface.targetReadCount).toBe(1);
  });

  test.each(["missing-boundary", "duplicate-boundary", "broken-prefix"] as const)(
    "rejects a restarted protocol-v2 snapshot with %s without checkpoint movement",
    async (scenario) => {
      const prefix = await activateAndConsumeControlPrefix();
      const checkpointBefore = (await state.getControlState()).controlBoundary;
      const lines = scenario === "missing-boundary"
        ? [ocrLine("anchor", 0.78), ocrLine("M", 0.68), ocrLine("ordinary", 0.58)]
        : scenario === "duplicate-boundary"
          ? [
              ocrLine(prefix.issued.markerText, 0.82),
              ocrLine(prefix.issued.markerText, 0.78),
              ocrLine("anchor", 0.68),
              ocrLine("M", 0.58),
            ]
          : [
              ocrLine(prefix.issued.markerText, 0.78),
              ocrLine("anchor", 0.68),
              ocrLine("changed-M", 0.58),
            ];
      const restartedState = new StateRepository(
        store,
        () => new Date("2026-08-19T01:00:00.000Z"),
      );
      surface.setRawSnapshots("file-transfer", [snapshot("file-transfer", {
        messages: parseVisibleWechatMessages(
          lines,
          "file-transfer",
          new Date("2026-08-23T01:00:00.000Z"),
        ),
      })]);

      await expect(
        new WeChatAdapter(surface, restartedState, identities).readControlConversation(),
      ).rejects.toThrow("CONTROL_BOUNDARY_AMBIGUOUS");

      expect((await restartedState.getControlState()).controlBoundary)
        .toEqual(checkpointBefore);
    },
  );

  test("fail-safe persists a visible STOP on an ambiguous snapshot without checkpoint movement", async () => {
    await activateAndConsumeControlPrefix();
    const checkpointBefore = (await state.getControlState()).controlBoundary;
    surface.setRawSnapshots("file-transfer", [snapshot("file-transfer", {
      messages: parseVisibleWechatMessages([
        ocrLine("停止继续生成", 0.78),
        ocrLine("anchor", 0.68),
        ocrLine("M", 0.58),
      ], "file-transfer", new Date("2026-08-23T01:00:00.000Z")),
    })]);
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlConversation(),
    ).rejects.toThrow("CONTROL_BOUNDARY_AMBIGUOUS");

    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
    });
    expect((await state.getControlState()).controlBoundary).toEqual(checkpointBefore);
    expect(surface.clearCount).toBe(1);
  });

  test("gives trusted STOP priority over legacy confirmation text and advances the chain", async () => {
    const prefix = await activateAndConsumeControlPrefix();
    const messages = parseVisibleWechatMessages([
      ocrLine(prefix.issued.markerText, 0.82),
      ocrLine("anchor", 0.74),
      ocrLine("M", 0.66),
      ocrLine("停止继续生成", 0.58),
      ocrLine("确认上一条已发送 0000000000000000", 0.50),
    ], "file-transfer", new Date("2026-08-23T01:00:00.000Z"));
    surface.setSnapshots("file-transfer", [snapshot("file-transfer", { messages })]);
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlConversation(),
    ).resolves.toMatchObject({ control: { command: "stop" } });

    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
      controlBoundary: {
        status: "active",
        consumedCount: 4,
      },
    });
  });

  test("migrates a legacy uncertain stop and drops its obsolete approval", async () => {
    const fingerprint = "a".repeat(64);
    const confirmationCode = "c".repeat(16);
    await store.write("state/control.enc", {
      stopped: true,
      stopReason: "SEND_RESULT_UNCERTAIN",
      updatedAt: "2026-08-19T01:00:00.000Z",
      controlCursor: "legacy-M",
      outgoing: {
        [fingerprint]: { status: "uncertain", updatedAt: "2026-08-19T01:00:00.000Z" },
      },
      sendReconciliationApproval: {
        candidateId: "b".repeat(64),
        fingerprint,
        confirmationCode,
        approvedAt: null,
        controlMessageIdHash: null,
      },
    });
    state = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    surface.setRawSnapshots("file-transfer", [snapshot("file-transfer", {
      messages: parseVisibleWechatMessages([
        ocrLine("legacy-M", 0.68),
        ocrLine(`确认上一条已发送 ${confirmationCode}`, 0.58),
      ], "file-transfer", new Date("2026-08-23T01:00:00.000Z")),
    })]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlConversation(),
    ).rejects.toThrow("CONTROL_BOUNDARY_REQUIRED");
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
      controlBoundary: { status: "awaiting-boundary" },
    });
    expect(await state.getControlState()).not.toHaveProperty("sendReconciliationApproval");
  });

  test("preserves repeated native STOP positions after the boundary and applies one stop", async () => {
    const messages = parseVisibleWechatMessages([
      ocrLine("停止继续生成", 0.78),
      ocrLine("继续生成", 0.68),
      ocrLine("停止继续生成", 0.58),
    ], "file-transfer", new Date("2026-08-21T09:00:00.000Z"));
    surface.setSnapshots("file-transfer", [snapshot("file-transfer", { messages })]);
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlConversation(),
    ).resolves.toMatchObject({ control: { command: "stop" } });

    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
      controlBoundary: { consumedCount: 3 },
    });
    expect(surface.clearCount).toBe(1);
    expect(surface.submitCount).toBe(0);
    expect(surface.replaceCount).toBe(0);
  });

  test("chains repeated STOP ids by position instead of treating content ids as cursors", async () => {
    const messages = parseVisibleWechatMessages([
      ocrLine("停止继续生成", 0.78),
      ocrLine("继续生成", 0.68),
      ocrLine("停止继续生成", 0.58),
    ], "file-transfer", new Date("2026-08-21T09:00:00.000Z"));
    surface.setSnapshots("file-transfer", [snapshot("file-transfer", { messages })]);
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlConversation(),
    ).resolves.toMatchObject({ control: { command: "stop" } });

    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
      controlBoundary: { consumedCount: 3 },
    });
    expect(surface.clearCount).toBe(1);
  });

  test.each(["stop-first", "stop-last"] as const)(
    "gives STOP priority over legacy confirmation text when it is $0",
    async (order) => {
      const stop = chatMessage("stop-control", "停止继续生成", "outgoing", "file-transfer");
      const confirm = chatMessage(
        "confirm-control",
        "确认上一条已发送 0000000000000000",
        "outgoing",
        "file-transfer",
      );
      const messages = order === "stop-first" ? [stop, confirm] : [confirm, stop];
      surface.setSnapshots("file-transfer", [snapshot("file-transfer", { messages })]);
      surface.setSnapshots("example-contact", [snapshot("example-contact")]);

      await expect(
        new WeChatAdapter(surface, state, identities).readControlConversation(),
      ).resolves.toMatchObject({ control: { command: "stop", messageId: stop.id } });
      await expect(state.getControlState()).resolves.toMatchObject({
        stopped: true,
        stopReason: "user-command",
        controlBoundary: { consumedCount: 2 },
      });
      expect(surface.clearCount).toBe(1);
    },
  );

  test.each(["stop-first", "stop-last"] as const)(
    "gives STOP priority over RESUME when it is $0",
    async (order) => {
      const stop = chatMessage("stop-control", "停止继续生成", "incoming", "file-transfer");
      const resume = chatMessage("resume-control", "继续生成", "incoming", "file-transfer");
      const messages = order === "stop-first" ? [stop, resume] : [resume, stop];
      surface.setSnapshots("file-transfer", [snapshot("file-transfer", { messages })]);
      surface.setSnapshots("example-contact", [snapshot("example-contact")]);

      await expect(
        new WeChatAdapter(surface, state, identities).readControlConversation(),
      ).resolves.toMatchObject({ control: { command: "stop", messageId: stop.id } });
      await expect(state.getControlState()).resolves.toMatchObject({
        stopped: true,
        stopReason: "user-command",
        controlBoundary: { consumedCount: 2 },
      });
      expect(surface.clearCount).toBe(1);
    },
  );

  test("consumes repeated RESUME ids by position inside a trusted boundary", async () => {
    const messages = parseVisibleWechatMessages([
      ocrLine("继续生成", 0.78),
      ocrLine("继续生成", 0.58),
    ], "file-transfer", new Date("2026-08-21T09:00:00.000Z"));
    await state.setStopped("user-command");
    surface.setSnapshots("file-transfer", [snapshot("file-transfer", { messages })]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlConversation(),
    ).resolves.toMatchObject({ control: { command: "resume" } });
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
      controlBoundary: { consumedCount: 2 },
    });
  });

  test("consumes repeated legacy confirmation text as ordinary control content", async () => {
    const text = "确认上一条已发送 0000000000000000";
    const messages = parseVisibleWechatMessages([
      ocrLine(text, 0.78),
      ocrLine(text, 0.58),
    ], "file-transfer", new Date("2026-08-21T09:00:00.000Z"));
    surface.setSnapshots("file-transfer", [snapshot("file-transfer", { messages })]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlConversation(),
    ).resolves.toMatchObject({ control: null });
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
      controlBoundary: { consumedCount: 2 },
    });
  });

  test("does not advance STOP cursor until the cleared composer is proven empty", async () => {
    const stop = chatMessage("stop-control", "停止继续生成", "outgoing", "file-transfer");
    surface.setSnapshots("file-transfer", [
      snapshot("file-transfer", { messages: [stop] }),
    ]);
    surface.setSnapshots("example-contact", [
      snapshot("example-contact", { composerEvidence: "ambiguous" }),
      snapshot("example-contact"),
    ]);
    const adapter = new WeChatAdapter(surface, state, identities);
    const before = await state.getControlBoundaryCheckpoint();

    await expect(adapter.readControlConversation()).rejects.toThrow(
      "DRAFT_CLEAR_NOT_VERIFIED",
    );
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
      controlBoundary: before,
    });
    expect(surface.clearCount).toBe(1);

    await expect(adapter.readControlConversation()).resolves.toMatchObject({
      control: { command: "stop", messageId: stop.id },
    });
    await expect(state.getControlState()).resolves.toMatchObject({
      controlBoundary: { consumedCount: before.consumedCount + 1 },
    });
    expect(surface.clearCount).toBe(2);
    expect(surface.submitCount).toBe(0);
  });

  test("keeps STOP durable and retries an idempotent clear when cursor persistence fails", async () => {
    const stop = chatMessage("stop-control", "停止继续生成", "outgoing", "file-transfer");
    surface.setSnapshots("file-transfer", [
      snapshot("file-transfer", { messages: [stop] }),
    ]);
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);
    store.failWriteOnce("state/control.enc", 2);
    const adapter = new WeChatAdapter(surface, state, identities);
    const before = await state.getControlBoundaryCheckpoint();

    await expect(adapter.readControlConversation()).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:state/control.enc",
    );
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
      controlBoundary: before,
    });
    expect(surface.clearCount).toBe(1);

    await expect(adapter.readControlConversation()).resolves.toMatchObject({
      control: { command: "stop", messageId: stop.id },
    });
    await expect(state.getControlState()).resolves.toMatchObject({
      controlBoundary: { consumedCount: before.consumedCount + 1 },
    });
    expect(surface.clearCount).toBe(2);
    expect(surface.submitCount).toBe(0);
  });

  test("allows only an identity-validated target read for owner advice while manually stopped", async () => {
    await state.setStopped("user-command");
    surface.setSnapshots("example-contact", [
      snapshot("example-contact", { messages: [chatMessage("sent-recovery", "我在呢，你说", "outgoing")] }),
    ]);
    const adapter = new WeChatAdapter(surface, state, identities);

    await expect(adapter.readConversationForOwnerAdvice("example-contact")).resolves.toMatchObject({
      conversationId: "example-contact",
      messages: [{ id: "sent-recovery" }],
    });
    await expect(adapter.readConversationForOwnerAdvice("file-transfer")).rejects.toThrow(
      "OWNER_ADVICE_TARGET_NOT_ALLOWED",
    );

    surface.setSnapshots("example-contact", [
      snapshot("example-contact", {
        identity: {
          ...snapshot("example-contact").identity,
          avatarFingerprint: "wrong-avatar",
        },
      }),
    ]);
    await expect(adapter.readConversationForOwnerAdvice("example-contact")).rejects.toThrow(
      "IDENTITY_VERIFICATION_FAILED",
    );
  });

  test("resumes only when the exact resume command is received", async () => {
    await state.setStopped("user-command");
    surface.setSnapshots("file-transfer", [
      snapshot("file-transfer", {
        messages: [chatMessage("control-2", "继续生成", "incoming", "file-transfer")],
      }),
    ]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlCommand(),
    ).resolves.toEqual({ command: "resume", messageId: "control-2" });
    await expect(state.getControlState()).resolves.toMatchObject({ stopped: false });
  });

  test("accepts an exact self-authored control command in File Transfer Assistant", async () => {
    surface.setSnapshots("file-transfer", [
      snapshot("file-transfer", {
        messages: [chatMessage("control-self", "停止继续生成", "outgoing", "file-transfer")],
      }),
    ]);
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);

    await expect(
      new WeChatAdapter(surface, state, identities).readControlCommand(),
    ).resolves.toEqual({ command: "stop", messageId: "control-self" });
    await expect(state.getControlState()).resolves.toMatchObject({ stopped: true });
  });

  test("sends once and marks the fingerprint verified only after a matching read-back", async () => {
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);
    const adapter = new WeChatAdapter(surface, state, identities);

    const result = await adapter.sendAndVerify("example-contact", "刚下班啊，辛苦了");

    expect(result).toMatchObject({ status: "verified" });
    expect(surface.submitCount).toBe(1);
    const controlState = await state.getControlState();
    expect(Object.values(controlState.outgoing)).toEqual([
      expect.objectContaining({ status: "verified" }),
    ]);
  });

  test("clears the draft and terminates only that attempt if the window changes", async () => {
    surface.setSnapshots("example-contact", [
      snapshot("example-contact", { windowRevision: "window-v1" }),
      snapshot("example-contact", { windowRevision: "window-v2" }),
    ]);
    const adapter = new WeChatAdapter(surface, state, identities);

    await expect(adapter.sendAndVerify("example-contact", "测试消息")).resolves.toMatchObject({
      status: "uncertain",
      reason: "WINDOW_CHANGED_BEFORE_SEND",
    });
    expect(surface.clearCount).toBe(1);
    expect(surface.submitCount).toBe(0);
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
    });
  });

  test("does not retry an uncertain fingerprint but allows a later different reply", async () => {
    surface.appendSubmittedMessage = false;
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);
    const adapter = new WeChatAdapter(surface, state, identities);

    await expect(adapter.sendAndVerify("example-contact", "只发一次")).resolves.toMatchObject({
      status: "uncertain",
      reason: "SEND_RESULT_NOT_VERIFIED",
    });
    expect(surface.submitCount).toBe(1);
    await expect(adapter.sendAndVerify("example-contact", "只发一次")).resolves.toMatchObject({
      status: "duplicate",
    });
    surface.appendSubmittedMessage = true;
    await expect(adapter.sendAndVerify("example-contact", "后续新消息")).resolves.toMatchObject({
      status: "verified",
    });
    expect(surface.submitCount).toBe(2);
  });

  test("does not write an automatic global stop after one uncertain adapter send", async () => {
    surface.appendSubmittedMessage = false;
    surface.setSnapshots("example-contact", [snapshot("example-contact")]);
    store.failWriteOnce("state/control.enc", 3);
    const adapter = new WeChatAdapter(surface, state, identities);

    await expect(adapter.sendAndVerify("example-contact", "只结束这一次"))
      .resolves.toMatchObject({ status: "uncertain" });
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
    });
  });

  test("does not overwrite a nonempty composer", async () => {
    surface.setSnapshots("example-contact", [snapshot("example-contact", { draftText: "用户正在输入" })]);

    await expect(
      new WeChatAdapter(surface, state, identities).sendAndVerify("example-contact", "助手回复"),
    ).rejects.toThrow("INPUT_NOT_EMPTY");
    expect(surface.submitCount).toBe(0);
  });

  async function activateAndConsumeControlPrefix(): Promise<{
    issued: Awaited<ReturnType<StateRepository["issueControlBoundary"]>>;
  }> {
    const issued = await state.issueControlBoundary();
    const adapter = new WeChatAdapter(surface, state, identities);
    surface.setSnapshots("file-transfer", [snapshot("file-transfer", {
      messages: parseVisibleWechatMessages([
        ocrLine(issued.markerText, 0.78),
      ], "file-transfer", new Date("2026-08-23T01:00:00.000Z")),
    })]);
    await adapter.readControlConversation();
    surface.setSnapshots("file-transfer", [snapshot("file-transfer", {
      messages: parseVisibleWechatMessages([
        ocrLine(issued.markerText, 0.78),
        ocrLine("anchor", 0.68),
        ocrLine("M", 0.58),
      ], "file-transfer", new Date("2026-08-23T01:00:01.000Z")),
    })]);
    await adapter.readControlConversation();
    return { issued };
  }
});
