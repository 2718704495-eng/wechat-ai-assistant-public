import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { access, writeFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { createFixedHeartbeatSupervisor } from
  "../../src/mcp/fixed-heartbeat-supervisor.js";
import { acquireLiveOperationCoordinator } from
  "../../src/mcp/live-operation-coordinator.js";
import {
  FileOperationQuarantineRepository,
  type OperationQuarantineRepository,
  type OperationQuarantineInput,
  type OperationTerminalBarrierInput,
} from "../../src/runtime-v2/operation-quarantine.js";

const enabled = process.env.RUNTIME_V2_ROUND7_WORKER === "1";

it.skipIf(!enabled)("runs one Round 7 terminal owner", async () => {
  const mode = required("RUNTIME_V2_ROUND7_MODE");
  const root = required("RUNTIME_V2_ROUND7_ROOT");
  const marker = required("RUNTIME_V2_ROUND7_MARKER");
  const allow = required("RUNTIME_V2_ROUND7_ALLOW");
  const failure = required("RUNTIME_V2_ROUND7_FAILURE");
  const baseRepository = new FileOperationQuarantineRepository(root);
  if (mode === "successor") {
    let factoryCount = 0;
    const supervisor = createFixedHeartbeatSupervisor({
      selectScheduledLane: () => Promise.resolve("p1"),
      beginScheduledTick: async () => {
        factoryCount += 1;
        await writeFile(`${marker}.ui`, "ui\n", { flag: "wx", mode: 0o600 });
        throw new Error("ROUND7_SUCCESSOR_UI_REACHED");
      },
    }, { quarantineRepository: baseRepository });
    const client = new Client({ name: "round7-real-successor", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([supervisor.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
        .toBe(true);
      expect(factoryCount).toBe(0);
      await writeFile(marker, "blocked\n", { flag: "wx", mode: 0o600 });
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      await Promise.allSettled([client.close(), supervisor.server.close()]);
    }
    return;
  }

  const coordinator = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
  const repository = injectRepositoryFailure(baseRepository, failure, marker, allow);
  const supervisor = createFixedHeartbeatSupervisor({
    selectScheduledLane: () => Promise.resolve("p1"),
    beginScheduledTick: () => Promise.resolve({
      lane: "p1" as const,
      cycleId: "77777777-7777-4777-8777-777777777777",
      complete: () => Promise.resolve(),
      runtime: {
        dependencies: {
          readTargetDirectForSupervisor: () => Promise.resolve({
            publicResult: { replyDecision: { action: "wait" } },
            controlProof: null,
            proof: null,
          }),
        } as never,
        close: async () => {
          await coordinator.close();
          await writeFile(`${marker}.gate-released`, "released\n", {
            flag: "wx", mode: 0o600,
          });
          if (failure === "owner-close-fail") {
            await writeFile(`${marker}.failure-stage`, "post-unlock\n", {
              flag: "wx", mode: 0o600,
            });
            throw new Error("ROUND7_OWNER_CLOSE_POST_UNLOCK_INJECTED");
          }
        },
      },
    }),
  }, { quarantineRepository: repository, releaseSha256: "7".repeat(64) });
  const client = new Client({ name: "round7-real-owner", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([supervisor.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    expect((await client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .not.toBe(true);
    const closing = client.callTool({ name: "close", arguments: {} });
    void closing.catch(() => undefined);
    await waitForPath(`${marker}.failure-stage`);
    if (failure !== "barrier-deferred") {
      expect((await closing).isError).toBe(true);
    }
    await waitForPath(allow);
    if (failure === "barrier-deferred") {
      expect((await closing).isError).not.toBe(true);
    }
  } finally {
    await supervisor.shutdown().catch(() => undefined);
    await coordinator.close().catch(() => undefined);
    await Promise.allSettled([client.close(), supervisor.server.close()]);
  }
});

function injectRepositoryFailure(
  base: FileOperationQuarantineRepository,
  failure: string,
  marker: string,
  allow: string,
): OperationQuarantineRepository {
  return {
    assertClear: () => base.assertClear(),
    quarantine: (input: OperationQuarantineInput) => base.quarantine(input),
    beginTerminalBarrier: async (input: OperationTerminalBarrierInput) => {
      await base.beginTerminalBarrier(input);
      if (failure === "barrier-deferred" || failure === "barrier-fail") {
        await writeFile(`${marker}.failure-stage`, "barrier\n", { flag: "wx", mode: 0o600 });
      }
      if (failure === "barrier-deferred") await waitForPath(allow);
      if (failure === "barrier-fail") throw new Error("ROUND7_BARRIER_INJECTED");
    },
    clearTerminalBarrier: async (input: OperationTerminalBarrierInput) => {
      if (failure === "owner-close-fail" || failure === "barrier-clear-fail") {
        await writeFile(`${marker}.failure-stage`, "post-unlock\n", {
          flag: "wx", mode: 0o600,
        });
      }
      if (failure === "barrier-clear-fail") {
        throw new Error("ROUND7_BARRIER_CLEAR_INJECTED");
      }
      await base.clearTerminalBarrier(input);
    },
  };
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("ROUND7_WORKER_SIGNAL_TIMEOUT");
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`ROUND7_ENV_MISSING:${name}`);
  return value;
}
