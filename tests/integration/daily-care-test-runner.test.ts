import { PassThrough } from "node:stream";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

interface RunnerModule {
  runDailyCareTestSession(options: {
    kind: "morning" | "night";
    rpc: { callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> };
    input: PassThrough;
    output: PassThrough;
    decisionTimeoutMs?: number;
  }): Promise<{ status: "verified" | "aborted"; messageHash?: string }>;
}

describe("daily-care no-echo test runner", () => {
  it("runs a morning decision without echoing the candidate", async () => {
    const module = await loadRunner();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(...chunk.toString("utf8").trim().split("\n")));
    const rpc = fakeRpc();
    const candidate = "PRIVATE_CANDIDATE_CANARY";

    const running = module.runDailyCareTestSession({ kind: "morning", rpc, input, output });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(JSON.parse(lines[0] ?? "null")).toEqual({
      type: "awaiting-candidate",
      kind: "morning",
      constraints: {
        bodyLength: { minimum: 60, maximum: 120 },
        signature: "——示例用户",
        maximumRegenerations: 2,
      },
      weather: {
        localDate: "2026-08-23",
        condition: "多云",
        temperature: { kind: "range", highC: 32, lowC: 25 },
        rainExpected: false,
        clothingConcepts: ["breathable", "sun-protection"],
        checkedAt: "2026-08-22T22:02:00.000Z",
      },
    });
    input.end(`${JSON.stringify({ decision: "send", text: candidate })}\n`);
    const result = await running;
    expect(result.status).toBe("verified");
    expect(result.messageHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(lines.join("\n")).not.toContain(candidate);
    expect(rpc.calls.map(({ name }) => name)).toEqual([
      "begin-test-preview",
      "research-morning-weather",
      "prepare-broadcast",
      "verify-draft",
      "submit-authorized-broadcast",
      "verify-send",
      "close",
    ]);
  });

  it("accepts the exact low-only public weather receipt", async () => {
    const module = await loadRunner();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(...chunk.toString("utf8").trim().split("\n")));
    const rpc = fakeRpc();
    rpc.responses.set("research-morning-weather", {
      localDate: "2026-08-23",
      condition: "小雨",
      temperature: { kind: "low-only", lowC: 7 },
      rainExpected: true,
      clothingConcepts: ["warmth", "rain-protection"],
      checkedAt: "2026-08-22T22:02:00.000Z",
    });

    const running = module.runDailyCareTestSession({ kind: "morning", rpc, input, output });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
      weather: { temperature: { kind: "low-only", lowC: 7 } },
    });
    input.end('{"decision":"abort"}\n');
    await expect(running).resolves.toEqual({ status: "aborted" });
  });

  it.each([
    ["mixed low-only", { kind: "low-only", lowC: 25, highC: 32 }],
    ["nullable range", { kind: "range", highC: null, lowC: 25 }],
    ["unknown kind", { kind: "average", lowC: 25 }],
    ["extra range key", { kind: "range", highC: 32, lowC: 25, averageC: 28 }],
  ])("rejects a %s public weather receipt", async (_name, temperature) => {
    const module = await loadRunner();
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = fakeRpc();
    rpc.responses.set("research-morning-weather", {
      localDate: "2026-08-23",
      condition: "多云",
      temperature,
      rainExpected: false,
      clothingConcepts: [],
      checkedAt: "2026-08-22T22:02:00.000Z",
    });

    await expect(module.runDailyCareTestSession({ kind: "morning", rpc, input, output }))
      .rejects.toThrow("TEST_PROTOCOL_INVALID");
    expect(rpc.calls.at(-1)?.name).toBe("close");
  });

  it("runs night with zero research calls and accepts an explicit abort", async () => {
    const module = await loadRunner();
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = fakeRpc();
    const running = module.runDailyCareTestSession({ kind: "night", rpc, input, output });
    output.once("data", () => input.end('{"decision":"abort"}\n'));
    await expect(running).resolves.toEqual({ status: "aborted" });
    expect(rpc.calls.map(({ name }) => name)).toEqual(["begin-test-preview", "close"]);
  });

  it.each([
    ["EOF", ""],
    ["extra line", '{"decision":"abort"}\n{"decision":"abort"}\n'],
    ["unknown field", '{"decision":"abort","contact":"示例联系人"}\n'],
  ])("fails closed for %s", async (_name, decision) => {
    const module = await loadRunner();
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = fakeRpc();
    const running = module.runDailyCareTestSession({ kind: "night", rpc, input, output });
    output.once("data", () => input.end(decision));
    await expect(running).rejects.toThrow(
      /DAILY_CARE_TEST_(?:STDIN|DECISION)|TEST_PROTOCOL_SECRET_LEAK/u,
    );
    expect(rpc.calls.at(-1)?.name).toBe("close");
  });

  it("rejects a server result containing a capability or token", async () => {
    const module = await loadRunner();
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = fakeRpc();
    rpc.responses.set("begin-test-preview", {
      ...rpc.responses.get("begin-test-preview") as object,
      token: "PRIVATE_TOKEN_CANARY",
    });
    await expect(module.runDailyCareTestSession({ kind: "night", rpc, input, output }))
      .rejects.toThrow("TEST_PROTOCOL_SECRET_LEAK");
  });
});

async function loadRunner(): Promise<RunnerModule> {
  return import(pathToFileURL(path.resolve("scripts/run-daily-care-test.mjs")).href) as Promise<RunnerModule>;
}

function fakeRpc() {
  const calls: Array<{ name: string; arguments_: Record<string, unknown> }> = [];
  const responses = new Map<string, unknown>([
    ["begin-test-preview", {
      kind: "morning",
      target: "file-transfer",
      weatherRequired: true,
      bodyLength: { minimum: 60, maximum: 120 },
      signature: "——示例用户",
      maximumRegenerations: 2,
    }],
    ["research-morning-weather", {
      localDate: "2026-08-23",
      condition: "多云",
      temperature: { kind: "range", highC: 32, lowC: 25 },
      rainExpected: false,
      clothingConcepts: ["breathable", "sun-protection"],
      checkedAt: "2026-08-22T22:02:00.000Z",
    }],
    ["prepare-broadcast", { prepared: true, conversationId: "file-transfer" }],
    ["verify-draft", { draftVerified: true, conversationId: "file-transfer" }],
    ["submit-authorized-broadcast", { submitted: true, conversationId: "file-transfer" }],
    ["verify-send", { status: "verified", conversationId: "file-transfer" }],
    ["close", { closed: true }],
  ]);
  return {
    calls,
    responses,
    callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
      calls.push({ name, arguments_ });
      if (name === "begin-test-preview" && arguments_.kind === "night") {
        const configured = responses.get(name);
        if (typeof configured === "object" && configured !== null && "token" in configured) {
          return Promise.resolve(configured);
        }
        return Promise.resolve({
          kind: "night",
          target: "file-transfer",
          weatherRequired: false,
          bodyLength: { minimum: 120, maximum: 220 },
          signature: "——示例用户",
          maximumRegenerations: 2,
        });
      }
      return Promise.resolve(responses.get(name));
    },
  };
}
