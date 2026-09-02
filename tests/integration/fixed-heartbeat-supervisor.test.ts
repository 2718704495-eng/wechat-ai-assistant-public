import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFixedHeartbeatSupervisor,
  type FixedHeartbeatRuntimeFactories,
} from "../../src/mcp/fixed-heartbeat-supervisor.js";
import type { LiveWechatRuntimeDependencies } from "../../src/mcp/live-server.js";
import type { DailyCareProductionRuntimeDependencies } from "../../src/mcp/daily-care-session.js";
import type { OperationQuarantineRepository } from
  "../../src/runtime-v2/operation-quarantine.js";
import { SingleDispatcherAdmission } from
  "../../src/runtime-v2/single-dispatcher-admission.js";

const expectedTools = [
  "abort-draft",
  "begin-scheduled-tick",
  "close",
  "prepare-broadcast",
  "prepare-latest-reply",
  "research-morning-weather",
  "show-comfort-station",
  "submit-authorized-broadcast",
  "submit-authorized-draft",
  "verify-draft",
  "verify-send",
];
const cleanups: Array<() => Promise<void>> = [];

describe("fixed heartbeat supervisor", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("lists one combined strict surface without acquiring either live runtime", async () => {
    const harness = await createHarness();
    const listedTools = (await harness.client.listTools()).tools;

    expect(listedTools.map(({ name }) => name).sort())
      .toEqual(expectedTools);
    const prepareReply = listedTools.find(({ name }) => name === "prepare-latest-reply");
    expect(Object.keys(prepareReply?.inputSchema.properties ?? {})).toEqual(["text"]);
    expect(JSON.stringify(prepareReply?.inputSchema)).not.toContain("target");
    expect(JSON.stringify(prepareReply?.inputSchema)).not.toContain("conversationId");
    expect(harness.factories.createPassive).not.toHaveBeenCalled();
    expect(harness.factories.createDailyCare).not.toHaveBeenCalled();

    const rejected = await harness.client.callTool({
      name: "begin-scheduled-tick",
      arguments: { target: "示例联系人" },
    });
    expect(rejected.isError).toBe(true);
    expect(harness.factories.createDailyCare).not.toHaveBeenCalled();
    const strictRead = await harness.client.callTool({
      name: "begin-scheduled-tick",
      arguments: { conversationId: "file-transfer" },
    });
    expect(strictRead.isError).toBe(true);
    expect(harness.factories.createPassive).not.toHaveBeenCalled();
  });

  it("returns a stable outside receipt without opening a cycle or runtime", async () => {
    const harness = await createHarness({ lanes: ["outside", "outside"] });

    const first = await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    expect(first.isError).not.toBe(true);
    expect(parseMcpTextResult(first)).toEqual({
      lane: "outside",
      status: "outside-window",
    });
    expect(harness.factories.createPassive).not.toHaveBeenCalled();
    expect(harness.factories.createDailyCare).not.toHaveBeenCalled();

    expect((await harness.client.callTool({ name: "close", arguments: {} })).isError)
      .not.toBe(true);
    const second = await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    expect(second.isError).not.toBe(true);
    expect(harness.factories.createPassive).not.toHaveBeenCalled();
    expect(harness.factories.createDailyCare).not.toHaveBeenCalled();
  });

  it("checks durable quarantine before realtime recovery and lane selection", async () => {
    const order: string[] = [];
    const quarantineRepository = quarantineRepositoryFixture();
    quarantineRepository.assertClear.mockImplementation(() => {
      order.push("quarantine");
      return Promise.resolve();
    });
    const recoverRealtimePending = vi.fn().mockImplementation(() => {
      order.push("recover");
      return Promise.resolve([]);
    });
    const selectScheduledLane = vi.fn().mockImplementation(() => {
      order.push("select");
      return Promise.resolve("outside" as const);
    });
    const harness = await createHarness({
      recoverRealtimePending,
      selectScheduledLane,
      quarantineRepository,
    });

    await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });

    expect(order).toEqual(["quarantine", "recover", "select"]);
  });

  it("uses an injected admission shared with the realtime producer", async () => {
    const realtimeOwner = { close: vi.fn().mockResolvedValue({ gateReleased: true }) };
    const shared = new SingleDispatcherAdmission({
      acquireOwner: vi.fn().mockResolvedValue(realtimeOwner),
    });
    const realtime = await shared.admit("p1");
    const runtime = passiveRuntime();
    const harness = await createHarness({ passive: [runtime], dispatcherAdmission: shared });

    const busy = await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    expect(busy.isError).toBe(true);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    await realtime.close();
  });

  it("blocks even an outside decision before recovery when durable quarantine exists", async () => {
    const quarantineRepository = quarantineRepositoryFixture();
    quarantineRepository.assertClear.mockRejectedValue(
      new Error("FIXED_HEARTBEAT_DURABLE_QUARANTINE"),
    );
    const harness = await createHarness({
      lanes: ["outside"],
      quarantineRepository,
    });

    const result = await harness.client.callTool({
      name: "begin-scheduled-tick",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(quarantineRepository.assertClear).toHaveBeenCalledTimes(1);
    expect(harness.factories.createPassive).not.toHaveBeenCalled();
    expect(harness.factories.createDailyCare).not.toHaveBeenCalled();
  });

  it("settles and quarantines a late decision when runtime close fails", async () => {
    vi.useFakeTimers();
    let resolveDecision: ((decision: Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>) => void) | undefined;
    const runtime = passiveRuntime();
    runtime.close.mockRejectedValueOnce(new Error("LATE_RUNTIME_CLOSE_FAILED"));
    const complete = vi.fn().mockResolvedValue(undefined);
    const quarantineRepository = quarantineRepositoryFixture();
    const decision = new Promise<Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>>((resolve) => { resolveDecision = resolve; });
    const harness = await createHarness({
      cycleTimeoutMs: 10_000,
      quarantineRepository,
      beginScheduledTick: vi.fn(() => decision),
    });

    const pending = harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).isError).toBe(true);
    resolveDecision?.({
      lane: "p1",
      runtime,
      cycleId: "22222222-2222-4222-8222-222222222222",
      complete,
    });

    await expect(harness.supervisor.shutdown())
      .rejects.toThrow("FIXED_HEARTBEAT_LATE_DECISION_CLEANUP_FAILED");
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ success: false });
    expect(quarantineRepository.quarantine).toHaveBeenCalledTimes(1);
    expect(quarantineRepository.quarantine).toHaveBeenCalledWith(expect.objectContaining({
      lane: "p1",
      cycleId: "22222222-2222-4222-8222-222222222222",
      reason: "OWNER_RELEASE_UNPROVEN",
      outcomeCause: "OWNER_RELEASE_UNPROVEN",
    }));
  });

  it("waits for and settles a decision when shutdown starts before its timeout", async () => {
    vi.useFakeTimers();
    let resolveDecision: ((decision: Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>) => void) | undefined;
    const runtime = passiveRuntime();
    const complete = vi.fn().mockResolvedValue(undefined);
    const quarantineRepository = quarantineRepositoryFixture();
    const decision = new Promise<Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>>((resolve) => { resolveDecision = resolve; });
    const beginScheduledTick = vi.fn(() => decision);
    const harness = await createHarness({
      cycleTimeoutMs: 10_000,
      quarantineRepository,
      beginScheduledTick,
    });

    const pending = harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    await vi.waitFor(() => expect(beginScheduledTick).toHaveBeenCalledTimes(1));
    let shutdownSettled = false;
    const shutdown = harness.supervisor.shutdown().then(() => { shutdownSettled = true; });
    await Promise.resolve();
    const settledBeforeDecision = shutdownSettled;
    resolveDecision?.({
      lane: "p1",
      runtime,
      cycleId: "33333333-3333-4333-8333-333333333333",
      complete,
    });

    await shutdown;
    const pendingResult = await pending;
    expect(settledBeforeDecision).toBe(false);
    expect(pendingResult.isError).toBe(true);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ success: false });
    expect(quarantineRepository.quarantine).not.toHaveBeenCalled();
  });

  it("surfaces and quarantines cleanup failure when shutdown starts before timeout", async () => {
    vi.useFakeTimers();
    let resolveDecision: ((decision: Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>) => void) | undefined;
    const runtime = passiveRuntime();
    runtime.close.mockRejectedValueOnce(new Error("LATE_RUNTIME_CLOSE_FAILED"));
    const complete = vi.fn().mockResolvedValue(undefined);
    const quarantineRepository = quarantineRepositoryFixture();
    const decision = new Promise<Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>>((resolve) => { resolveDecision = resolve; });
    const beginScheduledTick = vi.fn(() => decision);
    const harness = await createHarness({
      cycleTimeoutMs: 10_000,
      quarantineRepository,
      beginScheduledTick,
    });

    const pending = harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    await vi.waitFor(() => expect(beginScheduledTick).toHaveBeenCalledTimes(1));
    const shutdown = harness.supervisor.shutdown();
    resolveDecision?.({
      lane: "p1",
      runtime,
      cycleId: "44444444-4444-4444-8444-444444444444",
      complete,
    });

    const shutdownError = await shutdown.catch((error: unknown) => error);
    const secondShutdownError = await harness.supervisor.shutdown()
      .catch((error: unknown) => error);
    const pendingResult = await pending;

    expect(shutdownError).toBeInstanceOf(AggregateError);
    expect((shutdownError as Error).message)
      .toBe("FIXED_HEARTBEAT_LATE_DECISION_CLEANUP_FAILED");
    expect(secondShutdownError).toBe(shutdownError);
    expect(pendingResult.isError).toBe(true);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ success: false });
    expect(quarantineRepository.quarantine).toHaveBeenCalledTimes(1);
    expect(quarantineRepository.quarantine).toHaveBeenCalledWith(expect.objectContaining({
      lane: "p1",
      cycleId: "44444444-4444-4444-8444-444444444444",
      reason: "OWNER_RELEASE_UNPROVEN",
    }));
  });

  it("keeps outside readable but blocks new non-outside admission after shutdown", async () => {
    const selectScheduledLane = vi.fn()
      .mockResolvedValueOnce("outside" as const)
      .mockResolvedValueOnce("p1" as const);
    const beginScheduledTick = vi.fn<FixedHeartbeatRuntimeFactories["beginScheduledTick"]>();
    const quarantineRepository = quarantineRepositoryFixture();
    const harness = await createHarness({
      selectScheduledLane,
      beginScheduledTick,
      quarantineRepository,
    });
    await harness.supervisor.shutdown();

    const outside = await harness.client.callTool({
      name: "begin-scheduled-tick",
      arguments: {},
    });
    const blocked = await harness.client.callTool({
      name: "begin-scheduled-tick",
      arguments: {},
    });

    expect(outside.isError).not.toBe(true);
    expect(parseMcpTextResult(outside)).toEqual({
      lane: "outside",
      status: "outside-window",
    });
    expect(blocked.isError).toBe(true);
    expect(beginScheduledTick).not.toHaveBeenCalled();
    expect(quarantineRepository.assertClear).toHaveBeenCalledTimes(2);
  });

  it("releases and recreates a passive runtime for two cycles in the same task", async () => {
    const first = passiveRuntime();
    const second = passiveRuntime();
    const harness = await createHarness({ passive: [first, second] });

    expect((await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .not.toBe(true);
    expect((await harness.client.callTool({ name: "close", arguments: {} })).isError)
      .not.toBe(true);
    expect(first.close).toHaveBeenCalledTimes(1);

    expect((await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .not.toBe(true);
    await harness.client.callTool({ name: "close", arguments: {} });

    expect(harness.factories.createPassive).toHaveBeenCalledTimes(2);
    expect(first.dependencies.readTargetDirectForSupervisor).toHaveBeenCalledTimes(1);
    expect(second.dependencies.readTargetDirectForSupervisor).toHaveBeenCalledTimes(1);
    expect(first.dependencies.readControlForSupervisor).not.toHaveBeenCalled();
    expect(second.dependencies.readControlForSupervisor).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(harness.factories.createDailyCare).not.toHaveBeenCalled();
  });

  it("routes daily care lazily and rejects cross-mode operations within one cycle", async () => {
    const daily = dailyRuntime();
    const harness = await createHarness({ daily: [daily], lanes: ["p0"] });

    expect((await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .not.toBe(true);
    const crossMode = await harness.client.callTool({
      name: "prepare-latest-reply", arguments: { text: "收到" },
    });
    expect(crossMode.isError).toBe(true);
    expect(harness.factories.createPassive).not.toHaveBeenCalled();

    await harness.client.callTool({ name: "close", arguments: {} });
    expect(daily.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["DAILY_CARE_WEATHER_RETRYABLE", "SLOT_RETRYABLE"],
    ["DAILY_CARE_WEATHER_PERMANENT", "SLOT_TERMINAL"],
    ["DAILY_CARE_RETRY_LIMIT_EXHAUSTED", "SLOT_TERMINAL"],
    ["ENCRYPTED_STORE_BUSY", "RUNTIME_BUSY"],
    ["DAILY_CARE_OUTSIDE_PRODUCTION_WINDOW", "OUTSIDE_GRACE"],
    ["SYSTEM_STOPPED", "SYSTEM_STOPPED"],
  ])("keeps non-preparable weather states as bounded public errors for %s", async (
    privateCode,
    publicReason,
  ) => {
    const daily = dailyRuntime();
    daily.dependencies.researchMorningWeather = vi.fn().mockRejectedValue(new Error(privateCode));
    daily.dependencies.beginCurrentSlot = vi.fn().mockResolvedValue({
      kind: "morning", weatherRequired: true, skillId: "daily-care-message-writing",
      bodyLength: { minimum: 60, maximum: 120 }, signature: "——示例用户",
      maximumRegenerations: 2,
    });
    const harness = await createHarness({ daily: [daily], lanes: ["p0"] });
    await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });

    const result = await harness.client.callTool({
      name: "research-morning-weather",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("unavailable");
    expect(JSON.stringify(result)).toContain(publicReason);
    if (privateCode !== publicReason) {
      expect(JSON.stringify(result)).not.toContain(privateCode);
    }
    await harness.client.callTool({ name: "close", arguments: {} });
  });

  it("does not poison the next cycle when a runtime factory fails", async () => {
    const good = passiveRuntime();
    const createPassive = vi.fn<() => Promise<ReturnType<typeof passiveRuntime>>>()
      .mockRejectedValueOnce(new Error("PRIVATE_STARTUP_ERROR"))
      .mockResolvedValueOnce(good);
    const harness = await createHarness({ createPassive });

    const first = await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    expect(first.isError).toBe(true);
    expect(JSON.stringify(first)).not.toContain("PRIVATE_STARTUP_ERROR");

    const second = await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    expect(second.isError).not.toBe(true);
    await harness.client.callTool({ name: "close", arguments: {} });
    expect(good.close).toHaveBeenCalledTimes(1);
  });

  it("blocks the next heartbeat until a timed-out late decision is fully settled", async () => {
    vi.useFakeTimers();
    let resolveLate: ((decision: Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>) => void) | undefined;
    const late = passiveRuntime();
    const lateComplete = vi.fn().mockResolvedValue(undefined);
    const good = passiveRuntime();
    const goodComplete = vi.fn().mockResolvedValue(undefined);
    const delayedDecision = new Promise<Awaited<ReturnType<
      FixedHeartbeatRuntimeFactories["beginScheduledTick"]
    >>>((resolve) => { resolveLate = resolve; });
    const beginScheduledTick = vi.fn()
      .mockImplementationOnce(() => delayedDecision)
      .mockResolvedValueOnce({
        lane: "p1" as const,
        runtime: good,
        cycleId: "33333333-3333-4333-8333-333333333333",
        complete: goodComplete,
      });
    const harness = await createHarness({ beginScheduledTick, cycleTimeoutMs: 10_000 });

    const pending = harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).isError).toBe(true);

    expect((await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .toBe(true);
    expect(beginScheduledTick).toHaveBeenCalledTimes(1);
    resolveLate?.({
      lane: "p1",
      runtime: late,
      cycleId: "22222222-2222-4222-8222-222222222222",
      complete: lateComplete,
    });
    await vi.waitFor(() => expect(lateComplete).toHaveBeenCalledWith({ success: false }));
    expect(late.close).toHaveBeenCalledTimes(1);

    expect((await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .not.toBe(true);
    await harness.client.callTool({ name: "close", arguments: {} });
    expect(good.close).toHaveBeenCalledTimes(1);
  });

  it("times out a hung cycle, releases its runtime once, and permits a later cycle", async () => {
    vi.useFakeTimers();
    const hung = passiveRuntime();
    hung.dependencies.readTargetDirectForSupervisor = vi.fn<
      LiveWechatRuntimeDependencies["readTargetDirectForSupervisor"]
    >().mockImplementation(() => new Promise(() => undefined));
    const recovered = passiveRuntime();
    const harness = await createHarness({ passive: [hung, recovered], cycleTimeoutMs: 10_000 });

    const pending = harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).isError).toBe(true);
    await vi.waitFor(() => expect(hung.close).toHaveBeenCalledTimes(1));

    expect((await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .toBe(true);
    expect(recovered.close).not.toHaveBeenCalled();
  });

  it("transport shutdown releases an active runtime exactly once", async () => {
    const active = passiveRuntime();
    const harness = await createHarness({ passive: [active] });
    await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });

    await harness.supervisor.shutdown();
    await harness.supervisor.shutdown();

    expect(active.close).toHaveBeenCalledTimes(1);
  });

  it("quarantines the dispatcher when runtime close cannot prove gate release", async () => {
    const unsafe = passiveRuntime();
    unsafe.close.mockRejectedValueOnce(new Error("LIVE_CLOSE_FAILED"));
    const neverStarted = passiveRuntime();
    const harness = await createHarness({ passive: [unsafe, neverStarted] });
    await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });

    expect((await harness.client.callTool({ name: "close", arguments: {} })).isError).toBe(true);
    expect((await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} })).isError)
      .toBe(true);
    expect(harness.factories.createPassive).toHaveBeenCalledTimes(1);
    expect(neverStarted.close).not.toHaveBeenCalled();
  });

  it("completes one latest-incoming reply with one direct target read and zero control reads", async () => {
    const passive = passiveRuntime();
    const harness = await createHarness({ passive: [passive] });

    for (const name of [
      "begin-scheduled-tick",
      "prepare-latest-reply",
      "verify-draft",
      "submit-authorized-draft",
      "verify-send",
      "close",
    ]) {
      const arguments_ = name === "prepare-latest-reply" ? { text: "收到啦" } : {};
      expect((await harness.client.callTool({ name, arguments: arguments_ })).isError)
        .not.toBe(true);
    }

    expect(passive.dependencies.readTargetDirectForSupervisor).toHaveBeenCalledTimes(1);
    expect(passive.dependencies.readControlForSupervisor).not.toHaveBeenCalled();
    expect(passive.dependencies.prepareLatestReplyForSupervisor).toHaveBeenCalledTimes(1);
    expect(passive.dependencies.verifyDraft).toHaveBeenCalledTimes(1);
    expect(passive.dependencies.submitAuthorizedDraftForSupervisor).toHaveBeenCalledTimes(1);
    expect(passive.dependencies.verifySend).toHaveBeenCalledTimes(1);
    expect(passive.close).toHaveBeenCalledTimes(1);
  });

  it("routes one exact comfort-station wake through the image tool with no text fallback", async () => {
    const passive = passiveRuntime();
    passive.dependencies.readTargetDirectForSupervisor.mockResolvedValueOnce({
      publicResult: {
        replyDecision: { action: "reply-latest-incoming" },
        comfortStation: { requested: true },
      },
      controlProof: {
        capability: "control",
        checkpoint: controlCheckpoint(),
        verification: "persistent-stop-gate",
        gateRevision: "g".repeat(64),
      },
      proof: {
        capability: "target",
        trigger: targetTrigger(),
        comfortStationRequested: true,
      },
    });
    const harness = await createHarness({ passive: [passive] });

    const begin = await harness.client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    expect(parseMcpTextResult(begin)).toMatchObject({
      lane: "p1",
      result: { comfortStation: { requested: true } },
    });
    expect((await harness.client.callTool({
      name: "show-comfort-station",
      arguments: {},
    })).isError).not.toBe(true);
    expect((await harness.client.callTool({ name: "close", arguments: {} })).isError)
      .not.toBe(true);

    expect(passive.dependencies.showComfortStationCardForSupervisor).toHaveBeenCalledTimes(1);
    expect(passive.dependencies.prepareLatestReplyForSupervisor).not.toHaveBeenCalled();
    expect(passive.dependencies.submitAuthorizedDraftForSupervisor).not.toHaveBeenCalled();
  });
});

function parseMcpTextResult(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP_RESULT_INVALID");
  }
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content) || content.length !== 1) throw new Error("MCP_RESULT_INVALID");
  const block: unknown = content[0];
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("MCP_RESULT_INVALID");
  }
  const record = block as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") {
    throw new Error("MCP_TEXT_RESULT_EXPECTED");
  }
  return JSON.parse(record.text) as unknown;
}

async function createHarness(options: {
  passive?: ReturnType<typeof passiveRuntime>[];
  daily?: ReturnType<typeof dailyRuntime>[];
  createPassive?: () => Promise<ReturnType<typeof passiveRuntime>>;
  lanes?: Array<"p0" | "p1" | "outside">;
  cycleTimeoutMs?: number;
  beginScheduledTick?: FixedHeartbeatRuntimeFactories["beginScheduledTick"];
  selectScheduledLane?: FixedHeartbeatRuntimeFactories["selectScheduledLane"];
  quarantineRepository?: OperationQuarantineRepository;
  recoverRealtimePending?: () => Promise<readonly unknown[]>;
  dispatcherAdmission?: SingleDispatcherAdmission;
} = {}) {
  const passive = [...(options.passive ?? [passiveRuntime()])];
  const daily = [...(options.daily ?? [dailyRuntime()])];
  const createPassive = options.createPassive ?? vi.fn(() => {
      const runtime = passive.shift();
      if (runtime === undefined) throw new Error("NO_PASSIVE_FIXTURE");
      return Promise.resolve(runtime);
    });
  const createDailyCare = vi.fn(() => {
      const runtime = daily.shift();
      if (runtime === undefined) throw new Error("NO_DAILY_FIXTURE");
      return Promise.resolve(runtime);
    });
  const lanes = [...(options.lanes ?? Array.from({ length: 12 }, () => "p1" as const))];
  const defaultBeginScheduledTick = vi.fn(async () => {
      const lane = lanes.shift();
      if (lane === undefined) throw new Error("NO_SCHEDULED_LANE_FIXTURE");
      const decision = {
        cycleId: "11111111-1111-4111-8111-111111111111",
        complete: vi.fn().mockResolvedValue(undefined),
      };
      if (lane === "outside") {
        return { lane: "outside" as const, status: "outside-window" as const };
      }
      return lane === "p0"
        ? { lane: "p0" as const, runtime: await createDailyCare(), ...decision }
        : { lane: "p1" as const, runtime: await createPassive(), ...decision };
    });
  const factories = {
    selectScheduledLane: options.selectScheduledLane ?? vi.fn(() => Promise.resolve(
      lanes[0] ?? "p1",
    )),
    beginScheduledTick: options.beginScheduledTick ?? defaultBeginScheduledTick,
    recoverRealtimePending: options.recoverRealtimePending,
    createPassive,
    createDailyCare,
  };
  const supervisor = createFixedHeartbeatSupervisor({
    recoverRealtimePending: factories.recoverRealtimePending,
    selectScheduledLane: factories.selectScheduledLane,
    beginScheduledTick: factories.beginScheduledTick,
  }, {
    cycleTimeoutMs: options.cycleTimeoutMs,
    quarantineRepository: options.quarantineRepository,
    dispatcherGate:
      options.dispatcherAdmission === undefined
        ? undefined
        : cycleGateFor(options.dispatcherAdmission),
  });
  const client = new Client({ name: "fixed-heartbeat-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([supervisor.server.connect(serverTransport), client.connect(clientTransport)]);
  const cleanup = async () => {
    await supervisor.shutdown().catch(() => undefined);
    await Promise.allSettled([client.close(), supervisor.server.close()]);
  };
  cleanups.push(cleanup);
  return { client, factories, supervisor };
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

function quarantineRepositoryFixture() {
  return {
    assertClear: vi.fn().mockResolvedValue(undefined),
    beginTerminalBarrier: vi.fn().mockResolvedValue(undefined),
    clearTerminalBarrier: vi.fn().mockResolvedValue(undefined),
    quarantine: vi.fn().mockResolvedValue(undefined),
  } satisfies OperationQuarantineRepository;
}

function passiveRuntime() {
  return {
    dependencies: fakePassiveDependencies(),
    close: vi.fn(() => Promise.resolve()),
  };
}

function dailyRuntime() {
  return {
    dependencies: fakeDailyDependencies(),
    close: vi.fn(() => Promise.resolve()),
  };
}

function fakePassiveDependencies() {
  return {
    establishControlBoundaryForSupervisor: vi.fn().mockResolvedValue({
      status: "active", epoch: "e".repeat(64), boundaryMessageId: "b".repeat(64),
      consumedCount: 0, prefixChainHash: "p".repeat(64), markerOccurrenceCount: 1,
    }),
    readControlForSupervisor: vi.fn().mockResolvedValue({
      publicResult: { control: null, checkpointReady: true },
      proof: {
        capability: "control",
        checkpoint: controlCheckpoint(),
        verification: "ui-observed",
        gateRevision: "g".repeat(64),
      },
    }),
    readTargetDirectForSupervisor: vi.fn().mockResolvedValue({
      publicResult: { replyDecision: { action: "reply-latest-incoming" } },
      controlProof: {
        capability: "control",
        checkpoint: controlCheckpoint(),
        verification: "persistent-stop-gate",
        gateRevision: "g".repeat(64),
      },
      proof: {
        capability: "target",
        trigger: targetTrigger(),
        comfortStationRequested: false,
      },
    }),
    readTargetForSupervisor: vi.fn().mockResolvedValue({
      publicResult: { replyDecision: { action: "wait" } },
      proof: {
        capability: "target",
        trigger: targetTrigger(),
        comfortStationRequested: false,
      },
    }),
    prepareLatestReplyForSupervisor: vi.fn().mockResolvedValue({
      candidateToken: "c".repeat(64), prepared: true, conversationId: "example-contact",
    }),
    showComfortStationCardForSupervisor: vi.fn().mockResolvedValue({
      status: "verified", conversationId: "example-contact",
    }),
    verifyDraft: vi.fn().mockResolvedValue({ conversationId: "example-contact" }),
    submitAuthorizedDraftForSupervisor: vi.fn().mockResolvedValue({
      submitted: true, conversationId: "example-contact",
    }),
    abortPreparedDraftForSupervisor: vi.fn(),
    abortDraft: vi.fn(),
    verifySend: vi.fn().mockResolvedValue({ status: "verified", conversationId: "example-contact" }),
    getLiveState: vi.fn(), prepareDraft: vi.fn(),
    readConversation: vi.fn(), readTargetConversationForAdvice: vi.fn(),
  } satisfies LiveWechatRuntimeDependencies;
}

function controlCheckpoint() {
  return {
    epoch: "e".repeat(64),
    boundaryMessageId: "b".repeat(64),
    consumedCount: 0,
    prefixChainHash: "p".repeat(64),
  };
}

function targetTrigger() {
  return {
    triggerId: "t".repeat(64),
    baselineEpoch: "a".repeat(64),
    orderedSequenceHash: "o".repeat(64),
    triggerMessageId: "incoming-id",
    controlCheckpoint: controlCheckpoint(),
    gateRevision: "g".repeat(64),
    createdAt: "2026-08-24T00:00:00.000Z",
  };
}

function fakeDailyDependencies(): DailyCareProductionRuntimeDependencies {
  return {
    beginCurrentSlot: vi.fn().mockResolvedValue({
      kind: "night", weatherRequired: false, skillId: "daily-care-message-writing",
      bodyLength: { minimum: 120, maximum: 220 }, signature: "——示例用户",
      maximumRegenerations: 2,
    }),
    researchMorningWeather: vi.fn(), prepareBroadcast: vi.fn(), verifyDraft: vi.fn(),
    submitAuthorizedBroadcast: vi.fn(), verifySend: vi.fn(), abortDraft: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
  };
}
