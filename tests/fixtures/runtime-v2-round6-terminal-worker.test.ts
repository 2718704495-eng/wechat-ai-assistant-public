import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { access, writeFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { createFixedHeartbeatSupervisor } from
  "../../src/mcp/fixed-heartbeat-supervisor.js";
import { FileOperationQuarantineRepository } from
  "../../src/runtime-v2/operation-quarantine.js";

const enabled = process.env.RUNTIME_V2_ROUND6_WORKER === "1";

it.skipIf(!enabled)("runs one terminal-barrier worker", async () => {
  const mode = required("RUNTIME_V2_ROUND6_MODE");
  const root = required("RUNTIME_V2_ROUND6_ROOT");
  const marker = required("RUNTIME_V2_ROUND6_MARKER");
  if (mode === "successor") {
    let factoryCount = 0;
    const supervisor = createFixedHeartbeatSupervisor({
      selectScheduledLane: () => Promise.resolve("p1"),
      beginScheduledTick: async () => {
        factoryCount += 1;
        await writeFile(`${marker}.ui`, "ui\n", { flag: "wx", mode: 0o600 });
        return decision(marker);
      },
    }, { quarantineRepository: new FileOperationQuarantineRepository(root) });
    const client = new Client({ name: "round6-successor", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([supervisor.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
        .toBe(true);
      expect(factoryCount).toBe(0);
      await writeFile(marker, "blocked\n", { flag: "wx", mode: 0o600 });
    } finally {
      await supervisor.shutdown();
      await Promise.allSettled([client.close(), supervisor.server.close()]);
    }
    return;
  }

  const completionMode = required("RUNTIME_V2_ROUND6_COMPLETION");
  const allow = required("RUNTIME_V2_ROUND6_ALLOW");
  const supervisor = createFixedHeartbeatSupervisor({
    selectScheduledLane: () => Promise.resolve("p1"),
    beginScheduledTick: () => Promise.resolve({
      ...decision(marker),
      complete: async () => {
        await writeFile(`${marker}.outcome`, "started\n", { flag: "wx", mode: 0o600 });
        while (!await exists(allow)) await new Promise((resolve) => setTimeout(resolve, 5));
        if (completionMode === "failing") throw new Error("OUTCOME_DURABILITY_INJECTED");
      },
    }),
  }, {
    quarantineRepository: new FileOperationQuarantineRepository(root),
    releaseSha256: "d".repeat(64),
  });
  const client = new Client({ name: "round6-owner", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([supervisor.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    expect((await client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .not.toBe(true);
    const closed = await client.callTool({ name: "close", arguments: {} });
    expect(closed.isError === true).toBe(completionMode === "failing");
  } finally {
    await supervisor.shutdown().catch(() => undefined);
    await Promise.allSettled([client.close(), supervisor.server.close()]);
  }
});

function decision(marker: string) {
  return {
    lane: "p1" as const,
    cycleId: "33333333-3333-4333-8333-333333333333",
    complete: () => Promise.resolve(),
    runtime: {
      dependencies: {
        readTargetDirectForSupervisor: () => Promise.resolve({
          publicResult: { replyDecision: { action: "wait" } },
          controlProof: null,
          proof: null,
        }),
      } as never,
      close: () => writeFile(`${marker}.released`, "released\n", { flag: "wx", mode: 0o600 }),
    },
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`ROUND6_ENV_MISSING:${name}`);
  return value;
}
