import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runLiveCliBridgeProcess } from "../../src/mcp/live-cli-bridge.js";
import type { LiveWechatRuntimeDependencies } from "../../src/mcp/live-server.js";

describe("live CLI high-level supervisor protocol", () => {
  it("starts ready without serializing a challenge or capability", async () => {
    const result = await runLines(fakeDependencies(), [{ op: "close" }]);

    expect(result.startup).toEqual({
      ok: true,
      type: "ready",
      protocolVersion: 2,
      active: true,
    });
    expect(JSON.stringify(result.startup)).not.toContain("challenge");
    expect(result.responses).toEqual([{ ok: true, result: { closed: true } }]);
  });

  it("dispatches only the ordered high-level operations and never returns internal proofs", async () => {
    const dependencies = fakeDependencies();
    const result = await runLines(dependencies, [
      { op: "read-control" },
      { op: "read-target" },
      { op: "prepare-latest-reply", text: "收到啦" },
      { op: "verify-draft" },
      { op: "submit-authorized-draft" },
      { op: "verify-send" },
      { op: "close" },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.responses).toEqual([
      { ok: true, result: { control: null, checkpointReady: true } },
      { ok: true, result: {
        replyDecision: {
          action: "reply-latest-incoming",
          triggerMessageId: "incoming-id",
          reason: "LATEST_VISIBLE_INCOMING",
        },
      } },
      { ok: true, result: { prepared: true, conversationId: "example-contact" } },
      { ok: true, result: { draftVerified: true, conversationId: "example-contact" } },
      { ok: true, result: { submitted: true, conversationId: "example-contact" } },
      { ok: true, result: { status: "verified", conversationId: "example-contact" } },
      { ok: true, result: { closed: true } },
    ]);
    const serialized = JSON.stringify(result.responses);
    expect(serialized).not.toContain("CONTROL_CANARY");
    expect(serialized).not.toContain("TRIGGER_CANARY");
    expect(serialized).not.toContain("CANDIDATE_CANARY");
    expect(serialized).not.toContain("SUBMIT_CANARY");
  });

  it("accepts a strict zero-field boundary establishment and strips marker material", async () => {
    const result = await runLines(fakeDependencies(), [
      { op: "establish-control-boundary" },
      { op: "establish-control-boundary" },
      { op: "close" },
    ]);

    expect(result.responses.slice(0, 2)).toEqual([
      { ok: true, result: activeBoundaryProof() },
      { ok: true, result: activeBoundaryProof() },
    ]);
    expect(JSON.stringify(result.responses)).not.toContain("聊天助手控制边界");
    expect(JSON.stringify(result.responses)).not.toContain("NONCE_CANARY");
  });

  it.each([
    { name: "boundary extra field", value: { op: "establish-control-boundary", extra: true } },
    { name: "control extra field", value: { op: "read-control", text: "secret" } },
    { name: "target extra field", value: { op: "read-target", trigger: "secret" } },
    { name: "empty text", value: { op: "prepare-latest-reply", text: "" } },
    { name: "blank text", value: { op: "prepare-latest-reply", text: "   " } },
    { name: "overlong text", value: { op: "prepare-latest-reply", text: "x".repeat(501) } },
    { name: "line feed", value: { op: "prepare-latest-reply", text: "one\ntwo" } },
    { name: "candidate token", value: { op: "verify-draft", candidateToken: "a".repeat(64) } },
    { name: "conversation input", value: { op: "read-control", conversationId: "file-transfer" } },
    { name: "generic read", value: { op: "read", conversationId: "example-contact" } },
    { name: "generic prepare", value: { op: "prepare", conversationId: "file-transfer", text: "x" } },
    { name: "computer use type", value: { op: "type", text: "secret" } },
    { name: "computer use return", value: { op: "return" } },
    { name: "submit capability", value: { op: "submit" } },
    { name: "coordinate capability", value: { op: "ui", x: 1, y: 2 } },
  ])("rejects $name without invoking runtime operations", async ({ value }) => {
    const { dependencies, spies } = spiedDependencies();
    const result = await runLines(dependencies, [value, { op: "close" }]);

    expect(result.responses).toEqual([
      { ok: false, error: "INVALID_REQUEST" },
      { ok: true, result: { closed: true } },
    ]);
    expectRuntimeUntouched(spies);
  });

  it("maps out-of-order and secret runtime errors to one fixed response", async () => {
    const secret = "PRIVATE_INTERNAL_CAPABILITY";
    const dependencies = fakeDependencies({
      readControlForSupervisor: () => Promise.reject(new Error(secret)),
    });
    const result = await runLines(dependencies, [
      { op: "read-control" },
      { op: "close" },
    ]);

    expect(result.responses).toEqual([
      { ok: false, error: "LIVE_BRIDGE_OPERATION_FAILED" },
      { ok: true, result: { closed: true } },
    ]);
    expect(JSON.stringify(result.responses)).not.toContain(secret);
  });

  it("rejects argv input before runtime construction and never echoes it", async () => {
    const input = new PassThrough();
    input.end();
    const output = new PassThrough();
    const createRuntime = vi.fn();

    await expect(runLiveCliBridgeProcess({
      arguments: ["--text", "ARGV_SECRET"],
      createRuntime,
      input,
      output,
      signals: new EventEmitter(),
    })).resolves.toBe(1);

    expect(readOutput(output)).toBe('{"ok":false,"error":"LIVE_BRIDGE_STDIN_ONLY"}\n');
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("closes the runtime exactly once on EOF and invalidates the session", async () => {
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
    await waitForOutput(output);
    expect(parseResponse(readOutput(output).trim())).toEqual({
      ok: true,
      type: "ready",
      protocolVersion: 2,
      active: true,
    });

    input.end();

    await expect(running).resolves.toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(readOutput(output)).toBe("");
  });
});

async function runLines(
  dependencies: LiveWechatRuntimeDependencies,
  commands: unknown[],
): Promise<{ exitCode: number; startup: unknown; responses: unknown[] }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const running = runLiveCliBridgeProcess({
    arguments: [],
    createRuntime: () => Promise.resolve({ dependencies, close: () => Promise.resolve() }),
    input,
    output,
    signals: new EventEmitter(),
  });
  await waitForOutput(output);
  const startup = parseResponse(readOutput(output).trim());
  input.end(commands.map((command) => JSON.stringify(command)).join("\n") + "\n");
  const exitCode = await running;
  return {
    exitCode,
    startup,
    responses: readOutput(output).trimEnd().split("\n").filter(Boolean).map(parseResponse),
  };
}

function fakeDependencies(
  overrides: Partial<LiveWechatRuntimeDependencies> = {},
): LiveWechatRuntimeDependencies {
  return {
    getLiveState: () => Promise.resolve({ connected: true }),
    readConversation: () => Promise.resolve({}),
    prepareDraft: () => Promise.resolve({ candidateToken: "legacy", prepared: true }),
    verifyDraft: () => Promise.resolve({ draftVerified: true, conversationId: "example-contact" }),
    abortDraft: () => Promise.resolve({ aborted: true, conversationId: "example-contact" }),
    abortPreparedDraftForSupervisor: () => Promise.resolve({
      aborted: true,
      conversationId: "example-contact",
    }),
    verifySend: () => Promise.resolve({ status: "verified", conversationId: "example-contact" }),
    readTargetConversationForAdvice: () => Promise.resolve({}),
    establishControlBoundaryForSupervisor: () => Promise.resolve({
      ...activeBoundaryProof(),
      markerText: "聊天助手控制边界 NONCE_CANARY",
      nonce: "NONCE_CANARY",
    }),
    readControlForSupervisor: () => Promise.resolve({
      publicResult: { control: null, checkpointReady: true },
      proof: { capability: "CONTROL_CANARY" },
    }),
    readTargetForSupervisor: () => Promise.resolve({
      publicResult: {
        replyDecision: {
          action: "reply-latest-incoming",
          triggerMessageId: "incoming-id",
          reason: "LATEST_VISIBLE_INCOMING",
        },
      },
      proof: { capability: "TRIGGER_CANARY" },
    }),
    prepareLatestReplyForSupervisor: () => Promise.resolve({
      candidateToken: "CANDIDATE_CANARY",
      submitProof: "SUBMIT_CANARY",
      prepared: true,
      conversationId: "example-contact",
    }),
    submitAuthorizedDraftForSupervisor: () => Promise.resolve({
      submitted: true,
      conversationId: "example-contact",
    }),
    ...overrides,
  } as LiveWechatRuntimeDependencies;
}

function spiedDependencies() {
  const spies = {
    establishControlBoundaryForSupervisor: vi.fn(),
    readControlForSupervisor: vi.fn(),
    readTargetForSupervisor: vi.fn(),
    prepareLatestReplyForSupervisor: vi.fn(),
    submitAuthorizedDraftForSupervisor: vi.fn(),
    verifyDraft: vi.fn(),
    abortDraft: vi.fn(),
    abortPreparedDraftForSupervisor: vi.fn(),
    verifySend: vi.fn(),
  };
  return { dependencies: fakeDependencies(spies), spies };
}

function expectRuntimeUntouched(
  spies: ReturnType<typeof spiedDependencies>["spies"],
): void {
  for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
}

function activeBoundaryProof() {
  return {
    status: "active",
    epoch: "e".repeat(64),
    boundaryMessageId: "b".repeat(64),
    consumedCount: 0,
    prefixChainHash: "p".repeat(64),
    markerOccurrenceCount: 1,
  };
}

function parseResponse(serialized: string): unknown {
  return JSON.parse(serialized) as unknown;
}

function readOutput(output: PassThrough): string {
  const chunk: unknown = output.read();
  if (chunk === null) return "";
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (typeof chunk === "string") return chunk;
  throw new Error("UNEXPECTED_OUTPUT_CHUNK");
}

async function waitForOutput(output: PassThrough): Promise<void> {
  const deadline = Date.now() + 500;
  while (output.readableLength === 0) {
    if (Date.now() >= deadline) throw new Error("OUTPUT_DEADLINE_EXCEEDED");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
