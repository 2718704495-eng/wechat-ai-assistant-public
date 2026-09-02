import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationSnapshot, WeChatSurface } from "../../src/adapters/wechat.js";
import type { DailyCareWeatherFacts } from "../../src/daily-care/types.js";
import {
  createDailyCareProductionRuntime,
  createDailyCareRuntime,
} from "../../src/mcp/daily-care-runtime.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { DailyCareBroadcastRepository } from "../../src/storage/daily-care-broadcast-repository.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

const validMorning =
  "今天多云，最高32℃，最低25℃。上班通勤记得穿透气些，出门也做好防晒。忙起来别忘了喝水和按时吃饭，累了就稍微歇一会儿，照顾好身体呀。🌤️💛";
const validNight =
  "想认真和你说声晚安。无论今天过得怎样，都希望这会儿的你能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙";
const weather: DailyCareWeatherFacts = {
  localDate: "2026-08-23",
  condition: "多云",
  temperature: { kind: "range", highC: 32, lowC: 25 },
  rainExpected: false,
  clothingConcepts: ["breathable", "sun-protection"],
  sourceName: "中国天气网（七日）",
  sourceUrl: "https://www.weather.com.cn/weather/101190112.shtml",
  checkedAt: "2026-08-22T22:35:00.000Z",
  factHash: "f".repeat(64),
};

describe("daily-care production runtime", () => {
  let rootDir: string;
  let key: Buffer;
  let repository: DailyCareBroadcastRepository;
  let surface: ProductionSurface;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "daily-care-production-"));
    await initializeTestKernelLockCatalog(rootDir);
    key = randomBytes(32);
    repository = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
      () => new Date("2026-08-22T22:35:00.000Z"),
    );
    surface = new ProductionSurface();
  });

  afterEach(async () => rm(rootDir, { recursive: true, force: true }));

  it("rejects outside the trusted Beijing windows without a claim or UI operation", async () => {
    const runtime = createProduction({ now: () => new Date("2026-08-23T01:00:00.000Z") });

    await expect(runtime.beginCurrentSlot()).rejects.toThrow("DAILY_CARE_OUTSIDE_PRODUCTION_WINDOW");

    await expect(repository.getSlot("2026-08-23/morning")).resolves.toBeNull();
    expect(surface.operations).toEqual([]);
  });

  it("claims the current morning under the fixed production key and never accepts a target", async () => {
    const runtime = createProduction();

    await expect(runtime.beginCurrentSlot()).resolves.toEqual({
      kind: "morning",
      weatherRequired: true,
      skillId: "daily-care-message-writing",
      bodyLength: { minimum: 60, maximum: 120 },
      signature: "——示例用户",
      maximumRegenerations: 2,
    });
    await runtime.researchMorningWeather();
    await runtime.prepareBroadcast(validMorning);

    expect(surface.replaceCalls).toEqual([{
      id: "example-contact", text: `${validMorning}\n——示例用户`,
    }]);
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      slotKey: "2026-08-23/morning",
      targetMode: "production",
      weatherFactHash: weather.factHash,
    });
  });

  it("keeps production and file-transfer test claims isolated", async () => {
    const testRuntime = createDailyCareRuntime({
      repository,
      surface: new TestSurface(),
      researchWeather: vi.fn().mockResolvedValue(weather),
      isStopped: vi.fn().mockResolvedValue(false),
      release: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-08-22T22:35:00.000Z"),
      txid: () => "a".repeat(64),
    });
    const productionRuntime = createProduction();

    await testRuntime.beginTestPreview("morning");
    await productionRuntime.beginCurrentSlot();

    await expect(repository.getSlot(`test/${"a".repeat(64)}`)).resolves.toMatchObject({
      targetMode: "test",
    });
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      targetMode: "production",
    });
  });

  it("runs night preparation with zero weather or network executor calls", async () => {
    const researchWeather = vi.fn().mockResolvedValue(weather);
    const runtime = createProduction({
      now: () => new Date("2026-08-23T14:05:00.000Z"),
      researchWeather,
    });

    await runtime.beginCurrentSlot();
    await runtime.prepareBroadcast(validNight);

    expect(researchWeather).not.toHaveBeenCalled();
  });

  it("submits zero times when the target identity drifts before submit", async () => {
    const runtime = createProduction();
    await runtime.beginCurrentSlot();
    await runtime.researchMorningWeather();
    await runtime.prepareBroadcast(validMorning);
    await runtime.verifyDraft();
    surface.identityDrifted = true;

    await expect(runtime.submitAuthorizedBroadcast()).rejects.toThrow(
      "DAILY_CARE_TARGET_IDENTITY_MISMATCH",
    );

    expect(surface.submitCalls).toEqual([]);
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      status: "pending",
      phase: "draft-verified",
    });
  });

  it("grants one winner to concurrent production sessions for the same slot", async () => {
    const first = createProduction();
    const second = createProduction();

    const results = await Promise.allSettled([
      first.beginCurrentSlot(),
      second.beginCurrentSlot(),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("persists submitted uncertainty before native failure and never retries", async () => {
    const runtime = createProduction();
    surface.submitError = new Error("PRIVATE_NATIVE_FAILURE");
    await runtime.beginCurrentSlot();
    await runtime.researchMorningWeather();
    await runtime.prepareBroadcast(validMorning);
    await runtime.verifyDraft();

    await expect(runtime.submitAuthorizedBroadcast()).rejects.toThrow("PRIVATE_NATIVE_FAILURE");
    await expect(runtime.submitAuthorizedBroadcast()).rejects.toThrow(
      "DAILY_CARE_RUNTIME_SEQUENCE_ERROR",
    );
    expect(surface.submitCalls).toEqual(["example-contact"]);
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      status: "submitted-uncertain",
      phase: "submit-started",
    });
  });

  it("hydrates a claimed slot after restart instead of leaving a permanent claim tombstone", async () => {
    const first = createProduction();
    await first.beginCurrentSlot();
    await first.close();

    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      status: "pending",
      phase: "claimed",
      sessionAttemptCount: 1,
    });

    const restarted = createProduction({ repository: restartedRepository() });
    await expect(restarted.beginCurrentSlot()).resolves.toMatchObject({ kind: "morning" });
    expect(surface.replaceCalls).toEqual([]);
    expect(surface.submitCalls).toEqual([]);
  });

  it("atomically terminalizes an observed pending night slot immediately after grace", async () => {
    const duringGrace = () => new Date("2026-08-23T14:10:33.000Z");
    const first = createProduction({ now: duringGrace, repository: restartedRepository(duringGrace) });
    await expect(first.beginCurrentSlot()).resolves.toMatchObject({ kind: "night" });
    await first.close();

    const exactBoundary = () => new Date("2026-08-23T14:29:59.999Z");
    const finalAllowed = createProduction({
      now: exactBoundary,
      repository: restartedRepository(exactBoundary),
    });
    await expect(finalAllowed.beginCurrentSlot()).resolves.toMatchObject({ kind: "night" });
    await finalAllowed.close();

    const afterGrace = () => new Date("2026-08-23T15:00:00.000Z");
    const observer = createProduction({
      now: afterGrace,
      repository: restartedRepository(afterGrace),
    });
    await expect(observer.beginCurrentSlot()).rejects.toThrow(
      "DAILY_CARE_OUTSIDE_PRODUCTION_WINDOW",
    );
    await observer.close();

    expect(surface.replaceCalls).toEqual([]);
    expect(surface.submitCalls).toEqual([]);
    await expect(repository.getSlot("2026-08-23/night")).resolves.toMatchObject({
      status: "skipped",
      phase: "terminal",
      skipReason: "grace-expired",
      sessionAttemptCount: 2,
    });
  });

  it("routes unavailable external weather evidence to the no-weather fallback without UI writes", async () => {
    const first = createProduction({
      researchWeather: vi.fn().mockRejectedValue(new Error("DAILY_CARE_WEATHER_EVIDENCE_INVALID")),
    });
    await first.beginCurrentSlot();

    await expect(first.researchMorningWeather()).resolves.toEqual({ availability: "unavailable" });
    await first.close();

    expect(surface.operations).toEqual(["release"]);
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      status: "pending",
      phase: "claimed",
    });
    const retry = createProduction({ repository: restartedRepository() });
    await expect(retry.beginCurrentSlot()).resolves.toMatchObject({ kind: "morning" });
    await retry.close();
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      sessionAttemptCount: 2,
    });
  });

  it("classifies an invalid trusted weather clock as permanent and terminal", async () => {
    const runtime = createProduction({
      researchWeather: vi.fn().mockRejectedValue(new Error("DAILY_CARE_WEATHER_TIME_INVALID")),
    });
    await runtime.beginCurrentSlot();

    await expect(runtime.researchMorningWeather()).rejects.toThrow(
      "DAILY_CARE_WEATHER_PERMANENT",
    );
    await runtime.close();

    expect(surface.operations).toEqual(["release"]);
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      status: "skipped",
      phase: "terminal",
      skipReason: "weather-permanent",
    });
  });

  it("enforces three durable session attempts without touching the UI on the rejected fourth wake", async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const runtime = createProduction({ repository: restartedRepository() });
      await expect(runtime.beginCurrentSlot()).resolves.toMatchObject({ kind: "morning" });
      await runtime.close();
    }

    const exhausted = createProduction({ repository: restartedRepository() });
    await expect(exhausted.beginCurrentSlot()).rejects.toThrow(
      "DAILY_CARE_RETRY_LIMIT_EXHAUSTED",
    );
    await exhausted.close();

    expect(surface.operations).toEqual(["release", "release", "release", "release"]);
    expect(surface.replaceCalls).toEqual([]);
    expect(surface.submitCalls).toEqual([]);
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      status: "skipped",
      phase: "terminal",
      sessionAttemptCount: 3,
      skipReason: "retry-limit-exhausted",
    });
  });

  it("hydrates the same prepared candidate after restart without regeneration or a duplicate write", async () => {
    const nightNow = () => new Date("2026-08-23T14:05:00.000Z");
    const first = createProduction({ now: nightNow });
    await first.beginCurrentSlot();
    await first.prepareBroadcast(validNight);

    const restarted = createProduction({ now: nightNow, repository: restartedRepository(nightNow) });
    await expect(restarted.beginCurrentSlot()).resolves.toMatchObject({
      kind: "night",
      recoveredPhase: "candidate-prepared",
    });
    await expect(restarted.verifyDraft()).resolves.toEqual({ draftVerified: true });
    expect(surface.replaceCalls).toEqual([{
      id: "example-contact", text: `${validNight}\n——示例用户`,
    }]);
  });

  it("hydrates draft-verified state and performs the pending submit exactly once", async () => {
    const nightNow = () => new Date("2026-08-23T14:05:00.000Z");
    const first = createProduction({ now: nightNow });
    await first.beginCurrentSlot();
    await first.prepareBroadcast(validNight);
    await first.verifyDraft();

    const restarted = createProduction({ now: nightNow, repository: restartedRepository(nightNow) });
    await expect(restarted.beginCurrentSlot()).resolves.toMatchObject({
      recoveredPhase: "draft-verified",
    });
    await restarted.submitAuthorizedBroadcast();
    expect(surface.submitCalls).toEqual(["example-contact"]);
  });

  it("treats submit-started recovery as terminal uncertainty and never submits again", async () => {
    surface.submitError = new Error("PRIVATE_NATIVE_FAILURE");
    const first = createProduction();
    await first.beginCurrentSlot();
    await first.researchMorningWeather();
    await first.prepareBroadcast(validMorning);
    await first.verifyDraft();
    await expect(first.submitAuthorizedBroadcast()).rejects.toThrow("PRIVATE_NATIVE_FAILURE");

    const restarted = createProduction({ repository: restartedRepository() });
    await expect(restarted.beginCurrentSlot()).rejects.toThrow("DAILY_CARE_SUBMITTED_UNCERTAIN");
    expect(surface.submitCalls).toEqual(["example-contact"]);
  });

  it("revalidates the Beijing slot before prepare, verify, and submit UI boundaries", async () => {
    let current = new Date("2026-08-23T14:29:59.000Z");
    const now = () => new Date(current);

    const beforePrepare = createProduction({ now });
    await beforePrepare.beginCurrentSlot();
    current = new Date("2026-08-23T14:30:00.000Z");
    await expect(beforePrepare.prepareBroadcast(validNight)).rejects.toThrow("DAILY_CARE_SLOT_EXPIRED");
    expect(surface.replaceCalls).toEqual([]);

    current = new Date("2026-08-24T14:29:59.000Z");
    const beforeVerify = createProduction({ now });
    await beforeVerify.beginCurrentSlot();
    await beforeVerify.prepareBroadcast(validNight);
    current = new Date("2026-08-24T14:30:00.000Z");
    await expect(beforeVerify.verifyDraft()).rejects.toThrow("DAILY_CARE_SLOT_EXPIRED");
    expect(surface.draft).toBe("");

    current = new Date("2026-08-25T14:29:59.000Z");
    const beforeSubmit = createProduction({ now });
    await beforeSubmit.beginCurrentSlot();
    await beforeSubmit.prepareBroadcast(validNight);
    await beforeSubmit.verifyDraft();
    current = new Date("2026-08-25T14:30:00.000Z");
    await expect(beforeSubmit.submitAuthorizedBroadcast()).rejects.toThrow("DAILY_CARE_SLOT_EXPIRED");
    expect(surface.submitCalls).toEqual([]);
    expect(surface.draft).toBe("");
  });

  it("durably quarantines a draft when close cannot clear it and blocks every later sender", async () => {
    const runtime = createProduction();
    await runtime.beginCurrentSlot();
    await runtime.researchMorningWeather();
    await runtime.prepareBroadcast(validMorning);
    surface.clearError = new Error("PRIVATE_CLEAR_FAILURE");

    await expect(runtime.close()).rejects.toThrow("PRIVATE_CLEAR_FAILURE");
    expect(surface.operations.at(-1)).toBe("release");
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      draftQuarantined: true,
      draftQuarantineReason: "draft-clear-failed",
    });

    const later = createProduction({ repository: restartedRepository() });
    await expect(later.beginCurrentSlot()).rejects.toThrow("DAILY_CARE_DRAFT_QUARANTINED");
    expect(surface.submitCalls).toEqual([]);
  });

  it("fails closed after the injected whole-session deadline without holding the live lock", async () => {
    let current = new Date("2026-08-23T14:05:00.000Z");
    const runtime = createProduction({
      now: () => new Date(current),
      sessionDeadlineMs: 180_000,
    });
    await runtime.beginCurrentSlot();
    current = new Date("2026-08-23T14:08:01.000Z");

    await expect(runtime.prepareBroadcast(validNight)).rejects.toThrow(
      "DAILY_CARE_SESSION_DEADLINE_EXCEEDED",
    );
    await runtime.close();
    expect(surface.operations.at(-1)).toBe("release");
    expect(surface.replaceCalls).toEqual([]);
  });

  it("actively aborts a hung UI operation at the whole-session deadline and releases the lock", async () => {
    let replaceStarted = false;
    surface.beforeReplace = () => {
      replaceStarted = true;
      return new Promise<void>(() => undefined);
    };
    const runtime = createProduction({
      now: () => new Date("2026-08-23T14:05:00.000Z"),
      sessionDeadlineMs: 1_000,
    });
    await runtime.beginCurrentSlot();

    const preparing = runtime.prepareBroadcast(validNight);
    await vi.waitFor(() => expect(replaceStarted).toBe(true), { timeout: 500 });
    await expect(preparing).rejects.toThrow(
      "DAILY_CARE_SESSION_DEADLINE_EXCEEDED",
    );
    await vi.waitFor(() => expect(surface.operations).toContain("release"), { timeout: 300 });
    await runtime.close();
    expect(surface.submitCalls).toEqual([]);
  }, 2_000);

  it("serializes close behind an in-flight draft write, clears it, and releases last", async () => {
    const runtime = createProduction();
    let continueWrite: (() => void) | undefined;
    surface.beforeReplace = () => new Promise<void>((resolve) => { continueWrite = resolve; });
    await runtime.beginCurrentSlot();
    await runtime.researchMorningWeather();
    const prepare = runtime.prepareBroadcast(validMorning);
    await vi.waitFor(() => expect(continueWrite).toBeTypeOf("function"));

    const close = runtime.close();
    await expect(runtime.verifyDraft()).rejects.toThrow("DAILY_CARE_RUNTIME_CLOSED");
    expect(surface.clearCalls).toEqual([]);
    continueWrite?.();
    await prepare;
    await close;

    expect(surface.draft).toBe("");
    expect(surface.operations.at(-1)).toBe("release");
    await expect(repository.getSlot("2026-08-23/morning")).resolves.toMatchObject({
      status: "skipped",
      phase: "terminal",
    });
  });

  it("clears a written draft on close when the immediate post-write proof fails", async () => {
    const runtime = createProduction();
    surface.mismatchNextDraftRead = true;
    await runtime.beginCurrentSlot();
    await runtime.researchMorningWeather();

    await expect(runtime.prepareBroadcast(validMorning)).rejects.toThrow(
      "DAILY_CARE_DRAFT_NOT_VERIFIED",
    );
    await runtime.close();

    expect(surface.replaceCalls).toHaveLength(1);
    expect(surface.clearCalls).toEqual(["example-contact"]);
    expect(surface.draft).toBe("");
    expect(surface.operations.at(-1)).toBe("release");
  });

  function createProduction(overrides: {
    now?: () => Date;
    researchWeather?: () => Promise<DailyCareWeatherFacts>;
    sessionDeadlineMs?: number;
    repository?: DailyCareBroadcastRepository;
  } = {}) {
    return createDailyCareProductionRuntime({
      repository: overrides.repository ?? repository,
      surface,
      researchWeather: overrides.researchWeather ?? vi.fn().mockResolvedValue(weather),
      isStopped: vi.fn().mockResolvedValue(false),
      release: vi.fn().mockImplementation(() => {
        surface.operations.push("release");
        return Promise.resolve();
      }),
      now: overrides.now ?? (() => new Date("2026-08-22T22:35:00.000Z")),
      ...(overrides.sessionDeadlineMs === undefined
        ? {}
        : { sessionDeadlineMs: overrides.sessionDeadlineMs }),
    });
  }

  function restartedRepository(
    now: () => Date = () => new Date("2026-08-22T22:35:00.000Z"),
  ): DailyCareBroadcastRepository {
    return new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
      now,
    );
  }
});

class ProductionSurface implements WeChatSurface {
  public draft = "";
  public identityDrifted = false;
  public mismatchNextDraftRead = false;
  public submitError: Error | null = null;
  public clearError: Error | null = null;
  public beforeReplace: (() => Promise<void>) | null = null;
  public readonly replaceCalls: Array<{ id: string; text: string }> = [];
  public readonly clearCalls: string[] = [];
  public readonly submitCalls: string[] = [];
  public readonly operations: string[] = [];
  private lastSubmitted = "";

  public locateConversation(): Promise<ConversationSnapshot> {
    this.operations.push("locate");
    const id = this.identityDrifted ? "file-transfer" : "example-contact";
    const shouldMismatch = this.mismatchNextDraftRead && this.draft !== "";
    const draftText = shouldMismatch
      ? "mismatched draft"
      : this.draft;
    if (shouldMismatch) this.mismatchNextDraftRead = false;
    return Promise.resolve({
      conversationId: id,
      identity: {
        conversationId: id,
        visibleName: this.identityDrifted ? "文件传输助手" : "示例联系人",
        avatarFingerprint: "a".repeat(64),
        recentMessageFingerprint: "b".repeat(64),
        confidence: 0.99,
      },
      messages: this.submitCalls.length === 0 ? [] : [{
        id: "sent",
        conversationId: "example-contact",
        direction: "outgoing",
        kind: "text",
        text: this.lastSubmitted,
        occurredAt: "2026-08-22T22:35:00.000Z",
        source: "wechat",
        confidence: 0.99,
      }],
      draftText,
      composerEvidence: draftText === "" ? "proven-empty" : "meaningful-content",
      unreadIndicator: false,
      windowRevision: "revision",
    });
  }
  public focusConversation(): Promise<void> { return Promise.resolve(); }
  public async replaceDraft(id: string, text: string): Promise<void> {
    this.operations.push("replace");
    await this.beforeReplace?.();
    this.draft = text;
    this.replaceCalls.push({ id, text });
  }
  public clearDraft(id: string): Promise<void> {
    this.operations.push("clear");
    if (this.clearError !== null) return Promise.reject(this.clearError);
    this.draft = "";
    this.clearCalls.push(id);
    return Promise.resolve();
  }
  public submitDraft(id: string): Promise<void> {
    this.operations.push("submit");
    this.lastSubmitted = this.draft;
    this.submitCalls.push(id);
    if (this.submitError !== null) return Promise.reject(this.submitError);
    this.draft = "";
    return Promise.resolve();
  }
}

class TestSurface extends ProductionSurface {
  public override locateConversation(): Promise<ConversationSnapshot> {
    return Promise.resolve({
      conversationId: "file-transfer",
      identity: {
        conversationId: "file-transfer",
        visibleName: "文件传输助手",
        avatarFingerprint: "a".repeat(64),
        recentMessageFingerprint: "b".repeat(64),
        confidence: 0.99,
      },
      messages: [],
      draftText: "",
      composerEvidence: "proven-empty",
      unreadIndicator: false,
      windowRevision: "revision",
    });
  }
}
