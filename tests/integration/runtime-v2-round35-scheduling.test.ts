import { describe, expect, it, vi } from "vitest";

import type { DailyCareSlot } from "../../src/daily-care/types.js";
import { resolveProductionSlot } from "../../src/daily-care/schedule.js";
import {
  InMemorySingleSchedulerStateRepository,
  selectScheduledLane,
  SingleScheduler,
  type P0SlotInspection,
} from "../../src/runtime-v2/single-scheduler.js";

describe("Round35 unified P0/P1 schedule", () => {
  it("uses one pure selector with P0 priority and an all-day P1 fallback", () => {
    expect(selectScheduledLane(new Date("2026-08-28T16:00:00.000Z"), null)).toBe("p1");
    expect(selectScheduledLane(new Date("2026-08-28T22:00:00.000Z"), null)).toBe("p1");
    expect(selectScheduledLane(
      new Date("2026-08-28T22:30:00.000Z"),
      { status: "pending" },
    )).toBe("p0");
    expect(selectScheduledLane(
      new Date("2026-08-28T22:30:00.000Z"),
      { status: "verified" },
    )).toBe("p1");
  });

  it("assigns all 144 Shanghai ten-minute buckets with two P0 starts and 142 P1 fallbacks", () => {
    const start = new Date("2026-09-01T00:00:00+08:00");
    const completedKinds = new Set<DailyCareSlot["kind"]>();
    const lanes: Array<"p0" | "p1" | "outside"> = [];

    for (let bucket = 0; bucket < 144; bucket += 1) {
      const now = new Date(start.getTime() + bucket * 10 * 60 * 1_000);
      const slot = resolveProductionSlot(now);
      const inspection = slot === null
        ? null
        : { status: completedKinds.has(slot.kind) ? "verified" as const : "pending" as const };
      const lane = selectScheduledLane(now, inspection);
      lanes.push(lane);
      if (lane === "p0" && slot !== null) completedKinds.add(slot.kind);
    }

    expect(lanes.filter((lane) => lane === "p0")).toHaveLength(2);
    expect(lanes.filter((lane) => lane === "p1")).toHaveLength(142);
    expect(lanes).not.toContain("outside");
    expect(completedKinds).toEqual(new Set(["morning", "night"]));
  });

  it.each([
    ["00:00", "2026-08-28T16:00:00.000Z"],
    ["05:59", "2026-08-28T21:59:59.000Z"],
    ["07:00", "2026-08-28T23:00:00.000Z"],
    ["21:59", "2026-08-29T13:59:59.000Z"],
  ])("admits P1 at Shanghai %s", async (_label, instant) => {
    const createPassive = vi.fn().mockResolvedValue({ mode: "passive" });
    const createDailyCare = vi.fn().mockResolvedValue({ mode: "daily-care" });
    const scheduler = createScheduler();

    const decision = await scheduler.beginScheduledTick(new Date(instant), {
      createPassive,
      createDailyCare,
    });

    expect(decision).toMatchObject({ lane: "p1", runtime: { mode: "passive" } });
    expect(createPassive).toHaveBeenCalledTimes(1);
    expect(createDailyCare).not.toHaveBeenCalled();
    if (decision.lane === "p1") await decision.complete({ success: true });
  });

  it.each([
    ["06:00", "2026-08-28T22:00:00.000Z"],
    ["06:29", "2026-08-28T22:29:59.999Z"],
    ["22:30", "2026-08-29T14:30:00.000Z"],
    ["23:59", "2026-08-29T15:59:59.999Z"],
  ])("admits P1 during the former quiet window at Shanghai %s", async (
    _label,
    instant,
  ) => {
    const state = new InMemorySingleSchedulerStateRepository();
    const inspectP0Slot = vi.fn<() => Promise<P0SlotInspection | null>>()
      .mockResolvedValue(null);
    const createPassive = vi.fn().mockResolvedValue({ mode: "passive" });
    const createDailyCare = vi.fn().mockResolvedValue({ mode: "daily-care" });
    const scheduler = createScheduler({ state, inspectP0Slot });

    const decision = await scheduler.beginScheduledTick(new Date(instant), {
      createPassive,
      createDailyCare,
    });

    expect(inspectP0Slot).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ lane: "p1", runtime: { mode: "passive" } });
    expect(createPassive).toHaveBeenCalledTimes(1);
    expect(createDailyCare).not.toHaveBeenCalled();
    if (decision.lane === "p1") await decision.complete({ success: true });
  });

  it.each([
    ["morning", "2026-08-28T22:30:00.000Z"],
    ["night", "2026-08-29T14:00:00.000Z"],
  ])("gives pending %s P0 strict priority", async (kind, instant) => {
    const createPassive = vi.fn().mockResolvedValue({ mode: "passive" });
    const createDailyCare = vi.fn().mockResolvedValue({ mode: "daily-care" });
    const scheduler = createScheduler({
      inspectP0Slot: vi.fn().mockResolvedValue({ status: "pending" }),
    });

    const decision = await scheduler.beginScheduledTick(new Date(instant), {
      createPassive,
      createDailyCare,
    });

    expect(decision).toMatchObject({ lane: "p0", runtime: { mode: "daily-care" } });
    expect(createPassive).not.toHaveBeenCalled();
    expect(createDailyCare).toHaveBeenCalledTimes(1);
    expect(kind).toMatch(/morning|night/u);
    if (decision.lane === "p0") await decision.complete({ success: true });
  });

  it.each([
    ["06:40", "2026-08-28T22:40:00.000Z"],
    ["06:59", "2026-08-28T22:59:59.999Z"],
    ["22:10", "2026-08-29T14:10:00.000Z"],
    ["22:29", "2026-08-29T14:29:59.999Z"],
  ])("falls back to P1 after terminal P0 at Shanghai %s", async (
    _label,
    instant,
  ) => {
    const state = new InMemorySingleSchedulerStateRepository();
    const createPassive = vi.fn().mockResolvedValue({ mode: "passive" });
    const createDailyCare = vi.fn().mockResolvedValue({ mode: "daily-care" });
    const scheduler = createScheduler({
      state,
      inspectP0Slot: vi.fn().mockResolvedValue({ status: "verified" }),
    });

    const decision = await scheduler.beginScheduledTick(new Date(instant), {
      createPassive,
      createDailyCare,
    });

    expect(decision).toMatchObject({ lane: "p1", runtime: { mode: "passive" } });
    expect(createPassive).toHaveBeenCalledTimes(1);
    expect(createDailyCare).not.toHaveBeenCalled();
    if (decision.lane === "p1") await decision.complete({ success: true });
  });

  it("admits one runtime for concurrent wakes in the same P1 bucket", async () => {
    const state = new InMemorySingleSchedulerStateRepository();
    const createPassive = vi.fn().mockResolvedValue({ mode: "passive" });
    const createDailyCare = vi.fn().mockResolvedValue({ mode: "daily-care" });
    const scheduler = createScheduler({ state });

    const results = await Promise.allSettled([
      scheduler.beginScheduledTick(new Date("2026-08-29T00:01:00.000Z"), {
        createPassive,
        createDailyCare,
      }),
      scheduler.beginScheduledTick(new Date("2026-08-29T00:09:59.999Z"), {
        createPassive,
        createDailyCare,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(createPassive).toHaveBeenCalledTimes(1);
    expect(createDailyCare).not.toHaveBeenCalled();
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status !== "rejected" || !(rejected.reason instanceof Error)) {
      throw new Error("REJECTED_SCHEDULER_RESULT_EXPECTED");
    }
    expect(rejected.reason.message).toBe("SINGLE_SCHEDULER_TICK_CONSUMED");
    const fulfilled = results.find(({ status }) => status === "fulfilled");
    if (fulfilled?.status === "fulfilled" && fulfilled.value.lane !== "outside") {
      await fulfilled.value.complete({ success: true });
    }
  });
});

function createScheduler(options: {
  state?: InMemorySingleSchedulerStateRepository;
  inspectP0Slot?: (slot: DailyCareSlot) => Promise<P0SlotInspection | null>;
} = {}): SingleScheduler {
  return new SingleScheduler({
    state: options.state ?? new InMemorySingleSchedulerStateRepository(),
    inspectP0Slot: options.inspectP0Slot ?? vi.fn().mockResolvedValue(null),
  });
}
