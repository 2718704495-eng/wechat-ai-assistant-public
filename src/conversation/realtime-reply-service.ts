import {
  assertAuthorizedWechatTarget,
  assertContactDirectory,
  ContactDirectory,
  type AuthorizedWechatTarget,
} from "../contacts/contact-directory.js";
import type { ContactId } from "../contacts/contact-schema.js";
import type { NativeConversationListDetector } from "./native-conversation-list-detector.js";
import type { NativeOcrInboundSource } from "./native-ocr-inbound-source.js";
import {
  normalizedInboundMessageSchema,
  type NormalizedInboundMessage,
  type OfflinePersonalAccountCoordinator,
  type ReplyIntent,
} from "./personal-account-contract.js";
import type { RealtimeDispatcherControl } from "../runtime-v2/single-scheduler.js";
import {
  InMemoryRealtimeReplyRepository,
  type RealtimeBufferedBatch,
  type RealtimeReplyKey,
  type RealtimeReplyRecord,
  type RealtimeReadbackBaseline,
  type RealtimeReplyStateRepository,
} from "../storage/repositories.js";

export interface ContactReplyDelivery {
  deliver(claim: PreparedReplyClaim): Promise<{
    status: "verified" | "submitted-uncertain";
    submitCount: 1;
  }>;
  recoverSubmitted?(
    claim: PreparedReplyClaim,
  ): Promise<"verified" | "submitted-uncertain">;
}

declare const preparedReplyClaimBrand: unique symbol;

/** Opaque, process-local, one-shot authorization minted only by the service. */
export interface PreparedReplyClaim {
  readonly [preparedReplyClaimBrand]: true;
}

export interface PreparedReplyClaimPayload {
  readonly kind: "delivery" | "recovery";
  readonly target: AuthorizedWechatTarget;
  readonly intent: ReplyIntent;
  readonly signal: AbortSignal;
  readonly recordVersion: string;
  readonly readbackBaseline: RealtimeReadbackBaseline | null;
  readonly markSubmitStarted: (
    baseline: RealtimeReadbackBaseline,
  ) => Promise<boolean>;
}

const preparedReplyClaims = new WeakMap<object, PreparedReplyClaimPayload>();

export function consumePreparedReplyClaim(
  claim: PreparedReplyClaim,
): PreparedReplyClaimPayload {
  const payload = preparedReplyClaims.get(claim);
  if (payload === undefined) throw new Error("REALTIME_PREPARED_CLAIM_INVALID");
  preparedReplyClaims.delete(claim);
  if (payload.signal.aborted)
    throw new Error("REALTIME_PREPARED_CLAIM_ABORTED");
  return payload;
}

export interface RealtimeReplyServiceOptions {
  readonly pollIntervalMs?: 3_000 | 4_000 | 5_000;
  readonly bufferWindowMs: number;
  readonly detector: NativeConversationListDetector;
  readonly directory: ContactDirectory;
  readonly createSource: (
    target: AuthorizedWechatTarget,
  ) => NativeOcrInboundSource;
  readonly createCoordinator: (
    target: AuthorizedWechatTarget,
  ) =>
    | OfflinePersonalAccountCoordinator
    | Promise<OfflinePersonalAccountCoordinator>;
  readonly admission: RealtimeDispatcherControl;
  readonly delivery: ContactReplyDelivery;
  readonly repository?: RealtimeReplyStateRepository;
  readonly now?: () => Date;
  readonly lifecycleDrainTimeoutMs?: number;
}

export interface RealtimeTickReceipt {
  readonly status: "idle" | "processed" | "degraded" | "busy";
  readonly detectedContacts: number;
  readonly prepared: number;
  readonly submitCount: 0 | 1;
}

export interface RealtimeRecoveryReceipt {
  readonly contactId: ContactId;
  readonly triggerId: string;
  readonly status: "cancelled" | "verified" | "submitted-uncertain";
  readonly submitCount: 0;
}

interface ContactSession {
  target: AuthorizedWechatTarget;
  source: NativeOcrInboundSource;
  sourceStatus:
    | Parameters<OfflinePersonalAccountCoordinator["updateSourceStatus"]>[0]
    | null;
  pollTask: Promise<void> | null;
  bufferTimer: ReturnType<typeof setTimeout> | null;
  generationAbort: AbortController | null;
  generationTask: Promise<void> | null;
  closeContinuation: Promise<void> | null;
}

type LifecycleState =
  "stopped" | "starting" | "running" | "stopping" | "quarantined";

export class RealtimeReplyService {
  private readonly pollIntervalMs: 3_000 | 4_000 | 5_000;
  private readonly repository: RealtimeReplyStateRepository;
  private readonly now: () => Date;
  private readonly lifecycleDrainTimeoutMs: number;
  private readonly sessions = new Map<ContactId, ContactSession>();
  private readonly pendingAnnouncements = new Map<ContactId, () => void>();
  private readonly deliveryTasks = new Map<ContactId, Promise<void>>();
  private readonly deliveryControllers = new Set<AbortController>();
  private readonly sessionTasks = new Map<ContactId, Promise<ContactSession>>();
  private lifecycleState: LifecycleState = "stopped";
  private lifecycleTail: Promise<void> = Promise.resolve();
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private scanPromise: Promise<RealtimeTickReceipt> | null = null;
  private recoveryPromise: Promise<readonly RealtimeRecoveryReceipt[]> | null =
    null;
  private fairnessOffset = 0;
  private lifecycleGeneration = 0;
  private stopContinuation: Promise<void> | null = null;

  public constructor(private readonly options: RealtimeReplyServiceOptions) {
    assertContactDirectory(options.directory);
    const pollIntervalMs = options.pollIntervalMs ?? 3_000;
    if (
      pollIntervalMs !== 3_000 &&
      pollIntervalMs !== 4_000 &&
      pollIntervalMs !== 5_000
    ) {
      throw new Error("REALTIME_POLL_INTERVAL_INVALID");
    }
    if (
      !Number.isInteger(options.bufferWindowMs) ||
      options.bufferWindowMs < 1 ||
      options.bufferWindowMs > 30_000
    ) {
      throw new Error("REALTIME_BUFFER_WINDOW_INVALID");
    }
    const drainTimeout = options.lifecycleDrainTimeoutMs ?? 5_000;
    if (
      !Number.isInteger(drainTimeout) ||
      drainTimeout < 1 ||
      drainTimeout > 30_000
    ) {
      throw new Error("REALTIME_LIFECYCLE_TIMEOUT_INVALID");
    }
    this.pollIntervalMs = pollIntervalMs;
    this.repository =
      options.repository ?? new InMemoryRealtimeReplyRepository();
    this.now = options.now ?? (() => new Date());
    this.lifecycleDrainTimeoutMs = drainTimeout;
  }

  public start(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.lifecycleState === "running") return;
      if (this.lifecycleState === "quarantined")
        throw new Error("REALTIME_QUARANTINED");
      if (this.lifecycleState === "stopping")
        throw new Error("REALTIME_STOPPING");
      this.stopContinuation = null;
      this.lifecycleState = "starting";
      const generation = ++this.lifecycleGeneration;
      try {
        const targets =
          await ContactDirectory.prototype.listActiveAutoReplyTargets.call(
            this.options.directory,
          );
        for (const target of targets)
          await this.ensureSession(target, generation);
        this.assertLifecycleGeneration(generation, "starting");
        this.lifecycleState = "running";
        await this.restoreBufferedBatches();
        this.scheduleDetector(this.pollIntervalMs);
      } catch (error: unknown) {
        this.lifecycleState = "stopping";
        const cleanup = await this.closeSessionsBounded();
        this.lifecycleState = cleanup.length === 0 ? "stopped" : "quarantined";
        if (cleanup.length > 0) this.options.admission.quarantine();
        if (cleanup.length > 0) {
          throw new AggregateError(
            [error, ...cleanup],
            "REALTIME_START_CLEANUP_FAILED",
          );
        }
        throw error;
      }
    });
  }

  public stop(): Promise<void> {
    return this.runLifecycle(async () => {
      if (
        this.lifecycleState === "stopped" &&
        !this.hasOutstandingLifecycleWork()
      )
        return;
      if (this.stopContinuation === null) {
        this.lifecycleState = "stopping";
        this.lifecycleGeneration += 1;
        this.clearDetectorTimer();
        for (const controller of this.deliveryControllers) {
          controller.abort(new Error("REALTIME_STOPPING"));
        }
        for (const session of this.sessions.values()) {
          if (session.bufferTimer !== null) clearTimeout(session.bufferTimer);
          session.bufferTimer = null;
          session.generationAbort?.abort(new Error("REALTIME_STOPPING"));
        }
        const generations = [...this.sessions.values()]
          .map(({ generationTask }) => generationTask)
          .filter((task): task is Promise<void> => task !== null);
        const drains: Promise<unknown>[] = [
          ...generations,
          ...this.deliveryTasks.values(),
          ...this.sessionTasks.values(),
        ];
        if (this.scanPromise !== null) drains.push(this.scanPromise);
        if (this.recoveryPromise !== null) drains.push(this.recoveryPromise);
        this.stopContinuation = (async () => {
          await Promise.allSettled(drains);
          const errors = await this.closeSessionsBounded(false);
          this.releaseAllPendingAnnouncements();
          if (errors.length > 0) {
            throw new AggregateError(errors, "REALTIME_SOURCE_CLOSE_FAILED");
          }
        })().then(
          () => {
            this.lifecycleState = "stopped";
          },
          (error: unknown) => {
            this.lifecycleState = "quarantined";
            this.options.admission.quarantine();
            throw error;
          },
        );
      }
      await bounded(
        this.stopContinuation,
        this.lifecycleDrainTimeoutMs,
        "REALTIME_GENERATION_DRAIN_TIMEOUT",
      );
    });
  }

  public tickOnce(now: Date): Promise<RealtimeTickReceipt> {
    assertNow(now);
    if (this.scanPromise !== null) return Promise.resolve(busyReceipt());
    const scan = this.runTick(new Date(now.getTime())).finally(() => {
      if (this.scanPromise === scan) this.scanPromise = null;
    });
    this.scanPromise = scan;
    return scan;
  }

  public recoverPending(
    now: Date,
  ): Promise<readonly RealtimeRecoveryReceipt[]> {
    assertNow(now);
    if (
      this.lifecycleState === "stopping" ||
      this.lifecycleState === "quarantined"
    ) {
      return Promise.reject(new Error("REALTIME_RECOVERY_UNAVAILABLE"));
    }
    if (this.recoveryPromise !== null) return this.recoveryPromise;
    const recovery = this.runRecovery(new Date(now.getTime())).finally(() => {
      if (this.recoveryPromise === recovery) this.recoveryPromise = null;
    });
    this.recoveryPromise = recovery;
    return recovery;
  }

  public hasPendingWork(): Promise<boolean> {
    return this.repository.hasPendingWork();
  }

  private async runTick(now: Date): Promise<RealtimeTickReceipt> {
    if (this.lifecycleState === "quarantined") return degradedReceipt();
    let signals;
    try {
      signals = await this.options.detector.scan();
    } catch {
      return degradedReceipt();
    }
    const ordered = rotate(signals, this.fairnessOffset);
    if (signals.length > 0)
      this.fairnessOffset = (this.fairnessOffset + 1) % signals.length;
    let degraded = false;
    for (const signal of ordered) {
      try {
        const target =
          await ContactDirectory.prototype.requireActiveAutoReplyTarget.call(
            this.options.directory,
            signal.contactId,
          );
        assertAuthorizedWechatTarget(target);
        if (target.revision !== signal.contactRevision) {
          await this.repository.cancelPreSubmit(
            signal.contactId,
            "CONTACT_CHANGED",
            now,
          );
          await this.wakeBufferedContact(signal.contactId);
          continue;
        }
        const generation = this.lifecycleGeneration;
        const session = await this.ensureSession(target, generation);
        if (
          this.lifecycleState === "stopping" ||
          generation !== this.lifecycleGeneration
        )
          break;
        await this.pollSession(session, generation);
      } catch {
        degraded = true;
      }
    }
    const prepared = (await this.repository.list()).find(
      (record) => record.status === "prepared",
    );
    if (prepared !== undefined) this.startPreparedDelivery(keyOf(prepared));
    return {
      status: degraded ? "degraded" : signals.length > 0 ? "processed" : "idle",
      detectedContacts: signals.length,
      prepared: 0,
      submitCount: 0,
    };
  }

  private ensureSession(
    target: AuthorizedWechatTarget,
    generation = this.lifecycleGeneration,
    recoveryOnly = false,
  ): Promise<ContactSession> {
    const pending = this.sessionTasks.get(target.contactId);
    if (pending !== undefined) {
      return pending.then((session) =>
        sameTarget(session.target, target)
          ? session
          : this.ensureSession(target, generation, recoveryOnly),
      );
    }
    const task = this.createSession(target, generation, recoveryOnly).finally(
      () => {
        if (this.sessionTasks.get(target.contactId) === task) {
          this.sessionTasks.delete(target.contactId);
        }
      },
    );
    this.sessionTasks.set(target.contactId, task);
    return task;
  }

  private async createSession(
    target: AuthorizedWechatTarget,
    generation: number,
    recoveryOnly: boolean,
  ): Promise<ContactSession> {
    assertAuthorizedWechatTarget(target);
    const existing = this.sessions.get(target.contactId);
    if (existing !== undefined && sameTarget(existing.target, target))
      return existing;
    if (existing !== undefined) {
      existing.generationAbort?.abort(new Error("CONTACT_CHANGED"));
      if (existing.bufferTimer !== null) clearTimeout(existing.bufferTimer);
      await this.repository.cancelPreSubmit(
        target.contactId,
        "CONTACT_CHANGED",
        this.safeNow(),
      );
      await this.wakeBufferedContact(target.contactId);
      const closeErrors = await this.closeOneSession(existing);
      if (closeErrors.length > 0) {
        this.options.admission.quarantine();
        this.lifecycleState = "quarantined";
        throw new AggregateError(closeErrors, "REALTIME_SOURCE_CLOSE_FAILED");
      }
      this.sessions.delete(target.contactId);
    }
    const source = this.options.createSource(target);
    const session: ContactSession = {
      target,
      source,
      sourceStatus: null,
      pollTask: null,
      bufferTimer: null,
      generationAbort: null,
      generationTask: null,
      closeContinuation: null,
    };
    this.sessions.set(target.contactId, session);
    try {
      await source.start({
        onStatus: (status) => {
          session.sourceStatus = status;
        },
        onMessage: (message) => this.receiveMessage(session, message),
      });
      if (
        generation !== this.lifecycleGeneration ||
        this.lifecycleState === "stopping" ||
        (!recoveryOnly &&
          this.lifecycleState !== "starting" &&
          this.lifecycleState !== "running")
      ) {
        await this.closeOneSession(session);
        this.sessions.delete(target.contactId);
        throw new Error("REALTIME_LIFECYCLE_STALE");
      }
      return session;
    } catch (error: unknown) {
      const closeErrors = await this.closeOneSession(session);
      if (closeErrors.length === 0) this.sessions.delete(target.contactId);
      else {
        this.options.admission.quarantine();
        this.lifecycleState = "quarantined";
      }
      if (closeErrors.length > 0) {
        throw new AggregateError(
          [error, ...closeErrors],
          "REALTIME_SOURCE_START_FAILED",
        );
      }
      throw error;
    }
  }

  private pollSession(
    session: ContactSession,
    generation: number,
  ): Promise<void> {
    if (session.pollTask !== null) return session.pollTask;
    const poll = session.source
      .poll()
      .then(() => {
        if (
          generation !== this.lifecycleGeneration ||
          this.lifecycleState === "stopping"
        ) {
          throw new Error("REALTIME_LIFECYCLE_STALE");
        }
      })
      .finally(() => {
        if (session.pollTask === poll) session.pollTask = null;
      });
    session.pollTask = poll;
    return poll;
  }

  private async receiveMessage(
    session: ContactSession,
    input: NormalizedInboundMessage,
  ): Promise<void> {
    const message = normalizedInboundMessageSchema.parse(input);
    if (message.conversationId !== session.target.contactId) {
      throw new Error("REALTIME_MESSAGE_CONTACT_MISMATCH");
    }
    if (message.direction === "outgoing") {
      await this.repository.clearBufferedBatch(session.target.contactId);
      await this.repository.cancelPreSubmit(
        session.target.contactId,
        "OWNER_REPLIED",
        this.safeNow(),
      );
      if (session.bufferTimer !== null) clearTimeout(session.bufferTimer);
      session.bufferTimer = null;
      await this.wakeBufferedContact(session.target.contactId);
      await this.releasePendingIfIdle();
      return;
    }
    const now = this.safeNow();
    const batch = await this.repository.appendBufferedMessage({
      target: session.target,
      message,
      deadline: new Date(now.getTime() + this.options.bufferWindowMs),
      now,
    });
    this.ensurePendingAnnouncement(session.target.contactId);
    await this.scheduleBufferedBatch(session, batch);
  }

  private async scheduleBufferedBatch(
    session: ContactSession,
    batch: RealtimeBufferedBatch,
  ): Promise<void> {
    if (
      this.lifecycleState !== "running" ||
      (await this.repository.hasActiveForContact(batch.contactId))
    )
      return;
    if (session.bufferTimer !== null) clearTimeout(session.bufferTimer);
    const delay = Math.max(
      0,
      Date.parse(batch.deadlineAt) - this.safeNow().getTime(),
    );
    session.bufferTimer = setTimeout(() => {
      session.bufferTimer = null;
      this.startGeneration(session);
    }, delay);
  }

  private startGeneration(session: ContactSession): void {
    if (session.generationTask !== null) return;
    const controller = new AbortController();
    session.generationAbort = controller;
    const task = this.flushSession(session, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (session.generationTask === task) session.generationTask = null;
        if (session.generationAbort === controller)
          session.generationAbort = null;
        if (this.lifecycleState === "running") {
          void this.startQueuedBatch(session.target.contactId).catch(
            () => undefined,
          );
        }
      });
    session.generationTask = task;
  }

  private async flushSession(
    session: ContactSession,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      signal.aborted ||
      this.lifecycleState === "stopping" ||
      this.lifecycleState === "quarantined"
    )
      return;
    const claim = await this.repository.claimBufferedBatch(
      session.target.contactId,
      this.safeNow(),
    );
    if (!claim.claimed || claim.record === null) {
      await this.releasePendingIfIdle();
      return;
    }
    const key = keyOf(claim.record);
    if (
      !(await this.repository.compareAndSet({
        key,
        expectedStatus: "new",
        next: { status: "generating" },
        now: this.safeNow(),
      }))
    )
      return;
    let result;
    try {
      const coordinator = await this.options.createCoordinator(session.target);
      if (session.sourceStatus !== null)
        coordinator.updateSourceStatus(session.sourceStatus);
      result = await abortable(
        coordinator.process(claim.record.messages),
        signal,
      );
    } catch {
      if (signal.aborted) return;
      await this.fail(key, "SOURCE_BLOCKED", "generating");
      await this.releasePendingIfIdle();
      return;
    }
    if (signal.aborted) return;
    if (result.status !== "reply-intent") {
      const terminal = await this.repository.compareAndSet({
        key,
        expectedStatus: "generating",
        next:
          result.status === "cancelled"
            ? { status: "cancelled", reason: "OWNER_REPLIED" }
            : {
                status: "failed",
                reason:
                  result.status === "blocked" ? "SOURCE_BLOCKED" : "NO_REPLY",
              },
        now: this.safeNow(),
      });
      if (terminal) await this.wakeBufferedContact(key.contactId);
      await this.releasePendingIfIdle();
      return;
    }
    if (
      !(await this.repository.compareAndSet({
        key,
        expectedStatus: "generating",
        next: { status: "prepared", intent: result.intent },
        now: this.safeNow(),
      }))
    )
      return;
    await this.deliverPrepared(key, signal, this.lifecycleGeneration);
  }

  private async deliverPrepared(
    key: RealtimeReplyKey,
    signal: AbortSignal,
    generation = this.lifecycleGeneration,
  ): Promise<void> {
    if (signal.aborted || this.isStoppingOrStale(generation)) return;
    let current: AuthorizedWechatTarget;
    let latest: RealtimeReplyRecord | null;
    try {
      current =
        await ContactDirectory.prototype.requireActiveAutoReplyTarget.call(
          this.options.directory,
          key.contactId,
        );
      this.assertDeliveryCurrent(generation, signal);
      assertAuthorizedWechatTarget(current);
      latest = await this.repository.get(key);
      this.assertDeliveryCurrent(generation, signal);
      if (
        latest?.status !== "prepared" ||
        latest.intent === null ||
        !recordMatchesTarget(latest, current)
      )
        throw new Error("CONTACT_CHANGED");
      const session = this.sessions.get(key.contactId);
      if (session === undefined || !sameTarget(session.target, current)) {
        throw new Error("CONTACT_CHANGED");
      }
      await this.pollSession(session, this.lifecycleGeneration);
      this.assertDeliveryCurrent(generation, signal);
      latest = await this.repository.get(key);
      this.assertDeliveryCurrent(generation, signal);
      if (latest?.status !== "prepared" || latest.intent === null) return;
    } catch {
      const cancelled = await this.repository.compareAndSet({
        key,
        expectedStatus: "prepared",
        next: { status: "cancelled", reason: "CONTACT_CHANGED" },
        now: this.safeNow(),
      });
      if (cancelled) await this.wakeBufferedContact(key.contactId);
      return;
    }
    try {
      this.assertDeliveryCurrent(generation, signal);
      const delivered = await this.options.delivery.deliver(this.mintPreparedClaim({
        kind: "delivery",
        target: current,
        intent: latest.intent,
        signal,
        recordVersion: latest.updatedAt,
        readbackBaseline: null,
        key,
      }));
      if (delivered.submitCount !== 1) {
        throw new Error("REALTIME_DELIVERY_RECEIPT_INVALID");
      }
      const completed = await this.repository.compareAndSet({
        key,
        expectedStatus: "submit-started",
        next: { status: delivered.status },
        now: this.safeNow(),
      });
      if (completed) await this.wakeBufferedContact(key.contactId);
    } catch (error: unknown) {
      if (isBusy(error)) return;
      if (
        error instanceof Error &&
        error.message === "REALTIME_OWNER_REPLIED"
      ) {
        const cancelled = await this.repository.compareAndSet({
          key,
          expectedStatus: "prepared",
          next: { status: "cancelled", reason: "OWNER_REPLIED" },
          now: this.safeNow(),
        });
        if (cancelled) await this.wakeBufferedContact(key.contactId);
        return;
      }
      const afterFailure = await this.repository.get(key);
      if (afterFailure?.status === "submit-started") {
        const uncertain = await this.repository.compareAndSet({
          key,
          expectedStatus: "submit-started",
          next: { status: "submitted-uncertain" },
          now: this.safeNow(),
        });
        if (uncertain) await this.wakeBufferedContact(key.contactId);
      } else {
        await this.fail(key, "SOURCE_BLOCKED", "prepared");
      }
    } finally {
      await this.releasePendingIfIdle();
      await this.startQueuedBatch(key.contactId);
    }
  }

  private startPreparedDelivery(key: RealtimeReplyKey): void {
    if (this.deliveryTasks.has(key.contactId)) return;
    const controller = new AbortController();
    this.deliveryControllers.add(controller);
    const task = this.deliverPrepared(key, controller.signal, this.lifecycleGeneration)
      .catch(() => undefined)
      .finally(() => {
        if (this.deliveryTasks.get(key.contactId) === task) {
          this.deliveryTasks.delete(key.contactId);
        }
        this.deliveryControllers.delete(controller);
      });
    this.deliveryTasks.set(key.contactId, task);
  }

  private async runRecovery(
    now: Date,
  ): Promise<readonly RealtimeRecoveryReceipt[]> {
    const receipts: RealtimeRecoveryReceipt[] = [];
    const generation = this.lifecycleGeneration;
    const recoveryOnly = this.lifecycleState === "stopped";
    try {
      for (const record of await this.repository.listRecoverable()) {
        if (this.isStoppingOrStale(generation)) break;
        const key = keyOf(record);
        if (record.status === "new" || record.status === "generating") {
          const failed = await this.repository.compareAndSet({
            key,
            expectedStatus: record.status,
            next: { status: "failed", reason: "RECOVERY_CANCELLED" },
            now,
          });
          if (failed) {
            receipts.push(recoveryReceipt(record, "cancelled"));
            await this.wakeBufferedContact(record.contactId);
          }
          continue;
        }
        if (record.status === "prepared") {
          const target =
            await ContactDirectory.prototype.requireActiveAutoReplyTarget.call(
              this.options.directory,
              record.contactId,
            );
          const hadSession = this.sessions.has(record.contactId);
          const session = await this.ensureSession(
            target,
            generation,
            recoveryOnly,
          );
          const staleBeforeDelivery = this.isStoppingOrStale(generation);
          let deliveryError: unknown;
          if (!staleBeforeDelivery) {
            try {
              const controller = new AbortController();
              this.deliveryControllers.add(controller);
              try {
                await this.deliverPrepared(key, controller.signal, generation);
              } finally {
                this.deliveryControllers.delete(controller);
              }
            } catch (error: unknown) {
              deliveryError = error;
            }
          }
          const closeErrors =
            recoveryOnly && !hadSession
              ? await this.closeOneSession(session)
              : [];
          if (closeErrors.length === 0 && recoveryOnly && !hadSession) {
            this.sessions.delete(record.contactId);
          }
          if (closeErrors.length > 0) {
            this.options.admission.quarantine();
            this.lifecycleState = "quarantined";
            throw new AggregateError(
              deliveryError === undefined
                ? closeErrors
                : [deliveryError, ...closeErrors],
              "REALTIME_SOURCE_CLOSE_FAILED",
            );
          }
          if (deliveryError !== undefined) throw asError(deliveryError);
          if (staleBeforeDelivery) break;
          const completed = await this.repository.get(key);
          if (
            completed?.status === "verified" ||
            completed?.status === "submitted-uncertain"
          ) {
            receipts.push(recoveryReceipt(record, completed.status));
          }
          continue;
        }
        let expectedStatus = record.status;
        if (record.status === "submit-started") {
          if (
            !(await this.repository.compareAndSet({
              key,
              expectedStatus: "submit-started",
              next: { status: "submitted-uncertain" },
              now,
            }))
          )
            continue;
          expectedStatus = "submitted-uncertain";
        }
        const current = await this.repository.get(key);
        if (current?.intent === null || current === null) continue;
        let status: "verified" | "submitted-uncertain" = "submitted-uncertain";
        try {
          if (this.isStoppingOrStale(generation)) break;
          const target =
            await ContactDirectory.prototype.requireActiveAutoReplyTarget.call(
              this.options.directory,
              record.contactId,
            );
          if (this.isStoppingOrStale(generation)) break;
          assertAuthorizedWechatTarget(target);
          if (!recordMatchesTarget(record, target))
            throw new Error("CONTACT_CHANGED");
          if (this.isStoppingOrStale(generation)) break;
          const controller = new AbortController();
          this.deliveryControllers.add(controller);
          try {
            status =
              (await this.options.delivery.recoverSubmitted?.(this.mintPreparedClaim({
                kind: "recovery",
                target,
                intent: current.intent,
                readbackBaseline: current.readbackBaseline,
                signal: controller.signal,
                recordVersion: current.updatedAt,
                key,
              }))) ?? "submitted-uncertain";
          } finally {
            this.deliveryControllers.delete(controller);
          }
          if (status === "verified") {
            await this.repository.compareAndSet({
              key,
              expectedStatus,
              next: { status: "verified" },
              now,
            });
            await this.wakeBufferedContact(record.contactId);
          }
        } catch {
          status = "submitted-uncertain";
        }
        receipts.push(recoveryReceipt(record, status));
      }
    } finally {
      await this.compensateQueuedBatches();
      await this.releasePendingIfIdle();
    }
    return Object.freeze(receipts);
  }

  private async restoreBufferedBatches(): Promise<void> {
    for (const batch of await this.repository.listBufferedBatches()) {
      this.ensurePendingAnnouncement(batch.contactId);
      const session = this.sessions.get(batch.contactId);
      if (session !== undefined)
        await this.scheduleBufferedBatch(session, batch);
    }
  }

  private async startQueuedBatch(contactId: ContactId): Promise<void> {
    if (
      this.lifecycleState !== "running" ||
      (await this.repository.hasActiveForContact(contactId))
    )
      return;
    const batch = (await this.repository.listBufferedBatches()).find(
      (candidate) => candidate.contactId === contactId,
    );
    const session = this.sessions.get(contactId);
    if (batch !== undefined && session !== undefined) {
      await this.scheduleBufferedBatch(session, batch);
    }
  }

  private async fail(
    key: RealtimeReplyKey,
    reason: "NO_REPLY" | "SOURCE_BLOCKED" | "RECOVERY_CANCELLED",
    expectedStatus: "new" | "generating" | "prepared",
  ): Promise<boolean> {
    const failed = await this.repository.compareAndSet({
      key,
      expectedStatus,
      next: { status: "failed", reason },
      now: this.safeNow(),
    });
    if (failed) await this.wakeBufferedContact(key.contactId);
    return failed;
  }

  private mintPreparedClaim(input: {
    readonly kind: "delivery" | "recovery";
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
    readonly signal: AbortSignal;
    readonly recordVersion: string;
    readonly readbackBaseline: RealtimeReadbackBaseline | null;
    readonly key: RealtimeReplyKey;
  }): PreparedReplyClaim {
    const claim = Object.freeze({}) as PreparedReplyClaim;
    preparedReplyClaims.set(claim, Object.freeze({
      kind: input.kind,
      target: input.target,
      intent: input.intent,
      signal: input.signal,
      recordVersion: input.recordVersion,
      readbackBaseline: input.readbackBaseline,
      markSubmitStarted: async (baseline: RealtimeReadbackBaseline) => {
        if (input.signal.aborted) return false;
        const current = await this.repository.get(input.key);
        if (
          current?.status !== "prepared" ||
          current.updatedAt !== input.recordVersion ||
          current.intent === null ||
          !recordMatchesTarget(current, input.target)
        ) return false;
        return this.repository.compareAndSet({
          key: input.key,
          expectedStatus: "prepared",
          next: { status: "submit-started", readbackBaseline: baseline },
          now: this.safeNow(),
        });
      },
    }));
    return claim;
  }

  private async wakeBufferedContact(contactId: ContactId): Promise<void> {
    const batch = (await this.repository.listBufferedBatches()).find(
      (candidate) => candidate.contactId === contactId,
    );
    if (batch === undefined) return;
    if (this.lifecycleState !== "running") return;
    this.ensurePendingAnnouncement(contactId);
    await this.startQueuedBatch(contactId);
  }

  private async compensateQueuedBatches(): Promise<void> {
    for (const batch of await this.repository.listBufferedBatches()) {
      if (this.lifecycleState !== "running") continue;
      this.ensurePendingAnnouncement(batch.contactId);
      await this.startQueuedBatch(batch.contactId);
    }
  }

  private ensurePendingAnnouncement(contactId: ContactId): void {
    if (!this.pendingAnnouncements.has(contactId)) {
      this.pendingAnnouncements.set(
        contactId,
        this.options.admission.announcePending("p1"),
      );
    }
  }

  private async releasePendingIfIdle(): Promise<void> {
    if (await this.repository.hasPendingWork()) return;
    this.releaseAllPendingAnnouncements();
  }

  private releaseAllPendingAnnouncements(): void {
    for (const release of this.pendingAnnouncements.values()) release();
    this.pendingAnnouncements.clear();
  }

  private scheduleDetector(delayMs: number): void {
    if (this.lifecycleState !== "running") return;
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null;
      this.scheduleDetector(this.pollIntervalMs);
      void this.tickOnce(this.safeNow()).catch(() => undefined);
    }, delayMs);
  }

  private clearDetectorTimer(): void {
    if (this.loopTimer !== null) clearTimeout(this.loopTimer);
    this.loopTimer = null;
  }

  private runLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private safeNow(): Date {
    const now = this.now();
    assertNow(now);
    return new Date(now.getTime());
  }

  private assertLifecycleGeneration(
    generation: number,
    expectedState: LifecycleState,
  ): void {
    if (
      generation !== this.lifecycleGeneration ||
      this.lifecycleState !== expectedState
    ) {
      throw new Error("REALTIME_LIFECYCLE_STALE");
    }
  }

  private isStoppingOrStale(generation: number): boolean {
    return (
      generation !== this.lifecycleGeneration ||
      this.lifecycleState === "stopping"
    );
  }

  private hasOutstandingLifecycleWork(): boolean {
    return (
      this.sessions.size > 0 ||
      this.deliveryTasks.size > 0 ||
      this.sessionTasks.size > 0 ||
      this.scanPromise !== null ||
      this.recoveryPromise !== null ||
      [...this.sessions.values()].some(
        (session) =>
          session.generationTask !== null ||
          session.pollTask !== null ||
          session.bufferTimer !== null,
      )
    );
  }

  private assertDeliveryCurrent(
    generation: number,
    signal: AbortSignal,
  ): void {
    if (
      signal.aborted ||
      this.isStoppingOrStale(generation) ||
      this.lifecycleState === "quarantined"
    ) {
      throw new Error("REALTIME_LIFECYCLE_STALE");
    }
  }

  private async closeSessionsBounded(boundedWait = true): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const [contactId, session] of this.sessions) {
      const sessionErrors = await this.closeOneSession(session, boundedWait);
      errors.push(...sessionErrors);
      if (sessionErrors.length === 0) this.sessions.delete(contactId);
    }
    return errors;
  }

  private async closeOneSession(
    session: ContactSession,
    boundedWait = true,
  ): Promise<unknown[]> {
    session.closeContinuation ??= (async () => {
      if (session.pollTask !== null) await session.pollTask;
      await session.source.stop();
      await session.source.close();
    })();
    try {
      if (boundedWait) {
        await bounded(
          session.closeContinuation,
          this.lifecycleDrainTimeoutMs,
          "REALTIME_SOURCE_CLOSE_TIMEOUT",
        );
      } else {
        await session.closeContinuation;
      }
      return [];
    } catch (error: unknown) {
      return [error];
    }
  }
}

function keyOf(record: RealtimeReplyRecord): RealtimeReplyKey {
  return {
    contactId: record.contactId,
    contactRevision: record.contactRevision,
    bindingHash: record.bindingHash,
    triggerId: record.triggerId,
  };
}

function recordMatchesTarget(
  record: RealtimeReplyRecord,
  target: AuthorizedWechatTarget,
): boolean {
  assertAuthorizedWechatTarget(target);
  return (
    record.contactId === target.contactId &&
    record.contactRevision === target.revision &&
    record.bindingHash === target.bindingHash
  );
}

function sameTarget(
  left: AuthorizedWechatTarget,
  right: AuthorizedWechatTarget,
): boolean {
  assertAuthorizedWechatTarget(left);
  assertAuthorizedWechatTarget(right);
  return (
    left.contactId === right.contactId &&
    left.revision === right.revision &&
    left.bindingHash === right.bindingHash &&
    left.enrollmentFingerprint === right.enrollmentFingerprint
  );
}

function recoveryReceipt(
  record: RealtimeReplyRecord,
  status: RealtimeRecoveryReceipt["status"],
): RealtimeRecoveryReceipt {
  return {
    contactId: record.contactId,
    triggerId: record.triggerId,
    status,
    submitCount: 0,
  };
}

function rotate<T>(values: readonly T[], offset: number): readonly T[] {
  if (values.length < 2) return values;
  const normalized = offset % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

function busyReceipt(): RealtimeTickReceipt {
  return { status: "busy", detectedContacts: 0, prepared: 0, submitCount: 0 };
}

function degradedReceipt(): RealtimeTickReceipt {
  return {
    status: "degraded",
    detectedContacts: 0,
    prepared: 0,
    submitCount: 0,
  };
}

function assertNow(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("REALTIME_NOW_INVALID");
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /BUSY|INCOMING_PENDING/u.test(error.message);
}

function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(asError(error));
      },
    );
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(asError(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(asError(error));
      },
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("REALTIME_OPERATION_FAILED", { cause: error });
}
