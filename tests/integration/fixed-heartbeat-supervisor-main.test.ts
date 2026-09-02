import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  resolveFixedHeartbeatStateRoot,
  createDefaultProductionRealtimeMain,
  startFixedHeartbeatSupervisorMain,
  type StartFixedHeartbeatSupervisorMainOptions,
} from
  "../../src/mcp/fixed-heartbeat-supervisor-main.js";
import type { FixedHeartbeatRuntimeFactories } from
  "../../src/mcp/fixed-heartbeat-supervisor.js";
import { SingleDispatcherAdmission } from
  "../../src/runtime-v2/single-dispatcher-admission.js";
import { SingleScheduler } from "../../src/runtime-v2/single-scheduler.js";
import type { FixedHeartbeatSupervisorOptions } from
  "../../src/mcp/fixed-heartbeat-supervisor.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";
import { acquireLiveOperationCoordinator } from
  "../../src/mcp/live-operation-coordinator.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { hashReleaseBinding } from "../../src/runtime-v2/supervised-acceptance.js";

describe("fixed heartbeat supervisor main lifecycle", () => {
  it("starts realtime exactly once before connect and stops it exactly once", async () => {
    const order: string[] = [];
    const realtime = realtimeMainFixture(order);
    const handle = await startFixedHeartbeatSupervisorMain({
      realtimeMain: realtime,
      input: new EventEmitter(),
      signals: new EventEmitter(),
      connect: vi.fn().mockImplementation(() => {
        order.push("connect");
        return Promise.resolve({
          server: { server: {}, close: vi.fn().mockResolvedValue(undefined) },
          shutdown: vi.fn().mockResolvedValue(undefined),
        });
      }),
    });
    expect(order.slice(0, 2)).toEqual(["realtime-start", "connect"]);
    await Promise.all([handle.close(), handle.close()]);
    expect(realtime.start).toHaveBeenCalledTimes(1);
    expect(realtime.stop).toHaveBeenCalledTimes(1);
  });

  it("rolls realtime back when connect fails without leaving a supervisor timer", async () => {
    const order: string[] = [];
    const realtime = realtimeMainFixture(order);
    await expect(startFixedHeartbeatSupervisorMain({
      realtimeMain: realtime,
      input: new EventEmitter(),
      signals: new EventEmitter(),
      connect: vi.fn().mockImplementation(() => {
        order.push("connect-failed");
        return Promise.reject(new Error("CONNECT_FAILED"));
      }),
    })).rejects.toThrow("CONNECT_FAILED");
    expect(order).toEqual(["realtime-start", "connect-failed", "realtime-stop"]);
    expect(realtime.stop).toHaveBeenCalledTimes(1);
  });

  it("rolls back once and never connects when realtime start fails", async () => {
    const order: string[] = [];
    const realtime = realtimeMainFixture(order);
    vi.mocked(realtime.start).mockRejectedValueOnce(
      new Error("REALTIME_START_FAILED"),
    );
    const connect = vi.fn();
    await expect(startFixedHeartbeatSupervisorMain({
      realtimeMain: realtime,
      input: new EventEmitter(),
      signals: new EventEmitter(),
      connect,
    })).rejects.toThrow("REALTIME_START_FAILED");
    expect(connect).not.toHaveBeenCalled();
    expect(realtime.stop).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["realtime-stop"]);
  });
  it("constructs the concrete default realtime graph consumed by the no-args executable", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "default-realtime-main-"));
    const dataDir = path.join(home, "Desktop", "聊天助手");
    const runtimeRoot = path.join(dataDir, "runtime-v2");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    const executable = await readFile(
      path.resolve("src/mcp/live-supervisor-mcp-main.ts"),
      "utf8",
    );
    let main: Awaited<ReturnType<typeof createDefaultProductionRealtimeMain>> | undefined;
    try {
      main = await createDefaultProductionRealtimeMain({
        HOME: home,
        CHAT_ASSISTANT_MODE: "live",
        CHAT_ASSISTANT_DATA_DIR: runtimeRoot,
      });
      expect(Object.keys(main)).not.toEqual(
        expect.arrayContaining(["directory", "repository", "admission", "service"]),
      );
      expect(main.isDispatcherQuarantined()).toBe(false);
      expect(executable).toContain("await startFixedHeartbeatSupervisorMain();");
      await main.stop();
      expect(() => main?.start()).toThrow("REALTIME_PRODUCTION_TERMINAL");
      expect(() =>
        main?.tickOnce(new Date("2026-08-31T00:00:00.000Z")),
      ).toThrow("REALTIME_PRODUCTION_TERMINAL");
      expect(() =>
        main?.recoverPending(new Date("2026-08-31T00:00:00.000Z")),
      ).toThrow("REALTIME_PRODUCTION_TERMINAL");
      expect(() => main?.hasPendingWork()).toThrow(
        "REALTIME_PRODUCTION_TERMINAL",
      );
    } finally {
      await main?.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("shares the installed state root and sole live owner with passive production work", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "default-realtime-shared-"));
    const dataDir = path.join(home, "Desktop", "聊天助手");
    const runtimeRoot = path.join(dataDir, "runtime-v2");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    const environment = {
      HOME: home,
      CHAT_ASSISTANT_MODE: "live",
      CHAT_ASSISTANT_DATA_DIR: runtimeRoot,
    };
    const slot = {
      slotKey: "2026-08-23/morning",
      localDate: "2026-08-23",
      kind: "morning" as const,
      targetMode: "production" as const,
    };
    const keyProvider = { getOrCreate: () => Promise.resolve(Buffer.alloc(32, 43)) };
    const releaseBinding = {
      payloadManifestSha256: "a".repeat(64),
      nativeSha256: "b".repeat(64),
      effectiveConfigSha256: "c".repeat(64),
    };
    const store = new EncryptedStore(dataDir, keyProvider);
    await Promise.all([
      store.write("state/consent.enc", {
        version: 1,
        consentConfirmed: true,
        reportHash: "d".repeat(64),
        acceptanceBindingSha256: hashReleaseBinding(releaseBinding),
        activatedAt: "2026-08-30T00:00:00.000Z",
      }),
      store.write("profiles/initialization-report.enc", {
        hash: "d".repeat(64),
        approvedHash: "d".repeat(64),
      }),
    ]);
    let main: Awaited<ReturnType<typeof createDefaultProductionRealtimeMain>> | undefined;
    let passive: Awaited<ReturnType<NonNullable<typeof main>["createPassiveService"]>> | undefined;
    let daily: Awaited<ReturnType<NonNullable<typeof main>["createDailyCareService"]>> | undefined;
    try {
      main = await createDefaultProductionRealtimeMain(environment, () =>
        new Date("2026-08-22T22:30:00.000Z"), {
        keyProvider,
        testOnlyReleaseBinding: releaseBinding,
      });
      await main.markP0Skipped(slot, new Date("2026-08-22T22:30:00.000Z"));
      await expect(main.inspectDailyCareSlot(slot, environment)).resolves.toEqual({
        status: "skipped",
      });
      passive = await main.createPassiveService();
      await passive.close();
      daily = await main.createDailyCareService(environment);
      await daily.close();
      await expect(acquireLiveOperationCoordinator({
        dataDir: runtimeRoot,
        ownerKind: "cli",
      })).rejects.toThrow("LIVE_RUNTIME_BUSY");
    } finally {
      await passive?.close();
      await daily?.close();
      await main?.stop();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not construct the dynamic realtime or OneBot path in default production", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "fixed-contact-consumer-"));
    const dataDir = path.join(home, "Desktop", "聊天助手");
    const runtimeRoot = path.join(dataDir, "runtime-v2");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    let factories: FixedHeartbeatRuntimeFactories | null = null;
    let supervisorOptions: FixedHeartbeatSupervisorOptions | undefined;
    let handle: Awaited<ReturnType<typeof startFixedHeartbeatSupervisorMain>> | undefined;
    try {
      handle = await startFixedHeartbeatSupervisorMain({
        environment: {
          HOME: home,
          CHAT_ASSISTANT_MODE: "live",
          CHAT_ASSISTANT_DATA_DIR: runtimeRoot,
        },
        input: new EventEmitter(),
        signals: new EventEmitter(),
        connect: (capturedFactories, capturedOptions) => {
          factories = capturedFactories;
          supervisorOptions = capturedOptions;
          return Promise.resolve({
            server: {
              server: { onclose: undefined },
              close: vi.fn().mockResolvedValue(undefined),
            },
            shutdown: vi.fn().mockResolvedValue(undefined),
          });
        },
      });
      const capturedFactories = factories as FixedHeartbeatRuntimeFactories | null;
      const capturedOptions = supervisorOptions;
      if (capturedFactories === null || capturedOptions === undefined) {
        throw new Error("FIXED_HEARTBEAT_PRODUCTION_WIRING_NOT_CAPTURED");
      }
      expect(capturedFactories.recoverRealtimePending).toBeUndefined();
      expect(capturedOptions.dispatcherGate).toBeUndefined();
    } finally {
      await handle?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("binds scheduler and quarantine state to the installed runtime root", () => {
    const home = "/Users/example";
    const defaultDataDir = `${home}/Desktop/聊天助手`;
    const runtimeRoot = `${defaultDataDir}/runtime-v2`;

    expect(resolveFixedHeartbeatStateRoot(defaultDataDir, {
      HOME: home,
      CHAT_ASSISTANT_DATA_DIR: runtimeRoot,
    })).toBe(runtimeRoot);
    expect(resolveFixedHeartbeatStateRoot(defaultDataDir, { HOME: home })).toBe(runtimeRoot);
    expect(() => resolveFixedHeartbeatStateRoot(defaultDataDir, {
      HOME: home,
      CHAT_ASSISTANT_DATA_DIR: "/",
    })).toThrow("FIXED_HEARTBEAT_STATE_ROOT_INVALID");
  });

  it.each(["EOF", "SIGINT", "SIGTERM"] as const)(
    "closes the server and active cycle once on %s",
    async (trigger) => {
      const input = new EventEmitter();
      const signals = new EventEmitter();
      const shutdown = vi.fn().mockResolvedValue(undefined);
      const serverClose = vi.fn().mockResolvedValue(undefined);
      const server = { onclose: undefined as (() => void) | undefined };

      await startFixedHeartbeatSupervisorMain({
        input,
        signals,
        connect: vi.fn().mockResolvedValue({
          server: { server, close: serverClose },
          shutdown,
        }),
      });

      if (trigger === "EOF") input.emit("end");
      else signals.emit(trigger);

      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
      expect(serverClose).toHaveBeenCalledTimes(1);
      server.onclose?.();
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    },
  );

  it("still shuts down the active cycle when server close fails", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const handle = await startFixedHeartbeatSupervisorMain({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      connect: vi.fn().mockResolvedValue({
        server: {
          server: { onclose: undefined },
          close: vi.fn().mockRejectedValue(new Error("PRIVATE_SERVER_CLOSE_FAILURE")),
        },
        shutdown,
      }),
    });

    const error = await handle.close().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("closes the MCP server before awaiting supervisor shutdown", async () => {
    const order: string[] = [];
    let releaseShutdown: (() => void) | undefined;
    const shutdownWait = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    const handle = await startFixedHeartbeatSupervisorMain({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      connect: vi.fn().mockResolvedValue({
        server: {
          server: { onclose: undefined },
          close: vi.fn().mockImplementation(() => {
            order.push("server-close");
            return Promise.resolve();
          }),
        },
        shutdown: vi.fn().mockImplementation(() => {
          order.push("shutdown");
          return shutdownWait;
        }),
      }),
    });

    const closing = handle.close();
    await vi.waitFor(() => expect(order).toEqual(["server-close", "shutdown"]));
    releaseShutdown?.();
    await expect(closing).resolves.toBeUndefined();
  });

  it.each([
    ["2026-08-23T13:59:59.999Z", "p1", 1],
    ["2026-08-22T22:29:59.999Z", "p1", 1],
  ] as const)("routes a cross-product wake at %s to %s before constructing daily runtime", async (
    timestamp,
    expectedLane,
    passiveFactoryCalls,
  ) => {
    let factories: FixedHeartbeatRuntimeFactories | null = null;
    const createDailyCareService = vi.fn<
      NonNullable<StartFixedHeartbeatSupervisorMainOptions["createDailyCareService"]>
    >().mockResolvedValue({ dependencies: {} as never, close: vi.fn() });
    const passiveRuntime = { dependencies: {} as never, close: vi.fn().mockResolvedValue(undefined) };
    const createPassiveService = vi.fn().mockResolvedValue(passiveRuntime);
    const handle = await startFixedHeartbeatSupervisorMain({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      now: () => new Date(timestamp),
      createDailyCareService,
      createPassiveService,
      inspectDailyCareSlot: vi.fn().mockResolvedValue(null),
      connect: (value) => {
        factories = value;
        return Promise.resolve({
          server: { server: { onclose: undefined }, close: vi.fn().mockResolvedValue(undefined) },
          shutdown: vi.fn().mockResolvedValue(undefined),
        });
      },
    });
    try {
      const captured = factories as FixedHeartbeatRuntimeFactories | null;
      if (captured === null) throw new Error("FIXED_HEARTBEAT_FACTORIES_NOT_CAPTURED");
      await expect(captured.beginScheduledTick()).resolves.toMatchObject({ lane: expectedLane });
      expect(createDailyCareService).not.toHaveBeenCalled();
      expect(createPassiveService).toHaveBeenCalledTimes(passiveFactoryCalls);
    } finally {
      await handle.close();
    }
  });

  it.each([
    "2026-08-22T22:30:00.000Z",
    "2026-08-23T14:00:00.000Z",
  ])("constructs daily runtime for an accepted wake at %s", async (timestamp) => {
    let factories: FixedHeartbeatRuntimeFactories | null = null;
    const runtime = { dependencies: {} as never, close: vi.fn().mockResolvedValue(undefined) };
    const createDailyCareService = vi.fn<
      NonNullable<StartFixedHeartbeatSupervisorMainOptions["createDailyCareService"]>
    >().mockResolvedValue(runtime);
    const handle = await startFixedHeartbeatSupervisorMain({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      now: () => new Date(timestamp),
      createDailyCareService,
      inspectDailyCareSlot: vi.fn().mockResolvedValue(null),
      connect: (value) => {
        factories = value;
        return Promise.resolve({
          server: { server: { onclose: undefined }, close: vi.fn().mockResolvedValue(undefined) },
          shutdown: vi.fn().mockResolvedValue(undefined),
        });
      },
    });
    try {
      const captured = factories as FixedHeartbeatRuntimeFactories | null;
      if (captured === null) throw new Error("FIXED_HEARTBEAT_FACTORIES_NOT_CAPTURED");
      await expect(captured.beginScheduledTick()).resolves.toMatchObject({ lane: "p0", runtime });
      expect(createDailyCareService).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it("blocks a passive cross-wake before runtime construction while P0 is pending", async () => {
    let factories: FixedHeartbeatRuntimeFactories | null = null;
    const createPassiveService = vi.fn().mockResolvedValue({
      dependencies: {} as never,
      close: vi.fn().mockResolvedValue(undefined),
    });
    const dailyRuntime = { dependencies: {} as never, close: vi.fn().mockResolvedValue(undefined) };
    const handle = await startFixedHeartbeatSupervisorMain({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      now: () => new Date("2026-08-22T22:30:12.000Z"),
      createPassiveService,
      createDailyCareService: vi.fn().mockResolvedValue(dailyRuntime),
      inspectDailyCareSlot: vi.fn().mockResolvedValue({ status: "pending" }),
      connect: (value) => {
        factories = value;
        return Promise.resolve({
          server: { server: { onclose: undefined }, close: vi.fn().mockResolvedValue(undefined) },
          shutdown: vi.fn().mockResolvedValue(undefined),
        });
      },
    });
    try {
      const captured = factories as FixedHeartbeatRuntimeFactories | null;
      if (captured === null) throw new Error("FIXED_HEARTBEAT_FACTORIES_NOT_CAPTURED");
      await expect(captured.beginScheduledTick()).resolves.toMatchObject({
        lane: "p0", runtime: dailyRuntime,
      });
      expect(createPassiveService).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it("preserves an injected realtime recovery entry in offline heartbeat wiring", async () => {
    const recoverRealtimePending = vi.fn().mockResolvedValue([]);
    const factories: FixedHeartbeatRuntimeFactories = {
      recoverRealtimePending,
      selectScheduledLane: vi.fn().mockResolvedValue("outside"),
      beginScheduledTick: vi.fn().mockResolvedValue({
        lane: "outside", status: "outside-window",
      }),
    };
    let received: FixedHeartbeatRuntimeFactories | null = null;
    const handle = await startFixedHeartbeatSupervisorMain({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      factories,
      connect: (value) => {
        received = value;
        return Promise.resolve({
          server: { server: { onclose: undefined }, close: vi.fn() },
          shutdown: vi.fn(),
        });
      },
    });
    try {
      const captured = received as FixedHeartbeatRuntimeFactories | null;
      if (captured === null) throw new Error("FIXED_HEARTBEAT_FACTORIES_NOT_CAPTURED");
      await captured.recoverRealtimePending?.();
      expect(recoverRealtimePending).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
    }
  });

  it("wires realtime recovery, persistent P1 priority, and the same admission", async () => {
    let factories: FixedHeartbeatRuntimeFactories | null = null;
    let supervisorOptions: FixedHeartbeatSupervisorOptions | undefined;
    const admission = new SingleDispatcherAdmission({
      acquireOwner: vi.fn().mockRejectedValue(new Error("UNUSED")),
    });
    const recoverPending = vi.fn().mockResolvedValue([]);
    const hasPendingWork = vi.fn().mockResolvedValue(true);
    const cycleGate = cycleGateFor(admission);
    const realtime = {
      cycleGate,
      start: vi.fn().mockResolvedValue(undefined),
      hasPendingWork,
      hasRecentConversation: vi.fn().mockResolvedValue(false),
      createScheduler: (options: ConstructorParameters<typeof SingleScheduler>[0]) =>
        new SingleScheduler({ ...options, admission }),
      recoverPending,
      stop: vi.fn().mockResolvedValue(undefined),
    } as never;
    const handle = await startFixedHeartbeatSupervisorMain({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      now: () => new Date("2026-08-22T22:30:12.000Z"),
      realtimeMain: realtime,
      inspectDailyCareSlot: vi.fn().mockResolvedValue(null),
      connect: (value, receivedOptions) => {
        factories = value;
        supervisorOptions = receivedOptions;
        return Promise.resolve({
          server: { server: { onclose: undefined }, close: vi.fn() },
          shutdown: vi.fn(),
        });
      },
    });
    try {
      const captured = factories as FixedHeartbeatRuntimeFactories | null;
      if (captured === null) throw new Error("FIXED_HEARTBEAT_FACTORIES_NOT_CAPTURED");
      await captured.recoverRealtimePending?.();
      await expect(captured.selectScheduledLane()).resolves.toBe("outside");
      expect(recoverPending).toHaveBeenCalledTimes(1);
      expect(hasPendingWork).toHaveBeenCalled();
      expect(supervisorOptions?.dispatcherGate).toBe(cycleGate);
    } finally {
      await handle.close();
    }
  });

  it("durably routes a recent natural conversation through the P0 skip hook", async () => {
    let factories: FixedHeartbeatRuntimeFactories | null = null;
    const markP0Skipped = vi.fn().mockResolvedValue(undefined);
    const admission = new SingleDispatcherAdmission({
        acquireOwner: vi.fn().mockRejectedValue(new Error("UNUSED")),
      });
    const realtime = {
      cycleGate: cycleGateFor(admission),
      start: vi.fn().mockResolvedValue(undefined),
      hasPendingWork: vi.fn().mockResolvedValue(false),
      hasRecentConversation: vi.fn().mockResolvedValue(true),
      createScheduler: (options: ConstructorParameters<typeof SingleScheduler>[0]) =>
        new SingleScheduler({ ...options, admission }),
      recoverPending: vi.fn().mockResolvedValue([]),
      stop: vi.fn().mockResolvedValue(undefined),
    } as never;
    const handle = await startFixedHeartbeatSupervisorMain({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      now: () => new Date("2026-08-22T22:30:12.000Z"),
      realtimeMain: realtime,
      markP0Skipped,
      inspectDailyCareSlot: vi.fn().mockResolvedValue(null),
      connect: (value) => {
        factories = value;
        return Promise.resolve({
          server: { server: { onclose: undefined }, close: vi.fn() },
          shutdown: vi.fn(),
        });
      },
    });
    try {
      const captured = factories as FixedHeartbeatRuntimeFactories | null;
      if (captured === null) throw new Error("FIXED_HEARTBEAT_FACTORIES_NOT_CAPTURED");
      await expect(captured.selectScheduledLane()).resolves.toBe("outside");
      expect(markP0Skipped).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "morning" }),
        new Date("2026-08-22T22:30:12.000Z"),
      );
    } finally {
      await handle.close();
    }
  });

  it.each(["verified", "skipped"] as const)(
    "falls back to P1 after terminal P0 status: %s",
    async (status) => {
      let factories: FixedHeartbeatRuntimeFactories | null = null;
      const runtime = { dependencies: {} as never, close: vi.fn().mockResolvedValue(undefined) };
      const createPassiveService = vi.fn().mockResolvedValue(runtime);
      const handle = await startFixedHeartbeatSupervisorMain({
        input: new EventEmitter(),
        signals: new EventEmitter(),
        now: () => new Date("2026-08-22T22:31:12.000Z"),
        createPassiveService,
        inspectDailyCareSlot: vi.fn().mockResolvedValue({ status }),
        connect: (value) => {
          factories = value;
          return Promise.resolve({
            server: { server: { onclose: undefined }, close: vi.fn().mockResolvedValue(undefined) },
            shutdown: vi.fn().mockResolvedValue(undefined),
          });
        },
      });
      try {
        const captured = factories as FixedHeartbeatRuntimeFactories | null;
        if (captured === null) throw new Error("FIXED_HEARTBEAT_FACTORIES_NOT_CAPTURED");
        await expect(captured.beginScheduledTick()).resolves.toMatchObject({
          lane: "p1", runtime,
        });
        expect(createPassiveService).toHaveBeenCalledTimes(1);
      } finally {
        await handle.close();
      }
    },
  );
});

function realtimeMainFixture(order: string[]) {
  const admission = new SingleDispatcherAdmission({
    acquireOwner: () => Promise.reject(new Error("UNUSED")),
  });
  return {
    cycleGate: {
      admit: () => Promise.reject(new Error("UNUSED")),
      cancelPendingAcquisition: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    },
    start: vi.fn().mockImplementation(() => {
      order.push("realtime-start");
      return Promise.resolve();
    }),
    stop: vi.fn().mockImplementation(() => {
      order.push("realtime-stop");
      return Promise.resolve();
    }),
    tickOnce: vi.fn(),
    recoverPending: vi.fn().mockResolvedValue([]),
    hasPendingWork: vi.fn().mockResolvedValue(false),
    hasRecentConversation: vi.fn().mockResolvedValue(false),
    isDispatcherQuarantined: vi.fn().mockReturnValue(false),
    createScheduler: (options: ConstructorParameters<typeof SingleScheduler>[0]) =>
      new SingleScheduler({ ...options, admission }),
  };
}

function cycleGateFor(admission: SingleDispatcherAdmission) {
  return Object.freeze({
    admit: async (lane: "p0" | "p1") => {
      const session = await admission.admit(lane);
      return Object.freeze({ close: () => session.close() });
    },
    cancelPendingAcquisition: () => admission.cancelPendingAcquisition(),
    close: () => Promise.resolve(),
  });
}
