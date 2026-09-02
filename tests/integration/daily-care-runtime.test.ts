import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationSnapshot, WeChatSurface } from "../../src/adapters/wechat.js";
import type { DailyCareWeatherFacts } from "../../src/daily-care/types.js";
import { createDailyCareRuntime } from "../../src/mcp/daily-care-runtime.js";
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
  checkedAt: "2026-08-23T10:00:00.000Z",
  factHash: "f".repeat(64),
};

describe("daily-care runtime", () => {
  let rootDir: string;
  let repository: DailyCareBroadcastRepository;
  let surface: FakeSurface;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "daily-care-runtime-"));
    await initializeTestKernelLockCatalog(rootDir);
    repository = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32))),
      () => new Date("2026-08-23T10:00:00.000Z"),
    );
    surface = new FakeSurface();
  });

  afterEach(async () => rm(rootDir, { recursive: true, force: true }));

  it("writes, proves and submits one night candidate only to file-transfer", async () => {
    const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const runtime = createDailyCareRuntime({
      repository,
      surface,
      researchWeather: vi.fn().mockResolvedValue(weather),
      isStopped: vi.fn().mockResolvedValue(false),
      release,
      now: () => new Date("2026-08-23T10:00:00.000Z"),
      txid: () => "a".repeat(64),
    });

    await runtime.beginTestPreview("night");
    await runtime.prepareBroadcast(validNight);
    await runtime.verifyDraft();
    await runtime.submitAuthorizedBroadcast();
    await runtime.verifySend();
    await runtime.close();

    expect(surface.replaceCalls).toEqual([{
      id: "file-transfer", text: `${validNight}\n——示例用户`,
    }]);
    expect(surface.submitCalls).toEqual(["file-transfer"]);
    expect(surface.submitCalls).not.toContain("example-contact");
    expect(release).toHaveBeenCalledTimes(1);
    await expect(repository.getSlot(`test/${"a".repeat(64)}`)).resolves.toMatchObject({
      status: "verified",
    });
  });

  it("requires weather before a morning draft and binds the saved fact hash", async () => {
    const researchWeather = vi.fn().mockResolvedValue(weather);
    const runtime = createRuntime({ researchWeather });
    await runtime.beginTestPreview("morning");
    await expect(runtime.prepareBroadcast(validMorning)).rejects.toThrow(
      "DAILY_CARE_WEATHER_REQUIRED",
    );
    await expect(runtime.researchMorningWeather()).resolves.toMatchObject({
      condition: "多云",
      temperature: { kind: "range", highC: 32, lowC: 25 },
    });
    await runtime.prepareBroadcast(validMorning);
    await expect(repository.getSlot(`test/${"a".repeat(64)}`)).resolves.toMatchObject({
      weatherFactHash: weather.factHash,
    });
  });

  it("publishes a low-only weather receipt without legacy temperature fields", async () => {
    const runtime = createRuntime({
      researchWeather: vi.fn().mockResolvedValue({
        ...weather,
        condition: "小雨",
        temperature: { kind: "low-only" as const, lowC: 7 },
        rainExpected: true,
        clothingConcepts: ["warmth", "rain-protection"],
      }),
    });
    await runtime.beginTestPreview("morning");

    const result = await runtime.researchMorningWeather();

    expect(result).toEqual({
      localDate: "2026-08-23",
      condition: "小雨",
      temperature: { kind: "low-only", lowC: 7 },
      rainExpected: true,
      clothingConcepts: ["warmth", "rain-protection"],
      checkedAt: "2026-08-23T10:00:00.000Z",
    });
    expect(result).not.toHaveProperty("highC");
    expect(result).not.toHaveProperty("lowC");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.temperature)).toBe(true);
    expect(Object.isFrozen(result.clothingConcepts)).toBe(true);
  });

  it("persists submitted-uncertain before a native failure and refuses an automatic retry", async () => {
    surface.submitError = new Error("NATIVE_PRIVATE_FAILURE");
    const runtime = createRuntime();
    await runtime.beginTestPreview("night");
    await runtime.prepareBroadcast(validNight);
    await runtime.verifyDraft();
    await expect(runtime.submitAuthorizedBroadcast()).rejects.toThrow("NATIVE_PRIVATE_FAILURE");
    await expect(repository.getSlot(`test/${"a".repeat(64)}`)).resolves.toMatchObject({
      status: "submitted-uncertain",
      phase: "submit-started",
    });
    await expect(runtime.submitAuthorizedBroadcast()).rejects.toThrow(
      "DAILY_CARE_RUNTIME_SEQUENCE_ERROR",
    );
    expect(surface.submitCalls).toHaveLength(1);
  });

  it("checks STOP before any draft write and before submit", async () => {
    const isStopped = vi.fn().mockResolvedValue(true);
    const runtime = createRuntime({ isStopped });
    await runtime.beginTestPreview("night");
    await expect(runtime.prepareBroadcast(validNight)).rejects.toThrow("SYSTEM_STOPPED");
    expect(surface.replaceCalls).toHaveLength(0);
  });

  it("clears and proves an unsent prepared draft on abort", async () => {
    const runtime = createRuntime();
    await runtime.beginTestPreview("night");
    await runtime.prepareBroadcast(validNight);
    await runtime.abortDraft();
    expect(surface.clearCalls).toEqual(["file-transfer"]);
    expect(surface.draft).toBe("");
    await expect(repository.getSlot(`test/${"a".repeat(64)}`)).resolves.toMatchObject({
      status: "skipped",
      skipReason: "aborted",
    });
  });

  it("marks a begun slot skipped when close occurs before any UI write", async () => {
    const runtime = createRuntime();
    await runtime.beginTestPreview("night");

    await runtime.close();

    await expect(repository.getSlot(`test/${"a".repeat(64)}`)).resolves.toMatchObject({
      status: "skipped",
      phase: "terminal",
      skipReason: "session-closed-before-draft",
    });
    expect(surface.replaceCalls).toHaveLength(0);
    expect(surface.submitCalls).toHaveLength(0);
  });

  function createRuntime(overrides: {
    researchWeather?: () => Promise<DailyCareWeatherFacts>;
    isStopped?: () => Promise<boolean>;
  } = {}) {
    return createDailyCareRuntime({
      repository,
      surface,
      researchWeather: overrides.researchWeather ?? vi.fn().mockResolvedValue(weather),
      isStopped: overrides.isStopped ?? vi.fn().mockResolvedValue(false),
      release: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-08-23T10:00:00.000Z"),
      txid: () => "a".repeat(64),
    });
  }
});

class FakeSurface implements WeChatSurface {
  public draft = "";
  public readonly replaceCalls: Array<{ id: string; text: string }> = [];
  public readonly clearCalls: string[] = [];
  public readonly submitCalls: string[] = [];
  public submitError: Error | null = null;

  public locateConversation(): Promise<ConversationSnapshot> {
    return Promise.resolve({
      conversationId: "file-transfer",
      identity: {
        conversationId: "file-transfer",
        visibleName: "文件传输助手",
        avatarFingerprint: "a".repeat(64),
        recentMessageFingerprint: "b".repeat(64),
        confidence: 0.99,
      },
      messages: this.submitCalls.length === 0 ? [] : [{
        id: "sent",
        conversationId: "file-transfer",
        direction: "outgoing",
        kind: "text",
        text: this.lastSubmitted,
        occurredAt: "2026-08-23T10:00:00.000Z",
        source: "wechat",
        confidence: 0.99,
      }],
      draftText: this.draft,
      composerEvidence: this.draft === "" ? "proven-empty" : "meaningful-content",
      unreadIndicator: false,
      windowRevision: "revision",
    });
  }
  public focusConversation(): Promise<void> { return Promise.resolve(); }
  public replaceDraft(id: string, text: string): Promise<void> {
    this.draft = text;
    this.replaceCalls.push({ id, text });
    return Promise.resolve();
  }
  public clearDraft(id: string): Promise<void> {
    this.draft = "";
    this.clearCalls.push(id);
    return Promise.resolve();
  }
  private lastSubmitted = "";
  public submitDraft(id: string): Promise<void> {
    this.lastSubmitted = this.draft;
    this.submitCalls.push(id);
    if (this.submitError !== null) return Promise.reject(this.submitError);
    this.draft = "";
    return Promise.resolve();
  }
}
