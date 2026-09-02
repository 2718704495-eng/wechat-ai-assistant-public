import type { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProductionSlot } from "../daily-care/schedule.js";
import {
  createDailyCareProductionService,
  inspectDailyCareProductionSlot,
  type DailyCareProductionRuntime,
} from "./daily-care-bootstrap.js";
import {
  connectFixedHeartbeatSupervisorStdio,
  type FixedHeartbeatRuntimeFactories,
  type FixedHeartbeatSupervisorOptions,
} from "./fixed-heartbeat-supervisor.js";
import {
  createProductionRealtimeReplyMain,
  type ProductionRealtimeReplyMain,
} from "../runtime-v2/realtime-reply-main.js";
import type { DailyCareSlot } from "../daily-care/types.js";
import {
  closeSharedLiveProductionRuntime,
  createLiveProductionRuntime,
  createSharedLiveProductionRuntime,
  type LiveProductionRuntime,
} from "./live-bootstrap.js";
import {
  FileSingleSchedulerStateRepository,
  InMemorySingleSchedulerStateRepository,
  SingleScheduler,
  createProductionScheduledRuntime,
  type P0SlotInspection,
  type SingleSchedulerOptions,
} from "../runtime-v2/single-scheduler.js";
import { FileOperationQuarantineRepository } from "../runtime-v2/operation-quarantine.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { NativeBridge } from "../adapters/native-bridge.js";
import { NativeWechatSurface } from "../adapters/native-wechat-surface.js";
import {
  AstrBotOneBotEngine,
  OneBotReverseWebSocketTransport,
  stableOneBotId,
  type OneBotWebSocketClient,
} from "../conversation/akasha-onebot-engine.js";
import {
  MacOSKeychainKeyProvider,
  type KeyProvider,
} from "../security/keychain.js";
import { EncryptedStore } from "../storage/encrypted-store.js";
import { DailyCareBroadcastRepository } from "../storage/daily-care-broadcast-repository.js";
import {
  acquireLiveOperationChildAdmission,
  acquireLiveOperationCoordinator,
} from "./live-operation-coordinator.js";
import {
  RealtimeReplyRepository,
  StateRepository,
} from "../storage/repositories.js";
import { NativeOcrInboundSource } from "../conversation/native-ocr-inbound-source.js";
import { WebSocket } from "undici";

interface SupervisorHandle {
  server: {
    server: { onclose?: () => void };
    close(): Promise<void>;
  };
  shutdown(): Promise<void>;
}

export interface StartFixedHeartbeatSupervisorMainOptions {
  environment?: Record<string, string | undefined>;
  input?: Pick<EventEmitter, "once">;
  signals?: Pick<EventEmitter, "once">;
  factories?: FixedHeartbeatRuntimeFactories;
  realtimeMain?: ProductionRealtimeReplyMain;
  markP0Skipped?: (slot: DailyCareSlot, now: Date) => Promise<void>;
  now?: () => Date;
  createDailyCareService?: (
    environment: Record<string, string | undefined>,
  ) => Promise<DailyCareProductionRuntime>;
  createPassiveService?: () => Promise<LiveProductionRuntime>;
  inspectDailyCareSlot?: (
    slot: NonNullable<ReturnType<typeof resolveProductionSlot>>,
    environment: Record<string, string | undefined>,
  ) => Promise<P0SlotInspection | null>;
  connect?: (
    factories: FixedHeartbeatRuntimeFactories,
    supervisorOptions?: FixedHeartbeatSupervisorOptions,
  ) => Promise<SupervisorHandle>;
  reportFailure?: (error: unknown) => void;
}

export async function startFixedHeartbeatSupervisorMain(
  options: StartFixedHeartbeatSupervisorMainOptions = {},
): Promise<{ close(): Promise<void> }> {
  const environment = options.environment ?? process.env;
  const input = options.input ?? process.stdin;
  const signals = options.signals ?? process;
  const now = options.now ?? (() => new Date());
  const loadedConfig = loadRuntimeConfig(environment);
  const stateRoot = resolveFixedHeartbeatStateRoot(
    loadedConfig.dataDir,
    environment,
  );
  const realtime = options.realtimeMain ?? null;
  const createDailyCareService =
    options.createDailyCareService ??
    createDailyCareProductionService;
  const createPassiveService =
    options.createPassiveService ??
    (() => createLiveProductionRuntime({ ownerKind: "mcp", environment }));
  const inspectDailyCareSlot =
    options.inspectDailyCareSlot ??
    inspectDailyCareProductionSlot;
  const schedulerOptions: Omit<SingleSchedulerOptions, "admission"> = {
    state:
      options.connect === undefined
        ? new FileSingleSchedulerStateRepository(stateRoot)
        : new InMemorySingleSchedulerStateRepository(),
    inspectP0Slot: (slot) => inspectDailyCareSlot(slot, environment),
    hasPendingRealtimeReply:
      realtime === null || realtime === undefined
        ? undefined
        : () => realtime.hasPendingWork(),
    hasRecentNaturalConversation:
      realtime === null || realtime === undefined
        ? undefined
        : (_slot, current) =>
            realtime.hasRecentConversation(current, 30 * 60 * 1_000),
    markP0Skipped: options.markP0Skipped,
  };
  const scheduler =
    realtime?.createScheduler(schedulerOptions) ??
    new SingleScheduler(schedulerOptions);
  const factories = options.factories ?? {
    recoverRealtimePending:
      realtime === null || realtime === undefined
        ? undefined
        : () => realtime.recoverPending(now()),
    selectScheduledLane: () => scheduler.inspectScheduledLane(now()),
    beginScheduledTick: () =>
      scheduler.beginScheduledTick(now(), {
        createPassive: createPassiveService,
        createDailyCare: () => createDailyCareService(environment),
      }),
  };
  const connect = options.connect ?? connectFixedHeartbeatSupervisorStdio;
  const reportFailure = options.reportFailure ?? defaultReportFailure;
  const supervisorOptions: FixedHeartbeatSupervisorOptions = {
    quarantineRepository: new FileOperationQuarantineRepository(stateRoot),
    releaseSha256:
      options.connect === undefined
        ? await loadPackagedReleaseSha256()
        : undefined,
    dispatcherGate: realtime?.cycleGate,
  };
  let supervisor: SupervisorHandle;
  try {
    await realtime?.start();
    supervisor =
      options.connect === undefined
        ? await connectFixedHeartbeatSupervisorStdio(factories, {
            ...supervisorOptions,
          })
        : await connect(factories, supervisorOptions);
  } catch (error: unknown) {
    const rollbackErrors: unknown[] = [error];
    try {
      await realtime?.stop();
    } catch (rollbackError: unknown) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 1) {
      throw new AggregateError(
        rollbackErrors,
        "FIXED_HEARTBEAT_REALTIME_START_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
  let closePromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    const attempt = (async () => {
      const errors: unknown[] = [];
      try {
        await supervisor.shutdown();
      } catch (error: unknown) {
        errors.push(error);
      }
      try {
        await realtime?.stop();
      } catch (error: unknown) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "FIXED_HEARTBEAT_RUNTIME_SHUTDOWN_FAILED",
        );
      }
    })();
    shutdownPromise = attempt.catch((error: unknown) => {
      if (shutdownPromise !== null) shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  };

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    const attempt = (async () => {
      const errors: Error[] = [];
      try {
        await supervisor.server.close();
      } catch (error: unknown) {
        errors.push(asError(error));
      }
      try {
        await shutdown();
      } catch (error: unknown) {
        errors.push(asError(error));
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "FIXED_HEARTBEAT_SUPERVISOR_CLOSE_FAILED",
        );
      }
    })();
    closePromise = attempt.catch((error: unknown) => {
      closePromise = null;
      throw error;
    });
    return closePromise;
  };

  const requestClose = (): void => {
    void close().catch(reportFailure);
  };
  supervisor.server.server.onclose = () => {
    void shutdown().catch(reportFailure);
  };
  input.once("end", requestClose);
  signals.once("SIGINT", requestClose);
  signals.once("SIGTERM", requestClose);
  return { close };
}

export interface DefaultProductionRealtimeMain extends ProductionRealtimeReplyMain {
  readonly markP0Skipped: (slot: DailyCareSlot, now: Date) => Promise<void>;
  readonly inspectDailyCareSlot: (
    slot: DailyCareSlot,
    environment: Record<string, string | undefined>,
  ) => Promise<P0SlotInspection | null>;
  readonly createPassiveService: () => Promise<LiveProductionRuntime>;
  readonly createDailyCareService: (
    environment: Record<string, string | undefined>,
  ) => Promise<DailyCareProductionRuntime>;
}

export interface DefaultProductionRealtimeCompositionOptions {
  readonly keyProvider?: KeyProvider;
  readonly testOnlyReleaseBinding?: import("../runtime-v2/supervised-acceptance.js").ReleaseBinding;
}

export async function createDefaultProductionRealtimeMain(
  environment: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
  composition: DefaultProductionRealtimeCompositionOptions = {},
): Promise<DefaultProductionRealtimeMain> {
  const config = loadRuntimeConfig(environment);
  const stateRoot = resolveFixedHeartbeatStateRoot(config.dataDir, environment);
  const keyProvider = composition.keyProvider ?? new MacOSKeychainKeyProvider();
  const store = new EncryptedStore(stateRoot, keyProvider);
  const authorityStore = new EncryptedStore(config.dataDir, keyProvider);
  const coordinator = await acquireLiveOperationCoordinator({
    dataDir: stateRoot,
    ownerKind: "mcp",
  });
  try {
    const inboundDeliveryAdmission = acquireLiveOperationChildAdmission(
      coordinator,
      "inbound-delivery",
    );
    let surface: NativeWechatSurface | null = null;
    const repository = new RealtimeReplyRepository(store);
    const stopState = new StateRepository(authorityStore);
    const sharedRuntime = createSharedLiveProductionRuntime({
      coordinator,
      store,
      dataDir: stateRoot,
    });
    const sourceEpoch = `native-ocr-${randomUUID()}`;
    const sessionId = `realtime-${randomUUID()}`;
    const main = createProductionRealtimeReplyMain({
      store,
      repository,
      sourceEpoch,
      sessionId,
      now,
      createNativeContext: (directory, cursorRepository) => {
        const projectRoot = projectRootForModule(import.meta.url);
        const executablePath = path.join(
          projectRoot,
          "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
        );
        surface = new NativeWechatSurface(
          new NativeBridge({ executablePath, dataDir: stateRoot }),
          now,
          undefined,
          { textTargetDirectory: directory },
        );
        return {
          conversationListReader: surface,
          createSource: (target) =>
            new NativeOcrInboundSource({
              sourceEpoch,
              sessionId,
              target,
              directory,
              cursorRepository,
              deliveryAdmission: inboundDeliveryAdmission,
              readSnapshot: () =>
                requireSurface(surface).readAuthorizedConversationSnapshot({
                  contactId: target.contactId,
                  expectedRevision: target.revision,
                }),
            }),
        };
      },
      createScheduledRuntime: (directory, stateRepository) =>
        createProductionScheduledRuntime({
          directory,
          getSurface: () => requireSurface(surface),
          repository: stateRepository,
          now,
          readAuthorizedConversation: (target) =>
            requireSurface(surface).readAuthorizedConversationSnapshot({
              contactId: target.contactId,
              expectedRevision: target.revision,
            }),
          isStopped: async () => (await stopState.getControlState()).stopped,
          hasPendingPriorityLane: (lane) =>
            lane === "p1"
              ? repository.hasPendingWork()
              : Promise.resolve(false),
          sharedRuntime,
        }),
      createEngine: (target, directory) => ({
        generate: async (request) => {
          const ownerIdentity =
            environment.CHAT_ASSISTANT_ONEBOT_OWNER_IDENTITY ??
            "wechat-owner-account";
          const transport = new OneBotReverseWebSocketTransport({
            url: environment.CHAT_ASSISTANT_ONEBOT_URL ?? "ws://127.0.0.1:6199",
            selfId: stableOneBotId(ownerIdentity),
            accessToken: environment.CHAT_ASSISTANT_ONEBOT_ACCESS_TOKEN,
            createSocket: ({ url, headers }) =>
              new WebSocket(url, {
                headers,
              }) as unknown as OneBotWebSocketClient,
          });
          const engine = await AstrBotOneBotEngine.create({
            directory,
            contactId: target.contactId,
            expectedRevision: target.revision,
            ownerIdentity,
            source: "native-ocr",
            sourceEpoch: request.sourceEpoch,
            sessionId: request.sessionId,
            transport,
            now,
          });
          try {
            await engine.start();
            return await engine.generate(request);
          } finally {
            await engine.close();
          }
        },
      }),
    });
    let closeState: "open" | "closing" | "closed" | "failed" = "open";
    let closeAttempt: Promise<void> | null = null;
    let startAttempt: Promise<void> | null = null;
    const dailyCareRepository = new DailyCareBroadcastRepository(store);
    const assertOperational = (): void => {
      if (closeState !== "open")
        throw new Error("REALTIME_PRODUCTION_TERMINAL");
    };
    return Object.freeze({
      cycleGate: main.cycleGate,
      start: () => {
        assertOperational();
        startAttempt ??= main.start().catch((error: unknown) => {
          closeState = "failed";
          throw error;
        });
        return startAttempt;
      },
      tickOnce: (current: Date) => {
        assertOperational();
        return main.tickOnce(current);
      },
      recoverPending: (current: Date) => {
        assertOperational();
        return main.recoverPending(current);
      },
      hasPendingWork: () => {
        assertOperational();
        return main.hasPendingWork();
      },
      hasRecentConversation: (current: Date, windowMs: number) => {
        assertOperational();
        return main.hasRecentConversation(current, windowMs);
      },
      isDispatcherQuarantined: () => {
        assertOperational();
        return main.isDispatcherQuarantined();
      },
      createScheduler: (
        schedulerOptions: Omit<SingleSchedulerOptions, "admission">,
      ) => {
        assertOperational();
        return main.createScheduler(schedulerOptions);
      },
      markP0Skipped: async (slot: DailyCareSlot) => {
        assertOperational();
        let record = await dailyCareRepository.getSlot(slot.slotKey);
        if (record === null) {
          try {
            record = await dailyCareRepository.claimSlot({
              slot,
              targetConversationId: "example-contact",
              targetModeHash: createHash("sha256")
                .update("production:example-contact")
                .digest("hex"),
            });
          } catch (error: unknown) {
            if (
              !(error instanceof Error) ||
              error.message !== "BROADCAST_SLOT_ALREADY_CLAIMED"
            ) {
              throw error;
            }
            record = await dailyCareRepository.getSlot(slot.slotKey);
            if (record === null)
              throw new Error("BROADCAST_CLAIM_RECORD_MISSING");
          }
        }
        if (record.status === "skipped") return;
        await dailyCareRepository.markSkipped(
          slot.slotKey,
          "recent-natural-conversation",
        );
      },
      inspectDailyCareSlot: async (slot: DailyCareSlot) => {
        assertOperational();
        const record = await dailyCareRepository.getSlot(slot.slotKey);
        return record === null ? null : { status: record.status };
      },
      createPassiveService: () => {
        assertOperational();
        return createLiveProductionRuntime({
          ownerKind: "mcp",
          environment,
          sharedRuntime,
          authorityStore,
          ...(composition.testOnlyReleaseBinding === undefined
            ? {}
            : { testOnlyReleaseBinding: composition.testOnlyReleaseBinding }),
        });
      },
      createDailyCareService: (
        runtimeEnvironment: Record<string, string | undefined>,
      ) => {
        assertOperational();
        return createDailyCareProductionService(runtimeEnvironment, {
          sharedRuntime,
          authorityStore,
          ...(composition.testOnlyReleaseBinding === undefined
            ? {}
            : { testOnlyReleaseBinding: composition.testOnlyReleaseBinding }),
        });
      },
      stop: () => {
        if (closeState === "closed") return Promise.resolve();
        if (closeAttempt !== null) return closeAttempt;
        closeState = "closing";
        closeAttempt = (async () => {
          await main.stop();
          await closeSharedLiveProductionRuntime(sharedRuntime);
          closeState = "closed";
        })().catch((error: unknown) => {
          closeState = "failed";
          throw new AggregateError(
            [error],
            "REALTIME_PRODUCTION_CLOSE_FAILED",
          );
        }).finally(() => {
          if (closeState !== "closed") closeAttempt = null;
        });
        return closeAttempt;
      },
    });
  } catch (error: unknown) {
    await coordinator.close().catch(() => undefined);
    throw error;
  }
}

function requireSurface(
  surface: NativeWechatSurface | null,
): NativeWechatSurface {
  if (surface === null)
    throw new Error("REALTIME_PRODUCTION_SURFACE_UNAVAILABLE");
  return surface;
}

function projectRootForModule(moduleUrl: string): string {
  const sourceOrDistRoot = path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    "../..",
  );
  return path.basename(sourceOrDistRoot) === "dist"
    ? path.dirname(sourceOrDistRoot)
    : sourceOrDistRoot;
}

export function resolveFixedHeartbeatStateRoot(
  defaultDataDir: string,
  environment: Record<string, string | undefined>,
): string {
  if (
    typeof defaultDataDir !== "string" ||
    !path.isAbsolute(defaultDataDir) ||
    defaultDataDir.includes("\0")
  ) {
    throw new Error("FIXED_HEARTBEAT_STATE_ROOT_INVALID");
  }
  const expected = path.join(path.resolve(defaultDataDir), "runtime-v2");
  const configured = environment.CHAT_ASSISTANT_DATA_DIR;
  if (configured === undefined) return expected;
  if (
    configured.length === 0 ||
    !path.isAbsolute(configured) ||
    configured.includes("\0") ||
    path.resolve(configured) !== expected
  ) {
    throw new Error("FIXED_HEARTBEAT_STATE_ROOT_INVALID");
  }
  return expected;
}

async function loadPackagedReleaseSha256(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "../../..", "payload-manifest.sha256"),
    path.resolve(moduleDirectory, "../..", "payload-manifest.sha256"),
  ];
  const observed: string[] = [];
  for (const candidate of candidates) {
    try {
      const value = (await readFile(candidate, "utf8")).trim();
      if (/^[a-f0-9]{64}$/u.test(value)) observed.push(value);
    } catch {
      // Only an immutable packaged release is a valid production entry.
    }
  }
  if (observed.length !== 1)
    throw new Error("FIXED_HEARTBEAT_RELEASE_IDENTITY_INVALID");
  return observed[0]!;
}

function defaultReportFailure(): void {
  process.exitCode = 1;
  process.stderr.write("FIXED_HEARTBEAT_SUPERVISOR_FAILED\n");
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("FIXED_HEARTBEAT_SUPERVISOR_UNKNOWN_FAILURE", { cause: error });
}
