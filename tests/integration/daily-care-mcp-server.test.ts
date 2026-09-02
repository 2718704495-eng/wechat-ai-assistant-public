import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDailyCareMcpServer,
  createDailyCareProductionMcpServer,
} from "../../src/mcp/daily-care-mcp-server.js";
import type { DailyCareRuntimeDependencies } from "../../src/mcp/daily-care-session.js";

type ProductionRuntime = Parameters<typeof createDailyCareProductionMcpServer>[0];

const expectedTools = [
  "abort-draft",
  "begin-test-preview",
  "close",
  "prepare-broadcast",
  "research-morning-weather",
  "submit-authorized-broadcast",
  "verify-draft",
  "verify-send",
];

describe("daily-care test MCP server", () => {
  let client: Client;
  let closeAll: () => Promise<void>;
  let runtime: ReturnType<typeof fakeRuntime>;

  beforeEach(async () => {
    runtime = fakeRuntime();
    const server = createDailyCareMcpServer(runtime, { onCloseRequested: () => undefined });
    client = new Client({ name: "daily-care-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    closeAll = async () => Promise.allSettled([client.close(), server.close()]).then(() => undefined);
  });

  afterEach(async () => closeAll());

  it("exposes exactly the eight file-transfer test tools", async () => {
    expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual(expectedTools);
  });

  it.each([
    ["begin-test-preview", { kind: "morning", contact: "示例联系人" }],
    ["research-morning-weather", { query: "PRIVATE" }],
    ["prepare-broadcast", { text: "candidate", target: "示例联系人" }],
    ["verify-draft", { token: "PRIVATE" }],
  ] as const)("rejects extra parameters for %s before runtime", async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(runtime.beginTestPreview).not.toHaveBeenCalled();
    expect(runtime.prepareBroadcast).not.toHaveBeenCalled();
  });

  it("sanitizes runtime errors and never echoes candidate text", async () => {
    runtime.beginTestPreview.mockRejectedValueOnce(new Error("PRIVATE_CHAT_CANARY"));
    const result = await client.callTool({
      name: "begin-test-preview",
      arguments: { kind: "night" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("DAILY_CARE_OPERATION_FAILED");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CHAT_CANARY");
  });

});

describe("daily-care production MCP server", () => {
  let client: Client;
  let closeAll: () => Promise<void>;
  let runtime: ReturnType<typeof fakeProductionRuntime>;

  beforeEach(async () => {
    runtime = fakeProductionRuntime();
    const server = createDailyCareProductionMcpServer(runtime, {
      onCloseRequested: () => undefined,
    });
    client = new Client({ name: "daily-care-production", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    closeAll = async () => Promise.allSettled([client.close(), server.close()]).then(() => undefined);
  });

  afterEach(async () => closeAll());

  it("exposes exactly the eight strict production tools without the test entry", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "abort-draft",
      "begin-current-slot",
      "close",
      "prepare-broadcast",
      "research-morning-weather",
      "submit-authorized-broadcast",
      "verify-draft",
      "verify-send",
    ]);
    expect(tools.find(({ name }) => name === "begin-current-slot")?.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(tools.find(({ name }) => name === "prepare-broadcast")?.inputSchema).toMatchObject({
      type: "object",
      required: ["text"],
      additionalProperties: false,
    });
  });

  it.each([
    ["begin-current-slot", { kind: "night" }],
    ["research-morning-weather", { location: "PRIVATE" }],
    ["prepare-broadcast", { text: "candidate", contact: "PRIVATE" }],
    ["submit-authorized-broadcast", { token: "PRIVATE" }],
  ] as const)("rejects production override parameters for %s before runtime", async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(runtime.beginCurrentSlot).not.toHaveBeenCalled();
    expect(runtime.prepareBroadcast).not.toHaveBeenCalled();
  });

  it("does not return or echo the production target, claim, token or private errors", async () => {
    runtime.beginCurrentSlot.mockResolvedValueOnce({
      kind: "night",
      weatherRequired: false,
      skillId: "daily-care-message-writing",
      bodyLength: { minimum: 120, maximum: 220 },
      signature: "——示例用户",
      maximumRegenerations: 2,
    });
    const begun = await client.callTool({ name: "begin-current-slot", arguments: {} });
    expect(JSON.stringify(begun)).not.toMatch(/example-contact|示例联系人|claim|token/iu);

    runtime.prepareBroadcast.mockRejectedValueOnce(new Error("PRIVATE_PRODUCTION_CANARY"));
    const failed = await client.callTool({
      name: "prepare-broadcast",
      arguments: { text: "PRIVATE_CANDIDATE_CANARY" },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).toContain("DAILY_CARE_OPERATION_FAILED");
    expect(JSON.stringify(failed)).not.toMatch(/PRIVATE_PRODUCTION_CANARY|PRIVATE_CANDIDATE_CANARY/u);
  });
});

function fakeRuntime() {
  return {
    beginTestPreview: vi.fn<DailyCareRuntimeDependencies["beginTestPreview"]>(),
    researchMorningWeather: vi.fn<DailyCareRuntimeDependencies["researchMorningWeather"]>(),
    prepareBroadcast: vi.fn<DailyCareRuntimeDependencies["prepareBroadcast"]>(),
    verifyDraft: vi.fn<DailyCareRuntimeDependencies["verifyDraft"]>(),
    submitAuthorizedBroadcast: vi.fn<DailyCareRuntimeDependencies["submitAuthorizedBroadcast"]>(),
    verifySend: vi.fn<DailyCareRuntimeDependencies["verifySend"]>(),
    abortDraft: vi.fn<DailyCareRuntimeDependencies["abortDraft"]>(),
    close: vi.fn<DailyCareRuntimeDependencies["close"]>(),
  };
}

function fakeProductionRuntime() {
  return {
    beginCurrentSlot: vi.fn<ProductionRuntime["beginCurrentSlot"]>(),
    researchMorningWeather: vi.fn<ProductionRuntime["researchMorningWeather"]>(),
    prepareBroadcast: vi.fn<ProductionRuntime["prepareBroadcast"]>(),
    verifyDraft: vi.fn<ProductionRuntime["verifyDraft"]>(),
    submitAuthorizedBroadcast: vi.fn<ProductionRuntime["submitAuthorizedBroadcast"]>(),
    verifySend: vi.fn<ProductionRuntime["verifySend"]>(),
    abortDraft: vi.fn<ProductionRuntime["abortDraft"]>(),
    close: vi.fn<ProductionRuntime["close"]>(),
  };
}
