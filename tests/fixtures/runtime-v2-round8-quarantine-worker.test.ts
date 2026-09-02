import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { createFixedHeartbeatSupervisor } from
  "../../src/mcp/fixed-heartbeat-supervisor.js";
import { FileOperationQuarantineRepository } from
  "../../src/runtime-v2/operation-quarantine.js";

const enabled = process.env.RUNTIME_V2_ROUND8_WORKER === "1";

it.skipIf(!enabled)("blocks a successor on a durable barrier-clear receipt", async () => {
  const root = required("RUNTIME_V2_ROUND8_ROOT");
  const marker = required("RUNTIME_V2_ROUND8_MARKER");
  let factoryCount = 0;
  const supervisor = createFixedHeartbeatSupervisor({
    selectScheduledLane: () => Promise.resolve("p1"),
    beginScheduledTick: async () => {
      factoryCount += 1;
      await writeFile(`${marker}.ui`, "ui\n", { flag: "wx", mode: 0o600 });
      throw new Error("ROUND8_SUCCESSOR_UI_REACHED");
    },
  }, { quarantineRepository: new FileOperationQuarantineRepository(root) });
  const client = new Client({ name: "round8-successor", version: "1.0.0" });
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
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`ROUND8_ENV_MISSING:${name}`);
  return value;
}
