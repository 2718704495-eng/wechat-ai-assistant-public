import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContactDirectory,
  type AuthorizedWechatTarget,
} from "../../src/contacts/contact-directory.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import {
  consumePreparedReplyClaim,
  RealtimeReplyService,
  type PreparedReplyClaim,
} from "../../src/conversation/realtime-reply-service.js";
import type {
  InboundMessageSourceHandlers,
  NormalizedInboundMessage,
  ReplyIntent,
} from "../../src/conversation/personal-account-contract.js";
import { OfflinePersonalAccountCoordinator } from "../../src/conversation/personal-account-contract.js";
import { SingleDispatcherAdmission } from "../../src/runtime-v2/single-dispatcher-admission.js";
import {
  createProductionRealtimeReplyMain,
  createRealtimeReplyMain,
} from "../../src/runtime-v2/realtime-reply-main.js";
import { createProductionScheduledRuntime } from "../../src/runtime-v2/single-scheduler.js";
import { InMemoryRealtimeReplyRepository } from "../../src/storage/repositories.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { WechatIdentityEnrollmentRepository } from "../../src/storage/wechat-identity-enrollment-repository.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

const roots: string[] = [];

describe("realtime reply service", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("detects at 3 seconds, buffers one burst, and submits it once", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    harness.source.enqueue(incoming(1, "第一句"), incoming(2, "第二句"));
    harness.detector.scan.mockResolvedValueOnce([signal(harness.target)]);

    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.detector.scan).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    expect(harness.process).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => expect(harness.process).toHaveBeenCalledTimes(1));
    expect(harness.process.mock.calls[0]?.[0]).toHaveLength(2);
    await vi.waitFor(() =>
      expect(harness.delivery.deliver).toHaveBeenCalledTimes(1),
    );
    await harness.service.stop();
  });

  it.each([3_000, 4_000, 5_000] as const)(
    "accepts a %dms polling cadence and never reenters a slow scan",
    async (pollIntervalMs) => {
      vi.useFakeTimers();
      let releaseScan: (() => void) | undefined;
      const scan = vi.fn().mockImplementation(
        () =>
          new Promise<readonly []>((resolve) => {
            releaseScan = () => resolve([]);
          }),
      );
      const harness = await createHarness({ pollIntervalMs, scan });

      await harness.service.start();
      vi.advanceTimersByTime(pollIntervalMs * 2);
      await Promise.resolve();
      expect(scan).toHaveBeenCalledTimes(1);
      releaseScan?.();
      await harness.service.stop();
    },
  );

  it("cancels prepared work when the owner replies before submit", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({
      afterGenerate: (source) => source.enqueue(outgoing(2, "我人工回复了")),
    });
    harness.source.enqueue(incoming(1, "在吗"));
    harness.detector.scan.mockResolvedValueOnce([signal(harness.target)]);

    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      await expect(harness.repository.list()).resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          reason: "OWNER_REPLIED",
        }),
      ]);
    });
    await harness.service.stop();
  });

  it("cancels prepared work when the contact revision changes", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({
      afterGenerate: (_source, context) => context.bumpRevision(),
    });
    harness.source.enqueue(incoming(1, "在吗"));
    harness.detector.scan.mockResolvedValueOnce([signal(harness.target)]);

    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      await expect(harness.repository.list()).resolves.toEqual([
        expect.objectContaining({
          status: "cancelled",
          reason: "CONTACT_CHANGED",
        }),
      ]);
    });
    await harness.service.stop();
  });

  it("recovers terminal uncertainty by readback only and never replays terminal work", async () => {
    const harness = await createHarness();
    const key = await seedUncertain(harness.repository, harness.target);
    harness.delivery.recoverSubmitted.mockResolvedValue("verified");

    await expect(
      harness.service.recoverPending(new Date("2026-08-31T00:10:00.000Z")),
    ).resolves.toEqual([
      expect.objectContaining({
        contactId: harness.target.contactId,
        triggerId: key.triggerId,
        status: "verified",
        submitCount: 0,
      }),
    ]);
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    expect(harness.delivery.recoverSubmitted).toHaveBeenCalledTimes(1);
  });

  it("rejects polling values outside the explicit 3/4/5 second contract", async () => {
    await expect(
      createHarness({ pollIntervalMs: 2_999 as 3_000 }),
    ).rejects.toThrow("REALTIME_POLL_INTERVAL_INVALID");
  });

  it("creates offline main wiring without starting a detector or source", async () => {
    const harness = await createHarness();
    const main = createRealtimeReplyMain(harness.serviceOptions);

    expect(harness.detector.scan).not.toHaveBeenCalled();
    expect(harness.source.started).toBe(false);
    await main.stop();
  });

  it("keeps P1 pending from persisted input until a terminal trigger", async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    harness.source.enqueue(incoming(1, "pending"));
    harness.detector.scan.mockResolvedValueOnce([signal(harness.target)]);
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));

    await expect(harness.admission.admit("p0")).rejects.toThrow(
      "SINGLE_DISPATCHER_INCOMING_PENDING",
    );
    await harness.service.stop();
  });

  it("retries a persisted prepared trigger after dispatcher BUSY", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({ ownerBusyOnce: true });
    harness.source.enqueue(incoming(1, "busy-retry"));
    harness.detector.scan.mockResolvedValueOnce([signal(harness.target)]);
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(async () => {
      await expect(harness.repository.list()).resolves.toEqual([
        expect.objectContaining({ status: "prepared" }),
      ]);
    });
    expect(harness.delivery.deliver).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() =>
      expect(harness.delivery.deliver).toHaveBeenCalledTimes(1),
    );
    await harness.service.stop();
  });

  it("does not mark submit-started when delivery fails before its submit fence", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({ deliveryBeforeSubmitFailure: true });
    harness.source.enqueue(incoming(1, "pre-submit"));
    harness.detector.scan.mockResolvedValueOnce([signal(harness.target)]);
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(async () => {
      await expect(harness.repository.list()).resolves.toEqual([
        expect.objectContaining({ status: "failed", reason: "SOURCE_BLOCKED" }),
      ]);
    });
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1);
    await harness.service.stop();
  });

  it("records failed with zero submit when the durable fence rejects before action", async () => {
    vi.useFakeTimers();
    class RejectingFenceRepository extends InMemoryRealtimeReplyRepository {
      public override compareAndSet(
        input: Parameters<InMemoryRealtimeReplyRepository["compareAndSet"]>[0],
      ): ReturnType<InMemoryRealtimeReplyRepository["compareAndSet"]> {
        if (
          input.expectedStatus === "prepared" &&
          input.next.status === "submit-started"
        ) {
          return Promise.reject(new Error("LEDGER_FENCE_FAILED"));
        }
        return super.compareAndSet(input);
      }
    }
    const repository = new RejectingFenceRepository();
    const harness = await createHarness({ repository });
    harness.source.enqueue(incoming(1, "fence-reject"));
    harness.detector.scan.mockResolvedValueOnce([signal(harness.target)]);
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(async () => {
      await expect(repository.list()).resolves.toEqual([
        expect.objectContaining({ status: "failed", reason: "SOURCE_BLOCKED" }),
      ]);
    });
    expect(harness.delivery.deliver).toHaveBeenCalledTimes(1);
    await harness.service.stop();
  });

  it("keeps detector cadence independent from a slow per-contact generation", async () => {
    vi.useFakeTimers();
    let releaseGeneration: (() => void) | undefined;
    const generation = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const harness = await createHarness({ generationBarrier: generation });
    harness.source.enqueue(incoming(1, "slow"));
    harness.detector.scan.mockResolvedValue([signal(harness.target)]);
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(harness.process).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(4_000);

    await vi.waitFor(() => {
      expect(harness.detector.scan.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    releaseGeneration?.();
    await harness.service.stop();
  });

  it("constructs the concrete production graph without starting any operation", async () => {
    const harness = await createHarness();
    const readList = vi.fn();
    const readConversation = vi.fn();
    const createEngine = vi.fn();
    const createSource = vi.fn();

    const production = createProductionRealtimeReplyMain({
      store: harness.store,
      conversationListReader: { readConversationListSnapshot: readList },
      createSource,
      createEngine,
      createScheduledRuntime: (directory, repository) =>
        createProductionScheduledRuntime({
          directory,
          repository,
          getSurface: () => ({
            prepareAuthorizedTextDraft: () =>
              Promise.reject(new Error("UNEXPECTED_PREPARE")),
            submitAuthorizedTextDraft: () =>
              Promise.reject(new Error("UNEXPECTED_SUBMIT")),
          }),
          readAuthorizedConversation: readConversation,
          isStopped: () => Promise.resolve(false),
          now: () => new Date("2026-08-31T00:00:00.000Z"),
        }),
      sourceEpoch: "production-source",
      sessionId: "production-session",
    });

    expect(Object.keys(production)).not.toEqual(
      expect.arrayContaining(["directory", "repository", "admission", "service"]),
    );
    expect(readList).not.toHaveBeenCalled();
    expect(readConversation).not.toHaveBeenCalled();
    expect(createEngine).not.toHaveBeenCalled();
    expect(createSource).not.toHaveBeenCalled();
  });

  it("rejects a structural directory before any detector or sender can run", async () => {
    const harness = await createHarness();
    expect(
      () =>
        new RealtimeReplyService({
          ...harness.serviceOptions,
          directory: {} as ContactDirectory,
        }),
    ).toThrow("CONTACT_DIRECTORY_PROVENANCE_REQUIRED");
    expect(harness.detector.scan).not.toHaveBeenCalled();
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
  });

  it("restores a persisted burst after a crash boundary without replaying the source", async () => {
    vi.useFakeTimers();
    const repository = new InMemoryRealtimeReplyRepository();
    const first = await createHarness({ repository });
    first.source.enqueue(incoming(1, "crash-one"), incoming(2, "crash-two"));
    first.detector.scan.mockResolvedValueOnce([signal(first.target)]);
    await first.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(first.source.pollCount).toBe(1));
    const persisted = await repository.listBufferedBatches();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.messages.map(({ text }) => text)).toEqual([
      "crash-one",
      "crash-two",
    ]);
    await first.service.stop();

    const restarted = await createHarness({ repository });
    await restarted.service.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(restarted.process).toHaveBeenCalledTimes(1));
    expect(restarted.process.mock.calls[0]?.[0]).toHaveLength(2);
    await restarted.service.stop();
  });

  it("serializes start/stop and aborts a hung generation with bounded convergence", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const harness = await createHarness({ generationBarrier: never });
    harness.source.enqueue(incoming(1, "hang"));
    harness.detector.scan.mockResolvedValueOnce([signal(harness.target)]);
    await Promise.all([harness.service.start(), harness.service.start()]);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(harness.process).toHaveBeenCalledTimes(1));

    await expect(harness.service.stop()).resolves.toBeUndefined();
    expect(harness.source.closeCount).toBe(1);
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
  });

  it("preserves a failed source close and quarantines the shared dispatcher", async () => {
    const harness = await createHarness({ sourceCloseFailure: true });
    await harness.service.start();

    await expect(harness.service.stop()).rejects.toThrow(
      "REALTIME_SOURCE_CLOSE_FAILED",
    );
    expect(harness.source.closeCount).toBe(1);
    expect(harness.admission.isQuarantined()).toBe(true);
    await expect(harness.service.start()).rejects.toThrow(
      "REALTIME_QUARANTINED",
    );
  });

  it("keeps a timed-out stop observable so a second stop sees the late close", async () => {
    let releaseClose!: () => void;
    const closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const harness = await createHarness({
      sourceCloseBarrier: closeBarrier,
      lifecycleDrainTimeoutMs: 10,
    });
    await harness.service.start();

    await expect(harness.service.stop()).rejects.toThrow(
      "REALTIME_GENERATION_DRAIN_TIMEOUT",
    );
    const retry = harness.service.stop();
    releaseClose();
    await expect(retry).resolves.toBeUndefined();
    expect(harness.source.closeCount).toBe(1);
    expect(harness.admission.isQuarantined()).toBe(false);
  });

  it("uses a fresh real coordinator for a second terminal batch", async () => {
    vi.useFakeTimers();
    const harness = await createHarness({ realCoordinator: true });
    harness.detector.scan.mockResolvedValue([signal(harness.target)]);
    harness.source.enqueue(incoming(1, "第一批"));
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() =>
      expect(harness.source.pollCount).toBeGreaterThanOrEqual(1),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() =>
      expect(harness.delivery.deliver).toHaveBeenCalledTimes(1),
    );

    harness.source.enqueue(incoming(2, "第二批"));
    const pollsBeforeSecond = harness.source.pollCount;
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() =>
      expect(harness.source.pollCount).toBeGreaterThan(pollsBeforeSecond),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() =>
      expect(harness.delivery.deliver).toHaveBeenCalledTimes(2),
    );
    expect(harness.createCoordinator).toHaveBeenCalledTimes(2);
    expect(harness.engineGenerate).toHaveBeenCalledTimes(2);
    await harness.service.stop();
  });

  it("durably drains a second expired batch after the first generation is ignored", async () => {
    vi.useFakeTimers();
    let releaseGeneration!: () => void;
    const firstGeneration = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const harness = await createHarness({
      generationBarrier: firstGeneration,
      firstProcessIgnored: true,
    });
    harness.detector.scan.mockResolvedValue([signal(harness.target)]);
    harness.source.enqueue(incoming(1, "第一批"));
    await harness.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() =>
      expect(harness.source.pollCount).toBeGreaterThanOrEqual(1),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(harness.process).toHaveBeenCalledTimes(1));

    harness.source.enqueue(incoming(2, "排队第二批"));
    const pollsBeforeSecond = harness.source.pollCount;
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() =>
      expect(harness.source.pollCount).toBeGreaterThan(pollsBeforeSecond),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    releaseGeneration();
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => expect(harness.process).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(harness.delivery.deliver).toHaveBeenCalledTimes(1),
    );
    await harness.service.stop();
  });

  it("keeps source.poll single-flight across tick and recovery and leaves no recovery timer", async () => {
    vi.useFakeTimers();
    let releasePoll!: () => void;
    const pollBarrier = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const repository = new InMemoryRealtimeReplyRepository();
    const harness = await createHarness({ repository, pollBarrier });
    await seedPrepared(repository, harness.target);
    harness.detector.scan.mockResolvedValue([signal(harness.target)]);
    await harness.service.start();
    const tick = harness.service.tickOnce(new Date("2026-08-31T00:10:00.000Z"));
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    const recovery = harness.service.recoverPending(
      new Date("2026-08-31T00:10:01.000Z"),
    );
    await Promise.resolve();
    expect(harness.source.maxConcurrentPolls).toBe(1);
    releasePoll();
    await Promise.allSettled([tick, recovery]);
    expect(harness.source.maxConcurrentPolls).toBe(1);
    await harness.service.stop();
  });

  it("closes an ephemeral prepared recovery session without restoring buffered timers", async () => {
    vi.useFakeTimers();
    const repository = new InMemoryRealtimeReplyRepository();
    const harness = await createHarness({ repository });
    await seedPrepared(repository, harness.target);

    await expect(
      harness.service.recoverPending(new Date("2026-08-31T00:10:00.000Z")),
    ).resolves.toEqual([
      expect.objectContaining({ status: "verified", submitCount: 0 }),
    ]);
    expect(harness.source.closeCount).toBe(1);
    expect(harness.detector.scan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an expired queued batch durable during recovery-only delivery", async () => {
    vi.useFakeTimers();
    const repository = new InMemoryRealtimeReplyRepository();
    const harness = await createHarness({ repository });
    await seedPrepared(repository, harness.target);
    await repository.appendBufferedMessage({
      target: harness.target,
      message: incoming(2, "恢复时不启动计时器"),
      deadline: new Date("2026-08-31T00:00:01.000Z"),
      now: new Date("2026-08-31T00:00:00.000Z"),
    });

    await harness.service.recoverPending(new Date("2026-08-31T00:10:00.000Z"));

    expect(await repository.listBufferedBatches()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.process).not.toHaveBeenCalled();
  });

  it("wakes one durable queued batch after running recovery terminates an active new record", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:10:00.000Z"));
    const repository = new InMemoryRealtimeReplyRepository();
    const harness = await createHarness({ repository });
    await harness.service.start();
    await repository.claim({
      target: harness.target,
      triggerId: intent(harness.target, [incoming(1, "active")]).triggerId,
      source: "native-ocr",
      sourceEpoch: "source-1",
      sessionId: "session-1",
      messages: [incoming(1, "active")],
      now: new Date("2026-08-31T00:09:00.000Z"),
    });
    await repository.appendBufferedMessage({
      target: harness.target,
      message: incoming(2, "queued after recovery"),
      deadline: new Date("2026-08-31T00:10:02.000Z"),
      now: new Date("2026-08-31T00:10:00.000Z"),
    });

    await harness.service.recoverPending(new Date("2026-08-31T00:10:00.000Z"));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(harness.process).toHaveBeenCalledTimes(1));
    await harness.service.stop();
  });

  it("compensates a durable queued batch after a non-busy prepared admission failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:10:00.000Z"));
    const repository = new FlakyWakeRepository();
    const harness = await createHarness({ repository, ownerFailureOnce: true });
    await harness.service.start();
    await seedPrepared(repository, harness.target);
    await repository.appendBufferedMessage({
      target: harness.target,
      message: incoming(2, "durable compensation"),
      deadline: new Date("2026-08-31T00:10:02.000Z"),
      now: new Date("2026-08-31T00:10:00.000Z"),
    });
    repository.failNextBufferedScan();

    await Promise.allSettled([
      harness.service.recoverPending(new Date("2026-08-31T00:10:00.000Z")),
    ]);
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => expect(harness.process).toHaveBeenCalledTimes(1));
    expect(harness.source.maxConcurrentPolls).toBeLessThanOrEqual(1);
    await harness.service.stop();
  });

  it("fences stop while recovery is still listing work before any source exists", async () => {
    let releaseList!: () => void;
    const listBarrier = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const repository = new DelayedRecoveryRepository(listBarrier);
    const harness = await createHarness({ repository });
    await seedPrepared(repository, harness.target);

    const recovery = harness.service.recoverPending(
      new Date("2026-08-31T00:10:00.000Z"),
    );
    await vi.waitFor(() => expect(repository.listStarted).toBe(true));
    const stopping = harness.service.stop();
    releaseList();

    await expect(stopping).resolves.toBeUndefined();
    await expect(recovery).resolves.toEqual([]);
    expect(harness.source.started).toBe(false);
    expect(harness.source.pollCount).toBe(0);
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
  });

  it("fences a stopped recovery before stale delivery and drains its source once", async () => {
    let releasePoll!: () => void;
    const pollBarrier = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const repository = new InMemoryRealtimeReplyRepository();
    const harness = await createHarness({ repository, pollBarrier });
    await seedPrepared(repository, harness.target);

    const recovery = harness.service.recoverPending(
      new Date("2026-08-31T00:10:00.000Z"),
    );
    await vi.waitFor(() => expect(harness.source.pollCount).toBe(1));
    const stopping = harness.service.stop();
    releasePoll();

    await expect(stopping).resolves.toBeUndefined();
    await expect(recovery).resolves.toEqual([]);
    expect(harness.delivery.deliver).not.toHaveBeenCalled();
    expect(harness.source.closeCount).toBe(1);
  });
});

async function createHarness(
  options: {
    pollIntervalMs?: 3_000 | 4_000 | 5_000;
    scan?: ReturnType<typeof vi.fn>;
    afterGenerate?: (
      source: FakeSource,
      context: { bumpRevision(): Promise<void> },
    ) => void | Promise<void>;
    deliveryBeforeSubmitFailure?: boolean;
    generationBarrier?: Promise<void>;
    repository?: InMemoryRealtimeReplyRepository;
    sourceCloseFailure?: boolean;
    ownerBusyOnce?: boolean;
    ownerFailureOnce?: boolean;
    realCoordinator?: boolean;
    firstProcessIgnored?: boolean;
    pollBarrier?: Promise<void>;
    sourceCloseBarrier?: Promise<void>;
    lifecycleDrainTimeoutMs?: number;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "realtime-reply-service-"));
  roots.push(root);
  await initializeTestKernelLockCatalog(root);
  const store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
  const registry = new ContactRegistryRepository(store);
  const enrollments = new WechatIdentityEnrollmentRepository(store);
  const samples = [featureSample(1), featureSample(2), featureSample(3)];
  const fingerprint = enrollmentFingerprint(samples);
  await enrollments.enrollSupervised({
    version: 2,
    contactId: "contact-11111111111111111111111111111111",
    displayName: "测试联系人",
    fingerprintVersion: "vision-featureprint-v1",
    referenceSamples: samples,
    enrolledAt: "2026-08-31T00:00:00.000Z",
  });
  await registry.createConfirmed({
    contactId: "contact-11111111111111111111111111111111",
    displayName: "测试联系人",
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
  const directory = new ContactDirectory(registry, enrollments);
  const initialTarget = await directory.requireActiveAutoReplyTarget(
    "contact-11111111111111111111111111111111",
  );
  const source = new FakeSource(
    options.sourceCloseFailure === true,
    options.pollBarrier,
    options.sourceCloseBarrier,
  );
  const detector = { scan: options.scan ?? vi.fn().mockResolvedValue([]) };
  const process = vi
    .fn()
    .mockImplementation(async (messages: NormalizedInboundMessage[]) => {
      await options.generationBarrier;
      await options.afterGenerate?.(source, {
        bumpRevision: async () => {
          const current = await registry.get(initialTarget.contactId);
          if (current === null) throw new Error("CONTACT_NOT_FOUND");
          await registry.update(
            current.contactId,
            current.revision,
            {},
            new Date(),
          );
        },
      });
      if (
        options.firstProcessIgnored === true &&
        process.mock.calls.length === 1
      ) {
        return {
          status: "ignored" as const,
          reason: "ENGINE_REFUSED" as const,
        };
      }
      return Promise.resolve({
        status: "reply-intent" as const,
        intent: intent(initialTarget, messages),
      });
    });
  const coordinator = {
    updateSourceStatus: vi.fn(),
    process,
  };
  const engineGenerate = vi
    .fn()
    .mockResolvedValue({ status: "reply", text: "收到啦" });
  const createCoordinator = vi.fn(async (target: AuthorizedWechatTarget) =>
    options.realCoordinator === true
      ? OfflinePersonalAccountCoordinator.create({
          directory,
          contactId: target.contactId,
          expectedRevision: target.revision,
          engine: { generate: engineGenerate },
          source: "native-ocr",
          sourceEpoch: "source-1",
          sessionId: "session-1",
        })
      : (coordinator as never),
  );
  const owner = {
    lane: "p1" as const,
    readLatest: vi.fn().mockResolvedValue({ direction: "incoming" as const }),
    replyToLatestIncomingOnce: vi.fn(),
    close: vi.fn().mockResolvedValue({ gateReleased: true }),
  };
  const acquireOwner =
    options.ownerBusyOnce === true
      ? vi
          .fn()
          .mockRejectedValueOnce(new Error("SINGLE_DISPATCHER_BUSY"))
          .mockResolvedValue(owner)
      : options.ownerFailureOnce === true
        ? vi
            .fn()
            .mockRejectedValueOnce(new Error("OWNER_ACQUIRE_FAILED"))
            .mockResolvedValue(owner)
        : vi.fn().mockResolvedValue(owner);
  const admission = new SingleDispatcherAdmission<typeof owner>({
    acquireOwner,
  });
  const repository =
    options.repository ?? new InMemoryRealtimeReplyRepository();
  const delivery = {
    deliver: vi
      .fn()
      .mockImplementation(
        async (claim: PreparedReplyClaim) => {
          const input = consumePreparedReplyClaim(claim);
          if (options.deliveryBeforeSubmitFailure === true)
            throw new Error("PREPARE_FAILED");
          if (!(await input.markSubmitStarted({
            version: 1,
            windowRevision: "e".repeat(64),
            expectedTextHash: createHash("sha256")
              .update(input.intent.replyText)
              .digest("hex"),
            messages: [],
          })))
            throw new Error("SUBMIT_FENCE_REJECTED");
          return { status: "verified" as const, submitCount: 1 as const };
        },
      ),
    recoverSubmitted: vi.fn().mockImplementation((claim: PreparedReplyClaim) => {
      consumePreparedReplyClaim(claim);
      return Promise.resolve("submitted-uncertain" as const);
    }),
  };
  const serviceOptions = {
    pollIntervalMs: options.pollIntervalMs ?? 3_000,
    bufferWindowMs: 2_000,
    detector: detector as never,
    directory,
    createSource: () => source as never,
    createCoordinator,
    admission,
    delivery,
    repository,
    lifecycleDrainTimeoutMs: options.lifecycleDrainTimeoutMs,
  } as const;
  const service = new RealtimeReplyService(serviceOptions);
  return {
    service,
    source,
    detector,
    process,
    delivery,
    repository,
    admission,
    owner,
    store,
    target: initialTarget,
    serviceOptions,
    createCoordinator,
    engineGenerate,
  };
}

class FakeSource {
  public started = false;
  public pollCount = 0;
  public closeCount = 0;
  public maxConcurrentPolls = 0;
  private concurrentPolls = 0;
  private handlers: InboundMessageSourceHandlers | null = null;
  private readonly queued: NormalizedInboundMessage[] = [];

  public constructor(
    private readonly closeFailure = false,
    private readonly pollBarrier?: Promise<void>,
    private readonly closeBarrier?: Promise<void>,
  ) {}

  public enqueue(...messages: NormalizedInboundMessage[]): void {
    this.queued.push(...messages);
  }

  public async start(handlers: InboundMessageSourceHandlers): Promise<void> {
    this.started = true;
    this.handlers = handlers;
    await handlers.onStatus({
      contractVersion: 1,
      source: "native-ocr",
      sourceEpoch: "source-1",
      state: "waiting",
      lastEventAt: null,
      reason: null,
    });
  }

  public async poll(): Promise<void> {
    this.pollCount += 1;
    this.concurrentPolls += 1;
    this.maxConcurrentPolls = Math.max(
      this.maxConcurrentPolls,
      this.concurrentPolls,
    );
    await this.pollBarrier;
    const handlers = this.handlers;
    try {
      if (handlers === null) throw new Error("SOURCE_NOT_STARTED");
      for (const message of this.queued.splice(0))
        await handlers.onMessage(message);
    } finally {
      this.concurrentPolls -= 1;
    }
  }

  public stop(): Promise<void> {
    this.started = false;
    this.handlers = null;
    return Promise.resolve();
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
    this.handlers = null;
    await this.closeBarrier;
    if (this.closeFailure)
      throw new Error("SOURCE_CLOSE_FAILED");
  }
}

class DelayedRecoveryRepository extends InMemoryRealtimeReplyRepository {
  public listStarted = false;

  public constructor(private readonly barrier: Promise<void>) {
    super();
  }

  public override async listRecoverable() {
    this.listStarted = true;
    await this.barrier;
    return super.listRecoverable();
  }
}

class FlakyWakeRepository extends InMemoryRealtimeReplyRepository {
  private failBufferedScan = false;

  public failNextBufferedScan(): void {
    this.failBufferedScan = true;
  }

  public override listBufferedBatches() {
    if (this.failBufferedScan) {
      this.failBufferedScan = false;
      return Promise.reject(new Error("INJECTED_BUFFER_SCAN_FAILURE"));
    }
    return super.listBufferedBatches();
  }
}

function featureSample(byte: number): string {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

function enrollmentFingerprint(samples: readonly string[]): string {
  return createHash("sha256")
    .update(
      [
        "2",
        "contact-11111111111111111111111111111111",
        "测试联系人",
        "vision-featureprint-v1",
        "0.18",
        ...samples,
      ].join("\0"),
    )
    .digest("hex");
}

function signal(value: AuthorizedWechatTarget) {
  return {
    contactId: value.contactId,
    contactRevision: value.revision,
    previewHash: "f".repeat(64),
    observedMinute: "08:00",
    unread: true,
    windowRevision: "1".repeat(64),
  };
}

function incoming(sequence: number, text: string): NormalizedInboundMessage {
  return message(sequence, "incoming", text);
}

function outgoing(sequence: number, text: string): NormalizedInboundMessage {
  return message(sequence, "outgoing", text);
}

function message(
  sequence: number,
  direction: "incoming" | "outgoing",
  text: string,
): NormalizedInboundMessage {
  return {
    contractVersion: 1,
    source: "native-ocr",
    sourceEpoch: "source-1",
    sessionId: "session-1",
    conversationId: "contact-11111111111111111111111111111111",
    messageId: createHash("sha256")
      .update(`${sequence}:${direction}:${text}`)
      .digest("hex"),
    sequence,
    occurredAt: new Date(sequence * 1_000).toISOString(),
    direction,
    kind: "text",
    text,
  };
}

function intent(
  targetValue: AuthorizedWechatTarget,
  messages: readonly NormalizedInboundMessage[],
): ReplyIntent {
  const sourceMessageIds = messages.map(({ messageId }) => messageId);
  const triggerId = createHash("sha256")
    .update(
      [
        "personal-account-trigger-v2",
        targetValue.contactId,
        String(targetValue.revision),
        targetValue.bindingHash,
        "native-ocr",
        "source-1",
        "session-1",
        ...sourceMessageIds,
      ].join("\0"),
    )
    .digest("hex");
  const replyText = "收到啦";
  const deliveryKey = createHash("sha256")
    .update(
      [
        "personal-account-delivery-v2",
        triggerId,
        targetValue.contactId,
        String(targetValue.revision),
        targetValue.bindingHash,
        replyText,
      ].join("\0"),
    )
    .digest("hex");
  return {
    contractVersion: 1,
    status: "prepared",
    triggerId,
    conversationId: targetValue.contactId,
    contactId: targetValue.contactId,
    contactRevision: targetValue.revision,
    bindingHash: targetValue.bindingHash,
    source: "native-ocr",
    sourceEpoch: "source-1",
    sessionId: "session-1",
    replyText,
    sourceMessageIds,
    deliveryKey,
  };
}

async function seedUncertain(
  repository: InMemoryRealtimeReplyRepository,
  targetValue: AuthorizedWechatTarget,
) {
  const preparedIntent = intent(targetValue, [incoming(1, "pending")]);
  const key = {
    contactId: targetValue.contactId,
    contactRevision: targetValue.revision,
    bindingHash: targetValue.bindingHash,
    triggerId: preparedIntent.triggerId,
  };
  await repository.claim({
    target: targetValue,
    triggerId: key.triggerId,
    source: "native-ocr",
    sourceEpoch: "source-1",
    sessionId: "session-1",
    messages: [incoming(1, "pending")],
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
    next: { status: "prepared", intent: preparedIntent },
    now: new Date("2026-08-31T00:00:00.200Z"),
  });
  await repository.compareAndSet({
    key,
    expectedStatus: "prepared",
    next: { status: "submit-started" },
    now: new Date("2026-08-31T00:00:00.300Z"),
  });
  await repository.compareAndSet({
    key,
    expectedStatus: "submit-started",
    next: { status: "submitted-uncertain" },
    now: new Date("2026-08-31T00:00:00.400Z"),
  });
  return key;
}

async function seedPrepared(
  repository: InMemoryRealtimeReplyRepository,
  targetValue: AuthorizedWechatTarget,
) {
  const preparedIntent = intent(targetValue, [incoming(1, "pending")]);
  const key = {
    contactId: targetValue.contactId,
    contactRevision: targetValue.revision,
    bindingHash: targetValue.bindingHash,
    triggerId: preparedIntent.triggerId,
  };
  await repository.claim({
    target: targetValue,
    triggerId: key.triggerId,
    source: "native-ocr",
    sourceEpoch: "source-1",
    sessionId: "session-1",
    messages: [incoming(1, "pending")],
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
    next: { status: "prepared", intent: preparedIntent },
    now: new Date("2026-08-31T00:00:00.200Z"),
  });
  return key;
}
