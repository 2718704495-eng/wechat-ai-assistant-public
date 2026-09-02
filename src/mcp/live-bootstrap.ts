import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeBridge } from "../adapters/native-bridge.js";
import {
  NativeWechatSurface,
  liveWechatIdentities,
} from "../adapters/native-wechat-surface.js";
import { WeChatAdapter } from "../adapters/wechat.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import {
  MacOSKeychainKeyProvider,
  type KeyProvider,
} from "../security/keychain.js";
import {
  assertEncryptedStoreRoot,
  encryptedStoreRoot,
  EncryptedStore,
} from "../storage/encrypted-store.js";
import {
  AbortIntentRepository,
  AuditRepository,
  MessageRepository,
  PendingSendRepository,
  StateRepository,
} from "../storage/repositories.js";
import { ComfortStationDeliveryRepository } from "../storage/comfort-station-delivery-repository.js";
import {
  COMFORT_STATION_CARD_CANDIDATE_PATH,
  COMFORT_STATION_CARD_HEIGHT,
  COMFORT_STATION_CARD_SHA256,
  COMFORT_STATION_CARD_WIDTH,
} from "../relationship-care/comfort-station-card.js";
import {
  acquireLiveOperationCoordinator,
  assertLiveOperationCoordinator,
  type LiveOperationCoordinator,
  type LiveOwnerKind,
} from "./live-operation-coordinator.js";
import type { CurrentWechatMcpDependencies } from "./current-server.js";
import { createLiveWechatDependencies } from "./live-runtime.js";
import type { LiveWechatRuntimeDependencies } from "./live-server.js";
import { resolvePackagedReleaseBinding } from "../runtime-v2/release-binding.js";
import {
  hashReleaseBinding,
  type ReleaseBinding,
} from "../runtime-v2/supervised-acceptance.js";

export interface LiveProductionRuntime {
  dependencies: LiveWechatRuntimeDependencies;
  close(): Promise<void>;
}

export interface SharedLiveProductionRuntime {
  readonly store: EncryptedStore;
  readonly dataDir: string;
}

interface SharedRuntimeRecord {
  readonly coordinator: LiveOperationCoordinator;
  activeLeases: number;
  closing: boolean;
  closeContinuation: Promise<void> | null;
  readonly drained: Set<() => void>;
}

const sharedRuntimeRecords = new WeakMap<object, SharedRuntimeRecord>();
const sharedRuntimeByCoordinator = new WeakMap<
  LiveOperationCoordinator,
  Map<string, SharedLiveProductionRuntime>
>();

export function createSharedLiveProductionRuntime(input: {
  readonly coordinator: LiveOperationCoordinator;
  readonly store: EncryptedStore;
  readonly dataDir: string;
}): SharedLiveProductionRuntime {
  assertEncryptedStoreRoot(input.store, input.dataDir);
  const dataDir = encryptedStoreRoot(input.store);
  assertLiveOperationCoordinator(input.coordinator, dataDir);
  let byRoot = sharedRuntimeByCoordinator.get(input.coordinator);
  if (byRoot === undefined) {
    byRoot = new Map();
    sharedRuntimeByCoordinator.set(input.coordinator, byRoot);
  }
  const existing = byRoot.get(dataDir);
  if (existing !== undefined) return existing;
  const shared = Object.freeze({ store: input.store, dataDir });
  sharedRuntimeRecords.set(shared, {
    coordinator: input.coordinator,
    activeLeases: 0,
    closing: false,
    closeContinuation: null,
    drained: new Set(),
  });
  byRoot.set(dataDir, shared);
  return shared;
}

export function acquireSharedLiveProductionRuntimeLease(
  shared: SharedLiveProductionRuntime,
): LiveOperationCoordinator {
  const record = sharedRuntimeRecords.get(shared);
  if (record === undefined) throw new Error("SHARED_LIVE_RUNTIME_INVALID");
  if (record.closing) throw new Error("SHARED_LIVE_RUNTIME_CLOSING");
  record.activeLeases += 1;
  let closed = false;
  let operationTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    runExclusive: <T>(operation: () => Promise<T>) => {
      if (closed)
        return Promise.reject(new Error("SHARED_LIVE_RUNTIME_LEASE_CLOSED"));
      const result = record.coordinator.runExclusive(async () => {
        if (closed) throw new Error("SHARED_LIVE_RUNTIME_LEASE_CLOSED");
        const value = await operation();
        if (closed) throw new Error("SHARED_LIVE_RUNTIME_LEASE_CLOSED");
        return value;
      });
      operationTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    close: () => {
      if (closePromise !== null) return closePromise;
      closed = true;
      closePromise = operationTail.then(() => {
        record.activeLeases -= 1;
        if (record.activeLeases === 0) {
          for (const resolve of record.drained) resolve();
          record.drained.clear();
        }
      });
      return closePromise;
    },
  });
}

export function closeSharedLiveProductionRuntime(
  shared: SharedLiveProductionRuntime,
  drainTimeoutMs = 5_000,
): Promise<void> {
  const record = sharedRuntimeRecords.get(shared);
  if (record === undefined)
    return Promise.reject(new Error("SHARED_LIVE_RUNTIME_INVALID"));
  record.closing = true;
  record.closeContinuation ??= (async () => {
    if (record.activeLeases > 0) {
      await new Promise<void>((resolve) => {
        const onDrained = (): void => {
          resolve();
        };
        record.drained.add(onDrained);
      });
    }
    await record.coordinator.close();
  })();
  return boundedSharedClose(record.closeContinuation, drainTimeoutMs);
}

function boundedSharedClose(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return Promise.reject(
      new Error("SHARED_LIVE_RUNTIME_DRAIN_TIMEOUT_INVALID"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("SHARED_LIVE_RUNTIME_DRAIN_TIMEOUT")),
      timeoutMs,
    );
    operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new Error("SHARED_LIVE_RUNTIME_CLOSE_FAILED", { cause: error }),
        );
      },
    );
  });
}

export function createComfortStationDeliveryRepository(
  dataDir: string,
  keyProvider: KeyProvider = new MacOSKeychainKeyProvider(),
): ComfortStationDeliveryRepository {
  return new ComfortStationDeliveryRepository(
    new EncryptedStore(
      path.join(path.resolve(dataDir), "runtime-v2"),
      keyProvider,
    ),
  );
}

type CurrentRuntime = {
  dependencies: Pick<
    LiveWechatRuntimeDependencies,
    "getLiveState" | "readTargetConversationForAdvice"
  >;
  close(): Promise<void>;
};

type CurrentRuntimeFactory = (options: {
  ownerKind: LiveOwnerKind;
}) => Promise<CurrentRuntime>;

export function createOnDemandCurrentWechatDependencies(
  createRuntime: CurrentRuntimeFactory = createLiveProductionRuntime,
): CurrentWechatMcpDependencies {
  let tail: Promise<void> = Promise.resolve();

  const runScoped = <T>(
    operation: (runtime: CurrentRuntime) => Promise<T>,
  ): Promise<T> => {
    const result = tail.then(
      () => withCurrentRuntime(createRuntime, operation),
      () => withCurrentRuntime(createRuntime, operation),
    );
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    getConnectionState: () =>
      runScoped((runtime) => runtime.dependencies.getLiveState()),
    readTargetConversation: () =>
      runScoped((runtime) =>
        runtime.dependencies.readTargetConversationForAdvice(),
      ),
  };
}

export async function createLiveProductionRuntime(options: {
  ownerKind: LiveOwnerKind;
  testOnlyReleaseBinding?: ReleaseBinding;
  environment?: Record<string, string | undefined>;
  sharedRuntime?: SharedLiveProductionRuntime;
  authorityStore?: EncryptedStore;
}): Promise<LiveProductionRuntime> {
  const loadedConfig = loadRuntimeConfig(options.environment ?? process.env);
  const configuredDataDir = path.resolve(loadedConfig.dataDir);
  const runtimeRoot =
    options.sharedRuntime?.dataDir ??
    path.join(configuredDataDir, "runtime-v2");
  const config = { ...loadedConfig, dataDir: path.resolve(runtimeRoot) };
  const coordinator =
    options.sharedRuntime === undefined
      ? await acquireLiveOperationCoordinator({
          dataDir: runtimeRoot,
          ownerKind: options.ownerKind,
        })
      : acquireSharedLiveProductionRuntimeLease(options.sharedRuntime);
  try {
    const packaged =
      options.testOnlyReleaseBinding === undefined
        ? await resolvePackagedReleaseBinding(import.meta.url)
        : null;
    const releaseBinding = options.testOnlyReleaseBinding ?? packaged!.binding;
    const releaseRoot =
      packaged?.releaseRoot ?? projectRootForModule(import.meta.url);
    const activationBindingSha256 = hashReleaseBinding(releaseBinding);
    const projectRoot = projectRootForModule(import.meta.url);
    const executablePath = path.join(
      projectRoot,
      "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
    );
    const store =
      options.sharedRuntime?.store ??
      new EncryptedStore(configuredDataDir, new MacOSKeychainKeyProvider());
    const authorityStore = options.authorityStore ??
      (options.sharedRuntime === undefined
        ? store
        : new EncryptedStore(configuredDataDir, new MacOSKeychainKeyProvider()));
    assertEncryptedStoreRoot(authorityStore, configuredDataDir);
    const bridge = new NativeBridge({ executablePath, dataDir: runtimeRoot });
    const surface = new NativeWechatSurface(bridge);
    const state = new StateRepository(authorityStore);
    const adapter = new WeChatAdapter(surface, state, liveWechatIdentities);
    const dependencies = createLiveWechatDependencies({
      config,
      adapter,
      surface,
      store,
      authorityStore,
      messages: new MessageRepository(store),
      state,
      pending: new PendingSendRepository(store),
      aborts: new AbortIntentRepository(store),
      audit: new AuditRepository(store),
      comfortStationDeliveries:
        options.sharedRuntime === undefined
          ? createComfortStationDeliveryRepository(configuredDataDir)
          : new ComfortStationDeliveryRepository(store),
      comfortStationCard: {
        path: path.join(
          releaseRoot,
          ...COMFORT_STATION_CARD_CANDIDATE_PATH.split("/"),
        ),
        sha256: COMFORT_STATION_CARD_SHA256,
        width: COMFORT_STATION_CARD_WIDTH,
        height: COMFORT_STATION_CARD_HEIGHT,
      },
      coordinator,
      activationBindingSha256,
    });
    return {
      dependencies,
      close: () => coordinator.close().then(() => undefined),
    };
  } catch (error: unknown) {
    try {
      await coordinator.close();
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "LIVE_RUNTIME_CONSTRUCTION_CLEANUP_FAILED",
      );
    }
    throw error;
  }
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

async function withCurrentRuntime<T>(
  createRuntime: CurrentRuntimeFactory,
  operation: (runtime: CurrentRuntime) => Promise<T>,
): Promise<T> {
  const runtime = await createRuntime({ ownerKind: "mcp" });
  let result: T;
  try {
    result = await operation(runtime);
  } catch (error: unknown) {
    try {
      await runtime.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        "CURRENT_MCP_OPERATION_CLEANUP_FAILED",
      );
    }
    throw error;
  }
  await runtime.close();
  return result;
}
