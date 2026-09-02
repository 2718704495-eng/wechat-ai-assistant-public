import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { DailyCareProductionRuntime } from "./daily-care-bootstrap.js";
import { createDailyCareProductionSession } from "./daily-care-session.js";
import type { LiveProductionRuntime } from "./live-bootstrap.js";
import { createLiveSupervisorSession } from "./live-supervisor-session.js";
import {
  SingleDispatcherAdmission,
  type DispatcherOwner,
} from "../runtime-v2/single-dispatcher-admission.js";
import {
  InMemoryOperationQuarantineRepository,
  type OperationQuarantineRepository,
} from "../runtime-v2/operation-quarantine.js";
import type {
  ScheduledCycleGate,
  ScheduledCycleGateSession,
  SchedulerCycleOutcome,
} from "../runtime-v2/single-scheduler.js";
import type { ScheduledLane } from "../runtime-v2/single-scheduler.js";

type CycleMode = "passive" | "daily-care";
type CycleSession = ReturnType<typeof createLiveSupervisorSession>
  | ReturnType<typeof createDailyCareProductionSession>;

interface ActiveCycle {
  readonly mode: CycleMode;
  readonly runtime: LiveProductionRuntime | DailyCareProductionRuntime;
  readonly dispatcherSession: ScheduledCycleGateSession;
  readonly session: CycleSession;
  readonly timeout: Promise<never>;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cycleId: string;
  readonly complete: (input: SchedulerCycleOutcome) => Promise<void>;
  draftPending: boolean;
  outcomeFailed: boolean;
  submitUncertain: boolean;
  closeIntent: Promise<void> | null;
  closing: Promise<void> | null;
  expired: boolean;
  inFlightOperations: number;
}

export interface FixedHeartbeatRuntimeFactories {
  recoverRealtimePending?: () => Promise<readonly unknown[]>;
  selectScheduledLane: () => Promise<ScheduledLane>;
  beginScheduledTick: () => Promise<
    | {
      readonly lane: "p1";
      readonly runtime: LiveProductionRuntime;
      readonly cycleId: string;
      readonly complete: (input: SchedulerCycleOutcome) => Promise<void>;
    }
    | {
      readonly lane: "p0";
      readonly runtime: DailyCareProductionRuntime;
      readonly cycleId: string;
      readonly complete: (input: SchedulerCycleOutcome) => Promise<void>;
    }
    | {
      readonly lane: "outside";
      readonly status: "outside-window";
    }
  >;
}

export interface FixedHeartbeatSupervisorOptions {
  cycleTimeoutMs?: number;
  quarantineRepository?: OperationQuarantineRepository;
  releaseSha256?: string;
  dispatcherGate?: ScheduledCycleGate;
}

export interface FixedHeartbeatSupervisor {
  readonly server: McpServer;
  shutdown(): Promise<void>;
}

const noInput = {};
const passiveText = {
  text: z.string().min(1).max(500).refine((text) => text.trim().length > 0)
    .refine((text) => !/[\r\n]/u.test(text)),
};
const broadcastText = { text: z.string().min(1).max(1_000) };

export function createFixedHeartbeatSupervisor(
  factories: FixedHeartbeatRuntimeFactories,
  options: FixedHeartbeatSupervisorOptions = {},
): FixedHeartbeatSupervisor {
  const cycleTimeoutMs = options.cycleTimeoutMs ?? 90_000;
  if (!Number.isFinite(cycleTimeoutMs) || cycleTimeoutMs <= 0 || cycleTimeoutMs > 90_000) {
    throw new Error("FIXED_HEARTBEAT_TIMEOUT_INVALID");
  }

  const server = new McpServer({ name: "chat-assistant-supervisor", version: "2.0.0" });
  const quarantineRepository = options.quarantineRepository ??
    new InMemoryOperationQuarantineRepository();
  const releaseSha256 = options.releaseSha256 ?? "0".repeat(64);
  if (!/^[a-f0-9]{64}$/u.test(releaseSha256)) {
    throw new Error("FIXED_HEARTBEAT_RELEASE_IDENTITY_INVALID");
  }
  let active: ActiveCycle | null = null;
  let operationTail: Promise<void> = Promise.resolve();
  let shutdownPromise: Promise<void> | null = null;
  let shutdownRequested = false;
  let inFlightDecision: Promise<void> | null = null;
  let lateDecisionCleanup: Promise<void> | null = null;
  let lateDecisionCleanupError: Error | null = null;
  type RuntimeDecision = Exclude<
    Awaited<ReturnType<FixedHeartbeatRuntimeFactories["beginScheduledTick"]>>,
    { readonly lane: "outside" }
  >;
  let pendingDecision: RuntimeDecision | null = null;
  const acquirePendingRuntimeOwner = (
    lane: "p0" | "p1" | "acceptance",
  ): Promise<DispatcherOwner> => {
    if (lane === "acceptance") throw new Error("FIXED_HEARTBEAT_LANE_INVALID");
    const decision = pendingDecision;
    if (decision === null || decision.lane !== lane) {
      throw new Error("FIXED_HEARTBEAT_SCHEDULER_DECISION_INVALID");
    }
    pendingDecision = null;
    return Promise.resolve({
      close: () => Promise.resolve({ gateReleased: true }),
    });
  };
  const fallbackAdmission = new SingleDispatcherAdmission<DispatcherOwner>({
      acquireOwner: acquirePendingRuntimeOwner,
    });
  const dispatcher: ScheduledCycleGate = options.dispatcherGate ??
    Object.freeze({
      admit: async (lane: "p0" | "p1") => {
        const session = await fallbackAdmission.admit(lane);
        return Object.freeze({ close: () => session.close() });
      },
      cancelPendingAcquisition: () =>
        fallbackAdmission.cancelPendingAcquisition(),
      close: () => Promise.resolve(),
    });

  register("begin-scheduled-tick", noInput, () => enqueue(beginScheduledTick));
  register("prepare-latest-reply", passiveText, ({ text }) =>
    run("passive", { op: "prepare-latest-reply", text }, "draft-created"));
  register("show-comfort-station", noInput, () =>
    run("passive", { op: "show-comfort-station" }));
  register("research-morning-weather", noInput, () =>
    run("daily-care", { op: "research-morning-weather" }));
  register("prepare-broadcast", broadcastText, ({ text }) =>
    run("daily-care", { op: "prepare-broadcast", text }, "draft-created"));
  register("verify-draft", noInput, () => runActive({ op: "verify-draft" }));
  register("submit-authorized-draft", noInput, () =>
    run("passive", { op: "submit-authorized-draft" }, "draft-consumed"));
  register("submit-authorized-broadcast", noInput, () =>
    run("daily-care", { op: "submit-authorized-broadcast" }, "draft-consumed"));
  register("abort-draft", noInput, () => runActive({ op: "abort-draft" }, "draft-consumed"));
  register("verify-send", noInput, () => runActive({ op: "verify-send" }));
  register("close", noInput, closeActive);

  return { server, shutdown };

  function register<T extends z.ZodRawShape>(
    name: string,
    shape: T,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
  ): void {
    const inputSchema = z.object(shape).strict();
    server.registerTool<typeof inputSchema, typeof inputSchema>(
      name,
      { inputSchema },
      async (input): Promise<CallToolResult> => {
        try {
          const result = await handler(input);
          return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] };
        } catch (error: unknown) {
          const publicReason = publicOperationError(error);
          return {
            isError: true,
            content: [{ type: "text", text: publicReason }],
          };
        }
      },
    );
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function run(
    mode: CycleMode,
    command: unknown,
    effect?: "draft-created" | "draft-consumed",
  ): Promise<unknown> {
    return enqueue(async () => {
      await rejectAfterCloseIntent(active);
      const cycle = requireCycle(mode);
      cycle.inFlightOperations += 1;
      let result: unknown;
      try {
        result = await Promise.race([cycle.session.execute(command), cycle.timeout]);
      } catch (error: unknown) {
        cycle.outcomeFailed = true;
        if (isSubmitCommand(command)) cycle.submitUncertain = true;
        throw error;
      } finally {
        cycle.inFlightOperations -= 1;
      }
      if (effect === "draft-created") cycle.draftPending = true;
      if (effect === "draft-consumed") cycle.draftPending = false;
      return result;
    });
  }

  function runActive(
    command: unknown,
    effect?: "draft-created" | "draft-consumed",
  ): Promise<unknown> {
    return enqueue(async () => {
      const cycle = active;
      await rejectAfterCloseIntent(cycle);
      if (cycle === null || cycle.expired || cycle.closing !== null) {
        throw new Error("FIXED_HEARTBEAT_NO_ACTIVE_CYCLE");
      }
      cycle.inFlightOperations += 1;
      let result: unknown;
      try {
        result = await Promise.race([cycle.session.execute(command), cycle.timeout]);
      } catch (error: unknown) {
        cycle.outcomeFailed = true;
        if (isSubmitCommand(command)) cycle.submitUncertain = true;
        throw error;
      } finally {
        cycle.inFlightOperations -= 1;
      }
      if (effect === "draft-created") cycle.draftPending = true;
      if (effect === "draft-consumed") cycle.draftPending = false;
      return result;
    });
  }

  function beginScheduledTick(): Promise<unknown> {
    if (active !== null || inFlightDecision !== null) {
      return Promise.reject(new Error("FIXED_HEARTBEAT_CYCLE_ACTIVE"));
    }
    const attempt = beginScheduledTickAttempt();
    const tracked = attempt.then(() => undefined, () => undefined).finally(() => {
      if (inFlightDecision === tracked) inFlightDecision = null;
    });
    inFlightDecision = tracked;
    return attempt;
  }

  async function beginScheduledTickAttempt(): Promise<unknown> {
    const acquisitionStartedAt = Date.now();
    const decisionCreation = (async () => {
      await assertNoDurableQuarantineBeforeUi();
      if (!shutdownRequested) await factories.recoverRealtimePending?.();
      return factories.selectScheduledLane();
    })().then(async (selectedLane) => {
      if (selectedLane === "outside") return outsideDecision();
      if (shutdownRequested) throw new Error("FIXED_HEARTBEAT_SHUTTING_DOWN");
      if (lateDecisionCleanup !== null) {
        throw new Error("FIXED_HEARTBEAT_CYCLE_ACTIVE");
      }
      if (lateDecisionCleanupError !== null) {
        throw new Error("FIXED_HEARTBEAT_DURABLE_QUARANTINE");
      }
      if (shutdownRequested) throw new Error("FIXED_HEARTBEAT_SHUTTING_DOWN");
      return factories.beginScheduledTick();
    });
    let decisionTimer: ReturnType<typeof setTimeout> | null = null;
    let decisionTimedOut = false;
    const decisionDeadline = new Promise<never>((_resolve, reject) => {
      decisionTimer = setTimeout(() => {
        decisionTimedOut = true;
        reject(new Error("FIXED_HEARTBEAT_RUNTIME_ACQUISITION_TIMEOUT"));
      }, cycleTimeoutMs);
    });
    let decision: Awaited<ReturnType<FixedHeartbeatRuntimeFactories["beginScheduledTick"]>>;
    try {
      decision = await Promise.race([decisionCreation, decisionDeadline]);
    } finally {
      if (decisionTimer !== null) clearTimeout(decisionTimer);
      if (decisionTimedOut) {
        trackLateDecisionCleanup(decisionCreation);
      }
    }
    if (decision.lane === "outside") return decision;
    if (shutdownRequested) {
      await settleDecisionDuringShutdown(decision);
      throw new Error("FIXED_HEARTBEAT_SHUTTING_DOWN");
    }
    pendingDecision = decision;
    const mode: CycleMode = decision.lane === "p1" ? "passive" : "daily-care";
    let dispatcherSession: ScheduledCycleGateSession;
    try {
      dispatcherSession = await acquireRuntime(mode);
    } catch (error: unknown) {
      pendingDecision = null;
      await decision.runtime.close().catch(() => undefined);
      await decision.complete({ success: false });
      throw error;
    }
    if (shutdownRequested) {
      await settleDecisionDuringShutdown(decision, async () => {
        await closeRuntimeAndDispatcher(decision.runtime, dispatcherSession);
      });
      throw new Error("FIXED_HEARTBEAT_SHUTTING_DOWN");
    }
    const runtime = decision.runtime;
    const remainingCycleMs = Math.max(
      1,
      cycleTimeoutMs - (Date.now() - acquisitionStartedAt),
    );
    let rejectTimeout: (error: Error) => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    void timeout.catch(() => undefined);
    const cycle: ActiveCycle = {
      mode,
      cycleId: decision.cycleId,
      complete: decision.complete,
      runtime,
      dispatcherSession,
      session: mode === "passive"
        ? createLiveSupervisorSession(
          (runtime as LiveProductionRuntime).dependencies,
          { directTargetStart: true },
        )
        : createDailyCareProductionSession(
          (runtime as DailyCareProductionRuntime).dependencies,
        ),
      timeout,
      timer: setTimeout(() => {
        cycle.expired = true;
        rejectTimeout(new Error("FIXED_HEARTBEAT_CYCLE_TIMEOUT"));
        void forceClose(cycle).catch(() => undefined);
      }, remainingCycleMs),
      draftPending: false,
      outcomeFailed: false,
      submitUncertain: false,
      closeIntent: null,
      closing: null,
      expired: false,
      inFlightOperations: 0,
    };
    active = cycle;
    const initialCommand = mode === "passive"
      ? { op: "read-target" as const }
      : { op: "begin-current-slot" as const };
    cycle.inFlightOperations += 1;
    try {
      const result = await Promise.race([cycle.session.execute(initialCommand), cycle.timeout]);
      return { lane: decision.lane, result };
    } catch (error: unknown) {
      cycle.outcomeFailed = true;
      throw error;
    } finally {
      cycle.inFlightOperations -= 1;
    }
  }

  function trackLateDecisionCleanup(
    decisionCreation: Promise<Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>>,
  ): void {
    const attempt = decisionCreation.then(
      (lateDecision) => lateDecision.lane === "outside"
        ? undefined
        : settleLateDecision(lateDecision),
      () => undefined,
    );
    const tracked = attempt.catch((error: unknown) => {
      lateDecisionCleanupError = asError(error);
      throw error;
    }).finally(() => {
      if (lateDecisionCleanup === tracked) lateDecisionCleanup = null;
    });
    lateDecisionCleanup = tracked;
    void tracked.catch(() => undefined);
  }

  async function settleLateDecision(
    decision: Exclude<Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>, { readonly lane: "outside" }>,
    closeOwner: () => Promise<void> = () => decision.runtime.close(),
  ): Promise<void> {
    const errors: Error[] = [];
    let closeFailed = false;
    let outcomeFailed = false;
    try {
      await closeOwner();
    } catch (error: unknown) {
      closeFailed = true;
      errors.push(asError(error));
    }
    try {
      await decision.complete({ success: false });
    } catch (error: unknown) {
      outcomeFailed = true;
      errors.push(asError(error));
    }
    if (closeFailed || outcomeFailed) {
      const reason = closeFailed ? "OWNER_RELEASE_UNPROVEN" : "OUTCOME_DURABILITY_FAILED";
      try {
        await quarantineRepository.quarantine({
          lane: decision.lane,
          reason,
          cycleId: decision.cycleId,
          releaseSha256,
          draftPending: false,
          submitUncertain: false,
          outcomeCause: reason,
        });
      } catch (error: unknown) {
        errors.push(asError(error));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "FIXED_HEARTBEAT_LATE_DECISION_CLEANUP_FAILED");
    }
  }

  async function settleDecisionDuringShutdown(
    decision: Exclude<Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>, { readonly lane: "outside" }>,
    closeOwner?: () => Promise<void>,
  ): Promise<void> {
    try {
      await settleLateDecision(decision, closeOwner);
    } catch (error: unknown) {
      lateDecisionCleanupError = asError(error);
      throw error;
    }
  }

  function requireCycle(mode: CycleMode): ActiveCycle {
    if (active === null) throw new Error("FIXED_HEARTBEAT_NO_ACTIVE_CYCLE");
    if (active.expired || active.closeIntent !== null || active.closing !== null) {
      throw new Error("FIXED_HEARTBEAT_CYCLE_EXPIRED");
    }
    if (active.mode !== mode) throw new Error("FIXED_HEARTBEAT_MODE_CONFLICT");
    return active;
  }

  async function acquireRuntime(
    mode: CycleMode,
  ): Promise<ScheduledCycleGateSession> {
    const creation = dispatcher.admit(mode === "passive" ? "p1" : "p0");
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        dispatcher.cancelPendingAcquisition();
        reject(new Error("FIXED_HEARTBEAT_RUNTIME_ACQUISITION_TIMEOUT"));
      }, cycleTimeoutMs);
    });
    try {
      return await Promise.race([creation, deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (timedOut) {
        void creation.then((lateSession) => lateSession.close()).catch(() => undefined);
      }
    }
  }

  async function closeActive(): Promise<{ closed: true; active: boolean }> {
    const cycle = active;
    if (cycle === null) return { closed: true, active: false };
    await gracefulClose(cycle);
    return { closed: true, active: true };
  }

  function gracefulClose(cycle: ActiveCycle): Promise<void> {
    if (cycle.closing !== null) return cycle.closing;
    const terminalBarrier = terminalBarrierFor(cycle);
    return beginCloseAfterDurableBarrier(cycle, terminalBarrier, async () => {
      let sessionError: unknown;
      try {
        if (cycle.inFlightOperations > 0) {
          await Promise.race([operationTail, cycle.timeout]);
        }
        if (cycle.mode === "passive" && cycle.draftPending && !cycle.expired) {
          await Promise.race([
            cycle.session.execute({ op: "abort-draft" }),
            cycle.timeout,
          ]);
          cycle.draftPending = false;
        }
        if (!cycle.expired) {
          await Promise.race([cycle.session.execute({ op: "close" }), cycle.timeout]);
        }
      } catch (error: unknown) {
        sessionError = error;
      }
      if (sessionError !== undefined || cycle.inFlightOperations > 0 || cycle.expired) {
        await durableQuarantineBeforeOwnerRelease(cycle,
          cycle.draftPending ? "DRAFT_CLEAR_UNPROVEN" : "UI_OPERATION_UNSETTLED");
      }
      const success = sessionError === undefined && !cycle.expired &&
        !cycle.outcomeFailed && !cycle.submitUncertain;
      let completionError: unknown;
      try {
        await cycle.complete({ success });
      } catch (error: unknown) {
        completionError = error;
        await durableQuarantineBeforeOwnerRelease(cycle, "OUTCOME_DURABILITY_FAILED");
      }
      let ownerCloseError: unknown;
      try {
        await closeRuntimeAndDispatcher(cycle.runtime, cycle.dispatcherSession);
      } catch (error: unknown) {
        ownerCloseError = error;
        await durableQuarantineBeforeOwnerRelease(cycle, "OWNER_RELEASE_UNPROVEN");
      }
      let barrierClearError: unknown;
      if (success && completionError === undefined && ownerCloseError === undefined) {
        try {
          await quarantineRepository.clearTerminalBarrier(terminalBarrier);
        } catch (error: unknown) {
          barrierClearError = error;
        }
      }
      finishCycle(cycle);
      if (sessionError !== undefined) throw asError(sessionError);
      if (ownerCloseError !== undefined) throw asError(ownerCloseError);
      if (completionError !== undefined) throw asError(completionError);
      if (barrierClearError !== undefined) throw asError(barrierClearError);
    });
  }

  function forceClose(cycle: ActiveCycle): Promise<void> {
    if (cycle.closing !== null) return cycle.closing;
    return beginCloseAfterDurableBarrier(cycle, terminalBarrierFor(cycle), async () => {
      try {
        await durableQuarantineBeforeOwnerRelease(cycle, "UI_OPERATION_TIMEOUT");
        try {
          await cycle.complete({ success: false });
        } catch (error: unknown) {
          await durableQuarantineBeforeOwnerRelease(cycle, "OUTCOME_DURABILITY_FAILED");
          await closeRuntimeAndDispatcher(cycle.runtime, cycle.dispatcherSession);
          throw error;
        }
        await closeRuntimeAndDispatcher(cycle.runtime, cycle.dispatcherSession);
      } finally {
        finishCycle(cycle);
      }
    });
  }

  function beginCloseAfterDurableBarrier(
    cycle: ActiveCycle,
    terminalBarrier: ReturnType<typeof terminalBarrierFor>,
    closeBody: () => Promise<void>,
  ): Promise<void> {
    if (cycle.closing !== null) return cycle.closing;
    let closingPromise: Promise<void> | null = null;
    const rawAttempt = quarantineRepository.beginTerminalBarrier(terminalBarrier);
    const closeIntent = rawAttempt.catch((error: unknown) => {
      if (active === cycle && cycle.closeIntent === closeIntent &&
          cycle.closing === closingPromise) {
        cycle.closeIntent = null;
        cycle.closing = null;
      }
      throw error;
    });
    cycle.closeIntent = closeIntent;
    closingPromise = closeIntent.then(closeBody);
    cycle.closing = closingPromise;
    return closingPromise;
  }

  async function rejectAfterCloseIntent(cycle: ActiveCycle | null): Promise<void> {
    if (cycle?.closeIntent === null || cycle === null) return;
    try {
      await cycle.closeIntent;
    } catch (error: unknown) {
      if (cycle.closeIntent === null && cycle.closing === null && !cycle.expired) return;
      throw error;
    }
    throw new Error("FIXED_HEARTBEAT_CYCLE_EXPIRED");
  }

  function terminalBarrierFor(cycle: ActiveCycle) {
    return {
      lane: cycle.mode === "passive" ? "p1" as const : "p0" as const,
      cycleId: cycle.cycleId,
      releaseSha256,
      draftPending: cycle.draftPending,
      submitUncertain: cycle.submitUncertain,
    };
  }

  async function durableQuarantineBeforeOwnerRelease(
    cycle: ActiveCycle,
    reason: string,
  ): Promise<void> {
    await quarantineRepository.quarantine({
      lane: cycle.mode === "passive" ? "p1" : "p0",
      reason,
      cycleId: cycle.cycleId,
      releaseSha256,
      draftPending: cycle.draftPending,
      submitUncertain: cycle.submitUncertain,
      outcomeCause: cycle.expired ? "OPERATION_TIMEOUT" : reason,
    });
  }

  async function assertNoDurableQuarantineBeforeUi(): Promise<void> {
    await quarantineRepository.assertClear();
  }

  function finishCycle(cycle: ActiveCycle): void {
    clearTimeout(cycle.timer);
    cycle.draftPending = false;
    if (active === cycle) active = null;
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise !== null) return shutdownPromise;
    shutdownRequested = true;
    shutdownPromise = (async () => {
      while (true) {
        const cycle = active;
        if (cycle !== null) {
          await gracefulClose(cycle);
          continue;
        }
        const decision = inFlightDecision;
        if (decision !== null) {
          await decision;
          continue;
        }
        const cleanup = lateDecisionCleanup;
        if (cleanup !== null) {
          await cleanup;
          continue;
        }
        break;
      }
      if (lateDecisionCleanupError !== null) throw lateDecisionCleanupError;
    })();
    return shutdownPromise;
  }
}

function outsideDecision() {
  return { lane: "outside" as const, status: "outside-window" as const };
}

async function closeRuntimeAndDispatcher(
  runtime: LiveProductionRuntime | DailyCareProductionRuntime,
  dispatcher: ScheduledCycleGateSession,
): Promise<void> {
  const errors: unknown[] = [];
  try { await runtime.close(); } catch (error: unknown) { errors.push(error); }
  try { await dispatcher.close(); } catch (error: unknown) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "FIXED_HEARTBEAT_OWNER_CLOSE_FAILED");
  }
}

function isSubmitCommand(command: unknown): boolean {
  if (command === null || typeof command !== "object" || Array.isArray(command)) return false;
  const op = (command as { op?: unknown }).op;
  return op === "submit-authorized-draft" || op === "submit-authorized-broadcast" ||
    op === "show-comfort-station";
}

export async function connectFixedHeartbeatSupervisorStdio(
  factories: FixedHeartbeatRuntimeFactories,
  options: FixedHeartbeatSupervisorOptions = {},
): Promise<FixedHeartbeatSupervisor> {
  const supervisor = createFixedHeartbeatSupervisor(factories, options);
  try {
    await supervisor.server.connect(new StdioServerTransport());
    return supervisor;
  } catch (error: unknown) {
    await supervisor.shutdown().catch(() => undefined);
    throw error;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("FIXED_HEARTBEAT_UNKNOWN_ERROR", { cause: error });
}

function publicOperationError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "DAILY_CARE_WEATHER_RETRYABLE") return "SLOT_RETRYABLE";
  if ([
    "DAILY_CARE_WEATHER_PERMANENT",
    "DAILY_CARE_RETRY_LIMIT_EXHAUSTED",
    "DAILY_CARE_SLOT_TERMINAL",
    "DAILY_CARE_SUBMITTED_UNCERTAIN",
  ].includes(code)) return "SLOT_TERMINAL";
  if (code === "DAILY_CARE_OUTSIDE_PRODUCTION_WINDOW") return "OUTSIDE_GRACE";
  if (code === "SYSTEM_STOPPED") return "SYSTEM_STOPPED";
  if (/BUSY|_ACTIVE$/u.test(code)) return "RUNTIME_BUSY";
  return "SUPERVISOR_OPERATION_FAILED";
}
