import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthorizedWechatTarget } from "../../src/contacts/contact-directory.js";
import {
  NativeOcrInboundSource,
  type NativeOcrConversationSnapshot,
} from "../../src/conversation/native-ocr-inbound-source.js";
import {
  acquireLiveOperationCoordinator,
  acquireLiveOperationChildAdmission,
  type LiveOperationChildAdmission,
  type LiveOperationCoordinator,
} from "../../src/mcp/live-operation-coordinator.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { InboundCursorRepository } from "../../src/storage/inbound-cursor-repository.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

const target: AuthorizedWechatTarget = {
  contactId: "contact-0123456789abcdef0123456789abcdef",
  displayName: "我",
  revision: 3,
  enrollment: {
    version: 2,
    contactId: "contact-0123456789abcdef0123456789abcdef",
    displayName: "我",
    fingerprintVersion: "vision-featureprint-v1",
    referenceSamples: [],
    enrolledAt: "2026-08-31T04:00:00.000Z",
  },
  enrollmentFingerprint: "a".repeat(64),
  bindingHash: "b".repeat(64),
};

function message(text: string, direction: "incoming" | "outgoing" = "incoming") {
  return {
    id: `${direction}:${text}`,
    conversationId: target.contactId,
    direction,
    kind: "text" as const,
    text,
    occurredAt: "2026-08-31T04:00:00.000Z",
    confidence: 0.99,
  };
}

function snapshot(messages: NativeOcrConversationSnapshot["messages"]): NativeOcrConversationSnapshot {
  return {
    conversationId: target.contactId,
    identity: {
      conversationId: target.contactId,
      visibleName: target.displayName,
      enrollmentFingerprint: target.enrollmentFingerprint,
      confidence: 0.99,
    },
    messages,
    windowRevision: "c".repeat(64),
  };
}

function withProof(value: NativeOcrConversationSnapshot, proofId = "d".repeat(64)) {
  const latest = value.messages.at(-1);
  if (latest === undefined) throw new Error("LATEST_REQUIRED");
  return { ...value, latestIncomingEvidence: {
    version: 1 as const, proofId, messageId: latest.id, observedMinute: "04:00", confidence: 0.99,
    contactId: target.contactId,
    contactRevision: target.revision,
    windowRevision: value.windowRevision,
  } };
}

describe("NativeOcrInboundSource dynamic cursor", () => {
  const roots: string[] = [];
  const coordinators: LiveOperationCoordinator[] = [];
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function context() {
    const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-ocr-source-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const liveOwner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    coordinators.push(liveOwner);
    const deliveryAdmission = acquireLiveOperationChildAdmission(liveOwner, "inbound-delivery");
    return { root, key: randomBytes(32), liveOwner, deliveryAdmission };
  }

  function source(input: {
    root: string;
    key: Buffer;
    deliveryAdmission: LiveOperationChildAdmission;
    pages: Array<NativeOcrConversationSnapshot | Error>;
    directory?: { requireActiveAutoReplyTarget: () => Promise<AuthorizedWechatTarget> };
  }) {
    let index = 0;
    const events: Array<{ text: string; messageId: string; sequence: number }> = [];
    const instance = new NativeOcrInboundSource({
      sourceEpoch: "epoch-1",
      sessionId: "session-plaintext",
      target,
      directory: input.directory ?? { requireActiveAutoReplyTarget: () => Promise.resolve(target) },
      cursorRepository: new InboundCursorRepository(
        new EncryptedStore(input.root, new FixedKeyProvider(input.key)),
      ),
      deliveryAdmission: input.deliveryAdmission,
      readSnapshot: () => {
        const result = input.pages[index];
        index += 1;
        if (result === undefined) throw new Error("NO_PAGE");
        if (result instanceof Error) throw result;
        return Promise.resolve(result);
      },
    });
    return { instance, events };
  }

  it("baselines history, emits strict append, and does not replay after process restart", async () => {
    const ctx = await context();
    const old = snapshot([message("旧消息")]);
    const current = snapshot([...old.messages, message("新消息")]);
    const first = source({ ...ctx, pages: [old, current] });
    await first.instance.start({ onMessage: (event) => { first.events.push(event); }, onStatus: () => undefined });
    await first.instance.poll();
    expect(first.events).toEqual([expect.objectContaining({ text: "新消息", sequence: 1 })]);

    const restarted = source({ ...ctx, pages: [current, current] });
    await restarted.instance.start({ onMessage: (event) => { restarted.events.push(event); }, onStatus: () => undefined });
    await restarted.instance.poll();
    expect(restarted.events).toEqual([]);
  });

  it("does not advance the durable cursor when the handler fails", async () => {
    const ctx = await context();
    const current = snapshot([message("需要重试")]);
    const first = source({ ...ctx, pages: [snapshot([]), current] });
    await first.instance.start({ onMessage: () => { throw new Error("HANDLER_FAILED"); }, onStatus: () => undefined });
    await expect(first.instance.poll()).rejects.toThrow("HANDLER_FAILED");

    const retry = source({ ...ctx, pages: [current, current] });
    await retry.instance.start({ onMessage: (event) => { retry.events.push(event); }, onStatus: () => undefined });
    await retry.instance.poll();
    expect(retry.events).toEqual([expect.objectContaining({ text: "需要重试", sequence: 1 })]);
  });

  it("does not over-advance a three-message append when the third handler crashes", async () => {
    const ctx = await context();
    const current = snapshot([message("A"), message("B"), message("C")]);
    const first = source({ ...ctx, pages: [snapshot([]), current] });
    const attempted: string[] = [];
    await first.instance.start({
      onMessage: (event) => {
        attempted.push(event.text);
        if (event.text === "C") throw new Error("THIRD_HANDLER_CRASH");
      },
      onStatus: () => undefined,
    });
    await expect(first.instance.poll()).rejects.toThrow("THIRD_HANDLER_CRASH");
    expect(attempted).toEqual(["A", "B", "C"]);

    const restarted = source({ ...ctx, pages: [current, current] });
    await restarted.instance.start({
      onMessage: (event) => { restarted.events.push(event); },
      onStatus: () => undefined,
    });
    await restarted.instance.poll();
    expect(restarted.events).toEqual([expect.objectContaining({ text: "C", sequence: 3 })]);
  });

  it("holds a cross-instance delivery lease before invoking either handler", async () => {
    const ctx = await context();
    const current = snapshot([message("只能交付一次")]);
    const first = source({ ...ctx, pages: [snapshot([]), current] });
    const second = source({ ...ctx, pages: [snapshot([]), current] });
    let effects = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handler = async () => {
      effects += 1;
      if (effects === 1) await held;
    };
    await first.instance.start({ onMessage: handler, onStatus: () => undefined });
    await second.instance.start({ onMessage: handler, onStatus: () => undefined });
    const polls = [first.instance.poll(), second.instance.poll()];
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(effects).toBe(1);
    release?.();
    await Promise.all(polls);
    expect(effects).toBe(1);
    expect([first.instance.getStatus().state, second.instance.getStatus().state])
      .not.toContain("processing");
  });

  it("uses the production live owner as one shared admission without reacquiring it", async () => {
    const ctx = await context();
    const current = snapshot([message("共享 owner 只交付一次")]);
    const first = source({ ...ctx, pages: [snapshot([]), current] });
    const second = source({ ...ctx, pages: [snapshot([]), current] });
    const effects: string[] = [];
    const handlers = { onMessage: (event: { text: string }) => { effects.push(event.text); }, onStatus: () => undefined };

    await first.instance.start(handlers);
    await second.instance.start(handlers);
    await Promise.all([first.instance.poll(), second.instance.poll()]);

    expect(effects).toEqual(["共享 owner 只交付一次"]);
    expect(first.instance.getStatus().state).toBe("waiting");
    expect(second.instance.getStatus().state).toBe("waiting");
  });

  it("lets handler and status callbacks re-enter the production coordinator and encrypted store", async () => {
    const ctx = await context();
    const current = snapshot([message("回调可重入")]);
    const harness = source({ ...ctx, pages: [snapshot([]), current] });
    const callbackStore = new EncryptedStore(ctx.root, new FixedKeyProvider(ctx.key));
    let reentries = 0;
    await harness.instance.start({
      onMessage: async (event) => {
        await ctx.liveOwner.runExclusive(async () => {
          await callbackStore.runExclusiveTransaction("state/callback.lock", () => {
            reentries += 1;
            return Promise.resolve();
          });
        });
        harness.events.push(event);
      },
      onStatus: async (status) => {
        if (status.state === "waiting") {
          await ctx.liveOwner.runExclusive(() => {
            reentries += 1;
            return Promise.resolve();
          });
        }
      },
    });
    const outcome = await Promise.race([
      harness.instance.poll().then(() => "completed" as const),
      delay(500).then(() => "blocked" as const),
    ]);

    expect(outcome).toBe("completed");
    expect(reentries).toBeGreaterThanOrEqual(3);
    expect(harness.events).toEqual([expect.objectContaining({ text: "回调可重入" })]);
  });

  it("caches one opaque admission per owner and rejects a structural fake", async () => {
    const ctx = await context();
    expect(acquireLiveOperationChildAdmission(ctx.liveOwner, "inbound-delivery"))
      .toBe(ctx.deliveryAdmission);
    expect(() => source({
      ...ctx,
      deliveryAdmission: { runExclusive: (operation) => operation({ assertCurrent: () => undefined }) },
      pages: [snapshot([])],
    })).toThrow("OCR_DELIVERY_ADMISSION_REQUIRED");
  });

  it("fails closed when the production owner is no longer live", async () => {
    const ctx = await context();
    await ctx.liveOwner.close();
    await expect(ctx.deliveryAdmission.runExclusive(() => Promise.resolve("never")))
      .rejects.toThrow("LIVE_RUNTIME_CLOSED");
  });

  it("fences cursor CAS when owner close begins while the handler is blocked", async () => {
    const ctx = await context();
    const cursorRepository = new InboundCursorRepository(
      new EncryptedStore(ctx.root, new FixedKeyProvider(ctx.key)),
    );
    const commit = vi.spyOn(cursorRepository, "commitDelivered");
    let reads = 0;
    let handlerStarted: (() => void) | undefined;
    let releaseHandler: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const events: string[] = [];
    const instance = new NativeOcrInboundSource({
      sourceEpoch: "epoch-1",
      sessionId: "session-plaintext",
      target,
      directory: { requireActiveAutoReplyTarget: () => Promise.resolve(target) },
      cursorRepository,
      deliveryAdmission: ctx.deliveryAdmission,
      readSnapshot: () => Promise.resolve(reads++ === 0 ? snapshot([]) : snapshot([message("处理中关闭")])),
    });
    await instance.start({
      onMessage: async (event) => {
        events.push(event.text);
        handlerStarted?.();
        await gate;
      },
      onStatus: () => undefined,
    });
    const poll = instance.poll();
    await started;
    const closing = ctx.liveOwner.close();
    releaseHandler?.();

    await expect(poll).rejects.toThrow("LIVE_RUNTIME_CLOSED");
    await closing;
    expect(events).toEqual(["处理中关闭"]);
    expect(commit).not.toHaveBeenCalled();
    expect((await cursorRepository.read(target.contactId))?.nextSequence).toBe(1);
  });

  it("holds the owner lease while an already-started cursor CAS drains, then fences later effects", async () => {
    const ctx = await context();
    const cursorRepository = new InboundCursorRepository(
      new EncryptedStore(ctx.root, new FixedKeyProvider(ctx.key)),
    );
    const originalCommit = cursorRepository.commitDelivered.bind(cursorRepository);
    let casStarted: (() => void) | undefined;
    let releaseCas: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { casStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseCas = resolve; });
    vi.spyOn(cursorRepository, "commitDelivered").mockImplementation(async (input) => {
      casStarted?.();
      await gate;
      return originalCommit(input);
    });
    let reads = 0;
    const statuses: string[] = [];
    const instance = new NativeOcrInboundSource({
      sourceEpoch: "epoch-1",
      sessionId: "session-plaintext",
      target,
      directory: { requireActiveAutoReplyTarget: () => Promise.resolve(target) },
      cursorRepository,
      deliveryAdmission: ctx.deliveryAdmission,
      readSnapshot: () => Promise.resolve(reads++ === 0 ? snapshot([]) : snapshot([message("CAS 关闭")])),
    });
    await instance.start({
      onMessage: () => undefined,
      onStatus: (status) => { statuses.push(status.state); },
    });
    const poll = instance.poll();
    await started;
    const closing = ctx.liveOwner.close();

    await expect(acquireLiveOperationCoordinator({ dataDir: ctx.root, ownerKind: "cli" }))
      .rejects.toThrow("LIVE_RUNTIME_BUSY");
    const statusCountAtClose = statuses.length;
    releaseCas?.();
    await expect(poll).rejects.toThrow("LIVE_RUNTIME_CLOSED");
    await closing;
    expect(statuses).toHaveLength(statusCountAtClose);
    expect((await cursorRepository.read(target.contactId))?.nextSequence).toBe(2);
    const successor = await acquireLiveOperationCoordinator({ dataDir: ctx.root, ownerKind: "cli" });
    await successor.close();
  });

  it("recovers on the same instance after a transient handler failure", async () => {
    const ctx = await context();
    const current = snapshot([message("同实例重试")]);
    const harness = source({ ...ctx, pages: [snapshot([]), current, current] });
    let attempts = 0;
    await harness.instance.start({
      onMessage: (event) => {
        attempts += 1;
        if (attempts === 1) throw new Error("TRANSIENT_HANDLER_FAILURE");
        harness.events.push(event);
      },
      onStatus: () => undefined,
    });
    await expect(harness.instance.poll()).rejects.toThrow("TRANSIENT_HANDLER_FAILURE");
    expect(harness.instance.getStatus()).toMatchObject({ state: "degraded" });
    await harness.instance.poll();
    expect(harness.events).toEqual([expect.objectContaining({ text: "同实例重试", sequence: 1 })]);
    expect(harness.instance.getStatus()).toMatchObject({ state: "waiting" });
  });

  it("recovers on the same instance after a transient snapshot read failure", async () => {
    const ctx = await context();
    const current = snapshot([message("读取恢复")]);
    const harness = source({
      ...ctx,
      pages: [snapshot([]), new Error("TRANSIENT_CAPTURE_FAILURE"), current],
    });
    await harness.instance.start({
      onMessage: (event) => { harness.events.push(event); },
      onStatus: () => undefined,
    });
    await expect(harness.instance.poll()).rejects.toThrow("TRANSIENT_CAPTURE_FAILURE");
    expect(harness.instance.getStatus()).toMatchObject({ state: "degraded" });
    await harness.instance.poll();
    expect(harness.events).toEqual([expect.objectContaining({ text: "读取恢复", sequence: 1 })]);
    expect(harness.instance.getStatus()).toMatchObject({ state: "waiting" });
  });

  it("fails closed when a dynamic source has no shared delivery admission", () => {
    expect(() => new NativeOcrInboundSource({
      sourceEpoch: "epoch-1",
      sessionId: "session-plaintext",
      target,
      directory: { requireActiveAutoReplyTarget: () => Promise.resolve(target) },
      cursorRepository: {} as InboundCursorRepository,
      readSnapshot: () => Promise.resolve(snapshot([])),
    } as never)).toThrow("OCR_DELIVERY_ADMISSION_REQUIRED");
  });

  it("cannot mint an admission from a structural fake owner", () => {
    const fake = {
      runExclusive: <T>(operation: () => Promise<T>) => operation(),
      close: () => Promise.resolve(),
    };
    expect(() => acquireLiveOperationChildAdmission(fake, "inbound-delivery"))
      .toThrow("LIVE_OPERATION_OWNER_INVALID");
  });

  it("does not deliver or revive waiting when processing status stops the source", async () => {
    const ctx = await context();
    const harness = source({
      ...ctx,
      pages: [snapshot([]), snapshot([message("停止后不得交付")])],
    });
    await harness.instance.start({
      onMessage: (event) => { harness.events.push(event); },
      onStatus: async (status) => {
        if (status.state === "processing") await harness.instance.stop();
      },
    });

    await expect(harness.instance.poll()).rejects.toThrow("OCR_SOURCE_LIFECYCLE_CHANGED");
    expect(harness.events).toEqual([]);
    expect(harness.instance.getStatus()).toMatchObject({ state: "stopped", reason: "SOURCE_STOPPED" });
  });

  it("fences a concurrent close after snapshot read before delivery or cursor commit", async () => {
    const ctx = await context();
    let release: (() => void) | undefined;
    let snapshotStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const root = ctx.root;
    const key = ctx.key;
    const cursorRepository = new InboundCursorRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    );
    let reads = 0;
    const events: string[] = [];
    const instance = new NativeOcrInboundSource({
      sourceEpoch: "epoch-1",
      sessionId: "session-plaintext",
      target,
      directory: { requireActiveAutoReplyTarget: () => Promise.resolve(target) },
      cursorRepository,
      deliveryAdmission: ctx.deliveryAdmission,
      readSnapshot: async () => {
        reads += 1;
        if (reads === 1) return snapshot([]);
        snapshotStarted?.();
        await gate;
        return snapshot([message("并发关闭后不得交付")]);
      },
    });
    await instance.start({ onMessage: (event) => { events.push(event.text); }, onStatus: () => undefined });
    const poll = instance.poll();
    await started;
    await instance.close();
    release?.();
    await expect(poll).rejects.toThrow("OCR_SOURCE_LIFECYCLE_CHANGED");
    expect(events).toEqual([]);
    expect(instance.getStatus()).toMatchObject({ state: "stopped", reason: "SOURCE_CLOSED" });
    expect((await cursorRepository.read(target.contactId))?.nextSequence).toBe(1);
  });

  it("recovers one bound latest incoming after viewport truncation and persists its proof", async () => {
    const ctx = await context();
    const truncated = withProof(snapshot([message("C", "outgoing"), message("新来信")]));
    const first = source({ ...ctx, pages: [snapshot([message("A", "outgoing"), message("B", "outgoing")]), truncated] });
    await first.instance.start({ onMessage: (event) => { first.events.push(event); }, onStatus: () => undefined });
    await first.instance.poll();
    expect(first.events).toEqual([expect.objectContaining({ text: "新来信" })]);

    const replay = source({ ...ctx, pages: [truncated, withProof(snapshot([message("D", "outgoing"), message("新来信")]))] });
    await replay.instance.start({ onMessage: (event) => { replay.events.push(event); }, onStatus: () => undefined });
    await replay.instance.poll();
    expect(replay.events).toEqual([]);
    expect(replay.instance.getStatus()).toMatchObject({ state: "degraded", reason: "OCR_BASELINE_DISCONTINUITY" });
  });

  it("learns a delayed proof for an unchanged baseline without replaying it later", async () => {
    const ctx = await context();
    const current = snapshot([message("已有消息")]);
    const proof = withProof(current, "e".repeat(64));
    const h = source({
      ...ctx,
      pages: [current, proof, withProof(snapshot([message("其他", "outgoing"), message("已有消息")]), "e".repeat(64))],
    });
    await h.instance.start({ onMessage: (event) => { h.events.push(event); }, onStatus: () => undefined });
    await h.instance.poll();
    await h.instance.poll();
    expect(h.events).toEqual([]);
    expect(h.instance.getStatus()).toMatchObject({ state: "degraded", reason: "OCR_BASELINE_DISCONTINUITY" });
  });

  it("fails closed when directory lifecycle/revision changes before or after read", async () => {
    const ctx = await context();
    let calls = 0;
    const directory = { requireActiveAutoReplyTarget: () => {
      calls += 1;
      return calls <= 2 ? Promise.resolve(target) : Promise.reject(new Error("CONTACT_NOT_ACTIVE"));
    } };
    const h = source({ ...ctx, pages: [snapshot([]), snapshot([message("不应发出")])], directory });
    await h.instance.start({ onMessage: (event) => { h.events.push(event); }, onStatus: () => undefined });
    await expect(h.instance.poll()).rejects.toThrow("CONTACT_NOT_ACTIVE");
    expect(h.events).toEqual([]);
    expect(h.instance.getStatus()).toMatchObject({ state: "blocked", reason: "OCR_TARGET_AUTHORIZATION_CHANGED" });
  });
});
