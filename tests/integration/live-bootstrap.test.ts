import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeConstruction = vi.hoisted(() => ({ count: 0, fail: false }));

vi.mock("../../src/adapters/native-bridge.js", () => ({
  NativeBridge: class {
    public constructor() {
      nativeConstruction.count += 1;
      if (nativeConstruction.fail)
        throw new Error("NATIVE_CONSTRUCTION_FAILED");
    }
  },
}));

import {
  acquireSharedLiveProductionRuntimeLease,
  closeSharedLiveProductionRuntime,
  createLiveProductionRuntime,
  createOnDemandCurrentWechatDependencies,
  createSharedLiveProductionRuntime,
} from "../../src/mcp/live-bootstrap.js";
import {
  acquireLiveOperationCoordinator,
  type LiveOperationCoordinator,
} from "../../src/mcp/live-operation-coordinator.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

describe("live production bootstrap", () => {
  const testReleaseBinding = {
    payloadManifestSha256: "a".repeat(64),
    nativeSha256: "b".repeat(64),
    effectiveConfigSha256: "c".repeat(64),
  };
  let homeDirectory: string;
  let dataDirectory: string;
  let runtimeDirectory: string;
  let closables: Array<{ close(): Promise<void> }>;
  const originalHome = process.env.HOME;
  const originalMode = process.env.CHAT_ASSISTANT_MODE;

  beforeEach(async () => {
    homeDirectory = await mkdtemp(path.join(os.tmpdir(), "live-bootstrap-"));
    dataDirectory = path.join(homeDirectory, "Desktop", "聊天助手");
    runtimeDirectory = path.join(dataDirectory, "runtime-v2");
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await initializeTestKernelLockCatalog(dataDirectory);
    await initializeTestKernelLockCatalog(runtimeDirectory);
    closables = [];
    nativeConstruction.count = 0;
    nativeConstruction.fail = false;
    process.env.HOME = homeDirectory;
    process.env.CHAT_ASSISTANT_MODE = "dry-run";
  });

  afterEach(async () => {
    await Promise.allSettled(
      closables.map(async (closable) => closable.close()),
    );
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalMode === undefined) delete process.env.CHAT_ASSISTANT_MODE;
    else process.env.CHAT_ASSISTANT_MODE = originalMode;
    await rm(homeDirectory, { recursive: true, force: true });
  });

  it("rejects a second owner before native/runtime construction", async () => {
    const owner = await acquireLiveOperationCoordinator({
      dataDir: runtimeDirectory,
      ownerKind: "mcp",
    });
    closables.push(owner);

    await expect(
      createLiveProductionRuntime({ ownerKind: "cli" }),
    ).rejects.toThrow("LIVE_RUNTIME_BUSY");
    expect(nativeConstruction.count).toBe(0);
  });

  it("binds the production owner to runtime-v2 instead of the parent data root", async () => {
    const unrelatedParentOwner = await acquireLiveOperationCoordinator({
      dataDir: dataDirectory,
      ownerKind: "mcp",
    });
    closables.push(unrelatedParentOwner);

    const runtime = await createLiveProductionRuntime({
      ownerKind: "cli",
      testOnlyReleaseBinding: testReleaseBinding,
    });
    closables.push(runtime);
    expect(nativeConstruction.count).toBe(1);
  });

  it("binds the comfort-station delivery ledger to the runtime-v2 kernel catalog", async () => {
    await rm(path.join(dataDirectory, "state/.kernel-lock-v1"), {
      recursive: true,
      force: true,
    });
    const module = (await import("../../src/mcp/live-bootstrap.js")) as Record<
      string,
      unknown
    >;
    const createRepository = module["createComfortStationDeliveryRepository"];
    expect(typeof createRepository).toBe("function");
    const repository = (
      createRepository as (
        dataDir: string,
        keyProvider: KeyProvider,
      ) => {
        claim(input: {
          deliveryKey: string;
          triggerMessageIdHash: string;
          cardSha256: string;
          createdAt: string;
        }): Promise<{ claimed: boolean }>;
      }
    )(dataDirectory, {
      getOrCreate: () => Promise.resolve(Buffer.alloc(32, 37)),
    });
    await expect(
      repository.claim({
        deliveryKey: "d".repeat(64),
        triggerMessageIdHash: "e".repeat(64),
        cardSha256: "f".repeat(64),
        createdAt: "2026-08-30T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ claimed: true });
  });

  it("shares the generic lease across owner kinds for the full bootstrap lifetime", async () => {
    const mcp = await createLiveProductionRuntime({
      ownerKind: "mcp",
      testOnlyReleaseBinding: testReleaseBinding,
    });
    closables.push(mcp);
    expect(nativeConstruction.count).toBe(1);

    await expect(
      createLiveProductionRuntime({ ownerKind: "cli" }),
    ).rejects.toThrow("LIVE_RUNTIME_BUSY");
    expect(nativeConstruction.count).toBe(1);

    await mcp.close();
    const cli = await createLiveProductionRuntime({
      ownerKind: "cli",
      testOnlyReleaseBinding: testReleaseBinding,
    });
    closables.push(cli);
    expect(nativeConstruction.count).toBe(2);
  });

  it("reuses a production coordinator and store without acquiring a second live owner", async () => {
    const coordinator = await acquireLiveOperationCoordinator({
      dataDir: runtimeDirectory,
      ownerKind: "mcp",
    });
    closables.push(coordinator);
    const store = new EncryptedStore(runtimeDirectory, {
      getOrCreate: () => Promise.resolve(Buffer.alloc(32, 41)),
    });
    const runtime = await createLiveProductionRuntime({
      ownerKind: "mcp",
      testOnlyReleaseBinding: testReleaseBinding,
      sharedRuntime: createSharedLiveProductionRuntime({
        coordinator,
        store,
        dataDir: runtimeDirectory,
      }),
    });
    closables.push(runtime);

    expect(nativeConstruction.count).toBe(1);
    await expect(
      acquireLiveOperationCoordinator({
        dataDir: runtimeDirectory,
        ownerKind: "cli",
      }),
    ).rejects.toThrow("LIVE_RUNTIME_BUSY");

    await runtime.close();
    await expect(
      acquireLiveOperationCoordinator({
        dataDir: runtimeDirectory,
        ownerKind: "cli",
      }),
    ).rejects.toThrow("LIVE_RUNTIME_BUSY");
  });

  it("brands shared roots and drains idempotent child leases before the sole owner closes", async () => {
    const coordinator = await acquireLiveOperationCoordinator({
      dataDir: runtimeDirectory,
      ownerKind: "mcp",
    });
    const store = new EncryptedStore(runtimeDirectory, {
      getOrCreate: () => Promise.resolve(Buffer.alloc(32, 43)),
    });
    const shared = createSharedLiveProductionRuntime({
      coordinator,
      store,
      dataDir: runtimeDirectory,
    });
    const child = acquireSharedLiveProductionRuntimeLease(shared);
    let parentClosed = false;
    const parentClose = closeSharedLiveProductionRuntime(shared).then(() => {
      parentClosed = true;
    });
    await Promise.resolve();
    expect(parentClosed).toBe(false);
    expect(() => acquireSharedLiveProductionRuntimeLease(shared)).toThrow(
      "SHARED_LIVE_RUNTIME_CLOSING",
    );
    await child.close();
    await child.close();
    await parentClose;
    expect(parentClosed).toBe(true);
    const next = await acquireLiveOperationCoordinator({
      dataDir: runtimeDirectory,
      ownerKind: "cli",
    });
    await next.close();
    expect(() =>
      acquireSharedLiveProductionRuntimeLease({
        store,
        dataDir: runtimeDirectory,
      }),
    ).toThrow("SHARED_LIVE_RUNTIME_INVALID");
  });

  it("rejects fake coordinators, deduplicates canonical roots, and fences a closed child lease", async () => {
    const coordinator = await acquireLiveOperationCoordinator({
      dataDir: runtimeDirectory,
      ownerKind: "mcp",
    });
    const store = new EncryptedStore(runtimeDirectory, {
      getOrCreate: () => Promise.resolve(Buffer.alloc(32, 47)),
    });
    const first = createSharedLiveProductionRuntime({
      coordinator,
      store,
      dataDir: path.join(runtimeDirectory, "."),
    });
    const second = createSharedLiveProductionRuntime({
      coordinator,
      store,
      dataDir: runtimeDirectory,
    });
    expect(second).toBe(first);
    expect(() =>
      createSharedLiveProductionRuntime({
        coordinator: {
          runExclusive: <T>(operation: () => Promise<T>) => operation(),
          close: () => Promise.resolve(),
        },
        store,
        dataDir: runtimeDirectory,
      }),
    ).toThrow("LIVE_OPERATION_OWNER_INVALID");
    expect(() =>
      createSharedLiveProductionRuntime({
        coordinator,
        store: { rootDir: runtimeDirectory } as unknown as EncryptedStore,
        dataDir: runtimeDirectory,
      }),
    ).toThrow("ENCRYPTED_STORE_PROVENANCE_INVALID");
    expect(() =>
      createSharedLiveProductionRuntime({
        coordinator,
        store: new EncryptedStore(path.join(runtimeDirectory, "mismatch"), {
          getOrCreate: () => Promise.resolve(Buffer.alloc(32, 47)),
        }),
        dataDir: runtimeDirectory,
      }),
    ).toThrow("ENCRYPTED_STORE_ROOT_MISMATCH");

    const child = acquireSharedLiveProductionRuntimeLease(first);
    await child.close();
    await expect(
      child.runExclusive(() => Promise.resolve("escaped")),
    ).rejects.toThrow("SHARED_LIVE_RUNTIME_LEASE_CLOSED");
    await child.close();
    await closeSharedLiveProductionRuntime(first);
  });

  it("continues one parent drain after a bounded timeout and lets a retry observe completion", async () => {
    const coordinator = await acquireLiveOperationCoordinator({
      dataDir: runtimeDirectory,
      ownerKind: "mcp",
    });
    const store = new EncryptedStore(runtimeDirectory, {
      getOrCreate: () => Promise.resolve(Buffer.alloc(32, 49)),
    });
    const shared = createSharedLiveProductionRuntime({
      coordinator,
      store,
      dataDir: runtimeDirectory,
    });
    const child = acquireSharedLiveProductionRuntimeLease(shared);

    await expect(closeSharedLiveProductionRuntime(shared, 5)).rejects.toThrow(
      "SHARED_LIVE_RUNTIME_DRAIN_TIMEOUT",
    );
    await expect(
      acquireLiveOperationCoordinator({
        dataDir: runtimeDirectory,
        ownerKind: "cli",
      }),
    ).rejects.toThrow("LIVE_RUNTIME_BUSY");

    await child.close();
    await expect(
      closeSharedLiveProductionRuntime(shared, 500),
    ).resolves.toBeUndefined();
    const successor = await acquireLiveOperationCoordinator({
      dataDir: runtimeDirectory,
      ownerKind: "cli",
    });
    await successor.close();
  });

  it("releases the exact lease when construction fails", async () => {
    nativeConstruction.fail = true;
    await expect(
      createLiveProductionRuntime({
        ownerKind: "mcp",
        testOnlyReleaseBinding: testReleaseBinding,
      }),
    ).rejects.toThrow("NATIVE_CONSTRUCTION_FAILED");

    nativeConstruction.fail = false;
    const next = await createLiveProductionRuntime({
      ownerKind: "cli",
      testOnlyReleaseBinding: testReleaseBinding,
    });
    closables.push(next);
    expect(nativeConstruction.count).toBe(2);
  });

  it("keeps the readonly current MCP idle without a lease and scopes each call", async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const events: string[] = [];
    let runtimeCount = 0;
    const dependencies = createOnDemandCurrentWechatDependencies(() => {
      runtimeCount += 1;
      const runtimeId = runtimeCount;
      events.push(`open-${runtimeId}`);
      return Promise.resolve({
        dependencies: {
          getLiveState: async () => {
            events.push(`state-${runtimeId}`);
            firstEntered.resolve(undefined);
            await releaseFirst.promise;
            return { connected: true };
          },
          readTargetConversationForAdvice: () => {
            events.push(`read-${runtimeId}`);
            return Promise.resolve({ conversationId: "example-contact" });
          },
        },
        close: () => {
          events.push(`close-${runtimeId}`);
          return Promise.resolve();
        },
      });
    });

    expect(runtimeCount).toBe(0);
    const state = dependencies.getConnectionState();
    await firstEntered.promise;
    const read = dependencies.readTargetConversation();
    await flushAsyncTurns();
    expect(events).toEqual(["open-1", "state-1"]);

    releaseFirst.resolve(undefined);
    await expect(state).resolves.toEqual({ connected: true });
    await expect(read).resolves.toEqual({ conversationId: "example-contact" });
    expect(events).toEqual([
      "open-1",
      "state-1",
      "close-1",
      "open-2",
      "read-2",
      "close-2",
    ]);
  });

  it("closes the coordinated runtime when an assigned transport closes", async () => {
    const harness = await startMainHarness(true, dataDirectory, closables);
    try {
      harness.protocol.onclose?.();
      await expect(settlesWithin(harness.runtimeClosed.promise)).resolves.toBe(
        "SETTLED",
      );

      expect(harness.state.serverCloseCalls).toBe(0);
      expect(harness.state.runtimeCloseCalls).toBe(1);
      await expect(
        harness.coordinator.runExclusive(() => Promise.resolve()),
      ).rejects.toThrow("LIVE_RUNTIME_CLOSED");
      expect((await stat(harness.lockPath)).isDirectory()).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it.each([
    { event: "end", emitter: () => process.stdin, arguments: [] },
    { event: "SIGINT", emitter: () => process, arguments: ["SIGINT"] },
    { event: "SIGTERM", emitter: () => process, arguments: ["SIGTERM"] },
  ] as const)(
    "keeps the $event handler active while assigned-server shutdown drains",
    async ({ event, emitter: getEmitter, arguments: eventArguments }) => {
      const harness = await startMainHarness(true, dataDirectory, closables);
      const entered = deferred<void>();
      const release = deferred<void>();
      const inFlight = harness.coordinator.runExclusive(async () => {
        entered.resolve(undefined);
        await release.promise;
      });
      await entered.promise;

      try {
        const emitter = getEmitter();
        const firstListener = findNewRawListener(
          emitter,
          event,
          harness.listenerSnapshots[event],
        );
        if (firstListener !== undefined)
          invokeListener(firstListener, emitter, eventArguments);
        await flushAsyncTurns();

        expect(harness.state.serverCloseCalls).toBe(1);
        await expect(
          harness.coordinator.runExclusive(() => Promise.resolve()),
        ).rejects.toThrow("LIVE_RUNTIME_CLOSED");
        expect((await stat(harness.lockPath)).isDirectory()).toBe(true);

        const repeatedListener = findNewRawListener(
          emitter,
          event,
          harness.listenerSnapshots[event],
        );
        const stayedHandled = repeatedListener !== undefined;
        if (repeatedListener !== undefined) {
          invokeListener(repeatedListener, emitter, eventArguments);
        }
        release.resolve(undefined);
        await inFlight;
        await expect(
          settlesWithin(harness.runtimeClosed.promise),
        ).resolves.toBe("SETTLED");

        expect(firstListener).toBeDefined();
        expect(stayedHandled).toBe(true);
        expect(harness.state.serverCloseCalls).toBe(1);
        expect(harness.state.runtimeCloseCalls).toBe(1);
        expect((await stat(harness.lockPath)).isDirectory()).toBe(true);
      } finally {
        release.resolve(undefined);
        await inFlight.catch(() => undefined);
        await harness.cleanup();
      }
    },
  );

  it.each([
    { event: "end", emitter: () => process.stdin, arguments: [] },
    { event: "SIGINT", emitter: () => process, arguments: ["SIGINT"] },
    { event: "SIGTERM", emitter: () => process, arguments: ["SIGTERM"] },
  ] as const)(
    "handles $event before connect resolves and closes the late server",
    async ({ event, emitter: getEmitter, arguments: eventArguments }) => {
      const harness = await startMainHarness(false, dataDirectory, closables);
      try {
        const emitter = getEmitter();
        const listener = findNewRawListener(
          emitter,
          event,
          harness.listenerSnapshots[event],
        );
        const installedBeforeConnect = listener !== undefined;
        if (listener !== undefined) {
          invokeListener(listener, emitter, eventArguments);
          await expect(
            settlesWithin(harness.runtimeClosed.promise),
          ).resolves.toBe("SETTLED");
          await expect(
            harness.coordinator.runExclusive(() => Promise.resolve()),
          ).rejects.toThrow("LIVE_RUNTIME_CLOSED");
          expect((await stat(harness.lockPath)).isDirectory()).toBe(true);
        }

        harness.resolveConnect();
        await harness.importPromise;

        expect(installedBeforeConnect).toBe(true);
        expect(harness.state.serverCloseCalls).toBe(1);
        expect(harness.state.runtimeCloseCalls).toBe(1);
        expect((await stat(harness.lockPath)).isDirectory()).toBe(true);
      } finally {
        await harness.cleanup();
      }
    },
  );
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface MainHarness {
  coordinator: LiveOperationCoordinator;
  importPromise: Promise<unknown>;
  listenerSnapshots: Record<ShutdownEvent, ReadonlySet<EventListener>>;
  lockPath: string;
  protocol: { onclose?: () => void };
  runtimeClosed: Deferred<void>;
  state: { runtimeCloseCalls: number; serverCloseCalls: number };
  resolveConnect(): void;
  cleanup(): Promise<void>;
}

async function startMainHarness(
  connectImmediately: boolean,
  dataDirectory: string,
  closables: Array<{ close(): Promise<void> }>,
): Promise<MainHarness> {
  const coordinator = await acquireLiveOperationCoordinator({
    dataDir: dataDirectory,
    ownerKind: "mcp",
  });
  closables.push(coordinator);
  const lockPath = path.join(dataDirectory, "state/.kernel-lock-v1");
  const runtimeClosed = deferred<void>();
  const connectEntered = deferred<void>();
  const connectGate = deferred<FakeServer>();
  const state = { runtimeCloseCalls: 0, serverCloseCalls: 0 };
  const protocol: { onclose?: () => void } = {};
  let runtimeClosePromise: Promise<void> | null = null;
  const closeRuntime = (): Promise<void> => {
    state.runtimeCloseCalls += 1;
    if (runtimeClosePromise === null) {
      runtimeClosePromise = coordinator
        .close()
        .then(() => runtimeClosed.resolve(undefined));
    }
    return runtimeClosePromise;
  };
  const server: FakeServer = {
    server: protocol,
    close: () => {
      state.serverCloseCalls += 1;
      protocol.onclose?.();
      return Promise.resolve();
    },
  };
  const listenerSnapshots: Record<ShutdownEvent, ReadonlySet<EventListener>> = {
    end: new Set(rawEventListeners(process.stdin, "end")),
    SIGINT: new Set(rawEventListeners(process, "SIGINT")),
    SIGTERM: new Set(rawEventListeners(process, "SIGTERM")),
  };

  vi.resetModules();
  vi.doMock("../../src/mcp/live-bootstrap.js", () => ({
    createLiveProductionRuntime: () =>
      Promise.resolve({
        dependencies: { marker: "coordinated-dependencies" },
        close: closeRuntime,
      }),
  }));
  vi.doMock("../../src/mcp/live-server.js", () => ({
    connectLiveWechatMcpStdio: () => {
      connectEntered.resolve(undefined);
      return connectGate.promise;
    },
  }));
  const importPromise = import("../../src/mcp/live-server-main.js");
  await connectEntered.promise;

  let connectResolved = false;
  const resolveConnect = (): void => {
    if (connectResolved) return;
    connectResolved = true;
    connectGate.resolve(server);
  };
  if (connectImmediately) {
    resolveConnect();
    await importPromise;
  }

  return {
    coordinator,
    importPromise,
    listenerSnapshots,
    lockPath,
    protocol,
    runtimeClosed,
    state,
    resolveConnect,
    cleanup: async () => {
      resolveConnect();
      await importPromise.catch(() => undefined);
      removeNewListeners(process.stdin, "end", listenerSnapshots.end);
      removeNewListeners(process, "SIGINT", listenerSnapshots.SIGINT);
      removeNewListeners(process, "SIGTERM", listenerSnapshots.SIGTERM);
      vi.doUnmock("../../src/mcp/live-bootstrap.js");
      vi.doUnmock("../../src/mcp/live-server.js");
      vi.resetModules();
    },
  };
}

interface FakeServer {
  server: { onclose?: () => void };
  close(): Promise<void>;
}

function removeNewListeners(
  emitter: NodeJS.EventEmitter,
  event: string,
  priorListeners: ReadonlySet<EventListener>,
): void {
  for (const listener of rawEventListeners(emitter, event)) {
    if (!priorListeners.has(listener)) emitter.removeListener(event, listener);
  }
}

type EventListener = (...arguments_: unknown[]) => unknown;
type ShutdownEvent = "end" | "SIGINT" | "SIGTERM";

function rawEventListeners(
  emitter: NodeJS.EventEmitter,
  event: string,
): EventListener[] {
  return emitter.rawListeners(event) as EventListener[];
}

function findNewRawListener(
  emitter: NodeJS.EventEmitter,
  event: string,
  priorListeners: ReadonlySet<EventListener>,
): EventListener | undefined {
  return rawEventListeners(emitter, event).find(
    (listener) => !priorListeners.has(listener),
  );
}

function invokeListener(
  listener: EventListener,
  emitter: NodeJS.EventEmitter,
  arguments_: readonly unknown[],
): void {
  listener.apply(emitter, [...arguments_]);
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined)
        throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise(value);
    },
  };
}

async function settlesWithin(promise: Promise<unknown>): Promise<string> {
  let deadlineHandle: NodeJS.Timeout | undefined;
  const deadline = new Promise<string>((resolve) => {
    deadlineHandle = setTimeout(() => resolve("DEADLINE_EXCEEDED"), 250);
  });
  const outcome = await Promise.race([promise.then(() => "SETTLED"), deadline]);
  if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
  return outcome;
}

async function flushAsyncTurns(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}
