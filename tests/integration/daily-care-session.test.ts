import { describe, expect, it, vi } from "vitest";

import {
  createDailyCareProductionSession,
  createDailyCareSession,
  type DailyCareProductionRuntimeDependencies,
  type DailyCareRuntimeDependencies,
} from "../../src/mcp/daily-care-session.js";

describe("daily-care session", () => {
  it("closes a production morning without preparing or submitting when system weather is unavailable", async () => {
    const runtime = {
      beginCurrentSlot: vi.fn().mockResolvedValue({
        kind: "morning" as const,
        weatherRequired: true,
        skillId: "daily-care-message-writing" as const,
        bodyLength: { minimum: 60 as const, maximum: 120 as const },
        signature: "——示例用户" as const,
        maximumRegenerations: 2 as const,
      }),
      researchMorningWeather: vi.fn().mockResolvedValue({ availability: "unavailable" as const }),
      prepareBroadcast: vi.fn().mockResolvedValue({ prepared: true as const }),
      verifyDraft: vi.fn(),
      submitAuthorizedBroadcast: vi.fn(),
      verifySend: vi.fn(),
      abortDraft: vi.fn().mockResolvedValue({ aborted: true as const }),
      close: vi.fn().mockResolvedValue(undefined),
    } satisfies DailyCareProductionRuntimeDependencies;
    const session = createDailyCareProductionSession(runtime);
    await session.execute({ op: "begin-current-slot" });

    await expect(session.execute({ op: "research-morning-weather" }))
      .resolves.toEqual({ availability: "unavailable" });
    await expect(session.execute({ op: "prepare-broadcast", text: "FALLBACK" }))
      .rejects.toThrow("DAILY_CARE_WEATHER_REQUIRED");
    await expect(session.execute({ op: "close" })).resolves.toEqual({ closed: true });
    expect(runtime.researchMorningWeather).toHaveBeenCalledTimes(1);
    expect(runtime.prepareBroadcast).not.toHaveBeenCalled();
    expect(runtime.submitAuthorizedBroadcast).not.toHaveBeenCalled();
  });

  it("does not call weather research for a production night", async () => {
    const runtime = {
      beginCurrentSlot: vi.fn().mockResolvedValue({
        kind: "night" as const,
        weatherRequired: false,
        skillId: "daily-care-message-writing" as const,
        bodyLength: { minimum: 120 as const, maximum: 220 as const },
        signature: "——示例用户" as const,
        maximumRegenerations: 2 as const,
      }),
      researchMorningWeather: vi.fn(),
      prepareBroadcast: vi.fn().mockResolvedValue({ prepared: true as const }),
      verifyDraft: vi.fn(), submitAuthorizedBroadcast: vi.fn(), verifySend: vi.fn(),
      abortDraft: vi.fn(), close: vi.fn().mockResolvedValue(undefined),
    } satisfies DailyCareProductionRuntimeDependencies;
    const session = createDailyCareProductionSession(runtime);
    await session.execute({ op: "begin-current-slot" });
    await session.execute({ op: "prepare-broadcast", text: "NIGHT" });
    expect(runtime.researchMorningWeather).not.toHaveBeenCalled();
  });

  it("continues from a hydrated draft-verified production phase without replaying prepare", async () => {
    const runtime = {
      beginCurrentSlot: vi.fn<DailyCareProductionRuntimeDependencies["beginCurrentSlot"]>()
        .mockResolvedValue({
          kind: "night",
          weatherRequired: false,
          skillId: "daily-care-message-writing",
          bodyLength: { minimum: 120, maximum: 220 },
          signature: "——示例用户",
          maximumRegenerations: 2,
          recoveredPhase: "draft-verified",
        }),
      researchMorningWeather: vi.fn(),
      prepareBroadcast: vi.fn(),
      verifyDraft: vi.fn(),
      submitAuthorizedBroadcast: vi.fn().mockResolvedValue({ submitted: true as const }),
      verifySend: vi.fn(),
      abortDraft: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } satisfies DailyCareProductionRuntimeDependencies;
    const session = createDailyCareProductionSession(runtime);

    await session.execute({ op: "begin-current-slot" });
    await expect(session.execute({ op: "submit-authorized-broadcast" }))
      .resolves.toEqual({ submitted: true });
    expect(runtime.prepareBroadcast).not.toHaveBeenCalled();
  });

  it("executes one morning file-transfer send in a strict order", async () => {
    const runtime = fakeRuntime();
    const session = createDailyCareSession(runtime);

    await expect(session.execute({ op: "begin-test-preview", kind: "morning" }))
      .resolves.toMatchObject({ kind: "morning", target: "file-transfer" });
    await expect(session.execute({ op: "research-morning-weather" }))
      .resolves.toMatchObject({
        condition: "多云",
        temperature: { kind: "range", highC: 32, lowC: 25 },
      });
    await expect(session.execute({ op: "prepare-broadcast", text: "PRIVATE_CANDIDATE" }))
      .resolves.toEqual({ prepared: true, conversationId: "file-transfer" });
    await expect(session.execute({ op: "verify-draft" }))
      .resolves.toEqual({ draftVerified: true, conversationId: "file-transfer" });
    await expect(session.execute({ op: "submit-authorized-broadcast" }))
      .resolves.toEqual({ submitted: true, conversationId: "file-transfer" });
    await expect(session.execute({ op: "verify-send" }))
      .resolves.toEqual({ status: "verified", conversationId: "file-transfer" });
    await expect(session.execute({ op: "close" })).resolves.toEqual({ closed: true });

    expect(runtime.submitAuthorizedBroadcast).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await session.publicState())).not.toContain("PRIVATE_CANDIDATE");
  });

  it("rejects out-of-order and replayed operations", async () => {
    const runtime = fakeRuntime();
    const session = createDailyCareSession(runtime);
    await expect(session.execute({ op: "prepare-broadcast", text: "x" }))
      .rejects.toThrow("DAILY_CARE_SEQUENCE_ERROR");
    await session.execute({ op: "begin-test-preview", kind: "night" });
    await expect(session.execute({ op: "research-morning-weather" }))
      .rejects.toThrow("DAILY_CARE_WEATHER_NOT_ALLOWED");
    await session.execute({ op: "prepare-broadcast", text: "PRIVATE_CANDIDATE" });
    await session.execute({ op: "verify-draft" });
    await session.execute({ op: "submit-authorized-broadcast" });
    await expect(session.execute({ op: "submit-authorized-broadcast" }))
      .rejects.toThrow("DAILY_CARE_SEQUENCE_ERROR");
  });

  it("serializes close behind an in-flight prepare and cannot be revived", async () => {
    let releasePrepare: (() => void) | undefined;
    const runtime = fakeRuntime();
    runtime.prepareBroadcast.mockImplementation(() => new Promise((resolve) => {
      releasePrepare = () => resolve({ prepared: true, conversationId: "file-transfer" });
    }));
    const session = createDailyCareSession(runtime);
    await session.execute({ op: "begin-test-preview", kind: "night" });
    const prepare = session.execute({ op: "prepare-broadcast", text: "PRIVATE_CANDIDATE" });
    const close = session.execute({ op: "close" });
    await vi.waitFor(() => expect(releasePrepare).toBeTypeOf("function"));
    releasePrepare?.();
    await expect(prepare).resolves.toEqual({ prepared: true, conversationId: "file-transfer" });
    await expect(close).resolves.toEqual({ closed: true });
    expect(runtime.abortDraft).toHaveBeenCalledTimes(1);
    await expect(session.execute({ op: "verify-draft" })).rejects.toThrow(
      "DAILY_CARE_SESSION_CLOSED",
    );
  });

  it("keeps a submit-started result uncertain when submit throws and never retries", async () => {
    const runtime = fakeRuntime();
    runtime.submitAuthorizedBroadcast.mockRejectedValueOnce(new Error("native private failure"));
    const session = createDailyCareSession(runtime);
    await session.execute({ op: "begin-test-preview", kind: "night" });
    await session.execute({ op: "prepare-broadcast", text: "PRIVATE_CANDIDATE" });
    await session.execute({ op: "verify-draft" });
    await expect(session.execute({ op: "submit-authorized-broadcast" })).rejects.toThrow(
      "native private failure",
    );
    await expect(session.execute({ op: "submit-authorized-broadcast" })).rejects.toThrow(
      "DAILY_CARE_SEQUENCE_ERROR",
    );
    expect(runtime.submitAuthorizedBroadcast).toHaveBeenCalledTimes(1);
  });
});

function fakeRuntime() {
  return {
    beginTestPreview: vi.fn<DailyCareRuntimeDependencies["beginTestPreview"]>()
      .mockImplementation((kind) => Promise.resolve({
        kind,
        target: "file-transfer",
        weatherRequired: kind === "morning",
        bodyLength: kind === "morning" ? { minimum: 60, maximum: 120 } : { minimum: 120, maximum: 220 },
        signature: "——示例用户",
        maximumRegenerations: 2,
      })),
    researchMorningWeather: vi.fn<DailyCareRuntimeDependencies["researchMorningWeather"]>()
      .mockResolvedValue({
        localDate: "2026-08-23",
        condition: "多云",
        temperature: { kind: "range", highC: 32, lowC: 25 },
        rainExpected: false,
        clothingConcepts: ["breathable", "sun-protection"],
        checkedAt: "2026-08-22T22:02:00.000Z",
      }),
    prepareBroadcast: vi.fn<DailyCareRuntimeDependencies["prepareBroadcast"]>()
      .mockResolvedValue({ prepared: true, conversationId: "file-transfer" }),
    verifyDraft: vi.fn<DailyCareRuntimeDependencies["verifyDraft"]>()
      .mockResolvedValue({ draftVerified: true, conversationId: "file-transfer" }),
    submitAuthorizedBroadcast: vi.fn<DailyCareRuntimeDependencies["submitAuthorizedBroadcast"]>()
      .mockResolvedValue({ submitted: true, conversationId: "file-transfer" }),
    verifySend: vi.fn<DailyCareRuntimeDependencies["verifySend"]>()
      .mockResolvedValue({ status: "verified", conversationId: "file-transfer" }),
    abortDraft: vi.fn<DailyCareRuntimeDependencies["abortDraft"]>()
      .mockResolvedValue({ aborted: true, conversationId: "file-transfer" }),
    close: vi.fn<DailyCareRuntimeDependencies["close"]>().mockResolvedValue(undefined),
  };
}
