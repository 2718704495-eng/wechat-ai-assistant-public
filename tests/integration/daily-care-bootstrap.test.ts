import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationSnapshot, WeChatSurface } from "../../src/adapters/wechat.js";
import {
  createDailyCareProductionService,
  type DailyCareProductionBootstrapOverrides,
} from "../../src/mcp/daily-care-bootstrap.js";
import { createDailyCareProductionSession } from "../../src/mcp/daily-care-session.js";
import type { OfficialFetch } from "../../src/mcp/official-research-executor.js";
import { MacOSKeychainKeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { StateRepository } from "../../src/storage/repositories.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";
import {
  acquireLiveOperationCoordinator,
} from "../../src/mcp/live-operation-coordinator.js";
import {
  closeSharedLiveProductionRuntime,
  createSharedLiveProductionRuntime,
} from "../../src/mcp/live-bootstrap.js";

const fixedWeatherUrl = "https://www.weather.com.cn/weather/101190112.shtml";
const validMorning =
  "今天多云，最高32℃，最低25℃。上班通勤记得穿透气些，出门也做好防晒。忙起来别忘了喝水和按时吃饭，累了就稍微歇一会儿，照顾好身体呀。🌤️💛";

describe("daily-care production bootstrap gate", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([
    {
      mode: "dry-run",
      gate: { consentConfirmed: true, initializationReportApproved: true },
      error: "DAILY_CARE_LIVE_MODE_REQUIRED",
    },
    {
      mode: "live",
      gate: { consentConfirmed: false, initializationReportApproved: true },
      error: "CONSENT_NOT_CONFIRMED",
    },
    {
      mode: "live",
      gate: { consentConfirmed: true, initializationReportApproved: false },
      error: "INITIALIZATION_REPORT_NOT_APPROVED",
    },
  ])("blocks $mode/unapproved startup before constructing any Native UI surface", async ({ mode, gate, error }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daily-care-bootstrap-gate-"));
    roots.push(root);
    const dataDir = path.join(root, "runtime");
    await mkdir(dataDir, { mode: 0o700 });
    await initializeTestKernelLockCatalog(dataDir);
    const createSurface = vi.fn<() => WeChatSurface>();
    const create = createDailyCareProductionService as unknown as (
      environment: Record<string, string | undefined>,
      overrides: {
        readSendGate: () => Promise<typeof gate>;
        createSurface: () => WeChatSurface;
      },
    ) => ReturnType<typeof createDailyCareProductionService>;

    const outcome = await create({
      HOME: root,
      CHAT_ASSISTANT_DATA_DIR: dataDir,
      CHAT_ASSISTANT_MODE: mode,
    }, {
      readSendGate: vi.fn().mockResolvedValue(gate),
      createSurface,
    }).then(
      (runtime) => ({ runtime }),
      (failure: unknown) => ({ failure }),
    );
    if ("runtime" in outcome) await outcome.runtime.close();

    expect("failure" in outcome ? outcome.failure : null).toEqual(
      expect.objectContaining({ message: error }),
    );
    expect(createSurface).not.toHaveBeenCalled();
  });

  it("starts an approved live service without requiring biometric enrollment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daily-care-bootstrap-live-"));
    roots.push(root);
    const dataDir = path.join(root, "runtime");
    await mkdir(dataDir, { mode: 0o700 });
    await initializeTestKernelLockCatalog(dataDir);
    const surface = {} as WeChatSurface;
    const createSurface = vi.fn<NonNullable<DailyCareProductionBootstrapOverrides["createSurface"]>>(
      () => surface,
    );
    const runtime = await createDailyCareProductionService({
      HOME: root,
      CHAT_ASSISTANT_DATA_DIR: dataDir,
      CHAT_ASSISTANT_MODE: "live",
    }, {
      readSendGate: vi.fn().mockResolvedValue({
        consentConfirmed: true,
        initializationReportApproved: true,
      }),
      createSurface,
    });

    try {
      expect(createSurface).toHaveBeenCalledTimes(1);
      const context = createSurface.mock.calls[0]?.[0];
      expect(typeof context?.executablePath).toBe("string");
      expect(context?.dataDir).toBe(await realpath(dataDir));
    } finally {
      await runtime.close();
    }
  });

  it("uses the shared production owner and encrypted store without releasing either", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daily-care-shared-runtime-"));
    roots.push(root);
    const dataDir = path.join(root, "runtime");
    await mkdir(dataDir, { mode: 0o700 });
    await initializeTestKernelLockCatalog(dataDir);
    const coordinator = await acquireLiveOperationCoordinator({ dataDir, ownerKind: "mcp" });
    const store = new EncryptedStore(dataDir, {
      getOrCreate: () => Promise.resolve(Buffer.alloc(32, 42)),
    });
    const sharedRuntime = createSharedLiveProductionRuntime({ coordinator, store, dataDir });
    const runtime = await createDailyCareProductionService({
      HOME: root,
      CHAT_ASSISTANT_DATA_DIR: dataDir,
      CHAT_ASSISTANT_MODE: "live",
    }, {
      readSendGate: approvedGate,
      createSurface: () => ({} as WeChatSurface),
      sharedRuntime,
    });

    await runtime.close();
    await expect(acquireLiveOperationCoordinator({ dataDir, ownerKind: "cli" }))
      .rejects.toThrow("LIVE_RUNTIME_BUSY");
    await closeSharedLiveProductionRuntime(sharedRuntime);
    const next = await acquireLiveOperationCoordinator({ dataDir, ownerKind: "cli" });
    await next.close();
  });

  it("uses the same runtime-v2 root for default no-override daily and realtime composition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daily-care-default-root-"));
    roots.push(root);
    const dataDir = path.join(root, "Desktop", "聊天助手", "runtime-v2");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await initializeTestKernelLockCatalog(dataDir);
    const coordinator = await acquireLiveOperationCoordinator({ dataDir, ownerKind: "mcp" });
    const store = new EncryptedStore(dataDir, {
      getOrCreate: () => Promise.resolve(Buffer.alloc(32, 44)),
    });
    const sharedRuntime = createSharedLiveProductionRuntime({ coordinator, store, dataDir });
    const runtime = await createDailyCareProductionService({
      HOME: root,
      CHAT_ASSISTANT_MODE: "live",
    }, {
      readSendGate: approvedGate,
      createSurface: () => ({} as WeChatSurface),
      sharedRuntime,
    });
    await runtime.close();
    await closeSharedLiveProductionRuntime(sharedRuntime);
  });

  it("wires one fixed official weather fetch through typed facts and keeps unavailable research UI-free", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("UNEXPECTED_GLOBAL_FETCH"))));
    const now = () => new Date("2026-08-22T22:35:00.000Z");

    const successRoot = await prepareRuntimeRoot("daily-care-bootstrap-weather-success-");
    await activateControlBoundary(authorityRoot(successRoot));
    const successSurface = createSurfaceHarness();
    const successRequests: string[] = [];
    const successFetch: OfficialFetch = (url) => {
      successRequests.push(url);
      return Promise.resolve(new Response(weatherHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    };
    const successRuntime = await createDailyCareProductionService(liveEnvironment(successRoot), {
      readSendGate: approvedGate,
      createSurface: () => successSurface.surface,
      officialFetch: successFetch,
      now,
    });
    try {
      const session = createDailyCareProductionSession(successRuntime.dependencies);
      await session.execute({ op: "begin-current-slot" });
      await expect(session.execute({ op: "research-morning-weather" })).resolves.toEqual({
        localDate: "2026-08-23",
        condition: "多云",
        temperature: { kind: "range", highC: 32, lowC: 25 },
        rainExpected: false,
        clothingConcepts: ["breathable", "sun-protection"],
        checkedAt: "2026-08-22T22:35:00.000Z",
      });
      expect(successRequests).toEqual([fixedWeatherUrl]);
      await expect(session.execute({ op: "prepare-broadcast", text: validMorning }))
        .resolves.toEqual({ prepared: true });
      expect(successSurface.replaceDraft).toHaveBeenCalledTimes(1);
      expect(successSurface.submitDraft).not.toHaveBeenCalled();
    } finally {
      await successRuntime.close();
    }

    const failureRoot = await prepareRuntimeRoot("daily-care-bootstrap-weather-failure-");
    const failureSurface = createSurfaceHarness();
    const failureRequests: string[] = [];
    const failureRuntime = await createDailyCareProductionService(liveEnvironment(failureRoot), {
      readSendGate: approvedGate,
      createSurface: () => failureSurface.surface,
      officialFetch: (url) => {
        failureRequests.push(url);
        return Promise.resolve(new Response("<html><title>broken</title></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }));
      },
      now,
    });
    try {
      const session = createDailyCareProductionSession(failureRuntime.dependencies);
      await session.execute({ op: "begin-current-slot" });
      await expect(session.execute({ op: "research-morning-weather" }))
        .resolves.toEqual({ availability: "unavailable" });
      expect(failureRequests).toEqual([fixedWeatherUrl]);
      expect(failureSurface.focusConversation).not.toHaveBeenCalled();
      expect(failureSurface.replaceDraft).not.toHaveBeenCalled();
      expect(failureSurface.submitDraft).not.toHaveBeenCalled();
    } finally {
      await failureRuntime.close();
    }
  });

  it("uses the durable macOS system-weather snapshot without constructing the legacy web transport", async () => {
    const root = await prepareRuntimeRoot("daily-care-bootstrap-system-weather-");
    await activateControlBoundary(authorityRoot(root));
    const surface = createSurfaceHarness();
    const legacyFetch = vi.fn<OfficialFetch>(() =>
      Promise.reject(new Error("LEGACY_WEB_WEATHER_MUST_NOT_RUN")));
    const readSystemWeatherSnapshot = vi.fn().mockResolvedValue({
      version: 1,
      locationId: "nanjing-qixia-government",
      observedAt: "2026-08-22T22:20:00.000Z",
      eventDate: "2026-08-23",
      conditionCode: "partlyCloudy",
      temperatureC: 27.1,
      highC: 32.3,
      lowC: 25.4,
      precipitationChance: 0.1,
    });
    const create = createDailyCareProductionService as unknown as (
      environment: Record<string, string | undefined>,
      overrides: DailyCareProductionBootstrapOverrides & {
        readSystemWeatherSnapshot: typeof readSystemWeatherSnapshot;
      },
    ) => ReturnType<typeof createDailyCareProductionService>;
    const runtime = await create(liveEnvironment(root), {
      readSendGate: approvedGate,
      createSurface: () => surface.surface,
      officialFetch: legacyFetch,
      readSystemWeatherSnapshot,
      now: () => new Date("2026-08-22T22:30:00.000Z"),
    });
    try {
      const session = createDailyCareProductionSession(runtime.dependencies);
      await session.execute({ op: "begin-current-slot" });
      await expect(session.execute({ op: "research-morning-weather" })).resolves.toEqual({
        localDate: "2026-08-23",
        condition: "多云",
        temperature: { kind: "range", highC: 32, lowC: 25 },
        rainExpected: false,
        clothingConcepts: ["breathable", "sun-protection"],
        checkedAt: "2026-08-22T22:20:00.000Z",
      });
      expect(readSystemWeatherSnapshot).toHaveBeenCalledTimes(1);
      expect(legacyFetch).not.toHaveBeenCalled();
      expect(surface.focusConversation).not.toHaveBeenCalled();
      expect(surface.replaceDraft).not.toHaveBeenCalled();
      expect(surface.submitDraft).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("reads fixed example-contact context only after night production bootstrap owns the live gate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daily-care-bootstrap-context-"));
    roots.push(root);
    const dataDir = path.join(root, "runtime");
    await mkdir(dataDir, { mode: 0o700 });
    await initializeTestKernelLockCatalog(dataDir);
    const locateConversation = vi.fn().mockResolvedValue({
      conversationId: "example-contact",
      identity: {
        conversationId: "example-contact",
        visibleName: "示例联系人",
        avatarFingerprint: "a".repeat(64),
        recentMessageFingerprint: "b".repeat(64),
        confidence: 0.99,
      },
      messages: [{
        id: "c".repeat(64),
        conversationId: "example-contact",
        direction: "incoming",
        kind: "text",
        text: "旧消息的截图时刻不能冒充当天时间",
        occurredAt: "2026-08-26T14:05:00.000Z",
        source: "wechat",
        confidence: 0.99,
      }],
      draftText: "",
      composerEvidence: "proven-empty",
      unreadIndicator: false,
      windowRevision: "context-proof",
    });
    const surface = {
      locateConversation,
      focusConversation: vi.fn(),
      replaceDraft: vi.fn(),
      clearDraft: vi.fn(),
      submitDraft: vi.fn(),
    } as WeChatSurface;
    const runtime = await createDailyCareProductionService({
      HOME: root,
      CHAT_ASSISTANT_DATA_DIR: dataDir,
      CHAT_ASSISTANT_MODE: "live",
    }, {
      readSendGate: vi.fn().mockResolvedValue({
        consentConfirmed: true,
        initializationReportApproved: true,
      }),
      createSurface: () => surface,
      now: () => new Date("2026-08-26T14:05:00.000Z"),
    });
    try {
      const session = createDailyCareProductionSession(runtime.dependencies);
      const begun = await session.execute({ op: "begin-current-slot" }) as {
        kind: unknown;
        sameDayCareContext?: {
          localDate: unknown;
          availability: unknown;
          explicitSignals: unknown[];
          safeExcerpts: unknown[];
          proofHash: unknown;
        };
      };
      expect(begun).toMatchObject({
        kind: "night",
        sameDayCareContext: {
          localDate: "2026-08-26",
          availability: "unavailable",
          explicitSignals: [],
          safeExcerpts: [],
        },
      });
      expect(begun.sameDayCareContext?.proofHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(locateConversation).toHaveBeenCalledTimes(1);
      expect(locateConversation).toHaveBeenCalledWith("example-contact");
    } finally {
      await runtime.close();
    }
  });

  async function prepareRuntimeRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    const dataDir = path.join(root, "runtime");
    await mkdir(dataDir, { mode: 0o700 });
    await mkdir(authorityRoot(root), { recursive: true, mode: 0o700 });
    await initializeTestKernelLockCatalog(dataDir);
    return root;
  }
});

function liveEnvironment(root: string): Record<string, string | undefined> {
  return {
    HOME: root,
    CHAT_ASSISTANT_DATA_DIR: path.join(root, "runtime"),
    CHAT_ASSISTANT_MODE: "live",
  };
}

function authorityRoot(root: string): string {
  return path.join(root, "Desktop", "聊天助手");
}

const approvedGate = vi.fn().mockResolvedValue({
  consentConfirmed: true,
  initializationReportApproved: true,
});

function weatherHtml(): string {
  return `<!doctype html><html><head>
    <title>示例城区天气预报,示例城区7天天气预报</title>
    <script>var fc_24h_internal_update_time = "2026082305";</script>
  </head><body><ul class="t clearfix">
    <li class="sky skyid lv2 on"><h1>23日（今天）</h1>
      <p class="wea">多云</p><p class="tem"><span>32</span>/<i>25℃</i></p>
    </li>
  </ul></body></html>`;
}

function createSurfaceHarness() {
  let draftText = "";
  const locateConversation = vi.fn((): Promise<ConversationSnapshot> => Promise.resolve({
    conversationId: "example-contact",
    identity: {
      conversationId: "example-contact",
      visibleName: "示例联系人",
      avatarFingerprint: "a".repeat(64),
      recentMessageFingerprint: "b".repeat(64),
      confidence: 0.99,
    },
    messages: [],
    draftText,
    composerEvidence: draftText === "" ? "proven-empty" : "meaningful-content",
    unreadIndicator: false,
    windowRevision: "weather-fixture",
  }));
  const focusConversation = vi.fn(() => Promise.resolve());
  const replaceDraft = vi.fn((_conversationId: string, text: string) => {
    draftText = text;
    return Promise.resolve();
  });
  const clearDraft = vi.fn(() => {
    draftText = "";
    return Promise.resolve();
  });
  const submitDraft = vi.fn(() => Promise.resolve());
  const surface = {
    locateConversation,
    focusConversation,
    replaceDraft,
    clearDraft,
    submitDraft,
  } satisfies WeChatSurface;
  return { surface, locateConversation, focusConversation, replaceDraft, clearDraft, submitDraft };
}

async function activateControlBoundary(dataDir: string): Promise<void> {
  const state = new StateRepository(new EncryptedStore(dataDir, new MacOSKeychainKeyProvider()));
  const issued = await state.issueControlBoundary();
  await state.activateControlBoundary({
    expectedEpoch: issued.epoch,
    boundaryMessageId: issued.boundaryMessageId,
    markerOccurrenceCount: 1,
  });
}
