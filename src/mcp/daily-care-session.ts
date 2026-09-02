import { z } from "zod";

import { ASSISTANT_SIGNATURE } from "../assistant-identity.js";
import type {
  DailyCareClothingConcept,
  DailyCareKind,
  DailyCareTemperatureFacts,
} from "../daily-care/types.js";
import type { SameDayCareContext } from "../daily-care/types.js";

export interface DailyCareBeginResult {
  kind: DailyCareKind;
  target: "file-transfer";
  weatherRequired: boolean;
  bodyLength: { minimum: 60 | 120; maximum: 120 | 220 };
  signature: typeof ASSISTANT_SIGNATURE;
  maximumRegenerations: 2;
}

export interface DailyCareWeatherPublicResult {
  localDate: string;
  condition: string;
  temperature: DailyCareTemperatureFacts;
  rainExpected: boolean;
  clothingConcepts: readonly DailyCareClothingConcept[];
  checkedAt: string;
}

export interface DailyCareWeatherUnavailableResult {
  availability: "unavailable";
}

export interface DailyCareRuntimeDependencies {
  beginTestPreview(kind: DailyCareKind): Promise<DailyCareBeginResult>;
  researchMorningWeather(): Promise<DailyCareWeatherPublicResult>;
  prepareBroadcast(text: string): Promise<{ prepared: true; conversationId: "file-transfer" }>;
  verifyDraft(): Promise<{ draftVerified: true; conversationId: "file-transfer" }>;
  submitAuthorizedBroadcast(): Promise<{ submitted: true; conversationId: "file-transfer" }>;
  verifySend(): Promise<{ status: "verified"; conversationId: "file-transfer" }>;
  abortDraft(): Promise<{ aborted: true; conversationId: "file-transfer" }>;
  close(): Promise<void>;
}

export interface DailyCareProductionBeginResult {
  kind: DailyCareKind;
  weatherRequired: boolean;
  skillId: "daily-care-message-writing";
  bodyLength: { minimum: 60 | 120; maximum: 120 | 220 };
  signature: typeof ASSISTANT_SIGNATURE;
  maximumRegenerations: 2;
  sameDayCareContext?: SameDayCareContext;
  recoveredPhase?: "candidate-prepared" | "draft-verified";
}

export interface DailyCareProductionRuntimeDependencies {
  beginCurrentSlot(): Promise<DailyCareProductionBeginResult>;
  researchMorningWeather(): Promise<DailyCareWeatherPublicResult | DailyCareWeatherUnavailableResult>;
  prepareBroadcast(text: string): Promise<{ prepared: true }>;
  verifyDraft(): Promise<{ draftVerified: true }>;
  submitAuthorizedBroadcast(): Promise<{ submitted: true }>;
  verifySend(): Promise<{ status: "verified" }>;
  abortDraft(): Promise<{ aborted: true }>;
  close(): Promise<void>;
}

const commandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("begin-test-preview"), kind: z.enum(["morning", "night"]) }).strict(),
  z.object({ op: z.literal("research-morning-weather") }).strict(),
  z.object({ op: z.literal("prepare-broadcast"), text: z.string().min(1).max(1_000) }).strict(),
  z.object({ op: z.literal("verify-draft") }).strict(),
  z.object({ op: z.literal("submit-authorized-broadcast") }).strict(),
  z.object({ op: z.literal("verify-send") }).strict(),
  z.object({ op: z.literal("abort-draft") }).strict(),
  z.object({ op: z.literal("close") }).strict(),
]);

const productionCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("begin-current-slot") }).strict(),
  z.object({ op: z.literal("research-morning-weather") }).strict(),
  z.object({ op: z.literal("prepare-broadcast"), text: z.string().min(1).max(1_000) }).strict(),
  z.object({ op: z.literal("verify-draft") }).strict(),
  z.object({ op: z.literal("submit-authorized-broadcast") }).strict(),
  z.object({ op: z.literal("verify-send") }).strict(),
  z.object({ op: z.literal("abort-draft") }).strict(),
  z.object({ op: z.literal("close") }).strict(),
]);

type SessionPhase =
  | "idle"
  | "begun"
  | "researched"
  | "weather-unavailable"
  | "prepared"
  | "draft-verified"
  | "submitted"
  | "send-verified"
  | "closed";

export interface DailyCareSession {
  execute(command: unknown): Promise<unknown>;
  publicState(): Promise<{ phase: SessionPhase; kind: DailyCareKind | null }>;
}

export function createDailyCareSession(runtime: DailyCareRuntimeDependencies): DailyCareSession {
  let phase: SessionPhase = "idle";
  let kind: DailyCareKind | null = null;
  let closeRequested = false;
  let tail: Promise<void> = Promise.resolve();

  return { execute, publicState };

  function execute(value: unknown): Promise<unknown> {
    const command = commandSchema.parse(value);
    if (phase === "closed" || (closeRequested && command.op !== "close")) {
      return Promise.reject(new Error("DAILY_CARE_SESSION_CLOSED"));
    }
    if (command.op === "close") {
      if (closeRequested) return Promise.reject(new Error("DAILY_CARE_SESSION_CLOSED"));
      closeRequested = true;
    }
    const result = tail.then(() => dispatch(command), () => dispatch(command));
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function dispatch(command: z.infer<typeof commandSchema>): Promise<unknown> {
    switch (command.op) {
      case "begin-test-preview": {
        assertPhase("idle");
        const result = await runtime.beginTestPreview(command.kind);
        kind = command.kind;
        phase = "begun";
        return result;
      }
      case "research-morning-weather": {
        assertPhase("begun");
        if (kind !== "morning") throw new Error("DAILY_CARE_WEATHER_NOT_ALLOWED");
        const result = await runtime.researchMorningWeather();
        phase = "researched";
        return result;
      }
      case "prepare-broadcast": {
        if (kind === null || (kind === "morning" && phase !== "researched") ||
            (kind === "night" && phase !== "begun")) {
          throw new Error("DAILY_CARE_SEQUENCE_ERROR");
        }
        const result = await runtime.prepareBroadcast(command.text);
        phase = "prepared";
        return result;
      }
      case "verify-draft": {
        assertPhase("prepared");
        const result = await runtime.verifyDraft();
        phase = "draft-verified";
        return result;
      }
      case "submit-authorized-broadcast": {
        assertPhase("draft-verified");
        phase = "submitted";
        return runtime.submitAuthorizedBroadcast();
      }
      case "verify-send": {
        assertPhase("submitted");
        const result = await runtime.verifySend();
        phase = "send-verified";
        return result;
      }
      case "abort-draft": {
        assertPhase("prepared", "draft-verified");
        const result = await runtime.abortDraft();
        phase = "send-verified";
        return result;
      }
      case "close": {
        let abortError: unknown;
        if (phase === "prepared" || phase === "draft-verified") {
          try {
            await runtime.abortDraft();
          } catch (error: unknown) {
            abortError = error;
          }
        }
        try {
          await runtime.close();
        } finally {
          phase = "closed";
          kind = null;
        }
        if (abortError instanceof Error) throw abortError;
        if (abortError !== undefined) throw new Error("DAILY_CARE_ABORT_FAILED");
        return { closed: true as const };
      }
    }
  }

  function assertPhase(...allowed: SessionPhase[]): void {
    if (!allowed.includes(phase)) throw new Error("DAILY_CARE_SEQUENCE_ERROR");
  }

  async function publicState(): Promise<{ phase: SessionPhase; kind: DailyCareKind | null }> {
    await tail;
    return { phase, kind };
  }
}

export function createDailyCareProductionSession(
  runtime: DailyCareProductionRuntimeDependencies,
): DailyCareSession {
  let phase: SessionPhase = "idle";
  let kind: DailyCareKind | null = null;
  let closeRequested = false;
  let tail: Promise<void> = Promise.resolve();

  return { execute, publicState };

  function execute(value: unknown): Promise<unknown> {
    const command = productionCommandSchema.parse(value);
    if (phase === "closed" || (closeRequested && command.op !== "close")) {
      return Promise.reject(new Error("DAILY_CARE_SESSION_CLOSED"));
    }
    if (command.op === "close") {
      if (closeRequested) return Promise.reject(new Error("DAILY_CARE_SESSION_CLOSED"));
      closeRequested = true;
    }
    const result = tail.then(() => dispatch(command), () => dispatch(command));
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function dispatch(command: z.infer<typeof productionCommandSchema>): Promise<unknown> {
    switch (command.op) {
      case "begin-current-slot": {
        assertPhase("idle");
        const result = await runtime.beginCurrentSlot();
        kind = result.kind;
        phase = result.recoveredPhase === "candidate-prepared"
          ? "prepared"
          : result.recoveredPhase === "draft-verified"
            ? "draft-verified"
            : "begun";
        return result;
      }
      case "research-morning-weather": {
        assertPhase("begun");
        if (kind !== "morning") throw new Error("DAILY_CARE_WEATHER_NOT_ALLOWED");
        const result = await runtime.researchMorningWeather();
        phase = "availability" in result ? "weather-unavailable" : "researched";
        return result;
      }
      case "prepare-broadcast": {
        if (kind === "morning" && phase === "weather-unavailable") {
          throw new Error("DAILY_CARE_WEATHER_REQUIRED");
        }
        if (kind === null || (kind === "morning" && phase !== "researched") ||
            (kind === "night" && phase !== "begun")) {
          throw new Error("DAILY_CARE_SEQUENCE_ERROR");
        }
        const result = await runtime.prepareBroadcast(command.text);
        phase = "prepared";
        return result;
      }
      case "verify-draft": {
        assertPhase("prepared");
        const result = await runtime.verifyDraft();
        phase = "draft-verified";
        return result;
      }
      case "submit-authorized-broadcast": {
        assertPhase("draft-verified");
        phase = "submitted";
        return runtime.submitAuthorizedBroadcast();
      }
      case "verify-send": {
        assertPhase("submitted");
        const result = await runtime.verifySend();
        phase = "send-verified";
        return result;
      }
      case "abort-draft": {
        assertPhase("prepared", "draft-verified");
        const result = await runtime.abortDraft();
        phase = "send-verified";
        return result;
      }
      case "close": {
        let abortError: unknown;
        if (phase === "prepared" || phase === "draft-verified") {
          try {
            await runtime.abortDraft();
          } catch (error: unknown) {
            abortError = error;
          }
        }
        try {
          await runtime.close();
        } finally {
          phase = "closed";
          kind = null;
        }
        if (abortError instanceof Error) throw abortError;
        if (abortError !== undefined) throw new Error("DAILY_CARE_ABORT_FAILED");
        return { closed: true as const };
      }
    }
  }

  function assertPhase(...allowed: SessionPhase[]): void {
    if (!allowed.includes(phase)) throw new Error("DAILY_CARE_SEQUENCE_ERROR");
  }

  async function publicState(): Promise<{ phase: SessionPhase; kind: DailyCareKind | null }> {
    await tail;
    return { phase, kind };
  }
}
