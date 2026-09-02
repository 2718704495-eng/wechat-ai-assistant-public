import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConversationSnapshot, WeChatSurface } from "../../src/adapters/wechat.js";
import type { DailyCareWeatherFacts } from "../../src/daily-care/types.js";
import { createDailyCareProductionRuntime } from "../../src/mcp/daily-care-runtime.js";
import { acquireLiveOperationCoordinator } from "../../src/mcp/live-operation-coordinator.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { DailyCareBroadcastRepository } from
  "../../src/storage/daily-care-broadcast-repository.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

interface SimulationResult {
  readonly liveLockResidual: false;
  readonly submitCalls: 1;
}

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

const validMorningFallback =
  "早上好，上班路上别太赶，忙起来也记得按时吃饭、喝点温水，给自己留一点喘口气的时间，好好照顾身体，愿今天从容顺利，也记得对自己温柔一点。☀️💛";
const validNight =
  "想认真和你说声晚安。无论今天过得怎样，都希望这会儿的你能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙";

export async function runMorningRetrySimulation(): Promise<SimulationResult> {
  return withScenario(async ({ expectNoLiveLock, surface, wake }) => {
    const first = await wake(
      "2026-08-24T22:30:12.000Z",
      () => Promise.reject(new Error("DAILY_CARE_WEATHER_EVIDENCE_INVALID")),
    );
    await first.beginCurrentSlot();
    assert.deepEqual(await first.researchMorningWeather(), { availability: "unavailable" });
    assert.deepEqual(surface.operations, []);
    await first.prepareBroadcast(validMorningFallback);
    await first.verifyDraft();
    await first.submitAuthorizedBroadcast();
    await first.verifySend();
    await first.close();
    await expectNoLiveLock();

    const duplicateWake = await wake(
      "2026-08-24T22:40:11.000Z",
      () => Promise.resolve(weather),
    );
    await expectErrorCode(duplicateWake.beginCurrentSlot(), "DAILY_CARE_SLOT_TERMINAL");
    await duplicateWake.close();
    await expectNoLiveLock();
    assert.equal(surface.submitCalls, 1);
  });
}

export async function runNightRetrySimulation(): Promise<SimulationResult> {
  return withScenario(async ({ expectNoLiveLock, surface, wake }) => {
    for (const timestamp of [
      "2026-08-24T14:01:03.000Z",
      "2026-08-24T14:11:03.000Z",
    ]) {
      const attempt = await wake(timestamp, () => Promise.resolve(weather));
      const slot = await attempt.beginCurrentSlot();
      assert.equal(slot.kind, "night");
      await attempt.close();
      await expectNoLiveLock();
      assert.deepEqual(surface.operations, []);
    }

    const finalAttempt = await wake(
      "2026-08-24T14:21:11.000Z",
      () => Promise.resolve(weather),
    );
    await finalAttempt.beginCurrentSlot();
    await finalAttempt.prepareBroadcast(validNight);
    await finalAttempt.verifyDraft();
    await finalAttempt.submitAuthorizedBroadcast();
    await finalAttempt.verifySend();
    await finalAttempt.close();
    await expectNoLiveLock();
    assert.equal(surface.submitCalls, 1);
  });
}

async function withScenario(
  run: (scenario: Scenario) => Promise<void>,
): Promise<SimulationResult> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "daily-care-scheduler-e2e-"));
  await initializeTestKernelLockCatalog(rootDir);
  const key = randomBytes(32);
  const surface = new SchedulerSurface();
  const expectNoLiveLock = async (): Promise<void> => {
    const successor = await acquireLiveOperationCoordinator({
      dataDir: rootDir,
      ownerKind: "cli",
    });
    await successor.close();
  };
  const wake: Scenario["wake"] = async (timestamp, researchWeather) => {
    const now = () => new Date(timestamp);
    const coordinator = await acquireLiveOperationCoordinator({
      dataDir: rootDir,
      ownerKind: "mcp",
    });
    const repository = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
      now,
    );
    return createDailyCareProductionRuntime({
      repository,
      surface,
      researchWeather,
      isStopped: () => Promise.resolve(false),
      release: () => coordinator.close(),
      now,
    });
  };

  try {
    await run({ expectNoLiveLock, surface, wake });
    await expectNoLiveLock();
    assert.equal(surface.submitCalls, 1);
    return { liveLockResidual: false, submitCalls: 1 };
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

interface Scenario {
  readonly expectNoLiveLock: () => Promise<void>;
  readonly surface: SchedulerSurface;
  readonly wake: (
    timestamp: string,
    researchWeather: () => Promise<DailyCareWeatherFacts>,
  ) => Promise<ReturnType<typeof createDailyCareProductionRuntime>>;
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message === code);
}

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

class SchedulerSurface implements WeChatSurface {
  public readonly operations: string[] = [];
  public submitCalls = 0;
  private draft = "";
  private latestOutgoing = "";

  public locateConversation(): Promise<ConversationSnapshot> {
    this.operations.push("locate");
    return Promise.resolve({
      conversationId: "example-contact",
      identity: {
        conversationId: "example-contact",
        visibleName: "示例联系人",
        avatarFingerprint: "a".repeat(64),
        recentMessageFingerprint: "b".repeat(64),
        confidence: 0.99,
      },
      messages: this.latestOutgoing === "" ? [] : [{
        id: "sent",
        conversationId: "example-contact",
        direction: "outgoing",
        kind: "text",
        text: this.latestOutgoing,
        occurredAt: "2026-08-24T22:40:11.000Z",
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

  public replaceDraft(_id: string, text: string): Promise<void> {
    this.operations.push("replace");
    this.draft = text;
    return Promise.resolve();
  }

  public clearDraft(): Promise<void> {
    this.operations.push("clear");
    this.draft = "";
    return Promise.resolve();
  }

  public submitDraft(): Promise<void> {
    this.operations.push("submit");
    this.submitCalls += 1;
    this.latestOutgoing = this.draft;
    this.draft = "";
    return Promise.resolve();
  }
}

async function main(): Promise<void> {
  const [morning, night] = await Promise.all([
    runMorningRetrySimulation(),
    runNightRetrySimulation(),
  ]);
  process.stdout.write(`${JSON.stringify({ morning, night })}\n`, "utf8");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
