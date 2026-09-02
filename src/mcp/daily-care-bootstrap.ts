import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeBridge } from "../adapters/native-bridge.js";
import { NativeWechatSurface } from "../adapters/native-wechat-surface.js";
import type { WeChatSurface } from "../adapters/wechat.js";
import { assertSendGate, loadRuntimeConfig, type SendGateState } from "../config/runtime-config.js";
import { researchTodayQixiaWeather } from "../daily-care/weather.js";
import { researchTodayQixiaSystemWeather } from "../daily-care/system-weather.js";
import { MacOSKeychainKeyProvider, type KeyProvider } from "../security/keychain.js";
import { DailyCareBroadcastRepository } from "../storage/daily-care-broadcast-repository.js";
import {
  assertEncryptedStoreRoot,
  canonicalFilesystemRoot,
  EncryptedStore,
} from "../storage/encrypted-store.js";
import { StateRepository } from "../storage/repositories.js";
import { SystemWeatherSnapshotRepository } from "../storage/system-weather-snapshot-repository.js";
import {
  createDailyCareProductionRuntime,
  createDailyCareRuntime,
} from "./daily-care-runtime.js";
import type {
  DailyCareProductionRuntimeDependencies,
  DailyCareRuntimeDependencies,
} from "./daily-care-session.js";
import { LiveResearchBroker } from "./live-research-broker.js";
import { readSendGate } from "./live-runtime.js";
import {
  acquireLiveOperationCoordinator,
} from "./live-operation-coordinator.js";
import { OfficialResearchExecutor, type OfficialFetch } from "./official-research-executor.js";
import { createDailyCareWeatherResearch } from "./daily-care-weather-bootstrap.js";
import { resolvePackagedReleaseBinding } from "../runtime-v2/release-binding.js";
import { hashReleaseBinding, type ReleaseBinding } from
  "../runtime-v2/supervised-acceptance.js";
import {
  acquireSharedLiveProductionRuntimeLease,
  type SharedLiveProductionRuntime,
} from "./live-bootstrap.js";

export interface DailyCareTestRuntime {
  dependencies: DailyCareRuntimeDependencies;
  close(): Promise<void>;
}

export interface DailyCareProductionRuntime {
  dependencies: DailyCareProductionRuntimeDependencies;
  close(): Promise<void>;
}

export interface DailyCareProductionBootstrapOverrides {
  readSendGate?: (store: EncryptedStore) => Promise<SendGateState>;
  createSurface?: (context: {
    executablePath: string;
    dataDir: string;
  }) => WeChatSurface;
  officialFetch?: OfficialFetch;
  readSystemWeatherSnapshot?: () => Promise<unknown>;
  now?: () => Date;
  testOnlyReleaseBinding?: ReleaseBinding;
  sharedRuntime?: SharedLiveProductionRuntime;
  authorityStore?: EncryptedStore;
}

export async function inspectDailyCareProductionSlot(
  slot: import("../daily-care/types.js").DailyCareSlot,
  environment: Record<string, string | undefined> = process.env,
  keyProvider: KeyProvider = new MacOSKeychainKeyProvider(),
): Promise<{ status: "pending" | "submitted-uncertain" | "verified" | "skipped" } | null> {
  if (slot.targetMode !== "production") throw new Error("DAILY_CARE_PRODUCTION_SLOT_INVALID");
  const loaded = loadRuntimeConfig(environment);
  const dataDir = resolveDailyCareRuntimeRoot(
    loaded.dataDir,
    environment.CHAT_ASSISTANT_DATA_DIR,
    environment.HOME,
  );
  const store = new EncryptedStore(dataDir, keyProvider);
  const record = await new DailyCareBroadcastRepository(store).getSlot(slot.slotKey);
  return record === null ? null : { status: record.status };
}

export async function createDailyCareTestRuntime(
  environment: Record<string, string | undefined> = process.env,
): Promise<DailyCareTestRuntime> {
  const loaded = loadRuntimeConfig(environment);
  const dataDir = resolveDailyCareDataDir(
    loaded.dataDir,
    environment.CHAT_ASSISTANT_DATA_DIR,
    environment.HOME,
  );
  const coordinator = await acquireLiveOperationCoordinator({ dataDir, ownerKind: "mcp" });
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const executablePath = path.join(
      projectRoot,
      "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
    );
    const store = new EncryptedStore(dataDir, new MacOSKeychainKeyProvider());
    const state = new StateRepository(store);
    const broker = new LiveResearchBroker();
    const officialFetch: OfficialFetch = (url, init) => fetch(url, init);
    const executor = new OfficialResearchExecutor({ broker, fetch: officialFetch });
    const surface = new NativeWechatSurface(new NativeBridge({ executablePath, dataDir }));
    const dependencies = createDailyCareRuntime({
      repository: new DailyCareBroadcastRepository(store),
      surface,
      researchWeather: (slot) => researchTodayQixiaWeather({ broker, executor, slot }),
      isStopped: async () => (await state.getControlState()).stopped,
      release: () => coordinator.close(),
    });
    return { dependencies, close: () => dependencies.close() };
  } catch (error: unknown) {
    try {
      await coordinator.close();
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], "DAILY_CARE_RUNTIME_STARTUP_FAILED");
    }
    throw error;
  }
}

export async function createDailyCareProductionService(
  environment: Record<string, string | undefined> = process.env,
  overrides: DailyCareProductionBootstrapOverrides = {},
): Promise<DailyCareProductionRuntime> {
  const loaded = loadRuntimeConfig(environment);
  if (loaded.mode !== "live") throw new Error("DAILY_CARE_LIVE_MODE_REQUIRED");
  const configuredDataDir = resolveDailyCareRuntimeRoot(
    loaded.dataDir,
    environment.CHAT_ASSISTANT_DATA_DIR,
    environment.HOME,
  );
  const configuredIdentity = canonicalFilesystemRoot(configuredDataDir);
  const dataDir = path.resolve(
    overrides.sharedRuntime?.dataDir ?? configuredIdentity.canonicalPath,
  );
  if (overrides.sharedRuntime !== undefined) {
    const sharedIdentity = canonicalFilesystemRoot(dataDir);
    if (
      sharedIdentity.device !== configuredIdentity.device ||
      sharedIdentity.inode !== configuredIdentity.inode
    ) {
      throw new Error("DAILY_CARE_SHARED_RUNTIME_ROOT_MISMATCH");
    }
  }
  const coordinator = overrides.sharedRuntime === undefined
    ? await acquireLiveOperationCoordinator({ dataDir, ownerKind: "mcp" })
    : acquireSharedLiveProductionRuntimeLease(overrides.sharedRuntime);
  let weatherResearch: ReturnType<typeof createDailyCareWeatherResearch> | null = null;
  try {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const executablePath = path.join(
      projectRoot,
      "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
    );
    const store = overrides.sharedRuntime?.store ??
      new EncryptedStore(dataDir, new MacOSKeychainKeyProvider());
    const authorityStore = overrides.authorityStore ??
      new EncryptedStore(loaded.dataDir, new MacOSKeychainKeyProvider());
    assertEncryptedStoreRoot(authorityStore, loaded.dataDir);
    const activationBindingSha256 = overrides.readSendGate === undefined
      ? hashReleaseBinding(overrides.testOnlyReleaseBinding ??
        (await resolvePackagedReleaseBinding(import.meta.url)).binding)
      : undefined;
    const gateReader = overrides.readSendGate ?? ((input: EncryptedStore) =>
      readSendGate(input, activationBindingSha256));
    assertSendGate(loaded, await gateReader(authorityStore));
    const state = new StateRepository(authorityStore);
    const bootstrapNow = overrides.now;
    const snapshotRepository = new SystemWeatherSnapshotRepository(store);
    const initializedWeatherResearch = overrides.readSystemWeatherSnapshot === undefined &&
        overrides.officialFetch !== undefined
      ? createDailyCareWeatherResearch({
          officialFetch: overrides.officialFetch,
          ...(bootstrapNow === undefined ? {} : { now: bootstrapNow }),
          environment,
        })
      : createSystemWeatherResearch({
          readSnapshot: overrides.readSystemWeatherSnapshot ?? (() => snapshotRepository.read()),
          ...(bootstrapNow === undefined ? {} : { now: bootstrapNow }),
        });
    weatherResearch = initializedWeatherResearch;
    const surface = overrides.createSurface?.({ executablePath, dataDir }) ??
      new NativeWechatSurface(new NativeBridge({ executablePath, dataDir }));
    const dependencies = createDailyCareProductionRuntime({
      repository: new DailyCareBroadcastRepository(store),
      surface,
      researchWeather: (slot) => initializedWeatherResearch.research(slot),
      isStopped: async () => {
        assertSendGate(loaded, await gateReader(authorityStore));
        return (await state.getControlState()).stopped;
      },
      readSameDayCareContext: async ({ conversationId, localDate }) => {
        const snapshot = await surface.locateConversation(conversationId);
        if (snapshot.conversationId !== "example-contact" ||
            snapshot.identity.conversationId !== "example-contact" ||
            snapshot.identity.visibleName !== "示例联系人" ||
            snapshot.identity.confidence < 0.95) {
          throw new Error("DAILY_CARE_CONTEXT_TARGET_INVALID");
        }
        // Native OCR timestamps are capture times, not message occurrence times. Until
        // the visible sequence carries an independently proved date/continuity marker,
        // the only safe production result is an unavailable context.
        const proofHash = createHash("sha256").update(JSON.stringify({
          version: 1,
          localDate,
          availability: "unavailable",
          windowRevision: snapshot.windowRevision,
          visibleSequence: snapshot.messages.map(({ id, direction }) => ({ id, direction })),
        })).digest("hex");
        return {
          localDate,
          availability: "unavailable" as const,
          explicitSignals: [],
          safeExcerpts: [],
          proofHash,
        };
      },
      // Session close quiesces/clears the UI state. The fixed-heartbeat owner
      // releases the kernel gate only after its durable scheduler completion.
      release: () => Promise.resolve(),
      ...(bootstrapNow === undefined ? {} : { now: bootstrapNow }),
    });
    let closePromise: Promise<void> | null = null;
    return {
      dependencies,
      close: () => {
        closePromise ??= (async () => {
          const failures: unknown[] = [];
          try {
            await dependencies.close();
          } catch (error: unknown) {
            failures.push(error);
          }
          try {
            await initializedWeatherResearch.close();
          } catch (error: unknown) {
            failures.push(error);
          }
          try {
            await coordinator.close();
          } catch (error: unknown) {
            failures.push(error);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "DAILY_CARE_RUNTIME_CLOSE_FAILED");
        })();
        return closePromise;
      },
    };
  } catch (error: unknown) {
    const failures: unknown[] = [error];
    try {
      await weatherResearch?.close();
    } catch (cleanupError: unknown) {
      failures.push(cleanupError);
    }
    try {
      await coordinator.close();
    } catch (cleanupError: unknown) {
      failures.push(cleanupError);
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, "DAILY_CARE_RUNTIME_STARTUP_FAILED");
  }
}

function createSystemWeatherResearch(input: {
  readSnapshot: () => Promise<unknown>;
  now?: () => Date;
}): ReturnType<typeof createDailyCareWeatherResearch> {
  let closed = false;
  return Object.freeze({
    research: (slot: import("../daily-care/types.js").DailyCareSlot) => {
      if (closed) return Promise.reject(new Error("DAILY_CARE_WEATHER_BOOTSTRAP_CLOSED"));
      return researchTodayQixiaSystemWeather({
        slot,
        readSnapshot: input.readSnapshot,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    },
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  });
}

function resolveDailyCareDataDir(
  defaultDataDir: string,
  override: string | undefined,
  home: string | undefined,
): string {
  if (override === undefined) return path.resolve(defaultDataDir);
  if (override.length === 0 || !path.isAbsolute(override)) {
    throw new Error("DAILY_CARE_DATA_DIR_INVALID");
  }
  const resolved = path.resolve(override);
  if (resolved === path.parse(resolved).root || (home !== undefined && resolved === path.resolve(home))) {
    throw new Error("DAILY_CARE_DATA_DIR_INVALID");
  }
  return resolved;
}

function resolveDailyCareRuntimeRoot(
  defaultDataDir: string,
  override: string | undefined,
  home: string | undefined,
): string {
  const resolved = resolveDailyCareDataDir(defaultDataDir, override, home);
  return override === undefined ? path.join(resolved, "runtime-v2") : resolved;
}
