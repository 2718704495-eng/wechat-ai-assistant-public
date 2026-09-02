import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OCRLine } from "../../src/adapters/native-bridge.js";
import { parseVisibleWechatMessages } from "../../src/adapters/native-wechat-surface.js";
import type { NativeAuthorizedConversationSnapshot } from "../../src/adapters/native-wechat-surface.js";
import type {
  ConversationSnapshot,
  WeChatSurface,
} from "../../src/adapters/wechat.js";
import type { ConversationId } from "../../src/domain/types.js";
import {
  acquireLiveOperationCoordinator,
  type LiveOperationCoordinator,
} from "../../src/mcp/live-operation-coordinator.js";
import {
  createLiveWechatDependencies,
  createMcpContactReplyDelivery,
} from "../../src/mcp/live-runtime.js";
import {
  closeSharedLiveProductionRuntime,
  createSharedLiveProductionRuntime,
  type SharedLiveProductionRuntime,
} from "../../src/mcp/live-bootstrap.js";
import { createProductionScheduledRuntime } from "../../src/runtime-v2/single-scheduler.js";
import {
  ContactDirectory,
  type AuthorizedWechatTarget,
} from "../../src/contacts/contact-directory.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import { WechatIdentityEnrollmentRepository } from "../../src/storage/wechat-identity-enrollment-repository.js";
import {
  deriveConversationTriggerId,
  deriveReplyDeliveryKey,
  type ReplyIntent,
} from "../../src/conversation/personal-account-contract.js";
import {
  RealtimeReplyService,
  type ContactReplyDelivery,
  type PreparedReplyClaim,
} from "../../src/conversation/realtime-reply-service.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { ComfortStationDeliveryRepository } from "../../src/storage/comfort-station-delivery-repository.js";
import {
  AbortIntentRepository,
  AuditRepository,
  MessageRepository,
  PendingSendRepository,
  InMemoryRealtimeReplyRepository,
  StateRepository,
} from "../../src/storage/repositories.js";
import type { ZodType } from "zod";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

class FailOnceEncryptedStore extends EncryptedStore {
  private failure: { relativePath: string; remainingMatches: number } | null =
    null;

  public failWriteOnce(relativePath: string, matchNumber = 1): void {
    this.failure = { relativePath, remainingMatches: matchNumber };
  }

  public override write<T>(relativePath: string, value: T): Promise<void> {
    if (this.failure?.relativePath === relativePath) {
      this.failure.remainingMatches -= 1;
      if (this.failure.remainingMatches === 0) {
        this.failure = null;
        return Promise.reject(
          new Error(`INJECTED_WRITE_FAILURE:${relativePath}`),
        );
      }
    }
    return super.write(relativePath, value);
  }
}

class ReadinessBarrierEncryptedStore extends EncryptedStore {
  public readonly abortRead = deferred();
  public readonly allowPendingRead = deferred();
  private armed = false;

  public arm(): void {
    this.armed = true;
  }

  public override async read<T>(
    relativePath: string,
    schema: ZodType<T>,
  ): Promise<T | null> {
    if (this.armed && relativePath === "state/pending-send.enc") {
      await this.allowPendingRead.promise;
    }
    const value = await super.read(relativePath, schema);
    if (this.armed && relativePath === "state/abort-intent.enc") {
      this.abortRead.resolve();
    }
    return value;
  }
}

class AfterAbortReadBarrierEncryptedStore extends EncryptedStore {
  public readonly abortRead = deferred();
  public readonly continueAfterAbortRead = deferred();
  private armed = true;

  public override async read<T>(
    relativePath: string,
    schema: ZodType<T>,
  ): Promise<T | null> {
    const value = await super.read(relativePath, schema);
    if (this.armed && relativePath === "state/abort-intent.enc") {
      this.armed = false;
      this.abortRead.resolve();
      await this.continueAfterAbortRead.promise;
    }
    return value;
  }
}

class CountingEncryptedStore extends EncryptedStore {
  public abortIntentReadCount = 0;

  public override read<T>(
    relativePath: string,
    schema: ZodType<T>,
  ): Promise<T | null> {
    if (relativePath === "state/abort-intent.enc") {
      this.abortIntentReadCount += 1;
    }
    return super.read(relativePath, schema);
  }
}

class FakeLiveWechat implements WeChatSurface {
  public submitCount = 0;
  public replaceCount = 0;
  public clearCount = 0;
  public focusCount = 0;
  public locateCount = 0;
  public readonly locatedConversationIds: ConversationId[] = [];
  public focusError: Error | null = null;
  public draftAlternatives: string[] | undefined;
  public composerEvidence: "proven-empty" | "meaningful-content" | "ambiguous" =
    "proven-empty";
  public unreadIndicator: boolean | null = null;
  public failLocateAtCount: number | null = null;
  public onLocate: ((id: ConversationId) => Promise<void>) | null = null;
  public submitFailure: "before-effect" | "after-effect" | null = null;
  public comfortStationSendCount = 0;
  public comfortStationSendError: Error | null = null;
  private active: ConversationId = "file-transfer";
  private readonly drafts = new Map<ConversationId, string>();
  private readonly messages = new Map<
    ConversationId,
    ConversationSnapshot["messages"]
  >();

  public constructor() {
    this.messages.set("file-transfer", []);
    this.messages.set("example-contact", []);
  }

  public async locateConversation(
    id: ConversationId,
  ): Promise<ConversationSnapshot> {
    this.locateCount += 1;
    this.locatedConversationIds.push(id);
    if (this.failLocateAtCount === this.locateCount) {
      this.failLocateAtCount = null;
      throw new Error("INJECTED_LOCATE_FAILURE");
    }
    const onLocate = this.onLocate;
    this.onLocate = null;
    if (onLocate !== null) await onLocate(id);
    this.active = id;
    return {
      conversationId: id,
      identity: {
        conversationId: id,
        visibleName: id === "example-contact" ? "示例联系人" : "文件传输助手",
        avatarFingerprint: id,
        recentMessageFingerprint: id,
        confidence: 0.99,
      },
      messages: [...(this.messages.get(id) ?? [])],
      draftText: this.drafts.get(id) ?? "",
      draftAlternatives: this.draftAlternatives,
      composerEvidence: this.composerEvidence,
      unreadIndicator: this.unreadIndicator,
      windowRevision: `window-${id}`,
    };
  }

  public focusConversation(id: ConversationId): Promise<void> {
    this.active = id;
    this.focusCount += 1;
    return this.focusError === null
      ? Promise.resolve()
      : Promise.reject(this.focusError);
  }

  public replaceDraft(id: ConversationId, text: string): Promise<void> {
    this.active = id;
    this.replaceCount += 1;
    this.drafts.set(id, text);
    return Promise.resolve();
  }

  public clearDraft(id: ConversationId): Promise<void> {
    this.clearCount += 1;
    this.drafts.set(id, "");
    this.composerEvidence = "proven-empty";
    return Promise.resolve();
  }

  public submitDraft(): Promise<void> {
    this.submitCount += 1;
    if (this.submitFailure === "before-effect") {
      this.submitFailure = null;
      return Promise.reject(new Error("INJECTED_SUBMIT_FAILURE"));
    }
    this.externalReturn();
    if (this.submitFailure === "after-effect") {
      this.submitFailure = null;
      return Promise.reject(new Error("INJECTED_SUBMIT_FAILURE"));
    }
    return Promise.resolve();
  }

  public sendComfortStationCard(): Promise<{
    imageSha256: string;
    outgoingImageMatched: true;
    submitted: true;
    visualFingerprintVersion: "vision-featureprint-v1";
  }> {
    this.comfortStationSendCount += 1;
    if (this.comfortStationSendError !== null) {
      return Promise.reject(this.comfortStationSendError);
    }
    return Promise.resolve({
      imageSha256:
        "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177",
      outgoingImageMatched: true,
      submitted: true,
      visualFingerprintVersion: "vision-featureprint-v1",
    });
  }

  public draftFor(id: ConversationId): string {
    return this.drafts.get(id) ?? "";
  }

  public externalReturn(): void {
    const text = this.drafts.get(this.active) ?? "";
    this.drafts.set(this.active, "");
    this.composerEvidence = "proven-empty";
    this.messages.get(this.active)?.push({
      id:
        this.active === "file-transfer"
          ? createHash("sha256")
              .update(`file-transfer\0outgoing\0${text}`)
              .digest("hex")
          : `sent-${this.active}-${text}`,
      conversationId: this.active,
      direction: "outgoing",
      kind: "text",
      text,
      occurredAt: "2026-08-19T02:00:00.000Z",
      source: "wechat",
      confidence: 0.99,
    });
  }

  public externalType(text: string): void {
    this.drafts.set(this.active, text);
    this.composerEvidence =
      text.length === 0 ? "proven-empty" : "meaningful-content";
  }

  public replaceMessages(
    id: ConversationId,
    messages: ConversationSnapshot["messages"],
  ): void {
    this.messages.set(id, [...messages]);
  }
}

describe("live WeChat runtime", () => {
  let rootDir: string;
  let store: FailOnceEncryptedStore;
  let state: StateRepository;
  let pending: PendingSendRepository;
  let aborts: AbortIntentRepository;
  let audit: AuditRepository;
  let surface: FakeLiveWechat;
  let coordinator: LiveOperationCoordinator;
  let encryptionKey: Buffer;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "chat-live-runtime-"));
    await initializeTestKernelLockCatalog(rootDir);
    encryptionKey = randomBytes(32);
    coordinator = await acquireLiveOperationCoordinator({
      dataDir: rootDir,
      ownerKind: "mcp",
    });
    store = new FailOnceEncryptedStore(
      rootDir,
      new FixedKeyProvider(encryptionKey),
    );
    state = new StateRepository(
      store,
      () => new Date("2026-08-19T02:00:00.000Z"),
    );
    await activateControlBoundary(state);
    pending = new PendingSendRepository(store);
    aborts = new AbortIntentRepository(store);
    audit = new AuditRepository(
      store,
      () => new Date("2026-08-19T02:00:00.000Z"),
    );
    surface = new FakeLiveWechat();
  });

  afterEach(async () => {
    await coordinator.close();
    await makeTreeWritable(rootDir);
    await rm(rootDir, { recursive: true, force: true });
  });

  it("prepares a self-notification without submitting and verifies only after external Return", async () => {
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("file-transfer", "连接测试");
    expect(prepared.candidateToken).toHaveLength(64);
    expect(surface.submitCount).toBe(0);
    await expect(runtime.verifySend(prepared.candidateToken)).rejects.toThrow(
      "DRAFT_NOT_VERIFIED",
    );
    surface.externalType("连接测试");
    await expect(
      runtime.verifyDraft(prepared.candidateToken),
    ).resolves.toMatchObject({
      draftVerified: true,
      readyForComputerUseReturn: true,
    });
    surface.externalReturn();
    await expect(
      runtime.verifySend(prepared.candidateToken),
    ).resolves.toMatchObject({ status: "verified" });
    expect(surface.submitCount).toBe(0);
  });

  it("terminally blocks retry when an exact comfort-station image result is uncertain", async () => {
    await approveTargetGate();
    const runtime = createRuntime() as ReturnType<typeof createRuntime> & {
      showComfortStationCardForSupervisor(
        controlProof: unknown,
        targetProof: unknown,
      ): Promise<{
        status: "verified" | "already-handled";
        conversationId: "example-contact";
      }>;
    };
    await establishBaselineThenNewIncoming(runtime);
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("旧消息", 0.43, 0.76), ocrLine("示例用户", 0.43, 0.66)],
        "example-contact",
        new Date("2026-08-23T02:01:00.000Z"),
      ),
    );
    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);
    expect(target.proof).not.toBeNull();

    surface.comfortStationSendError = new Error(
      "INJECTED_IMAGE_SEND_UNCERTAIN",
    );
    await expect(
      runtime.showComfortStationCardForSupervisor(control.proof, target.proof),
    ).rejects.toThrow("INJECTED_IMAGE_SEND_UNCERTAIN");
    await expect(
      runtime.showComfortStationCardForSupervisor(control.proof, target.proof),
    ).resolves.toEqual({
      status: "already-handled",
      conversationId: "example-contact",
    });
    expect(surface.comfortStationSendCount).toBe(1);
  });

  it("verifies one exact comfort-station card and consumes its target trigger", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("旧消息", 0.43, 0.76), ocrLine("示例用户。", 0.43, 0.66)],
        "example-contact",
        new Date("2026-08-23T02:01:00.000Z"),
      ),
    );
    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);
    if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");

    await expect(
      runtime.showComfortStationCardForSupervisor(control.proof, target.proof),
    ).resolves.toEqual({ status: "verified", conversationId: "example-contact" });
    expect(surface.comfortStationSendCount).toBe(1);
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      pendingTrigger: null,
    });
  });

  it("keeps a named concrete question in the normal P1 reply lane", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine("旧消息", 0.43, 0.76),
          ocrLine("示例用户，胃不舒服怎么办", 0.43, 0.66),
        ],
        "example-contact",
        new Date("2026-08-23T02:01:00.000Z"),
      ),
    );

    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);

    expect(target.proof).not.toBeNull();
    expect(target.publicResult).toMatchObject({
      comfortStation: { requested: false },
    });
    expect(surface.comfortStationSendCount).toBe(0);
  });

  it("durably claims the comfort-station delivery before the send path can touch WeChat", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("旧消息", 0.43, 0.76), ocrLine("示例用户", 0.43, 0.66)],
        "example-contact",
        new Date("2026-08-23T02:01:00.000Z"),
      ),
    );
    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);
    if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");
    const cardSha256 =
      "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177";
    const deliveryKey = createHash("sha256")
      .update(
        [
          "comfort-station-delivery-v1",
          "example-contact",
          target.proof.trigger.triggerMessageId,
          cardSha256,
        ].join("\0"),
      )
      .digest("hex");
    const deliveryRepository = new ComfortStationDeliveryRepository(store);
    surface.onLocate = async () => {
      await expect(deliveryRepository.get(deliveryKey)).resolves.toMatchObject({
        status: "intent",
        cardSha256,
      });
    };

    await expect(
      runtime.showComfortStationCardForSupervisor(control.proof, target.proof),
    ).resolves.toEqual({ status: "verified", conversationId: "example-contact" });
    expect(surface.comfortStationSendCount).toBe(1);
  });

  it("proactively delivers one release-bound comfort-station acceptance card exactly once", async () => {
    const activationBindingSha256 = "b".repeat(64);
    await approveReleaseGate(activationBindingSha256);
    const runtime = createRuntime(
      coordinator,
      activationBindingSha256,
    ) as ReturnType<typeof createRuntime> & {
      showComfortStationCardForReleaseAcceptance(): Promise<{
        status: "verified" | "already-handled";
        conversationId: "example-contact";
      }>;
    };

    await expect(
      runtime.showComfortStationCardForReleaseAcceptance(),
    ).resolves.toEqual({
      status: "verified",
      conversationId: "example-contact",
    });
    await expect(
      runtime.showComfortStationCardForReleaseAcceptance(),
    ).resolves.toEqual({
      status: "already-handled",
      conversationId: "example-contact",
    });
    expect(surface.comfortStationSendCount).toBe(1);

    const nextActivationBindingSha256 = "d".repeat(64);
    await approveReleaseGate(nextActivationBindingSha256);
    const nextRuntime = createRuntime(
      coordinator,
      nextActivationBindingSha256,
    ) as typeof runtime;
    await expect(
      nextRuntime.showComfortStationCardForReleaseAcceptance(),
    ).resolves.toEqual({
      status: "verified",
      conversationId: "example-contact",
    });
    expect(surface.comfortStationSendCount).toBe(2);
  });

  it("never retries a release-bound comfort-station acceptance card after uncertainty", async () => {
    const activationBindingSha256 = "c".repeat(64);
    await approveReleaseGate(activationBindingSha256);
    const runtime = createRuntime(
      coordinator,
      activationBindingSha256,
    ) as ReturnType<typeof createRuntime> & {
      showComfortStationCardForReleaseAcceptance(): Promise<{
        status: "verified" | "already-handled";
        conversationId: "example-contact";
      }>;
    };
    surface.comfortStationSendError = new Error(
      "INJECTED_RELEASE_CARD_UNCERTAIN",
    );

    await expect(
      runtime.showComfortStationCardForReleaseAcceptance(),
    ).rejects.toThrow("INJECTED_RELEASE_CARD_UNCERTAIN");
    await expect(
      runtime.showComfortStationCardForReleaseAcceptance(),
    ).resolves.toEqual({
      status: "already-handled",
      conversationId: "example-contact",
    });
    expect(surface.comfortStationSendCount).toBe(1);
  });

  it("establishes an idempotent boundary only in File Transfer Assistant and returns no marker secret", async () => {
    await store.write("state/control.enc", {
      stopped: false,
      stopReason: null,
      updatedAt: null,
      controlCursor: null,
      outgoing: {},
      sendReconciliationApproval: null,
    });
    restartRepositories();
    const runtime = createRuntime();

    const first = await runtime.establishControlBoundaryForSupervisor();
    const serialized = JSON.stringify(first);

    expect(first).toMatchObject({
      status: "active",
      consumedCount: 0,
      markerOccurrenceCount: 1,
    });
    expect(first.epoch).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.boundaryMessageId).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.prefixChainHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(serialized).not.toContain("聊天助手控制边界");
    expect(first).not.toHaveProperty("nonce");
    expect(surface.submitCount).toBe(1);
    expect((await surface.locateConversation("example-contact")).messages).toEqual(
      [],
    );
    await expect(
      runtime.establishControlBoundaryForSupervisor(),
    ).resolves.toEqual(first);
    expect(surface.submitCount).toBe(1);
    expect(JSON.stringify(await audit.list())).not.toContain(
      "聊天助手控制边界",
    );
  });

  it("clears and proves an unsent boundary draft after pre-submit readback failure", async () => {
    await resetToLegacyControlState();
    const runtime = createRuntime();
    surface.failLocateAtCount = 2;

    await expect(
      runtime.establishControlBoundaryForSupervisor(),
    ).rejects.toThrow("INJECTED_LOCATE_FAILURE");

    expect(surface.submitCount).toBe(0);
    expect(surface.clearCount).toBe(1);
    expect(surface.draftFor("file-transfer")).toBe("");
    await expect(pending.get()).resolves.toBeNull();
    await expect(
      runtime.establishControlBoundaryForSupervisor(),
    ).resolves.toMatchObject({
      status: "active",
    });
    expect(surface.submitCount).toBe(1);
  });

  it("keeps a recoverable pending boundary after submit fails before visible evidence", async () => {
    await resetToLegacyControlState();
    const runtime = createRuntime();
    surface.submitFailure = "before-effect";

    await expect(
      runtime.establishControlBoundaryForSupervisor(),
    ).rejects.toThrow("INJECTED_SUBMIT_FAILURE");

    expect(surface.submitCount).toBe(1);
    await expect(pending.get()).resolves.toMatchObject({
      conversationId: "file-transfer",
    });
    await expect(
      runtime.establishControlBoundaryForSupervisor(),
    ).rejects.toThrow();
    expect(surface.submitCount).toBe(1);
  });

  it("recovers an already submitted boundary after readback failure without a second submit", async () => {
    await resetToLegacyControlState();
    const runtime = createRuntime();
    surface.failLocateAtCount = 3;

    await expect(
      runtime.establishControlBoundaryForSupervisor(),
    ).rejects.toThrow("INJECTED_LOCATE_FAILURE");
    expect(surface.submitCount).toBe(1);
    await expect(pending.get()).resolves.toMatchObject({
      conversationId: "file-transfer",
    });

    await expect(
      runtime.establishControlBoundaryForSupervisor(),
    ).resolves.toMatchObject({
      status: "active",
    });
    expect(surface.submitCount).toBe(1);
    await expect(pending.get()).resolves.toBeNull();
  });

  it("establishes the first encrypted target baseline without minting a reply", async () => {
    const incoming = parseVisibleWechatMessages(
      [ocrLine("第一次看到的旧消息", 0.43, 0.65)],
      "example-contact",
      new Date("2026-08-23T02:00:00.000Z"),
    );
    surface.replaceMessages("example-contact", incoming);
    surface.unreadIndicator = false;

    await expect(
      createRuntime().readConversation("example-contact"),
    ).resolves.toMatchObject({
      replyDecision: {
        action: "wait",
        triggerMessageId: null,
        reason: "BASELINE_ESTABLISHED_NO_SEND",
      },
    });
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      version: 2,
      baseline: {
        latestMessageId: incoming[0]?.id,
        latestDirection: "incoming",
        unreadIndicator: false,
      },
      pendingTrigger: null,
    });
  });

  it("does not remint a trigger from the same old red badge after restart", async () => {
    const incoming = parseVisibleWechatMessages(
      [ocrLine("重启前已经可见", 0.43, 0.65)],
      "example-contact",
      new Date("2026-08-23T02:00:00.000Z"),
    );
    surface.replaceMessages("example-contact", incoming);
    surface.unreadIndicator = true;
    await createRuntime().readConversation("example-contact");
    restartRepositories();

    await expect(
      createRuntime().readConversation("example-contact"),
    ).resolves.toMatchObject({
      replyDecision: {
        action: "wait",
        triggerMessageId: null,
        reason: "NO_NEW_INCOMING",
      },
    });
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      pendingTrigger: null,
    });
  });

  it("rotates the baseline epoch and sends nothing when target continuity is ambiguous", async () => {
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("上一屏最后一条", 0.43, 0.72)],
        "example-contact",
        new Date("2026-08-23T02:00:00.000Z"),
      ),
    );
    surface.unreadIndicator = false;
    const runtime = createRuntime();
    await runtime.readConversation("example-contact");
    const beforeEpoch = (await state.getTargetReplyState()).baseline?.epoch;
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("无法证明接续的新视口", 0.43, 0.62)],
        "example-contact",
        new Date("2026-08-23T02:01:00.000Z"),
      ),
    );
    surface.unreadIndicator = true;

    await expect(runtime.readConversation("example-contact")).resolves.toMatchObject(
      {
        replyDecision: {
          action: "wait",
          triggerMessageId: null,
          reason: "BASELINE_ESTABLISHED_NO_SEND",
        },
      },
    );
    const after = await state.getTargetReplyState();
    expect(after.baseline?.epoch).not.toBe(beforeEpoch);
    expect(after.pendingTrigger).toBeNull();
    expect(surface.submitCount).toBe(0);
  });

  it("mints one trigger for a provable unread false-to-true transition and never replays it after consume", async () => {
    const incoming = parseVisibleWechatMessages(
      [ocrLine("同一条仍是最新来信", 0.43, 0.65)],
      "example-contact",
      new Date("2026-08-23T02:00:00.000Z"),
    );
    surface.replaceMessages("example-contact", incoming);
    surface.unreadIndicator = false;
    await createRuntime().readConversation("example-contact");
    surface.unreadIndicator = true;

    await expect(
      createRuntime().readConversation("example-contact"),
    ).resolves.toMatchObject({
      replyDecision: {
        action: "reply-latest-incoming",
        triggerMessageId: incoming[0]?.id,
        reason: "LATEST_VISIBLE_INCOMING",
      },
    });
    const trigger = (await state.getTargetReplyState()).pendingTrigger;
    if (trigger === null) throw new Error("EXPECTED_PENDING_TRIGGER");
    await state.consumeTargetReplyTrigger(trigger.triggerId);
    restartRepositories();

    await expect(
      createRuntime().readConversation("example-contact"),
    ).resolves.toMatchObject({
      replyDecision: {
        action: "wait",
        triggerMessageId: null,
        reason: "NO_NEW_INCOMING",
      },
    });
  });

  it("replies only to a baseline-relative new latest incoming", async () => {
    const baseline = parseVisibleWechatMessages(
      [ocrLine("旧消息", 0.43, 0.72)],
      "example-contact",
      new Date("2026-08-23T02:00:00.000Z"),
    );
    surface.replaceMessages("example-contact", baseline);
    surface.unreadIndicator = false;
    await createRuntime().readConversation("example-contact");
    const next = parseVisibleWechatMessages(
      [ocrLine("旧消息", 0.43, 0.72), ocrLine("自然新来信", 0.43, 0.62)],
      "example-contact",
      new Date("2026-08-23T02:01:00.000Z"),
    );
    surface.replaceMessages("example-contact", next);

    await expect(
      createRuntime().readConversation("example-contact"),
    ).resolves.toMatchObject({
      replyDecision: {
        action: "reply-latest-incoming",
        triggerMessageId: next.at(-1)?.id,
        reason: "LATEST_VISIBLE_INCOMING",
      },
    });
  });

  it("lets a latest outgoing suppress an earlier newly added incoming", async () => {
    const baseline = parseVisibleWechatMessages(
      [ocrLine("旧消息", 0.43, 0.76)],
      "example-contact",
      new Date("2026-08-23T02:00:00.000Z"),
    );
    surface.replaceMessages("example-contact", baseline);
    surface.unreadIndicator = false;
    await createRuntime().readConversation("example-contact");
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine("旧消息", 0.43, 0.76),
          ocrLine("较早的新来信", 0.43, 0.66),
          ocrLine("主人已经回复", 0.76, 0.56),
        ],
        "example-contact",
        new Date("2026-08-23T02:01:00.000Z"),
      ),
    );

    await expect(
      createRuntime().readConversation("example-contact"),
    ).resolves.toMatchObject({
      replyDecision: {
        action: "wait",
        triggerMessageId: null,
        reason: "LATEST_VISIBLE_OUTGOING",
      },
    });
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      pendingTrigger: null,
    });
  });

  it("reads a persisted STOP before any direct-heartbeat WeChat UI operation", async () => {
    await state.setStopped("user-command");
    const runtime = createRuntime();
    const locateBefore = surface.locateCount;

    await expect(
      runtime.readTargetDirectForSupervisor(),
    ).resolves.toMatchObject({
      publicResult: {
        stopped: true,
        stopReason: "user-command",
        replyDecision: { action: "wait", reason: "CONTROL_STOPPED" },
      },
      controlProof: null,
      proof: null,
    });

    expect(surface.locateCount).toBe(locateBefore);
    expect(surface.focusCount).toBe(0);
    expect(surface.replaceCount).toBe(0);
    expect(surface.submitCount).toBe(0);
  });

  it("direct heartbeat sees owner latest outgoing and only locates example-contact", async () => {
    const runtime = createRuntime();
    surface.unreadIndicator = false;
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("旧消息", 0.43, 0.72)],
        "example-contact",
        new Date("2026-08-24T06:00:00.000Z"),
      ),
    );
    await runtime.readConversation("example-contact");
    surface.locatedConversationIds.length = 0;
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine("旧消息", 0.43, 0.72),
          ocrLine("刚收到的来信", 0.43, 0.62),
          ocrLine("主人已经回复", 0.76, 0.52),
        ],
        "example-contact",
        new Date("2026-08-24T06:01:00.000Z"),
      ),
    );

    await expect(
      runtime.readTargetDirectForSupervisor(),
    ).resolves.toMatchObject({
      publicResult: {
        replyDecision: { action: "wait", reason: "LATEST_VISIBLE_OUTGOING" },
      },
      proof: null,
    });

    expect(surface.locatedConversationIds).toEqual(["example-contact"]);
    expect(surface.replaceCount).toBe(0);
    expect(surface.submitCount).toBe(0);
  });

  it("direct heartbeat completes one latest reply without locating file-transfer", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    surface.locatedConversationIds.length = 0;

    const target = await runtime.readTargetDirectForSupervisor();
    if (target.controlProof === null || target.proof === null) {
      throw new Error("EXPECTED_DIRECT_TARGET_PROOFS");
    }
    const prepared = await runtime.prepareLatestReplyForSupervisor(
      "收到啦",
      target.controlProof,
      target.proof,
    );
    await runtime.verifyDraft(prepared.candidateToken);
    await runtime.submitAuthorizedDraftForSupervisor(
      prepared.candidateToken,
      target.controlProof,
      target.proof,
    );
    await runtime.verifySend(prepared.candidateToken);

    expect(surface.submitCount).toBe(1);
    expect(surface.locatedConversationIds.length).toBeGreaterThan(0);
    expect(
      surface.locatedConversationIds.every((id) => id === "example-contact"),
    ).toBe(true);
  });

  it("does not revive the same pending target after STOP and RESUME", async () => {
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    const first = await runtime.readTargetDirectForSupervisor();
    expect(first.proof).not.toBeNull();

    await state.setStopped("user-command");
    await state.resume();
    const second = await runtime.readTargetDirectForSupervisor();

    expect(second).toMatchObject({
      publicResult: {
        replyDecision: { action: "wait", reason: "NO_NEW_INCOMING" },
      },
      proof: null,
    });
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      pendingTrigger: null,
    });
    expect(surface.focusCount).toBe(0);
    expect(surface.replaceCount).toBe(0);
    expect(surface.submitCount).toBe(0);
  });

  it("fails a target read when STOP and RESUME occur during UI read and never replays it", async () => {
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    expect(
      (await runtime.readTargetDirectForSupervisor()).proof,
    ).not.toBeNull();
    surface.onLocate = async (id) => {
      expect(id).toBe("example-contact");
      await state.setStopped("user-command");
      await state.resume();
    };

    await expect(runtime.readTargetDirectForSupervisor()).rejects.toThrow(
      "CONTROL_CHANGED",
    );
    await expect(
      runtime.readTargetDirectForSupervisor(),
    ).resolves.toMatchObject({
      publicResult: {
        replyDecision: { action: "wait", reason: "NO_NEW_INCOMING" },
      },
      proof: null,
    });
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      pendingTrigger: null,
    });
    expect(surface.focusCount).toBe(0);
    expect(surface.replaceCount).toBe(0);
    expect(surface.submitCount).toBe(0);
  });

  it("clears a mismatched trigger revision without minting a new added incoming in that read", async () => {
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    expect(
      (await runtime.readTargetDirectForSupervisor()).proof,
    ).not.toBeNull();
    await state.setStopped("user-command");
    await state.resume();
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine("旧消息", 0.43, 0.76),
          ocrLine("自然新来信", 0.43, 0.66),
          ocrLine("停止后才出现的新来信", 0.43, 0.56),
        ],
        "example-contact",
        new Date("2026-08-23T02:02:00.000Z"),
      ),
    );

    await expect(
      runtime.readTargetDirectForSupervisor(),
    ).resolves.toMatchObject({
      publicResult: {
        replyDecision: { action: "wait", reason: "NO_NEW_INCOMING" },
      },
      proof: null,
    });
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      pendingTrigger: null,
    });
  });

  it("rejects a prepare proof whose target and control gate revisions differ", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    const target = await runtime.readTargetDirectForSupervisor();
    if (target.controlProof === null || target.proof === null) {
      throw new Error("EXPECTED_DIRECT_TARGET_PROOFS");
    }
    const mismatchedTargetProof = {
      ...target.proof,
      trigger: {
        ...target.proof.trigger,
        gateRevision: differentRevision(target.controlProof.gateRevision),
      },
    };

    await expect(
      runtime.prepareLatestReplyForSupervisor(
        "禁止准备",
        target.controlProof,
        mismatchedTargetProof,
      ),
    ).rejects.toThrow("TARGET_PROOF_CONTROL_MISMATCH");
    await expect(pending.get()).resolves.toBeNull();
    expect(surface.focusCount).toBe(0);
    expect(surface.replaceCount).toBe(0);
    expect(surface.submitCount).toBe(0);
  });

  it("rejects a submit proof whose target and control gate revisions differ", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    const target = await runtime.readTargetDirectForSupervisor();
    if (target.controlProof === null || target.proof === null) {
      throw new Error("EXPECTED_DIRECT_TARGET_PROOFS");
    }
    const prepared = await runtime.prepareLatestReplyForSupervisor(
      "禁止提交",
      target.controlProof,
      target.proof,
    );
    await runtime.verifyDraft(prepared.candidateToken);
    const mismatchedTargetProof = {
      ...target.proof,
      trigger: {
        ...target.proof.trigger,
        gateRevision: differentRevision(target.controlProof.gateRevision),
      },
    };

    await expect(
      runtime.submitAuthorizedDraftForSupervisor(
        prepared.candidateToken,
        target.controlProof,
        mismatchedTargetProof,
      ),
    ).rejects.toThrow("TARGET_PROOF_CONTROL_MISMATCH");
    expect(surface.submitCount).toBe(0);
  });

  it("rechecks persisted STOP before direct prepare and direct submit without control UI", async () => {
    await approveTargetGate();
    const prepareRuntime = createRuntime();
    await establishBaselineThenNewIncoming(prepareRuntime);
    const prepareTarget = await prepareRuntime.readTargetDirectForSupervisor();
    if (prepareTarget.controlProof === null || prepareTarget.proof === null) {
      throw new Error("EXPECTED_DIRECT_TARGET_PROOFS");
    }
    const readsBeforePrepare = surface.locatedConversationIds.length;
    await state.setStopped("user-command");
    await expect(
      prepareRuntime.prepareLatestReplyForSupervisor(
        "禁止发送",
        prepareTarget.controlProof,
        prepareTarget.proof,
      ),
    ).rejects.toThrow("CONTROL_CHANGED");
    expect(surface.locatedConversationIds).toHaveLength(readsBeforePrepare);
    expect(surface.submitCount).toBe(0);

    await state.resume();
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine("旧消息", 0.43, 0.76),
          ocrLine("自然新来信", 0.43, 0.66),
          ocrLine("另一条自然新来信", 0.43, 0.56),
        ],
        "example-contact",
        new Date("2026-08-23T02:02:00.000Z"),
      ),
    );
    const submitRuntime = createRuntime();
    await expect(
      submitRuntime.readTargetDirectForSupervisor(),
    ).resolves.toMatchObject({
      publicResult: {
        replyDecision: { action: "wait", reason: "NO_NEW_INCOMING" },
      },
      proof: null,
    });
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine("旧消息", 0.43, 0.76),
          ocrLine("自然新来信", 0.43, 0.66),
          ocrLine("另一条自然新来信", 0.43, 0.56),
          ocrLine("清理旧触发后到达的新来信", 0.43, 0.46),
        ],
        "example-contact",
        new Date("2026-08-23T02:03:00.000Z"),
      ),
    );
    const submitTarget = await submitRuntime.readTargetDirectForSupervisor();
    if (submitTarget.controlProof === null || submitTarget.proof === null) {
      throw new Error("EXPECTED_DIRECT_TARGET_PROOFS");
    }
    const prepared = await submitRuntime.prepareLatestReplyForSupervisor(
      "这次也不发送",
      submitTarget.controlProof,
      submitTarget.proof,
    );
    await submitRuntime.verifyDraft(prepared.candidateToken);
    await state.setStopped("user-command");

    await expect(
      submitRuntime.submitAuthorizedDraftForSupervisor(
        prepared.candidateToken,
        submitTarget.controlProof,
        submitTarget.proof,
      ),
    ).rejects.toThrow("CONTROL_CHANGED");
    expect(surface.submitCount).toBe(0);
    expect(
      surface.locatedConversationIds.every((id) => id === "example-contact"),
    ).toBe(true);
  });

  it("automatically creates one durable travel Demo for the latest trusted incoming", async () => {
    const runtime = createRuntime();
    surface.unreadIndicator = false;
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("旧消息", 0.43, 0.72)],
        "example-contact",
        new Date("2026-08-24T06:00:00.000Z"),
      ),
    );
    await runtime.readConversation("example-contact");
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine("旧消息", 0.43, 0.72),
          ocrLine("帮我做一份示例城市三天旅行攻略", 0.43, 0.62),
        ],
        "example-contact",
        new Date("2026-08-24T06:01:00.000Z"),
      ),
    );

    const firstControl = await runtime.readControlForSupervisor();
    const first = await runtime.readTargetForSupervisor(firstControl.proof);
    const firstPublic = first.publicResult as {
      travelDemo?: {
        kind: string;
        jobId?: string;
        status?: string;
        deliveryCode?: string;
      };
    };
    expect(firstPublic.travelDemo).toMatchObject({
      kind: "artifact",
      status: "delivery-blocked",
      deliveryCode: "NATIVE_FILE_ATTACHMENT_UNAVAILABLE",
    });
    const jobId = firstPublic.travelDemo?.jobId;
    if (jobId === undefined) throw new Error("EXPECTED_TRAVEL_DEMO_JOB");
    expect(jobId).toMatch(/^[a-f0-9]{64}$/u);

    const secondControl = await runtime.readControlForSupervisor();
    const second = await runtime.readTargetForSupervisor(secondControl.proof);
    expect(
      (second.publicResult as { travelDemo?: { jobId?: string } }).travelDemo
        ?.jobId,
    ).toBe(jobId);
    expect(
      (await readdir(path.join(rootDir, "artifacts", "travel-demo"))).filter(
        (entry) => !entry.startsWith("."),
      ),
    ).toEqual([jobId]);
    expect(surface.replaceCount).toBe(0);
    expect(surface.submitCount).toBe(0);
  });

  it("does not create a travel Demo when the owner already replied after the request", async () => {
    const runtime = createRuntime();
    surface.unreadIndicator = false;
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("旧消息", 0.43, 0.72)],
        "example-contact",
        new Date("2026-08-24T06:00:00.000Z"),
      ),
    );
    await runtime.readConversation("example-contact");
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine("旧消息", 0.43, 0.72),
          ocrLine("帮我做一份示例城市三天旅行攻略", 0.43, 0.62),
          ocrLine("我来安排就好", 0.76, 0.52),
        ],
        "example-contact",
        new Date("2026-08-24T06:01:00.000Z"),
      ),
    );

    const control = await runtime.readControlForSupervisor();
    const read = await runtime.readTargetForSupervisor(control.proof);

    expect(read.publicResult).toMatchObject({
      replyDecision: { action: "wait", reason: "LATEST_VISIBLE_OUTGOING" },
      travelDemo: {
        kind: "not-applicable",
        reason: "NO_TRUSTED_TARGET_TRIGGER",
      },
    });
    await expect(
      readdir(path.join(rootDir, "artifacts", "travel-demo")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(surface.replaceCount).toBe(0);
    expect(surface.submitCount).toBe(0);
  });

  it("does not reply to an earlier incoming when the latest daily-care outgoing repeats older text", async () => {
    const care = "今天也要照顾好自己——示例用户";
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine(care, 0.76, 0.76)],
        "example-contact",
        new Date("2026-08-24T22:00:00.000Z"),
      ),
    );
    surface.unreadIndicator = false;
    await createRuntime().readConversation("example-contact");
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [
          ocrLine(care, 0.76, 0.76),
          ocrLine("刚刚收到的新来信", 0.43, 0.66),
          ocrLine(care, 0.76, 0.56),
        ],
        "example-contact",
        new Date("2026-08-24T22:01:00.000Z"),
      ),
    );

    await expect(
      createRuntime().readConversation("example-contact"),
    ).resolves.toMatchObject({
      replyDecision: {
        action: "wait",
        triggerMessageId: null,
        reason: "BASELINE_ESTABLISHED_NO_SEND",
      },
    });
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      pendingTrigger: null,
    });
    expect(surface.replaceCount).toBe(0);
    expect(surface.submitCount).toBe(0);
  });

  it.each(["control-stop", "target-outgoing"] as const)(
    "rejects %s drift before pending creation or UI focus",
    async (drift) => {
      await approveTargetGate();
      const runtime = createRuntime();
      await establishBaselineThenNewIncoming(runtime);
      const control = await runtime.readControlForSupervisor();
      const target = await runtime.readTargetForSupervisor(control.proof);
      if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");
      if (drift === "control-stop") {
        await state.setStopped("user-command");
      } else {
        surface.replaceMessages(
          "example-contact",
          parseVisibleWechatMessages(
            [
              ocrLine("旧消息", 0.43, 0.76),
              ocrLine("自然新来信", 0.43, 0.66),
              ocrLine("主人抢先回复", 0.76, 0.56),
            ],
            "example-contact",
            new Date("2026-08-23T02:02:00.000Z"),
          ),
        );
      }
      const focusBefore = surface.focusCount;

      await expect(
        runtime.prepareLatestReplyForSupervisor(
          "收到啦",
          control.proof,
          target.proof,
        ),
      ).rejects.toThrow(
        drift === "control-stop" ? "CONTROL_CHANGED" : "TARGET_TRIGGER_CHANGED",
      );

      await expect(pending.get()).resolves.toBeNull();
      expect(surface.focusCount).toBe(focusBefore);
      expect((await state.getControlState()).outgoing).toEqual({});
    },
  );

  it.each(["control-stop", "target-outgoing"] as const)(
    "clears an exact verified draft and submits zero times when %s appears before authorization",
    async (drift) => {
      await approveTargetGate();
      const runtime = createRuntime();
      await establishBaselineThenNewIncoming(runtime);
      const control = await runtime.readControlForSupervisor();
      const target = await runtime.readTargetForSupervisor(control.proof);
      if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");
      const prepared = await runtime.prepareLatestReplyForSupervisor(
        "收到啦",
        control.proof,
        target.proof,
      );
      expect(surface.draftFor("example-contact")).toBe("收到啦\n——示例用户");
      expect(surface.replaceCount).toBe(1);
      await runtime.verifyDraft(prepared.candidateToken);
      expect(surface.replaceCount).toBe(1);
      if (drift === "control-stop") {
        await state.setStopped("user-command");
      } else {
        surface.replaceMessages(
          "example-contact",
          parseVisibleWechatMessages(
            [
              ocrLine("旧消息", 0.43, 0.76),
              ocrLine("自然新来信", 0.43, 0.66),
              ocrLine("主人抢先回复", 0.76, 0.56),
            ],
            "example-contact",
            new Date("2026-08-23T02:03:00.000Z"),
          ),
        );
      }

      await expect(
        runtime.submitAuthorizedDraftForSupervisor(
          prepared.candidateToken,
          control.proof,
          target.proof,
        ),
      ).rejects.toThrow(
        drift === "control-stop" ? "CONTROL_CHANGED" : "TARGET_TRIGGER_CHANGED",
      );

      expect(surface.submitCount).toBe(0);
      expect(surface.clearCount).toBe(1);
      await expect(pending.get()).resolves.toBeNull();
    },
  );

  it("appends the assistant signature to every prepared automatic reply", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);
    if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");

    await runtime.prepareLatestReplyForSupervisor(
      "收到啦",
      control.proof,
      target.proof,
    );

    expect(surface.draftFor("example-contact")).toBe("收到啦\n——示例用户");
    await expect(pending.get()).resolves.toMatchObject({
      conversationId: "example-contact",
      text: "收到啦\n——示例用户",
    });
  });

  it("rejects the legacy assistant signature before writing an automatic reply", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);
    if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");

    await expect(
      runtime.prepareLatestReplyForSupervisor(
        "收到啦\n——聊天助手",
        control.proof,
        target.proof,
      ),
    ).rejects.toThrow("AUTOMATIC_REPLY_SIGNATURE_INVALID");

    expect(surface.replaceCount).toBe(0);
    await expect(pending.get()).resolves.toBeNull();
  });

  it("rejects a legacy signature before an otherwise exact current suffix", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);
    if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");

    await expect(
      runtime.prepareLatestReplyForSupervisor(
        "收到啦\n——聊天助手\n——示例用户",
        control.proof,
        target.proof,
      ),
    ).rejects.toThrow("AUTOMATIC_REPLY_SIGNATURE_INVALID");

    expect(surface.replaceCount).toBe(0);
    await expect(pending.get()).resolves.toBeNull();
  });

  it("invokes Native submit exactly once and rejects replay before a second submit", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);
    if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");
    const prepared = await runtime.prepareLatestReplyForSupervisor(
      "收到啦",
      control.proof,
      target.proof,
    );
    expect(surface.draftFor("example-contact")).toBe("收到啦\n——示例用户");
    expect(surface.replaceCount).toBe(1);
    await runtime.verifyDraft(prepared.candidateToken);
    expect(surface.replaceCount).toBe(1);

    await expect(
      runtime.submitAuthorizedDraftForSupervisor(
        prepared.candidateToken,
        control.proof,
        target.proof,
      ),
    ).resolves.toEqual({ submitted: true, conversationId: "example-contact" });
    await expect(
      runtime.submitAuthorizedDraftForSupervisor(
        prepared.candidateToken,
        control.proof,
        target.proof,
      ),
    ).rejects.toThrow("SUBMIT_PROOF_CONSUMED");

    expect(surface.submitCount).toBe(1);
    await expect(
      runtime.verifySend(prepared.candidateToken),
    ).resolves.toMatchObject({
      status: "verified",
    });
  });

  it("terminally consumes one target trigger when Native submit becomes uncertain", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await establishBaselineThenNewIncoming(runtime);
    const control = await runtime.readControlForSupervisor();
    const target = await runtime.readTargetForSupervisor(control.proof);
    if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");
    const prepared = await runtime.prepareLatestReplyForSupervisor(
      "收到啦",
      control.proof,
      target.proof,
    );
    await runtime.verifyDraft(prepared.candidateToken);
    surface.submitFailure = "after-effect";

    await expect(
      runtime.submitAuthorizedDraftForSupervisor(
        prepared.candidateToken,
        control.proof,
        target.proof,
      ),
    ).rejects.toThrow("INJECTED_SUBMIT_FAILURE");

    expect(surface.submitCount).toBe(1);
    await expect(pending.get()).resolves.toBeNull();
    await expect(state.getTargetReplyState()).resolves.toMatchObject({
      pendingTrigger: null,
    });
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
    });
  });

  it.each(["prepared", "verified"] as const)(
    "aborts an internally written %s supervisor draft without submitting",
    async (phase) => {
      await approveTargetGate();
      const runtime = createRuntime();
      await establishBaselineThenNewIncoming(runtime);
      const control = await runtime.readControlForSupervisor();
      const target = await runtime.readTargetForSupervisor(control.proof);
      if (target.proof === null) throw new Error("EXPECTED_TARGET_PROOF");
      const prepared = await runtime.prepareLatestReplyForSupervisor(
        "收到啦",
        control.proof,
        target.proof,
      );
      if (phase === "verified")
        await runtime.verifyDraft(prepared.candidateToken);

      await expect(
        runtime.abortPreparedDraftForSupervisor(prepared.candidateToken),
      ).resolves.toEqual({ aborted: true, conversationId: "example-contact" });

      expect(surface.submitCount).toBe(0);
      expect(surface.draftFor("example-contact")).toBe("");
      await expect(pending.get()).resolves.toBeNull();
      expect((await state.getControlState()).outgoing).toEqual({});
    },
  );

  it("blocks target draft preparation until consent and the exact report hash are approved", async () => {
    await store.write("state/consent.enc", { consentConfirmed: true });
    await store.write("profiles/initialization-report.enc", {
      hash: "a".repeat(64),
      approvedHash: null,
    });
    await expect(
      createRuntime().prepareDraft("example-contact", "辛苦啦"),
    ).rejects.toThrow("INITIALIZATION_REPORT_NOT_APPROVED");
    expect(surface.submitCount).toBe(0);
  });

  it("marks a target candidate verified after an exact new outgoing read-back", async () => {
    await store.write("state/consent.enc", { consentConfirmed: true });
    await store.write("profiles/initialization-report.enc", {
      hash: "a".repeat(64),
      approvedHash: "a".repeat(64),
    });
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft(
      "example-contact",
      "辛苦啦，早点休息",
    );
    surface.externalType("辛苦啦，早点休息");
    await runtime.verifyDraft(prepared.candidateToken);
    surface.externalReturn();
    await expect(
      runtime.verifySend(prepared.candidateToken),
    ).resolves.toMatchObject({ status: "verified" });
    expect(Object.values((await state.getControlState()).outgoing)).toEqual([
      expect.objectContaining({ status: "verified" }),
    ]);
  });

  it("releases a new target claim when focus fails before any draft write", async () => {
    await store.write("state/consent.enc", { consentConfirmed: true });
    await store.write("profiles/initialization-report.enc", {
      hash: "a".repeat(64),
      approvedHash: "a".repeat(64),
    });
    const runtime = createRuntime();
    surface.focusError = new Error("WINDOW_REVISION_CHANGED");

    await expect(
      runtime.prepareDraft("example-contact", "辛苦啦，早点休息"),
    ).rejects.toThrow("WINDOW_REVISION_CHANGED");

    await expect(pending.get()).resolves.toBeNull();
    const control = await state.getControlState();
    expect(control).toMatchObject({
      stopped: false,
      stopReason: null,
    });
    expect(control.outgoing).toEqual({});
    surface.focusError = null;
    await expect(
      runtime.prepareDraft("example-contact", "辛苦啦，早点休息"),
    ).resolves.toMatchObject({ prepared: true });
  });

  it("aborts an exact unverified target candidate only while the composer is empty", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft(
      "example-contact",
      "辛苦啦，早点休息",
    );

    await expect(runtime.abortDraft(prepared.candidateToken)).resolves.toEqual({
      aborted: true,
      conversationId: "example-contact",
    });

    await expect(pending.get()).resolves.toBeNull();
    expect((await state.getControlState()).outgoing).toEqual({});
    const abortRecord = (await audit.list()).find(
      (record) => record.type === "live-draft-aborted",
    );
    expect(abortRecord?.details).toEqual({
      conversationId: "example-contact",
      textHash:
        "c54ac7ac1570289be03c4ca1f641593cd9040368ecbe38ebe1de23fbb94d58cb",
    });
    await expect(
      runtime.prepareDraft("example-contact", "辛苦啦，早点休息"),
    ).resolves.toMatchObject({ prepared: true });
  });

  it("keeps the pending candidate when the abort token does not match", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    await runtime.prepareDraft("example-contact", "辛苦啦");
    const before = await pending.get();

    await expect(runtime.abortDraft("f".repeat(64))).rejects.toThrow(
      "PENDING_SEND_TOKEN_MISMATCH",
    );

    await expect(pending.get()).resolves.toEqual(before);
    expect(Object.values((await state.getControlState()).outgoing)).toEqual([
      expect.objectContaining({ status: "claimed" }),
    ]);
    await expect(aborts.get()).resolves.toBeNull();
  });

  it("keeps a verified candidate locked against abort even with an empty composer", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "辛苦啦");
    surface.externalType("辛苦啦");
    await runtime.verifyDraft(prepared.candidateToken);
    surface.externalType("");
    const before = await pending.get();

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "DRAFT_ALREADY_VERIFIED",
    );

    await expect(pending.get()).resolves.toEqual(before);
    await expect(aborts.get()).resolves.toBeNull();
  });

  it("keeps an unverified candidate when the composer is nonempty", async () => {
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("file-transfer", "连接测试");
    surface.externalType("未核验的草稿");
    const before = await pending.get();

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "DRAFT_NOT_EMPTY_OR_UNKNOWN",
    );

    await expect(pending.get()).resolves.toEqual(before);
    await expect(aborts.get()).resolves.toBeNull();
  });

  it("keeps an unverified candidate when OCR draft alternatives are unknown", async () => {
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("file-transfer", "连接测试");
    surface.draftAlternatives = ["可能仍有内容"];
    const before = await pending.get();

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "DRAFT_NOT_EMPTY_OR_UNKNOWN",
    );

    await expect(pending.get()).resolves.toEqual(before);
  });

  it("keeps an unverified candidate and claim when composer evidence is ambiguous", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "辛苦啦");
    surface.composerEvidence = "ambiguous";
    const before = await pending.get();

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "DRAFT_NOT_EMPTY_OR_UNKNOWN",
    );

    await expect(pending.get()).resolves.toEqual(before);
    expect(Object.values((await state.getControlState()).outgoing)).toEqual([
      expect.objectContaining({ status: "claimed" }),
    ]);
    await expect(aborts.get()).resolves.toBeNull();
  });

  it("rejects preparation when composer evidence is ambiguous", async () => {
    surface.composerEvidence = "ambiguous";

    await expect(
      createRuntime().prepareDraft("file-transfer", "连接测试"),
    ).rejects.toThrow("INPUT_NOT_EMPTY");

    await expect(pending.get()).resolves.toBeNull();
  });

  it("finalizes only the uncertain attempt when post-Return evidence is ambiguous", async () => {
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("file-transfer", "连接测试");
    surface.externalType("连接测试");
    surface.composerEvidence = "meaningful-content";
    await runtime.verifyDraft(prepared.candidateToken);
    surface.externalReturn();
    surface.composerEvidence = "ambiguous";

    await expect(runtime.verifySend(prepared.candidateToken)).rejects.toThrow(
      "SEND_RESULT_NOT_VERIFIED",
    );

    await expect(pending.get()).resolves.toBeNull();
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
    });
  });

  it("cleans a persisted legacy uncertain pending attempt without any UI operation", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "遗留候选");
    await pending.markDraftVerified(
      prepared.candidateToken.length === 64
        ? createHash("sha256").update(prepared.candidateToken).digest("hex")
        : "",
      "2026-08-19T02:00:00.000Z",
    );
    const candidate = await pending.get();
    if (
      candidate?.fingerprint === null ||
      candidate?.fingerprint === undefined
    ) {
      throw new Error("EXPECTED_TARGET_FINGERPRINT");
    }
    await state.markOutgoingUncertain(candidate.fingerprint);
    await state.setStopped("SEND_RESULT_UNCERTAIN");
    const uiCounts = {
      locate: surface.locateCount,
      replace: surface.replaceCount,
      submit: surface.submitCount,
    };

    await expect(runtime.getLiveState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
      pendingSend: null,
      targetSendReady: true,
    });

    await expect(pending.get()).resolves.toBeNull();
    expect({
      locate: surface.locateCount,
      replace: surface.replaceCount,
      submit: surface.submitCount,
    }).toEqual(uiCounts);
  });

  it("uses one validated File Transfer Assistant snapshot for control and messages", async () => {
    let legacyControlReads = 0;
    let legacyConversationReads = 0;
    let combinedReads = 0;
    const runtimeAdapter = {
      readControlCommand: () => {
        legacyControlReads += 1;
        return Promise.resolve(null);
      },
      readConversation: (id: ConversationId) => {
        legacyConversationReads += 1;
        return surface.locateConversation(id);
      },
      readControlConversation: async () => {
        combinedReads += 1;
        return {
          control: null,
          snapshot: await surface.locateConversation("file-transfer"),
          controlCheckpoint: await state.getControlBoundaryCheckpoint(),
        };
      },
      readConversationForOwnerAdvice: (id: ConversationId) =>
        surface.locateConversation(id),
    };
    const runtime = createRuntimeFor(
      store,
      state,
      pending,
      aborts,
      audit,
      surface,
      coordinator,
      runtimeAdapter,
    );

    await expect(
      runtime.readConversation("file-transfer"),
    ).resolves.toMatchObject({
      conversationId: "file-transfer",
    });

    expect({
      combinedReads,
      legacyControlReads,
      legacyConversationReads,
    }).toEqual({
      combinedReads: 1,
      legacyControlReads: 0,
      legacyConversationReads: 0,
    });
  });

  it("reads the fixed target for advice while automatic operation is stopped", async () => {
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("今天加班", 0.43, 0.65)],
        "example-contact",
        new Date("2026-08-19T02:00:00.000Z"),
      ),
    );
    await state.setStopped("user-command");
    const runtime = createRuntimeFor(
      store,
      state,
      pending,
      aborts,
      audit,
      surface,
      coordinator,
      {
        readConversation: () => Promise.reject(new Error("SYSTEM_STOPPED")),
        readControlCommand: () => Promise.resolve(null),
        readControlConversation: async () => ({
          control: null,
          snapshot: await surface.locateConversation("file-transfer"),
          controlCheckpoint: await state.getControlBoundaryCheckpoint(),
        }),
        readConversationForOwnerAdvice: (id: ConversationId) =>
          surface.locateConversation(id),
      },
    );

    await expect(
      runtime.readTargetConversationForAdvice(),
    ).resolves.toMatchObject({
      conversationId: "example-contact",
      messages: [{ direction: "incoming", text: "今天加班" }],
    });
    expect(surface.submitCount).toBe(0);
    await expect(new MessageRepository(store).list()).resolves.toEqual([]);
    await expect(audit.list()).resolves.toEqual([]);
    await expect(state.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
    });
  });

  it("does not clear pending state when its fingerprint is no longer claimed", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "辛苦啦");
    const before = await pending.get();
    if (before?.fingerprint === null || before?.fingerprint === undefined) {
      throw new Error("EXPECTED_TARGET_FINGERPRINT");
    }
    await state.markOutgoingVerified(before.fingerprint);

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "OUTGOING_NOT_CLAIMED",
    );

    await expect(pending.get()).resolves.toEqual(before);
    await expect(aborts.get()).resolves.toBeNull();
  });

  it("does not create an abort intent for an uncertain outgoing fingerprint", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "辛苦啦");
    const before = await pending.get();
    if (before?.fingerprint === null || before?.fingerprint === undefined) {
      throw new Error("EXPECTED_TARGET_FINGERPRINT");
    }
    await state.markOutgoingUncertain(before.fingerprint);

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "OUTGOING_NOT_CLAIMED",
    );

    await expect(pending.get()).resolves.toEqual(before);
    await expect(aborts.get()).resolves.toBeNull();
    await expect(state.getControlState()).resolves.toMatchObject({
      outgoing: {
        [before.fingerprint]: { status: "uncertain" },
      },
    });
  });

  it("resumes an exact abort after claim release succeeds but pending clear persistence fails once", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft(
      "example-contact",
      "辛苦啦，早点休息",
    );
    store.failWriteOnce("state/pending-send.enc");

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:state/pending-send.enc",
    );
    await expect(pending.get()).resolves.not.toBeNull();
    expect((await state.getControlState()).outgoing).toEqual({});
    const intent = await aborts.get();
    expect(intent?.conversationId).toBe("example-contact");
    expect(intent?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(intent?.textHash).toBe(
      "c54ac7ac1570289be03c4ca1f641593cd9040368ecbe38ebe1de23fbb94d58cb",
    );
    expect(intent?.intentId).toMatch(/^[a-f0-9]{64}$/u);
    expect(intent?.candidateId).toMatch(/^[a-f0-9]{64}$/u);
    expect(intent?.auditId).toMatch(/^[a-f0-9-]{36}$/u);
    const encryptedIntent = await readFile(
      path.join(rootDir, "state/abort-intent.enc"),
      "utf8",
    );
    expect(encryptedIntent).not.toContain("辛苦啦，早点休息");
    expect(encryptedIntent).not.toContain(prepared.candidateToken);

    restartRepositories();
    await expect(
      createRuntime().abortDraft(prepared.candidateToken),
    ).resolves.toEqual({
      aborted: true,
      conversationId: "example-contact",
    });

    await expect(pending.get()).resolves.toBeNull();
    expect((await state.getControlState()).outgoing).toEqual({});
    const abortRecords = (await audit.list()).filter(
      (record) => record.type === "live-draft-aborted",
    );
    expect(abortRecords).toHaveLength(1);
    expect(abortRecords[0]?.id).toBe(intent?.auditId);
    await expect(aborts.get()).resolves.toBeNull();
  });

  it("resumes an exact abort after pending clear succeeds but audit persistence fails once", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft(
      "example-contact",
      "辛苦啦，早点休息",
    );
    store.failWriteOnce("logs/audit.enc");

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:logs/audit.enc",
    );
    await expect(pending.get()).resolves.toBeNull();
    expect((await state.getControlState()).outgoing).toEqual({});

    restartRepositories();
    await expect(
      createRuntime().abortDraft(prepared.candidateToken),
    ).resolves.toEqual({
      aborted: true,
      conversationId: "example-contact",
    });

    expect(
      (await audit.list()).filter(
        (record) => record.type === "live-draft-aborted",
      ),
    ).toHaveLength(1);
  });

  it("keeps an audit-stage abort intent when composer evidence becomes ambiguous", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "辛苦啦");
    store.failWriteOnce("logs/audit.enc");
    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:logs/audit.enc",
    );
    const intent = await aborts.get();
    surface.composerEvidence = "ambiguous";

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "DRAFT_NOT_EMPTY_OR_UNKNOWN",
    );

    await expect(aborts.get()).resolves.toEqual(intent);
    expect(
      (await audit.list()).filter(
        (record) => record.type === "live-draft-aborted",
      ),
    ).toHaveLength(0);
  });

  it("keeps the send gate and new preparation closed while abort recovery is pending", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "辛苦啦");
    store.failWriteOnce("logs/audit.enc");
    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:logs/audit.enc",
    );

    await expect(runtime.getLiveState()).resolves.toMatchObject({
      targetSendReady: false,
    });
    await expect(
      runtime.prepareDraft("example-contact", "换一个候选"),
    ).rejects.toThrow("ABORT_INTENT_EXISTS");
  });

  it("does not duplicate abort audit when intent clearing fails after audit persistence", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "辛苦啦");
    store.failWriteOnce("state/abort-intent.enc", 2);

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:state/abort-intent.enc",
    );
    expect(
      (await audit.list()).filter(
        (record) => record.type === "live-draft-aborted",
      ),
    ).toHaveLength(1);

    restartRepositories();
    await expect(
      createRuntime().abortDraft(prepared.candidateToken),
    ).resolves.toEqual({
      aborted: true,
      conversationId: "example-contact",
    });
    expect(
      (await audit.list()).filter(
        (record) => record.type === "live-draft-aborted",
      ),
    ).toHaveLength(1);
  });

  it("preserves a conflicting pending candidate while an abort intent exists", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "辛苦啦");
    store.failWriteOnce("state/pending-send.enc");
    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:state/pending-send.enc",
    );
    const intent = await aborts.get();
    await expect(runtime.abortDraft("f".repeat(64))).rejects.toThrow(
      "PENDING_SEND_TOKEN_MISMATCH",
    );
    await expect(aborts.get()).resolves.toEqual(intent);
    const original = await pending.get();
    if (original === null) throw new Error("EXPECTED_PENDING_CANDIDATE");
    await pending.clearMatching(original.tokenHash);
    const conflicting = {
      ...original,
      text: "替换候选",
      tokenHash: "a".repeat(64),
    };
    await pending.put(conflicting);

    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "ABORT_INTENT_CONFLICT",
    );

    await expect(pending.get()).resolves.toEqual(conflicting);
  });

  it("serializes readiness across repository instances after the null intent read", async () => {
    const barrierStore = new ReadinessBarrierEncryptedStore(
      rootDir,
      new FixedKeyProvider(encryptionKey),
    );
    const competingStore = new CountingEncryptedStore(
      rootDir,
      new FixedKeyProvider(encryptionKey),
    );
    const pendingA = new PendingSendRepository(barrierStore);
    await pendingA.put({
      conversationId: "file-transfer",
      text: "旧候选",
      tokenHash:
        "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
      fingerprint: null,
      baselineMessageIds: [],
      createdAt: "2026-08-19T02:00:00.000Z",
      draftVerifiedAt: null,
    });
    await approveGate(barrierStore);
    const runtimeA = createRuntimeFor(
      barrierStore,
      new StateRepository(barrierStore),
      pendingA,
      new AbortIntentRepository(barrierStore),
      new AuditRepository(barrierStore),
      surface,
      coordinator,
    );
    const runtimeB = createRuntimeFor(
      competingStore,
      new StateRepository(competingStore),
      new PendingSendRepository(competingStore),
      new AbortIntentRepository(competingStore),
      new AuditRepository(competingStore),
      surface,
      coordinator,
    );
    barrierStore.arm();

    const stateResult = runtimeA.getLiveState();
    await barrierStore.abortRead.promise;
    const abortResult = runtimeB.abortDraft("a".repeat(64));
    await flushAsyncTurns();
    const competingReadsBeforeRelease = competingStore.abortIntentReadCount;
    if (competingReadsBeforeRelease > 0) await abortResult;
    barrierStore.allowPendingRead.resolve();
    const observedState = await stateResult;
    if (competingReadsBeforeRelease === 0) await abortResult;

    expect(competingReadsBeforeRelease).toBe(0);
    expect(observedState).toMatchObject({
      pendingSend: {
        conversationId: "file-transfer",
        createdAt: "2026-08-19T02:00:00.000Z",
      },
      targetSendReady: false,
    });
  });

  it("serializes prepare from its null intent read through the old candidate abort", async () => {
    const barrierStore = new AfterAbortReadBarrierEncryptedStore(
      rootDir,
      new FixedKeyProvider(encryptionKey),
    );
    const competingStore = new CountingEncryptedStore(
      rootDir,
      new FixedKeyProvider(encryptionKey),
    );
    const stateA = new StateRepository(barrierStore);
    const pendingA = new PendingSendRepository(barrierStore);
    await stateA.claimOutgoing("1".repeat(64));
    await pendingA.put({
      conversationId: "example-contact",
      text: "旧候选",
      tokenHash:
        "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
      fingerprint: "1".repeat(64),
      baselineMessageIds: [],
      createdAt: "2026-08-19T02:00:00.000Z",
      draftVerifiedAt: null,
    });
    await approveGate(barrierStore);
    const runtimeA = createRuntimeFor(
      barrierStore,
      stateA,
      pendingA,
      new AbortIntentRepository(barrierStore),
      new AuditRepository(barrierStore),
      surface,
      coordinator,
    );
    const runtimeB = createRuntimeFor(
      competingStore,
      new StateRepository(competingStore),
      new PendingSendRepository(competingStore),
      new AbortIntentRepository(competingStore),
      new AuditRepository(competingStore),
      surface,
      coordinator,
    );

    const prepareOutcome = runtimeA.prepareDraft("example-contact", "新候选").then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.message : "UNKNOWN_ERROR",
    );
    await barrierStore.abortRead.promise;
    const abortResult = runtimeB.abortDraft("a".repeat(64));
    await flushAsyncTurns();
    const competingReadsBeforeRelease = competingStore.abortIntentReadCount;
    if (competingReadsBeforeRelease > 0) await abortResult;
    barrierStore.continueAfterAbortRead.resolve();
    const observedPrepare = await prepareOutcome;
    if (competingReadsBeforeRelease === 0) await abortResult;

    expect(competingReadsBeforeRelease).toBe(0);
    expect(observedPrepare).toBe("PENDING_SEND_EXISTS");
    expect(surface.focusCount).toBe(0);
    await expect(
      new PendingSendRepository(competingStore).get(),
    ).resolves.toBeNull();
    expect(
      (await new StateRepository(competingStore).getControlState()).outgoing,
    ).toEqual({});
  });

  it("rejects draft verification before UI read while an abort intent exists", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "待核验候选");
    store.failWriteOnce("state/control.enc");
    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:state/control.enc",
    );
    surface.externalType("待核验候选");
    const readsBeforeVerify = surface.locateCount;
    const auditBeforeVerify = await audit.list();

    await expect(runtime.verifyDraft(prepared.candidateToken)).rejects.toThrow(
      "ABORT_INTENT_EXISTS",
    );

    expect(surface.locateCount).toBe(readsBeforeVerify);
    await expect(pending.get()).resolves.toMatchObject({
      draftVerifiedAt: null,
    });
    await expect(audit.list()).resolves.toEqual(auditBeforeVerify);
  });

  it("rejects send verification outside the uncertain catch while an abort intent exists", async () => {
    await approveTargetGate();
    const runtime = createRuntime();
    const prepared = await runtime.prepareDraft("example-contact", "待发送候选");
    store.failWriteOnce("state/control.enc");
    await expect(runtime.abortDraft(prepared.candidateToken)).rejects.toThrow(
      "INJECTED_WRITE_FAILURE:state/control.enc",
    );
    const candidate = await pending.get();
    if (candidate === null) throw new Error("EXPECTED_PENDING_CANDIDATE");
    await pending.markDraftVerified(
      candidate.tokenHash,
      "2026-08-19T02:01:00.000Z",
    );
    surface.externalType("待发送候选");
    surface.externalReturn();
    const pendingBeforeVerify = await pending.get();
    const intentBeforeVerify = await aborts.get();
    const controlBeforeVerify = await state.getControlState();
    const auditBeforeVerify = await audit.list();

    await expect(runtime.verifySend(prepared.candidateToken)).rejects.toThrow(
      "ABORT_INTENT_EXISTS",
    );

    await expect(pending.get()).resolves.toEqual(pendingBeforeVerify);
    await expect(aborts.get()).resolves.toEqual(intentBeforeVerify);
    await expect(state.getControlState()).resolves.toEqual(controlBeforeVerify);
    await expect(audit.list()).resolves.toEqual(auditBeforeVerify);
  });

  it.each([
    "getLiveState",
    "readConversation",
    "prepareDraft",
    "verifyDraft",
    "abortDraft",
    "verifySend",
  ] as const)(
    "requires the coordinator for the complete %s operation",
    async (method) => {
      const closedCoordinator: LiveOperationCoordinator = {
        runExclusive: () => Promise.reject(new Error("LIVE_RUNTIME_CLOSED")),
        close: () => Promise.resolve(),
      };
      const runtime = createRuntime(closedCoordinator);
      const operation =
        method === "getLiveState"
          ? runtime.getLiveState()
          : method === "readConversation"
            ? runtime.readConversation("file-transfer")
            : method === "prepareDraft"
              ? runtime.prepareDraft("file-transfer", "候选")
              : method === "verifyDraft"
                ? runtime.verifyDraft("a".repeat(64))
                : method === "abortDraft"
                  ? runtime.abortDraft("a".repeat(64))
                  : runtime.verifySend("a".repeat(64));

      await expect(operation).rejects.toThrow("LIVE_RUNTIME_CLOSED");
    },
  );

  async function approveTargetGate(): Promise<void> {
    await Promise.all([
      store.write("state/consent.enc", { consentConfirmed: true }),
      store.write("profiles/initialization-report.enc", {
        hash: "a".repeat(64),
        approvedHash: "a".repeat(64),
      }),
    ]);
  }

  async function approveGate(targetStore: EncryptedStore): Promise<void> {
    await Promise.all([
      targetStore.write("state/consent.enc", { consentConfirmed: true }),
      targetStore.write("profiles/initialization-report.enc", {
        hash: "a".repeat(64),
        approvedHash: "a".repeat(64),
      }),
    ]);
  }

  async function approveReleaseGate(
    activationBindingSha256: string,
  ): Promise<void> {
    await Promise.all([
      store.write("state/consent.enc", {
        version: 1,
        consentConfirmed: true,
        reportHash: "a".repeat(64),
        acceptanceBindingSha256: activationBindingSha256,
        activatedAt: "2026-08-30T00:00:00.000Z",
      }),
      store.write("profiles/initialization-report.enc", {
        hash: "a".repeat(64),
        approvedHash: "a".repeat(64),
      }),
    ]);
  }

  function restartRepositories(): void {
    state = new StateRepository(
      store,
      () => new Date("2026-08-19T02:00:00.000Z"),
    );
    pending = new PendingSendRepository(store);
    aborts = new AbortIntentRepository(store);
    audit = new AuditRepository(
      store,
      () => new Date("2026-08-19T02:00:00.000Z"),
    );
  }

  function createRuntime(
    operationCoordinator: LiveOperationCoordinator = coordinator,
    activationBindingSha256?: string,
  ) {
    return createRuntimeFor(
      store,
      state,
      pending,
      aborts,
      audit,
      surface,
      operationCoordinator,
      undefined,
      activationBindingSha256,
    );
  }

  function createRuntimeFor(
    runtimeStore: EncryptedStore,
    runtimeState: StateRepository,
    runtimePending: PendingSendRepository,
    runtimeAborts: AbortIntentRepository,
    runtimeAudit: AuditRepository,
    runtimeSurface: FakeLiveWechat,
    operationCoordinator: LiveOperationCoordinator,
    runtimeAdapter = {
      readConversation: (id: ConversationId) =>
        runtimeSurface.locateConversation(id),
      readControlCommand: () => Promise.resolve(null),
      readControlConversation: async () => ({
        control: null,
        snapshot: await runtimeSurface.locateConversation("file-transfer"),
        controlCheckpoint: checkpointFromControl(
          await runtimeState.getControlState(),
        ),
      }),
      readConversationForOwnerAdvice: (id: ConversationId) =>
        runtimeSurface.locateConversation(id),
    },
    activationBindingSha256?: string,
  ) {
    return createLiveWechatDependencies({
      config: {
        dataDir: rootDir,
        mode: "supervised-send",
        allowedWechatConversations: ["example-contact", "file-transfer"],
        douyinWriteEnabled: false,
      },
      adapter: runtimeAdapter,
      surface: runtimeSurface,
      store: runtimeStore,
      messages: new MessageRepository(runtimeStore),
      state: runtimeState,
      pending: runtimePending,
      aborts: runtimeAborts,
      audit: runtimeAudit,
      comfortStationDeliveries: new ComfortStationDeliveryRepository(
        runtimeStore,
      ),
      comfortStationCard: {
        path: path.resolve(
          "assets/relationship-care/intro-card.png",
        ),
        sha256:
          "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177",
        width: 1080,
        height: 1350,
      },
      coordinator: operationCoordinator,
      activationBindingSha256,
      now: () => new Date("2026-08-19T02:00:00.000Z"),
    });
  }

  async function establishBaselineThenNewIncoming(
    runtime: ReturnType<typeof createRuntime>,
  ): Promise<void> {
    surface.unreadIndicator = false;
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("旧消息", 0.43, 0.76)],
        "example-contact",
        new Date("2026-08-23T02:00:00.000Z"),
      ),
    );
    await runtime.readConversation("example-contact");
    surface.replaceMessages(
      "example-contact",
      parseVisibleWechatMessages(
        [ocrLine("旧消息", 0.43, 0.76), ocrLine("自然新来信", 0.43, 0.66)],
        "example-contact",
        new Date("2026-08-23T02:01:00.000Z"),
      ),
    );
  }

  async function resetToLegacyControlState(): Promise<void> {
    await store.write("state/control.enc", {
      stopped: false,
      stopReason: null,
      updatedAt: null,
      controlCursor: null,
      outgoing: {},
      sendReconciliationApproval: null,
    });
    restartRepositories();
  }
});

describe("MCP contact reply delivery", () => {
  it("does not export any owner or capability minting escape hatch", async () => {
    const scheduler =
      (await import("../../src/runtime-v2/single-scheduler.js")) as Record<
        string,
        unknown
      >;
    const runtime = (await import("../../src/mcp/live-runtime.js")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(scheduler)).not.toEqual(
      expect.arrayContaining([
        "mintScheduledP1DeliveryCapability",
        "createScheduledP1Owner",
        "requireScheduledP1DeliveryCapability",
      ]),
    );
    expect(Object.keys(runtime)).not.toContain(
      "createMcpScheduledP1DeliveryCapability",
    );
  });

  let deliveryRoot: string;
  let directory: ContactDirectory;
  let authorizedTarget: AuthorizedWechatTarget;

  beforeEach(async () => {
    deliveryRoot = await mkdtemp(
      path.join(os.tmpdir(), "mcp-contact-delivery-"),
    );
    await initializeTestKernelLockCatalog(deliveryRoot);
    const deliveryStore = new EncryptedStore(
      deliveryRoot,
      new FixedKeyProvider(randomBytes(32)),
    );
    const registry = new ContactRegistryRepository(deliveryStore);
    const enrollments = new WechatIdentityEnrollmentRepository(deliveryStore);
    const samples = [
      deliveryFeatureSample(1),
      deliveryFeatureSample(2),
      deliveryFeatureSample(3),
    ];
    const fingerprint = deliveryEnrollmentFingerprint(samples);
    await enrollments.enrollSupervised({
      version: 2,
      contactId: "contact-33333333333333333333333333333333",
      displayName: "交付联系人",
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: samples,
      enrolledAt: "2026-08-31T00:00:00.000Z",
    });
    await registry.createConfirmed({
      contactId: "contact-33333333333333333333333333333333",
      displayName: "交付联系人",
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
    authorizedTarget = await directory.requireActiveAutoReplyTarget(
      "contact-33333333333333333333333333333333",
    );
  });

  afterEach(async () => {
    await rm(deliveryRoot, { recursive: true, force: true });
  });

  it("uses prepare, verify, one submit, and verify-send in exact order", async () => {
    const order: string[] = [];
    const operations = deliveryOperations(order);
    const admission = deliveryAdmission(directory, operations, () => {
      order.push("submit-fence");
      return Promise.resolve(true);
    });
    const delivery = createMcpContactReplyDelivery(directory, admission);

    await expect(
      executePreparedDelivery(
        delivery,
        directory,
        authorizedTarget,
        deliveryIntent(authorizedTarget),
      ),
    ).resolves.toEqual({ status: "verified", submitCount: 1 });

    expect(order).toEqual(["prepare", "submit"]);
    expect(operations.submitAuthorizedDraft).toHaveBeenCalledTimes(1);
    expect(operations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: authorizedTarget.contactId,
        expectedRevision: authorizedTarget.revision,
      }),
    );
  });

  it("treats every post-submit failure as terminal uncertainty without resubmit", async () => {
    const order: string[] = [];
    const operations = deliveryOperations(order);
    vi.mocked(operations.submitAuthorizedDraft).mockImplementationOnce(
      async (input) => {
        await input.markSubmitStarted();
        throw new Error("MCP_TIMEOUT");
      },
    );
    const delivery = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, operations),
    );

    await expect(
      executePreparedDelivery(
        delivery,
        directory,
        authorizedTarget,
        deliveryIntent(authorizedTarget),
      ),
    ).resolves.toEqual({ status: "submitted-uncertain", submitCount: 1 });
    expect(operations.submitAuthorizedDraft).toHaveBeenCalledTimes(1);
  });

  it("recovers by readback only without prepare, verify-draft, or submit", async () => {
    const order: string[] = [];
    const operations = deliveryOperations(order);
    const delivery = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, operations),
    );

    await expect(
      executeRecoveryDelivery(
        delivery,
        directory,
        authorizedTarget,
        deliveryIntent(authorizedTarget),
      ),
    ).resolves.toBe("submitted-uncertain");
    expect(order).toEqual([]);
    expect(operations.submitAuthorizedDraft).not.toHaveBeenCalled();
  });

  it("keeps pre-submit failure outside the uncertainty boundary", async () => {
    const order: string[] = [];
    const operations = deliveryOperations(order);
    vi.mocked(operations.prepare).mockRejectedValueOnce(
      new Error("VERIFY_PREPARED_FAILED"),
    );
    const markSubmitStarted = vi.fn().mockResolvedValue(true);
    const delivery = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, operations, markSubmitStarted),
    );

    await expect(
      executePreparedDelivery(
        delivery,
        directory,
        authorizedTarget,
        deliveryIntent(authorizedTarget),
      ),
    ).rejects.toThrow("VERIFY_PREPARED_FAILED");
    expect(markSubmitStarted).not.toHaveBeenCalled();
    expect(operations.submitAuthorizedDraft).not.toHaveBeenCalled();
  });

  it("keeps a rejected submit fence before the irreversible action at attempted false", async () => {
    const order: string[] = [];
    const operations = deliveryOperations(order);
    const repository = new RejectingDeliveryFenceRepository();
    const delivery = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, operations),
    );

    await expect(
      executePreparedDelivery(
        delivery,
        directory,
        authorizedTarget,
        deliveryIntent(authorizedTarget),
        { repository },
      ),
    ).rejects.toThrow("LEDGER_FENCE_FAILED");
    expect(order).toEqual(["prepare"]);
  });

  it("mints a fresh private session per call while a replayed delivery key fences at zero submit", async () => {
    const order: string[] = [];
    const operations = deliveryOperations(order);
    const markSubmitStarted = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const delivery = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, operations, markSubmitStarted),
    );
    const claim = await capturePreparedClaim(
      directory,
      authorizedTarget,
      deliveryIntent(authorizedTarget),
    );

    await expect(delivery.deliver(claim)).resolves.toEqual({
      status: "verified",
      submitCount: 1,
    });
    await expect(delivery.deliver(claim)).rejects.toThrow(
      "REALTIME_PREPARED_CLAIM_INVALID",
    );
    expect(order.filter((phase) => phase === "submit")).toHaveLength(1);
  });

  it.each(["manual-outgoing", "STOP"] as const)(
    "rechecks the authorized conversation after prepare and blocks %s before the fence",
    async (change) => {
      const operations = deliveryOperations([]);
      const markSubmitStarted = vi.fn().mockResolvedValue(true);
      let reads = 0;
      const delivery = createMcpContactReplyDelivery(
        directory,
        deliveryAdmission(directory, operations, markSubmitStarted, {
          readAuthorizedConversation: (target) => {
            reads += 1;
            return Promise.resolve(
              reads === 1
                ? deliverySnapshot(target, [
                    { id: "c".repeat(64), direction: "incoming", text: "在吗" },
                  ])
                : deliverySnapshot(target, [
                    { id: "c".repeat(64), direction: "incoming", text: "在吗" },
                    {
                      id: "e".repeat(64),
                      direction:
                        change === "manual-outgoing" ? "outgoing" : "incoming",
                      text: change === "manual-outgoing" ? "我手动回复了" : "STOP",
                    },
                  ]),
            );
          },
        }),
      );

      await expect(
        executePreparedDelivery(
          delivery,
          directory,
          authorizedTarget,
          deliveryIntent(authorizedTarget),
        ),
      ).rejects.toThrow("REALTIME_OWNER_REPLIED");
      expect(operations.prepare).toHaveBeenCalledTimes(1);
      expect(markSubmitStarted).not.toHaveBeenCalled();
      expect(operations.submitAuthorizedDraft).not.toHaveBeenCalled();
    },
  );

  it("verifies restart readback only for one candidate-specific outgoing append", async () => {
    const intent = deliveryIntent(authorizedTarget);
    const incomingHash = createHash("sha256").update("在吗").digest("hex");
    const replyHash = createHash("sha256").update(intent.replyText).digest("hex");
    const baseline = {
      version: 1 as const,
      windowRevision: "e".repeat(64),
      expectedTextHash: replyHash,
      messages: [
        { direction: "incoming" as const, textHash: incomingHash, confidence: 0.99 },
      ],
    };
    const exact = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, deliveryOperations([]), undefined, {
        readAuthorizedConversation: (target) =>
          Promise.resolve(
            deliverySnapshot(target, [
              { id: "c".repeat(64), direction: "incoming", text: "在吗" },
              { id: "d".repeat(64), direction: "outgoing", text: intent.replyText },
            ]),
          ),
      }),
    );
    await expect(
      executeRecoveryDelivery(
        exact,
        directory,
        authorizedTarget,
        intent,
        baseline,
      ),
    ).resolves.toBe("verified");

    const historicalBaseline = {
      ...baseline,
      messages: [
        ...baseline.messages,
        { direction: "outgoing" as const, textHash: replyHash, confidence: 0.99 },
      ],
    };
    await expect(
      executeRecoveryDelivery(
        exact,
        directory,
        authorizedTarget,
        intent,
        historicalBaseline,
      ),
    ).resolves.toBe("submitted-uncertain");
  });

  it("stops a sealed delivery session after close while prepare is awaiting", async () => {
    let releasePrepare!: () => void;
    let prepareEntered!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      prepareEntered = resolve;
    });
    const operations = deliveryOperations([]);
    vi.mocked(operations.prepare).mockImplementationOnce(async () => {
      prepareEntered();
      await prepareGate;
      return { candidateToken: "d".repeat(64) };
    });
    const markSubmitStarted = vi.fn().mockResolvedValue(true);
    const delivery = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, operations, markSubmitStarted),
    );
    let service: RealtimeReplyService | undefined;
    const attempt = executePreparedDelivery(
      delivery,
      directory,
      authorizedTarget,
      deliveryIntent(authorizedTarget),
      { onService: (value) => { service = value; } },
    );
    await entered;
    const stopping = service?.stop();
    releasePrepare();

    await expect(attempt).rejects.toThrow(
      "SCHEDULED_P1_OWNER_CAPABILITY_INVALID",
    );
    expect(markSubmitStarted).not.toHaveBeenCalled();
    expect(operations.submitAuthorizedDraft).not.toHaveBeenCalled();
    await stopping;
  });

  it("retains the shared root until an aborted prepare phase has safely drained", async () => {
    let releasePrepare!: () => void;
    let prepareEntered!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      prepareEntered = resolve;
    });
    const store = new EncryptedStore(
      deliveryRoot,
      new FixedKeyProvider(randomBytes(32)),
    );
    const coordinator = await acquireLiveOperationCoordinator({
      dataDir: deliveryRoot,
      ownerKind: "mcp",
    });
    const sharedRuntime = createSharedLiveProductionRuntime({
      coordinator,
      store,
      dataDir: deliveryRoot,
    });
    const operations = deliveryOperations([]);
    vi.mocked(operations.prepare).mockImplementationOnce(async () => {
      prepareEntered();
      await prepareGate;
      return { candidateToken: "d".repeat(64) };
    });
    const delivery = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, operations, undefined, { sharedRuntime }),
    );
    let service: RealtimeReplyService | undefined;
    const attempt = executePreparedDelivery(
      delivery,
      directory,
      authorizedTarget,
      deliveryIntent(authorizedTarget),
      { onService: (value) => { service = value; } },
    );
    await entered;

    await expect(
      closeSharedLiveProductionRuntime(sharedRuntime, 5),
    ).rejects.toThrow("SHARED_LIVE_RUNTIME_DRAIN_TIMEOUT");
    const stopping = service?.stop();
    releasePrepare();
    await expect(attempt).rejects.toThrow(
      "SCHEDULED_P1_OWNER_CAPABILITY_INVALID",
    );
    await expect(
      closeSharedLiveProductionRuntime(sharedRuntime, 500),
    ).resolves.toBeUndefined();
    await stopping;
  });

  it("does not export owner-based delivery or recovery entry points", async () => {
    const scheduler =
      (await import("../../src/runtime-v2/single-scheduler.js")) as Record<
        string,
        unknown
      >;
    expect(Object.keys(scheduler)).not.toEqual(
      expect.arrayContaining([
        "deliverScheduledP1",
        "recoverScheduledP1",
        "deliverWithScheduledP1Admission",
        "recoverWithScheduledP1Admission",
      ]),
    );
  });

  it("rejects a forged contact-bound delivery facade before any phase can run", () => {
    expect(() =>
      createMcpContactReplyDelivery(directory, {} as never),
    ).toThrow("SCHEDULED_P1_DELIVERY_FACADE_INVALID");
  });

  it("rejects arbitrary structural input at the opaque claim boundary", async () => {
    const operations = deliveryOperations([]);
    const delivery = createMcpContactReplyDelivery(
      directory,
      deliveryAdmission(directory, operations),
    );
    const clone = structuredClone(authorizedTarget);

    await expect(
      delivery.deliver({
        target: clone,
        intent: deliveryIntent(clone),
        signal: new AbortController().signal,
      } as unknown as PreparedReplyClaim),
    ).rejects.toThrow("REALTIME_PREPARED_CLAIM_INVALID");
    expect(operations.prepare).not.toHaveBeenCalled();
  });
});

function ocrLine(text: string, x: number, y: number): OCRLine {
  return {
    text,
    confidence: 0.99,
    bounds: { x, y, width: 0.12, height: 0.025 },
  };
}

function checkpointFromControl(
  control: Awaited<ReturnType<StateRepository["getControlState"]>>,
) {
  return {
    epoch: control.controlBoundary.epoch,
    boundaryMessageId: control.controlBoundary.boundaryMessageId,
    consumedCount: control.controlBoundary.consumedCount,
    prefixChainHash: control.controlBoundary.prefixChainHash,
  };
}

function differentRevision(revision: string): string {
  return `${revision.startsWith("0") ? "1" : "0"}${revision.slice(1)}`;
}

async function makeTreeWritable(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await chmod(directory, 0o700);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeTreeWritable(target);
    } else if (!entry.isSymbolicLink()) {
      await chmod(target, 0o600);
    }
  }
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined)
        throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise();
    },
  };
}

async function flushAsyncTurns(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function activateControlBoundary(
  repository: StateRepository,
): Promise<void> {
  const issued = await repository.issueControlBoundary();
  await repository.activateControlBoundary({
    expectedEpoch: issued.epoch,
    boundaryMessageId: issued.boundaryMessageId,
    markerOccurrenceCount: 1,
  });
}

function deliveryIntent(target: AuthorizedWechatTarget): ReplyIntent {
  const sourceMessageIds = ["c".repeat(64)];
  const triggerId = deriveConversationTriggerId({
    contactId: target.contactId,
    contactRevision: target.revision,
    bindingHash: target.bindingHash,
    source: "native-ocr",
    sourceEpoch: "source-epoch",
    sessionId: "session-id",
    sourceMessageIds,
  });
  const replyText = "收到啦";
  return {
    contractVersion: 1,
    status: "prepared",
    triggerId,
    conversationId: target.contactId,
    contactId: target.contactId,
    contactRevision: target.revision,
    bindingHash: target.bindingHash,
    source: "native-ocr",
    sourceEpoch: "source-epoch",
    sessionId: "session-id",
    replyText,
    sourceMessageIds,
    deliveryKey: deriveReplyDeliveryKey({
      triggerId,
      contactId: target.contactId,
      contactRevision: target.revision,
      bindingHash: target.bindingHash,
      replyText,
    }),
  };
}

function deliverySnapshot(
  target: AuthorizedWechatTarget,
  messages: ReadonlyArray<{
    readonly id: string;
    readonly direction: "incoming" | "outgoing";
    readonly text: string;
  }>,
): NativeAuthorizedConversationSnapshot {
  const windowRevision = "e".repeat(64);
  const latestIncoming = [...messages]
    .reverse()
    .find((message) => message.direction === "incoming");
  return {
    conversationId: target.contactId,
    identity: {
      conversationId: target.contactId,
      visibleName: target.displayName,
      enrollmentFingerprint: target.enrollmentFingerprint,
      observedFingerprint: target.enrollmentFingerprint,
      confidence: 0.99,
    },
    messages: messages.map((message) => ({
      ...message,
      conversationId: target.contactId,
      kind: "text" as const,
      occurredAt: "2026-08-31T00:00:00.000Z",
      confidence: 0.99,
    })),
    windowRevision,
    ...(latestIncoming === undefined
      ? {}
      : {
          latestIncomingEvidence: {
            version: 1 as const,
            proofId: "f".repeat(64),
            messageId: latestIncoming.id,
            observedMinute: "2026-08-31T00:00",
            confidence: 0.99,
            contactId: target.contactId,
            contactRevision: target.revision,
            windowRevision,
          },
        }),
  };
}

function deliveryAdmission(
  directory: ContactDirectory,
  operations: DeliveryTestOperations = deliveryOperations([]),
  _markSubmitStarted: () => Promise<boolean> = () => Promise.resolve(true),
  options: {
    readonly readAuthorizedConversation?: (
      target: AuthorizedWechatTarget,
    ) => Promise<NativeAuthorizedConversationSnapshot>;
    readonly isStopped?: () => Promise<boolean>;
    readonly sharedRuntime?: SharedLiveProductionRuntime;
  } = {},
) {
  return createProductionScheduledRuntime({
    directory,
    getSurface: () => ({
      prepareAuthorizedTextDraft: (input) => operations.prepare(input),
      submitAuthorizedTextDraft: (input) =>
        operations.submitAuthorizedDraft(input),
    }),
    repository: {
      compareAndSet: () => _markSubmitStarted(),
    },
    now: () => new Date("2026-08-31T00:00:10.000Z"),
    isStopped: options.isStopped ?? (() => Promise.resolve(false)),
    sharedRuntime: options.sharedRuntime,
    readAuthorizedConversation:
      options.readAuthorizedConversation ?? ((target) =>
      Promise.resolve({
        conversationId: target.contactId,
        identity: {
          conversationId: target.contactId,
          visibleName: target.displayName,
          enrollmentFingerprint: target.enrollmentFingerprint,
          observedFingerprint: target.enrollmentFingerprint,
          confidence: 0.99,
        },
        messages: [
          {
            id: "c".repeat(64),
            conversationId: target.contactId,
            direction: "incoming" as const,
            kind: "text" as const,
            text: "你好",
            occurredAt: "2026-08-31T00:00:00.000Z",
            confidence: 0.99,
          },
        ],
        windowRevision: "e".repeat(64),
        latestIncomingEvidence: {
          version: 1 as const,
          proofId: "f".repeat(64),
          messageId: "c".repeat(64),
          observedMinute: "2026-08-31T00:00",
          confidence: 0.99,
          contactId: target.contactId,
          contactRevision: target.revision,
          windowRevision: "e".repeat(64),
        },
      })),
  }).delivery;
}

async function executePreparedDelivery(
  delivery: ContactReplyDelivery,
  directory: ContactDirectory,
  target: AuthorizedWechatTarget,
  intent: ReplyIntent,
  options: {
    readonly repository?: InMemoryRealtimeReplyRepository;
    readonly onService?: (service: RealtimeReplyService) => void;
  } = {},
): Promise<{ status: "verified" | "submitted-uncertain"; submitCount: 1 }> {
  const repository = options.repository ?? new InMemoryRealtimeReplyRepository();
  await seedDeliveryRecord(repository, target, intent, "prepared");
  let result:
    | { status: "verified" | "submitted-uncertain"; submitCount: 1 }
    | undefined;
  let failure: Error | undefined;
  const service = claimMintingService(directory, repository, {
    deliver: async (claim) => {
      try {
        result = await delivery.deliver(claim);
        return result;
      } catch (error: unknown) {
        failure =
          error instanceof Error ? error : new Error("TEST_DELIVERY_FAILED");
        throw error;
      }
    },
  });
  options.onService?.(service);
  await service.recoverPending(new Date("2026-08-31T00:00:10.000Z"));
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error("TEST_DELIVERY_NOT_INVOKED");
  return result;
}

async function executeRecoveryDelivery(
  delivery: ContactReplyDelivery,
  directory: ContactDirectory,
  target: AuthorizedWechatTarget,
  intent: ReplyIntent,
  baseline: Parameters<typeof seedDeliveryRecord>[4] = null,
): Promise<"verified" | "submitted-uncertain"> {
  const repository = new InMemoryRealtimeReplyRepository();
  await seedDeliveryRecord(
    repository,
    target,
    intent,
    "submitted-uncertain",
    baseline,
  );
  let result: "verified" | "submitted-uncertain" | undefined;
  const service = claimMintingService(directory, repository, {
    deliver: () => Promise.reject(new Error("UNEXPECTED_DELIVERY")),
    recoverSubmitted: async (claim) => {
      if (delivery.recoverSubmitted === undefined)
        throw new Error("TEST_RECOVERY_UNAVAILABLE");
      result = await delivery.recoverSubmitted(claim);
      return result;
    },
  });
  await service.recoverPending(new Date("2026-08-31T00:00:10.000Z"));
  if (result === undefined) throw new Error("TEST_RECOVERY_NOT_INVOKED");
  return result;
}

async function capturePreparedClaim(
  directory: ContactDirectory,
  target: AuthorizedWechatTarget,
  intent: ReplyIntent,
): Promise<PreparedReplyClaim> {
  const repository = new InMemoryRealtimeReplyRepository();
  await seedDeliveryRecord(repository, target, intent, "prepared");
  let captured: PreparedReplyClaim | undefined;
  const service = claimMintingService(directory, repository, {
    deliver: (claim) => {
      captured = claim;
      return Promise.resolve({ status: "verified", submitCount: 1 });
    },
  });
  await service.recoverPending(new Date("2026-08-31T00:00:10.000Z"));
  if (captured === undefined) throw new Error("TEST_CLAIM_NOT_MINTED");
  return captured;
}

function claimMintingService(
  directory: ContactDirectory,
  repository: InMemoryRealtimeReplyRepository,
  delivery: ConstructorParameters<typeof RealtimeReplyService>[0]["delivery"],
): RealtimeReplyService {
  const source = {
    start: () => Promise.resolve(),
    poll: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return new RealtimeReplyService({
    bufferWindowMs: 1,
    detector: { scan: () => Promise.resolve([]) } as never,
    directory,
    createSource: () => source as never,
    createCoordinator: () => Promise.reject(new Error("UNEXPECTED_COORDINATOR")),
    admission: {
      announcePending: () => () => undefined,
      quarantine: () => undefined,
      isQuarantined: () => false,
    },
    delivery,
    repository,
    now: () => new Date("2026-08-31T00:00:10.000Z"),
  });
}

async function seedDeliveryRecord(
  repository: InMemoryRealtimeReplyRepository,
  target: AuthorizedWechatTarget,
  intent: ReplyIntent,
  status: "prepared" | "submitted-uncertain",
  baseline: import("../../src/storage/repositories.js").RealtimeReadbackBaseline | null = null,
): Promise<void> {
  const key = {
    contactId: target.contactId,
    contactRevision: target.revision,
    bindingHash: target.bindingHash,
    triggerId: intent.triggerId,
  };
  await repository.claim({
    target,
    triggerId: intent.triggerId,
    source: intent.source,
    sourceEpoch: intent.sourceEpoch,
    sessionId: intent.sessionId,
    messages: [{
      contractVersion: 1,
      source: intent.source,
      sourceEpoch: intent.sourceEpoch,
      sessionId: intent.sessionId,
      conversationId: target.contactId,
      messageId: intent.sourceMessageIds[0]!,
      sequence: 1,
      occurredAt: "2026-08-31T00:00:00.000Z",
      direction: "incoming",
      kind: "text",
      text: "你好",
    }],
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  await repository.compareAndSet({
    key,
    expectedStatus: "new",
    next: { status: "generating" },
    now: new Date("2026-08-31T00:00:00.100Z"),
  });
  await repository.compareAndSet({
    key,
    expectedStatus: "generating",
    next: { status: "prepared", intent },
    now: new Date("2026-08-31T00:00:00.200Z"),
  });
  if (status === "submitted-uncertain") {
    await repository.compareAndSet({
      key,
      expectedStatus: "prepared",
      next: { status: "submit-started", ...(baseline === null ? {} : { readbackBaseline: baseline }) },
      now: new Date("2026-08-31T00:00:00.300Z"),
    });
    await repository.compareAndSet({
      key,
      expectedStatus: "submit-started",
      next: { status: "submitted-uncertain" },
      now: new Date("2026-08-31T00:00:00.400Z"),
    });
  }
}

class RejectingDeliveryFenceRepository extends InMemoryRealtimeReplyRepository {
  public override compareAndSet(
    input: Parameters<InMemoryRealtimeReplyRepository["compareAndSet"]>[0],
  ): Promise<boolean> {
    if (
      input.expectedStatus === "prepared" &&
      input.next.status === "submit-started"
    ) {
      return Promise.reject(new Error("LEDGER_FENCE_FAILED"));
    }
    return super.compareAndSet(input);
  }
}

function deliveryFeatureSample(byte: number): string {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

function deliveryEnrollmentFingerprint(samples: readonly string[]): string {
  return createHash("sha256")
    .update(
      [
        "2",
        "contact-33333333333333333333333333333333",
        "交付联系人",
        "vision-featureprint-v1",
        "0.18",
        ...samples,
      ].join("\0"),
    )
    .digest("hex");
}

interface DeliveryTestOperations {
  readonly prepare: (input: {
    readonly contactId: AuthorizedWechatTarget["contactId"];
    readonly expectedRevision: number;
    readonly text: string;
    readonly slotKey: string;
  }) => Promise<unknown>;
  readonly submitAuthorizedDraft: (input: {
    readonly contactId: AuthorizedWechatTarget["contactId"];
    readonly expectedRevision: number;
    readonly markSubmitStarted: () => Promise<boolean>;
  }) => Promise<{ readonly attempted: boolean }>;
}

function deliveryOperations(order: string[]): DeliveryTestOperations {
  return {
    prepare: vi.fn().mockImplementation(() => {
      order.push("prepare");
      return Promise.resolve({ candidateToken: "d".repeat(64) });
    }),
    submitAuthorizedDraft: vi
      .fn()
      .mockImplementation(
        async (input: { markSubmitStarted: () => Promise<boolean> }) => {
          if (!(await input.markSubmitStarted()))
            return { attempted: false as const };
          order.push("submit");
          return { attempted: true as const };
        },
      ),
  };
}
