import { describe, expect, it, vi } from "vitest";

import type { DailyCareSlot, DailyCareWeatherFacts } from "../../src/daily-care/types.js";
import {
  SingleDispatcherAdmission,
  type DispatcherOwner,
} from
  "../../src/runtime-v2/single-dispatcher-admission.js";
import {
  DAILY_CARE_WRITING_SKILL_ID,
  InMemorySingleSchedulerStateRepository,
  selectScheduledLane,
  SingleScheduler,
  type DailyCareCandidateGeneratorInput,
  type P0SlotInspection,
} from "../../src/runtime-v2/single-scheduler.js";

interface ScheduledP0Owner extends DispatcherOwner {
  readonly lane: "p0";
  readonly kind: "morning" | "night";
  readonly listRecentVerifiedTexts: () => Promise<readonly string[]>;
  readonly researchWeather: () => Promise<DailyCareWeatherFacts>;
  readonly prepareAndSubmitCandidate: (
    candidate: string,
    weather: DailyCareWeatherFacts | null,
  ) => Promise<"verified" | "submitted-uncertain">;
  readonly verifyOutgoingAfterUncertain: () => Promise<
    "verified" | "submitted-uncertain"
  >;
}

interface ScheduledP1Owner extends DispatcherOwner {
  readonly lane: "p1";
  readonly readLatest: () => Promise<{
    readonly direction: "incoming" | "outgoing" | "none";
  }>;
  readonly replyToLatestIncomingOnce: () => Promise<{
    readonly status: "verified" | "submitted-uncertain";
    readonly submitCount: 1;
  }>;
}

type ScheduledLaneOwner = ScheduledP0Owner | ScheduledP1Owner;

const validMorning =
  "今天多云，最高32℃，最低25℃。上班通勤记得穿透气些，出门也做好防晒。忙起来别忘了喝水和按时吃饭，累了就稍微歇一会儿，照顾好身体呀。🌤️💛";
const fallbackMorning =
  "早上好，上班路上别太赶，忙起来也记得按时吃饭、喝点温水，给自己留一点喘口气的时间，好好照顾身体，愿今天从容顺利，也记得对自己温柔一点。☀️💛";
const validNight =
  "想认真和你说声晚安。无论今天过得怎样，都希望这会儿的你能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙";
const weather: DailyCareWeatherFacts = {
  localDate: "2026-08-25",
  condition: "多云",
  temperature: { kind: "range", highC: 32, lowC: 25 },
  rainExpected: false,
  clothingConcepts: ["breathable", "sun-protection"],
  sourceName: "中国天气网（七日）",
  sourceUrl: "https://www.weather.com.cn/weather/101190112.shtml",
  checkedAt: "2026-08-24T22:30:12.000Z",
  factHash: "f".repeat(64),
};

describe("single runtime-v2 scheduler", () => {
  it.each([
    ["2026-09-01T00:00:00+08:00", null, "p1"],
    ["2026-09-01T06:20:00+08:00", null, "p1"],
    ["2026-09-01T06:30:00+08:00", null, "p0"],
    ["2026-09-01T06:40:00+08:00", { status: "verified" }, "p1"],
    ["2026-09-01T22:00:00+08:00", null, "p0"],
    ["2026-09-01T22:10:00+08:00", { status: "skipped" }, "p1"],
    ["2026-09-01T22:30:00+08:00", null, "p1"],
    ["2026-09-01T23:50:00+08:00", null, "p1"],
  ] as const)("selects the expected all-day lane at %s", (iso, inspection, expected) => {
    expect(selectScheduledLane(new Date(iso), inspection)).toBe(expected);
  });

  it("returns before runtime acquisition when P0 is due and never constructs P1", async () => {
    const status = vi.fn().mockResolvedValue({ status: "pending" });
    const p0 = p0Owner();
    const p1 = p1Owner("incoming");
    const acquireOwner = vi.fn((lane: "p0" | "p1" | "acceptance") =>
      Promise.resolve(lane === "p0" ? p0 : p1));
    const scheduler = schedulerHarness({ status, acquireOwner }).scheduler;

    await expect(scheduler.tick(new Date("2026-08-24T22:30:12.000Z")))
      .resolves.toMatchObject({ lane: "p0", status: "verified" });

    expect(acquireOwner).toHaveBeenCalledWith("p0");
    expect(p1.readLatest).not.toHaveBeenCalled();
  });

  it("falls back to P1 in the remaining P0 grace after the slot becomes terminal", async () => {
    let status: "pending" | "verified" = "pending";
    const p0 = p0Owner({ onComplete: () => { status = "verified"; } });
    const p1 = p1Owner("outgoing");
    const harness = schedulerHarness({
      status: vi.fn(() => Promise.resolve({ status })),
      acquireOwner: vi.fn((lane) => Promise.resolve(lane === "p0" ? p0 : p1)),
    });

    await harness.scheduler.tick(new Date("2026-08-24T22:30:12.000Z"));
    await expect(harness.scheduler.tick(new Date("2026-08-24T22:40:12.000Z")))
      .resolves.toMatchObject({ lane: "p1", status: "wait", submitCount: 0 });
    expect(p1.readLatest).toHaveBeenCalledTimes(1);
    expect(p1.replyToLatestIncomingOnce).not.toHaveBeenCalled();
  });

  it("keeps P0 and P1 failure counters and circuits independent", async () => {
    const state = new InMemorySingleSchedulerStateRepository();
    const brokenP0 = p0Owner();
    const generate = vi.fn().mockRejectedValue(new Error("GENERATOR_FAILED"));
    const healthyP1 = p1Owner("outgoing");
    const p0Scheduler = schedulerHarness({
      state,
      generate,
      status: vi.fn().mockResolvedValue({ status: "pending" }),
      acquireOwner: vi.fn((lane) => Promise.resolve(lane === "p0" ? brokenP0 : healthyP1)),
    }).scheduler;
    for (const minute of [30, 40, 50]) {
      await p0Scheduler.tick(new Date(`2026-08-24T22:${minute}:00.000Z`));
    }
    expect(await state.load()).toMatchObject({ p0Failures: 3, p1Failures: 0 });
    await expect(p0Scheduler.tick(new Date("2026-08-25T00:00:00.000Z")))
      .resolves.toMatchObject({ lane: "p1", status: "wait" });

    const p1State = new InMemorySingleSchedulerStateRepository();
    const brokenP1 = {
      ...p1Owner("incoming"),
      replyToLatestIncomingOnce: vi.fn().mockRejectedValue(new Error("P1_FAILED")),
    };
    const healthyP0 = p0Owner();
    const p1Scheduler = schedulerHarness({
      state: p1State,
      status: vi.fn().mockResolvedValue({ status: "pending" }),
      acquireOwner: vi.fn((lane) => Promise.resolve(lane === "p0" ? healthyP0 : brokenP1)),
    }).scheduler;
    for (const minute of [0, 10, 20]) {
      await p1Scheduler.tick(new Date(
        `2026-08-25T00:${String(minute).padStart(2, "0")}:00.000Z`,
      ));
    }
    expect(await p1State.load()).toMatchObject({ p0Failures: 0, p1Failures: 3 });
    await expect(p1Scheduler.tick(new Date("2026-08-25T22:30:00.000Z")))
      .resolves.toMatchObject({ lane: "p0", status: "verified" });
  });

  it("uses only three ten-minute P0 buckets and recovers uncertainty by readback without resubmit", async () => {
    let status: "pending" | "submitted-uncertain" | "verified" = "pending";
    const first = p0Owner({
      completeResult: "submitted-uncertain",
      onComplete: () => { status = "submitted-uncertain"; },
    });
    const recovery = p0Owner({
      recoverResult: "verified",
      onRecover: () => { status = "verified"; },
    });
    const p1 = p1Owner("outgoing");
    const owners: ScheduledLaneOwner[] = [first, recovery, p1];
    const scheduler = schedulerHarness({
      status: vi.fn(() => Promise.resolve({ status })),
      acquireOwner: vi.fn(() => Promise.resolve(owners.shift() as ScheduledLaneOwner)),
    }).scheduler;

    await scheduler.tick(new Date("2026-08-24T22:30:00.000Z"));
    await scheduler.tick(new Date("2026-08-24T22:40:00.000Z"));
    await scheduler.tick(new Date("2026-08-24T22:40:30.000Z"));
    await scheduler.tick(new Date("2026-08-24T22:50:00.000Z"));

    expect(first.prepareAndSubmitCandidate).toHaveBeenCalledTimes(1);
    expect(recovery.verifyOutgoingAfterUncertain).toHaveBeenCalledTimes(1);
    expect(recovery.prepareAndSubmitCandidate).not.toHaveBeenCalled();
    expect(p1.readLatest).toHaveBeenCalledTimes(1);
  });

  it("routes morning verified/fallback and night candidates through the writing Skill interface", async () => {
    const verifiedOwner = p0Owner();
    const verifiedGenerator = vi.fn().mockResolvedValue(validMorning);
    await schedulerHarness({
      generate: verifiedGenerator,
      status: vi.fn().mockResolvedValue({ status: "pending" }),
      acquireOwner: vi.fn(() => Promise.resolve(verifiedOwner)),
    }).scheduler.tick(new Date("2026-08-24T22:30:12.000Z"));
    expect(verifiedGenerator).toHaveBeenCalledWith(expect.objectContaining({
      skillId: DAILY_CARE_WRITING_SKILL_ID,
      kind: "morning",
      verifiedWeatherFacts: weather,
    }));

    const fallbackOwner = p0Owner({ weatherError: new Error("WEATHER_UNAVAILABLE") });
    const fallbackGenerator = vi.fn().mockResolvedValue(fallbackMorning);
    await schedulerHarness({
      generate: fallbackGenerator,
      status: vi.fn().mockResolvedValue({ status: "pending" }),
      acquireOwner: vi.fn(() => Promise.resolve(fallbackOwner)),
    }).scheduler.tick(new Date("2026-08-24T22:40:12.000Z"));
    expect(fallbackGenerator).toHaveBeenCalledWith(expect.objectContaining({
      kind: "morning", verifiedWeatherFacts: null,
    }));
    expect(fallbackOwner.prepareAndSubmitCandidate)
      .toHaveBeenCalledWith(fallbackMorning, null);

    const nightOwner = p0Owner({ kind: "night" });
    const nightGenerator = vi.fn().mockResolvedValue(validNight);
    await schedulerHarness({
      generate: nightGenerator,
      status: vi.fn().mockResolvedValue({ status: "pending" }),
      acquireOwner: vi.fn(() => Promise.resolve(nightOwner)),
    }).scheduler.tick(new Date("2026-08-25T14:00:12.000Z"));
    expect(nightOwner.researchWeather).not.toHaveBeenCalled();
    expect(nightGenerator).toHaveBeenCalledWith(expect.objectContaining({
      skillId: DAILY_CARE_WRITING_SKILL_ID, kind: "night", verifiedWeatherFacts: null,
    }));
  });

  it("reads only the latest P1 direction and sends at most once per ten-minute tick", async () => {
    const incoming = p1Owner("incoming");
    const next = p1Owner("outgoing");
    const owners: ScheduledLaneOwner[] = [incoming, next];
    const harness = schedulerHarness({
      status: vi.fn().mockResolvedValue(null),
      acquireOwner: vi.fn(() => Promise.resolve(owners.shift() as ScheduledLaneOwner)),
    });

    await expect(harness.scheduler.tick(new Date("2026-08-25T00:01:00.000Z")))
      .resolves.toMatchObject({ lane: "p1", status: "verified", submitCount: 1 });
    await expect(harness.scheduler.tick(new Date("2026-08-25T00:09:59.000Z")))
      .resolves.toMatchObject({ lane: "p1", status: "already-consumed", submitCount: 0 });
    await expect(harness.scheduler.tick(new Date("2026-08-25T00:10:01.000Z")))
      .resolves.toMatchObject({ lane: "p1", status: "wait", latestDirection: "outgoing" });
    expect(incoming.readLatest).toHaveBeenCalledTimes(1);
    expect(incoming.replyToLatestIncomingOnce).toHaveBeenCalledTimes(1);
    expect(next.replyToLatestIncomingOnce).not.toHaveBeenCalled();
  });

  it("defers P0 for an incoming realtime reply and retries inside the 30-minute window", async () => {
    let incomingPending = true;
    const daily = p0Owner();
    const acquireOwner = vi.fn().mockResolvedValue(daily);
    const harness = schedulerHarness({
      status: vi.fn().mockResolvedValue({ status: "pending" }),
      acquireOwner,
      hasPendingRealtimeReply: vi.fn(() => Promise.resolve(incomingPending)),
    });

    await expect(harness.scheduler.beginScheduledTick(
      new Date("2026-08-24T22:30:00.000Z"),
      { createPassive: vi.fn(), createDailyCare: vi.fn() },
    )).resolves.toEqual({ lane: "outside", status: "outside-window" });
    incomingPending = false;
    await expect(harness.scheduler.tick(new Date("2026-08-24T22:40:00.000Z")))
      .resolves.toMatchObject({ lane: "p0", status: "verified" });
    expect(acquireOwner).toHaveBeenCalledTimes(1);
  });

  it("marks P0 skipped without acquiring a lane after recent natural conversation", async () => {
    const markP0Skipped = vi.fn().mockResolvedValue(undefined);
    const acquireOwner = vi.fn().mockResolvedValue(p0Owner());
    const harness = schedulerHarness({
      status: vi.fn().mockResolvedValue({ status: "pending" }),
      acquireOwner,
      hasRecentNaturalConversation: vi.fn().mockResolvedValue(true),
      markP0Skipped,
    });

    await expect(harness.scheduler.tick(new Date("2026-08-24T22:30:00.000Z")))
      .resolves.toEqual({ lane: "outside", status: "outside-window", submitCount: 0 });
    expect(markP0Skipped).toHaveBeenCalledTimes(1);
    expect(acquireOwner).not.toHaveBeenCalled();
  });
});

function schedulerHarness(options: {
  status?: (slot: DailyCareSlot) => Promise<P0SlotInspection | null>;
  acquireOwner?: (lane: "p0" | "p1" | "acceptance") => Promise<ScheduledLaneOwner>;
  generate?: (input: DailyCareCandidateGeneratorInput) => Promise<string>;
  state?: InMemorySingleSchedulerStateRepository;
  hasPendingRealtimeReply?: () => Promise<boolean>;
  hasRecentNaturalConversation?: (
    slot: DailyCareSlot,
    now: Date,
  ) => Promise<boolean>;
  markP0Skipped?: (slot: DailyCareSlot, now: Date) => Promise<void>;
} = {}) {
  const state = options.state ?? new InMemorySingleSchedulerStateRepository();
  const generator = { generate: options.generate ?? vi.fn().mockResolvedValue(validMorning) };
  const admission = new SingleDispatcherAdmission<ScheduledLaneOwner>({
    acquireOwner: options.acquireOwner ?? vi.fn(() => Promise.resolve(p1Owner("outgoing"))),
  });
  return {
    scheduler: new SingleScheduler({
      state,
      inspectP0Slot: options.status ?? vi.fn().mockResolvedValue(null),
      admission,
      candidateGenerator: generator,
      hasPendingRealtimeReply: options.hasPendingRealtimeReply,
      hasRecentNaturalConversation: options.hasRecentNaturalConversation,
      markP0Skipped: options.markP0Skipped,
    }),
    state,
  };
}

function p0Owner(options: {
  kind?: "morning" | "night";
  weatherError?: Error;
  completeResult?: "verified" | "submitted-uncertain";
  recoverResult?: "verified" | "submitted-uncertain";
  onComplete?: () => void;
  onRecover?: () => void;
} = {}): ScheduledP0Owner {
  return {
    lane: "p0",
    kind: options.kind ?? "morning",
    listRecentVerifiedTexts: vi.fn().mockResolvedValue([]),
    researchWeather: options.weatherError === undefined
      ? vi.fn().mockResolvedValue(weather)
      : vi.fn().mockRejectedValue(options.weatherError),
    prepareAndSubmitCandidate: vi.fn().mockImplementation(() => {
      options.onComplete?.();
      return Promise.resolve(options.completeResult ?? "verified");
    }),
    verifyOutgoingAfterUncertain: vi.fn().mockImplementation(() => {
      options.onRecover?.();
      return Promise.resolve(options.recoverResult ?? "submitted-uncertain");
    }),
    close: vi.fn().mockResolvedValue({ gateReleased: true }),
  };
}

function p1Owner(direction: "incoming" | "outgoing" | "none"): ScheduledP1Owner {
  return {
    lane: "p1",
    readLatest: vi.fn().mockResolvedValue({ direction }),
    replyToLatestIncomingOnce: vi.fn().mockResolvedValue({
      status: "verified", submitCount: 1,
    }),
    close: vi.fn().mockResolvedValue({ gateReleased: true }),
  };
}
