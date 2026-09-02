import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runLiveCliBridgeProcess,
  type LiveCliBridgeRuntime,
} from "../../src/mcp/live-cli-bridge.js";
import {
  acquireLiveOperationCoordinator,
  type LiveOperationCoordinator,
  type LiveOwnerKind,
} from "../../src/mcp/live-operation-coordinator.js";
import type { LiveWechatRuntimeDependencies } from "../../src/mcp/live-server.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live CLI supervisor process", () => {
  it("uses one CLI production owner and retains the shared lease across high-level commands", async () => {
    const dataDirectory = await temporaryRoot();
    const input = new PassThrough();
    const output = new PassThrough();
    let coordinator: LiveOperationCoordinator | null = null;
    const running = runLiveCliBridgeProcess({
      arguments: [],
      createRuntime: async (options) => {
        coordinator = await acquireLiveOperationCoordinator({
          dataDir: dataDirectory,
          ownerKind: options.ownerKind,
        });
        return { dependencies: fakeDependencies(), close: () => coordinator?.close() ?? Promise.resolve() };
      },
      input,
      output,
      signals: new EventEmitter(),
    });
    await expectReady(output);

    await expect(acquireLiveOperationCoordinator({
      dataDir: dataDirectory,
      ownerKind: "mcp",
    })).rejects.toThrow("LIVE_RUNTIME_BUSY");
    input.write('{"op":"read-control"}\n');
    await waitForLine(output);
    expect(readJsonResponses(output)).toEqual([
      { ok: true, result: { control: null, checkpointReady: true } },
    ]);
    await expect(acquireLiveOperationCoordinator({
      dataDir: dataDirectory,
      ownerKind: "cli",
    })).rejects.toThrow("LIVE_RUNTIME_BUSY");

    input.write('{"op":"close"}\n');
    await expect(running).resolves.toBe(0);
    expect(readJsonResponses(output)).toEqual([{ ok: true, result: { closed: true } }]);
    const nextOwner = await acquireLiveOperationCoordinator({ dataDir: dataDirectory, ownerKind: "mcp" });
    await nextOwner.close();
  });

  it("fails a second bridge closed without disturbing the first session", async () => {
    const dataDirectory = await temporaryRoot();
    const firstInput = new PassThrough();
    const firstOutput = new PassThrough();
    const first = runLiveCliBridgeProcess({
      arguments: [],
      createRuntime: productionLikeFactory(dataDirectory),
      input: firstInput,
      output: firstOutput,
      signals: new EventEmitter(),
    });
    await expectReady(firstOutput);

    const secondInput = new PassThrough();
    secondInput.end();
    const secondOutput = new PassThrough();
    await expect(runLiveCliBridgeProcess({
      arguments: [],
      createRuntime: productionLikeFactory(dataDirectory),
      input: secondInput,
      output: secondOutput,
      signals: new EventEmitter(),
    })).resolves.toBe(1);
    expect(readJsonResponses(secondOutput)).toEqual([{ ok: false, error: "LIVE_BRIDGE_BUSY" }]);

    firstInput.end('{"op":"close"}\n');
    await expect(first).resolves.toBe(0);
    expect(readJsonResponses(firstOutput)).toEqual([{ ok: true, result: { closed: true } }]);
  });

  it("drains an accepted operation and invalidates the session on SIGTERM", async () => {
    const dataDirectory = await temporaryRoot();
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = new EventEmitter();
    const entered = deferred<void>();
    const release = deferred<void>();
    const coordinator = await acquireLiveOperationCoordinator({ dataDir: dataDirectory, ownerKind: "cli" });
    const close = vi.fn(async () => coordinator.close());
    const running = runLiveCliBridgeProcess({
      arguments: [],
      createRuntime: () => Promise.resolve({
        dependencies: fakeDependencies({
          readControlForSupervisor: async () => {
            entered.resolve(undefined);
            await release.promise;
            return controlRead();
          },
        }),
        close,
      }),
      input,
      output,
      signals,
    });
    await expectReady(output);
    input.write('{"op":"read-control"}\n');
    await entered.promise;

    signals.emit("SIGTERM");
    expect((await stat(path.join(dataDirectory, "state/.kernel-lock-v1"))).isDirectory()).toBe(true);
    release.resolve(undefined);

    await expect(running).resolves.toBe(0);
    expect(readJsonResponses(output)).toEqual([
      { ok: true, result: { control: null, checkpointReady: true } },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect((await stat(path.join(dataDirectory, "state/.kernel-lock-v1"))).isDirectory()).toBe(true);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes exactly once on EOF without inventing a command response", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const running = runLiveCliBridgeProcess({
      arguments: [],
      createRuntime: () => Promise.resolve({ dependencies: fakeDependencies(), close }),
      input,
      output,
      signals: new EventEmitter(),
    });
    await expectReady(output);

    input.end();

    await expect(running).resolves.toBe(0);
    expect(readOutput(output)).toBe("");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects argv before runtime construction without echoing it", async () => {
    const input = new PassThrough();
    input.end();
    const output = new PassThrough();
    const createRuntime = vi.fn<() => Promise<LiveCliBridgeRuntime>>();

    await expect(runLiveCliBridgeProcess({
      arguments: ["--candidate", "ARGV_SECRET"],
      createRuntime,
      input,
      output,
      signals: new EventEmitter(),
    })).resolves.toBe(1);

    expect(readOutput(output)).toBe('{"ok":false,"error":"LIVE_BRIDGE_STDIN_ONLY"}\n');
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "handles %s after the lease is acquired but before bootstrap returns",
    async (signal) => {
      const dataDirectory = await temporaryRoot();
      const input = new PassThrough();
      input.write('{"op":"read-control"}\n');
      const output = new PassThrough();
      const signals = new EventEmitter();
      const leaseAcquired = deferred<void>();
      const returnRuntime = deferred<void>();
      let operationCalls = 0;
      let closeCalls = 0;
      const running = runLiveCliBridgeProcess({
        arguments: [],
        createRuntime: async (options) => {
          const coordinator = await acquireLiveOperationCoordinator({
            dataDir: dataDirectory,
            ownerKind: options.ownerKind,
          });
          leaseAcquired.resolve(undefined);
          await returnRuntime.promise;
          return {
            dependencies: fakeDependencies({
              readControlForSupervisor: () => {
                operationCalls += 1;
                return Promise.resolve(controlRead());
              },
            }),
            close: async () => {
              closeCalls += 1;
              await coordinator.close();
            },
          };
        },
        input,
        output,
        signals,
      });
      await leaseAcquired.promise;

      signals.emit(signal);
      returnRuntime.resolve(undefined);

      await expect(running).resolves.toBe(0);
      expect(operationCalls).toBe(0);
      expect(closeCalls).toBe(1);
      expect(readOutput(output)).toBe("");
      expect(signals.listenerCount(signal)).toBe(0);
    },
  );

  it.each(["already ended", "ends during bootstrap"] as const)(
    "treats input EOF that is %s as pending shutdown",
    async (scenario) => {
      const dataDirectory = await temporaryRoot();
      const input = new PassThrough();
      const eofObserved = once(input, "end");
      if (scenario === "already ended") input.end('{"op":"read-control"}\n');
      const output = new PassThrough();
      const leaseAcquired = deferred<void>();
      const returnRuntime = deferred<void>();
      let operationCalls = 0;
      const running = runLiveCliBridgeProcess({
        arguments: [],
        createRuntime: async (options) => {
          const coordinator = await acquireLiveOperationCoordinator({
            dataDir: dataDirectory,
            ownerKind: options.ownerKind,
          });
          leaseAcquired.resolve(undefined);
          await returnRuntime.promise;
          return {
            dependencies: fakeDependencies({
              readControlForSupervisor: () => {
                operationCalls += 1;
                return Promise.resolve(controlRead());
              },
            }),
            close: () => coordinator.close(),
          };
        },
        input,
        output,
        signals: new EventEmitter(),
      });
      await leaseAcquired.promise;
      if (scenario === "ends during bootstrap") input.end('{"op":"read-control"}\n');
      await eofObserved;
      returnRuntime.resolve(undefined);

      await expect(running).resolves.toBe(0);
      expect(operationCalls).toBe(0);
      expect(readOutput(output)).toBe("");
    },
  );

  it("arbitrates 500 pending EOF deliveries without dispatch or capability output", { timeout: 30_000 }, async () => {
    const root = await temporaryRoot();
    let operationCalls = 0;
    let nonzeroExitCodes = 0;
    let unexpectedOutput = 0;

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const dataDirectory = root;
      const input = new PassThrough();
      const output = new PassThrough();
      const leaseAcquired = deferred<void>();
      const returnRuntime = deferred<void>();
      const running = runLiveCliBridgeProcess({
        arguments: [],
        createRuntime: async (options) => {
          const coordinator = await acquireLiveOperationCoordinator({
            dataDir: dataDirectory,
            ownerKind: options.ownerKind,
          });
          leaseAcquired.resolve(undefined);
          await returnRuntime.promise;
          return {
            dependencies: fakeDependencies({
              readControlForSupervisor: () => {
                operationCalls += 1;
                return Promise.resolve(controlRead());
              },
            }),
            close: () => coordinator.close(),
          };
        },
        input,
        output,
        signals: new EventEmitter(),
      });
      await leaseAcquired.promise;
      input.end('{"op":"read-control"}\n');
      returnRuntime.resolve(undefined);
      if (await running !== 0) nonzeroExitCodes += 1;
      if (readOutput(output) !== "") unexpectedOutput += 1;
    }

    expect({ operationCalls, nonzeroExitCodes, unexpectedOutput }).toEqual({
      operationCalls: 0,
      nonzeroExitCodes: 0,
      unexpectedOutput: 0,
    });
  });
});

function productionLikeFactory(
  dataDirectory: string,
): (options: { ownerKind: LiveOwnerKind }) => Promise<LiveCliBridgeRuntime> {
  return async (options) => {
    const coordinator = await acquireLiveOperationCoordinator({
      dataDir: dataDirectory,
      ownerKind: options.ownerKind,
    });
    return { dependencies: fakeDependencies(), close: () => coordinator.close() };
  };
}

function fakeDependencies(
  overrides: Partial<LiveWechatRuntimeDependencies> = {},
): LiveWechatRuntimeDependencies {
  return {
    getLiveState: () => Promise.resolve({ connected: true }),
    readConversation: () => Promise.resolve({}),
    prepareDraft: () => Promise.resolve({ candidateToken: "legacy", prepared: true }),
    verifyDraft: () => Promise.resolve({ draftVerified: true }),
    abortDraft: () => Promise.resolve({ aborted: true }),
    abortPreparedDraftForSupervisor: () => Promise.resolve({
      aborted: true,
      conversationId: "example-contact",
    }),
    verifySend: () => Promise.resolve({ status: "verified" }),
    readTargetConversationForAdvice: () => Promise.resolve({}),
    establishControlBoundaryForSupervisor: () => Promise.resolve({
      status: "active",
      epoch: "e".repeat(64),
      boundaryMessageId: "b".repeat(64),
      consumedCount: 0,
      prefixChainHash: "p".repeat(64),
      markerOccurrenceCount: 1,
    }),
    readControlForSupervisor: () => Promise.resolve(controlRead()),
    readTargetForSupervisor: () => Promise.resolve({
      publicResult: { replyDecision: { action: "wait", triggerMessageId: null, reason: "NO_NEW_INCOMING" } },
      proof: null,
    }),
    readTargetDirectForSupervisor: () => Promise.resolve({
      publicResult: { replyDecision: { action: "wait", triggerMessageId: null, reason: "NO_NEW_INCOMING" } },
      controlProof: null,
      proof: null,
    }),
    prepareLatestReplyForSupervisor: () => Promise.reject(new Error("TARGET_TRIGGER_CHANGED")),
    showComfortStationCardForSupervisor: () => Promise.resolve({
      status: "verified",
      conversationId: "example-contact",
    }),
    submitAuthorizedDraftForSupervisor: () => Promise.reject(new Error("SUBMIT_PROOF_CONSUMED")),
    ...overrides,
  };
}

function controlRead() {
  return {
    publicResult: { control: null, checkpointReady: true },
    proof: {
      capability: "CONTROL_CAPABILITY_CANARY",
      checkpoint: {
        epoch: "e".repeat(64),
        boundaryMessageId: "b".repeat(64),
        consumedCount: 0,
        prefixChainHash: "p".repeat(64),
      },
      verification: "ui-observed" as const,
      gateRevision: "g".repeat(64),
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-cli-bridge-"));
  await initializeTestKernelLockCatalog(root);
  temporaryRoots.push(root);
  return root;
}

async function expectReady(output: PassThrough): Promise<void> {
  await waitForLine(output);
  expect(readJsonResponses(output)).toEqual([{
    ok: true,
    type: "ready",
    protocolVersion: 2,
    active: true,
  }]);
}

function readJsonResponses(output: PassThrough): unknown[] {
  const serialized = readOutput(output);
  return serialized.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

function readOutput(output: PassThrough): string {
  const chunk: unknown = output.read();
  if (chunk === null) return "";
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (typeof chunk === "string") return chunk;
  throw new Error("UNEXPECTED_OUTPUT_CHUNK");
}

async function waitForLine(output: PassThrough): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (output.readableLength === 0) {
    if (Date.now() >= deadline) throw new Error("OUTPUT_LINE_DEADLINE_EXCEEDED");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise(value);
    },
  };
}
