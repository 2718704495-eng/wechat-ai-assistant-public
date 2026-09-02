import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  DailyCareKind,
  DailyCareSlot,
  SameDayCareContext,
} from "../daily-care/types.js";
import type { EncryptedStore } from "./encrypted-store.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const sameDayCareContextSchema = z.object({
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  availability: z.enum(["available", "unavailable"]),
  explicitSignals: z.array(z.enum([
    "stated-discomfort",
    "expressed-fatigue",
    "requested-rest",
    "owner-already-sent-care",
  ])).max(4),
  safeExcerpts: z.array(z.string().min(1).max(80).refine((value) => !/[\r\n]/u.test(value))).max(3),
  proofHash: hashSchema,
});
const slotRecordSchema = z.object({
  slotKey: z.string().min(1),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  kind: z.enum(["morning", "night"]),
  targetMode: z.enum(["production", "test"]),
  targetModeHash: hashSchema,
  status: z.enum(["pending", "submitted-uncertain", "verified", "skipped"]),
  phase: z.enum(["claimed", "candidate-prepared", "draft-verified", "submit-started", "terminal"]),
  candidateText: z.string().nullable(),
  normalizedHash: hashSchema.nullable(),
  weatherFactHash: hashSchema.nullable(),
  sameDayCareContext: sameDayCareContextSchema.nullable().default(null),
  careContextProofHash: hashSchema.nullable().default(null),
  createdAt: z.string().datetime(),
  submitStartedAt: z.string().datetime().nullable(),
  verifiedAt: z.string().datetime().nullable(),
  skipReason: z.string().nullable(),
  draftQuarantined: z.boolean().default(false),
  draftQuarantineReason: z.string().max(128).nullable().default(null),
  draftQuarantinedAt: z.string().datetime().nullable().default(null),
  sessionAttemptCount: z.number().int().min(0).max(3).default(0),
});
const broadcastStateSchema = z.object({
  version: z.literal(1),
  slots: z.array(slotRecordSchema),
});

export type DailyCareSlotRecord = z.infer<typeof slotRecordSchema>;

export interface ClaimDailyCareSlotInput {
  slot: DailyCareSlot;
  targetConversationId: "file-transfer" | "example-contact";
  targetModeHash: string;
}

export interface SavedCandidate {
  text: string;
  normalizedHash: string;
  weatherFactHash: string | null;
  careContextProofHash?: string | null;
}

const STATE_PATH = "state/daily-care-broadcasts.enc";
const STATE_LOCK_PATH = "state/daily-care-broadcasts.lock";

export class DailyCareBroadcastRepository {
  private queue: Promise<void> = Promise.resolve();
  private readonly activeSlots = new Set<string>();

  public constructor(
    private readonly store: EncryptedStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async claimSlot(input: ClaimDailyCareSlotInput): Promise<DailyCareSlotRecord> {
    validateClaim(input);
    const markerHash = sha256(input.slot.slotKey);
    const created = await this.store.createExclusiveMarker(
      `state/daily-care-claims/${markerHash}.claim`,
    );
    if (!created) {
      throw new Error("BROADCAST_SLOT_ALREADY_CLAIMED");
    }
    return this.exclusive(async () => {
      const state = await this.readState();
      if (state.slots.some(({ slotKey }) => slotKey === input.slot.slotKey)) {
        throw new Error("BROADCAST_SLOT_ALREADY_CLAIMED");
      }
      const createdAt = this.validNow();
      const record: DailyCareSlotRecord = {
        slotKey: input.slot.slotKey,
        localDate: input.slot.localDate,
        kind: input.slot.kind,
        targetMode: input.slot.targetMode,
        targetModeHash: input.targetModeHash,
        status: "pending",
        phase: "claimed",
        candidateText: null,
        normalizedHash: null,
        weatherFactHash: null,
        sameDayCareContext: null,
        careContextProofHash: null,
        createdAt,
        submitStartedAt: null,
        verifiedAt: null,
        skipReason: null,
        draftQuarantined: false,
        draftQuarantineReason: null,
        draftQuarantinedAt: null,
        sessionAttemptCount: 0,
      };
      state.slots.push(record);
      await this.store.write(STATE_PATH, state);
      return structuredClone(record);
    });
  }

  public async claimOrHydrateSlot(input: ClaimDailyCareSlotInput): Promise<DailyCareSlotRecord> {
    validateClaim(input);
    if (this.activeSlots.has(input.slot.slotKey)) throw new Error("BROADCAST_SLOT_ACTIVE");
    this.activeSlots.add(input.slot.slotKey);
    try {
      let record = await this.getSlot(input.slot.slotKey);
      if (record === null) {
        try {
          record = await this.claimSlot(input);
        } catch (error: unknown) {
          if (!(error instanceof Error) || error.message !== "BROADCAST_SLOT_ALREADY_CLAIMED") {
            throw error;
          }
          record = await this.getSlot(input.slot.slotKey);
          if (record === null) throw new Error("BROADCAST_CLAIM_RECORD_MISSING");
        }
      }
      if (record.localDate !== input.slot.localDate || record.kind !== input.slot.kind ||
          record.targetMode !== input.slot.targetMode || record.targetModeHash !== input.targetModeHash) {
        throw new Error("BROADCAST_SLOT_RECOVERY_MISMATCH");
      }
      return await this.startSessionAttempt(input.slot.slotKey);
    } catch (error: unknown) {
      this.activeSlots.delete(input.slot.slotKey);
      throw error;
    }
  }

  public releaseSessionSlot(slotKey: string): void {
    this.activeSlots.delete(slotKey);
  }

  public getSlot(slotKey: string): Promise<DailyCareSlotRecord | null> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const record = state.slots.find((candidate) => candidate.slotKey === slotKey);
      return record === undefined ? null : structuredClone(record);
    });
  }

  public listRecentVerifiedTexts(kind: DailyCareKind, limit = 14): Promise<string[]> {
    return this.exclusive(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 14) {
        throw new Error("BROADCAST_HISTORY_LIMIT_INVALID");
      }
      const state = await this.readState();
      return state.slots
        .filter((record) => record.kind === kind && record.status === "verified" &&
          record.candidateText !== null && record.verifiedAt !== null)
        .sort((a, b) => (b.verifiedAt ?? "").localeCompare(a.verifiedAt ?? ""))
        .slice(0, limit)
        .map((record) => record.candidateText as string);
    });
  }

  public saveCandidate(slotKey: string, input: SavedCandidate): Promise<void> {
    return this.update(slotKey, (record) => {
      validateHash(input.normalizedHash, "BROADCAST_CANDIDATE_HASH_INVALID");
      if (input.weatherFactHash !== null) {
        validateHash(input.weatherFactHash, "BROADCAST_WEATHER_HASH_INVALID");
      }
      const contextProofHash = input.careContextProofHash ?? null;
      if (contextProofHash !== null) {
        validateHash(contextProofHash, "BROADCAST_CARE_CONTEXT_HASH_INVALID");
      }
      if (record.targetMode === "production" && record.kind === "night" &&
          (record.sameDayCareContext === null ||
           record.sameDayCareContext.proofHash !== contextProofHash)) {
        throw new Error("BROADCAST_CARE_CONTEXT_MISMATCH");
      }
      if (record.kind === "morning" && contextProofHash !== null) {
        throw new Error("BROADCAST_CARE_CONTEXT_NOT_ALLOWED");
      }
      if (record.phase === "candidate-prepared") {
        if (record.candidateText === input.text && record.normalizedHash === input.normalizedHash &&
            record.weatherFactHash === input.weatherFactHash &&
            record.careContextProofHash === contextProofHash) {
          return;
        }
        throw new Error("BROADCAST_CANDIDATE_CONFLICT");
      }
      this.assertPendingPhase(record, "claimed");
      record.candidateText = input.text;
      record.normalizedHash = input.normalizedHash;
      record.weatherFactHash = input.weatherFactHash;
      record.careContextProofHash = contextProofHash;
      record.phase = "candidate-prepared";
    });
  }

  public saveSameDayCareContext(slotKey: string, input: SameDayCareContext): Promise<void> {
    return this.update(slotKey, (record) => {
      const validated = sameDayCareContextSchema.parse(input);
      if (record.targetMode !== "production" || record.kind !== "night" ||
          validated.localDate !== record.localDate) {
        throw new Error("BROADCAST_CARE_CONTEXT_INVALID");
      }
      if (validated.availability === "unavailable" &&
          (validated.explicitSignals.length !== 0 || validated.safeExcerpts.length !== 0)) {
        throw new Error("BROADCAST_CARE_CONTEXT_INVALID");
      }
      if (record.sameDayCareContext !== null) {
        if (JSON.stringify(record.sameDayCareContext) === JSON.stringify(validated)) return;
        throw new Error("BROADCAST_CARE_CONTEXT_CONFLICT");
      }
      record.sameDayCareContext = validated;
    });
  }

  public markDraftVerified(slotKey: string): Promise<void> {
    return this.update(slotKey, (record) => {
      this.assertPendingPhase(record, "candidate-prepared");
      record.phase = "draft-verified";
    });
  }

  public markSubmitStarted(slotKey: string): Promise<void> {
    return this.update(slotKey, (record) => {
      this.assertPendingPhase(record, "draft-verified");
      record.phase = "submit-started";
      record.status = "submitted-uncertain";
      record.submitStartedAt = this.validNow();
    });
  }

  public markVerified(slotKey: string): Promise<void> {
    return this.update(slotKey, (record) => {
      if (record.status === "verified" || record.status === "skipped") {
        throw new Error("BROADCAST_SLOT_TERMINAL");
      }
      if (record.phase !== "submit-started" || record.status !== "submitted-uncertain") {
        throw new Error("BROADCAST_SLOT_PHASE_INVALID");
      }
      record.status = "verified";
      record.phase = "terminal";
      record.verifiedAt = this.validNow();
    });
  }

  public markSkipped(slotKey: string, reason: string): Promise<void> {
    return this.update(slotKey, (record) => {
      if (reason.length === 0 || reason.length > 128) {
        throw new Error("BROADCAST_SKIP_REASON_INVALID");
      }
      if (record.status !== "pending") {
        throw new Error("BROADCAST_SLOT_TERMINAL");
      }
      record.status = "skipped";
      record.phase = "terminal";
      record.skipReason = reason;
    });
  }

  public terminalizeExpiredPendingSlot(slot: DailyCareSlot): Promise<DailyCareSlotRecord | null> {
    if (slot.targetMode !== "production" || slot.slotKey !== `${slot.localDate}/${slot.kind}`) {
      return Promise.reject(new Error("BROADCAST_PRODUCTION_SLOT_INVALID"));
    }
    return this.exclusive(async () => {
      const state = await this.readState();
      const record = state.slots.find((candidate) => candidate.slotKey === slot.slotKey);
      if (record === undefined) return null;
      if (record.localDate !== slot.localDate || record.kind !== slot.kind ||
          record.targetMode !== "production") {
        throw new Error("BROADCAST_SLOT_RECOVERY_MISMATCH");
      }
      if (record.status === "pending") {
        record.status = "skipped";
        record.phase = "terminal";
        record.skipReason = "grace-expired";
        await this.store.write(STATE_PATH, state);
      }
      return structuredClone(record);
    });
  }

  public markDraftQuarantined(slotKey: string, reason: string): Promise<void> {
    return this.update(slotKey, (record) => {
      if (reason.length === 0 || reason.length > 128) {
        throw new Error("BROADCAST_QUARANTINE_REASON_INVALID");
      }
      record.draftQuarantined = true;
      record.draftQuarantineReason = reason;
      record.draftQuarantinedAt = this.validNow();
    });
  }

  public clearDraftQuarantine(slotKey: string): Promise<void> {
    return this.update(slotKey, (record) => {
      if (!record.draftQuarantined) throw new Error("BROADCAST_DRAFT_NOT_QUARANTINED");
      record.draftQuarantined = false;
      record.draftQuarantineReason = null;
      record.draftQuarantinedAt = null;
    });
  }

  private update(slotKey: string, mutate: (record: DailyCareSlotRecord) => void): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const record = state.slots.find((candidate) => candidate.slotKey === slotKey);
      if (record === undefined) {
        throw new Error("BROADCAST_SLOT_NOT_FOUND");
      }
      if (record.status === "verified" || record.status === "skipped") {
        throw new Error("BROADCAST_SLOT_TERMINAL");
      }
      mutate(record);
      await this.store.write(STATE_PATH, state);
    });
  }

  private startSessionAttempt(slotKey: string): Promise<DailyCareSlotRecord> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const record = state.slots.find((candidate) => candidate.slotKey === slotKey);
      if (record === undefined) throw new Error("BROADCAST_SLOT_NOT_FOUND");
      if (record.status !== "pending" || record.phase === "submit-started" ||
          record.phase === "terminal") {
        return structuredClone(record);
      }
      if (record.sessionAttemptCount >= 3) {
        record.status = "skipped";
        record.phase = "terminal";
        record.skipReason = "retry-limit-exhausted";
      } else {
        record.sessionAttemptCount += 1;
      }
      await this.store.write(STATE_PATH, state);
      return structuredClone(record);
    });
  }

  private assertPendingPhase(record: DailyCareSlotRecord, expected: DailyCareSlotRecord["phase"]): void {
    if (record.status !== "pending" || record.phase !== expected) {
      throw new Error("BROADCAST_SLOT_PHASE_INVALID");
    }
  }

  private async readState(): Promise<z.infer<typeof broadcastStateSchema>> {
    return (await this.store.read(STATE_PATH, broadcastStateSchema)) ?? { version: 1, slots: [] };
  }

  private validNow(): string {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("DAILY_CARE_NOW_INVALID");
    return now.toISOString();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = () => this.store.runExclusiveTransaction(STATE_LOCK_PATH, operation);
    const result = this.queue.then(guarded, guarded);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateClaim(input: ClaimDailyCareSlotInput): void {
  validateHash(input.targetModeHash, "BROADCAST_TARGET_HASH_INVALID");
  if (input.slot.targetMode === "test" && input.targetConversationId !== "file-transfer") {
    throw new Error("BROADCAST_TEST_TARGET_INVALID");
  }
  if (input.slot.targetMode === "production" && input.targetConversationId !== "example-contact") {
    throw new Error("BROADCAST_PRODUCTION_TARGET_INVALID");
  }
  if (input.slot.targetMode === "test" && !/^test\/[a-f0-9]{64}$/u.test(input.slot.slotKey)) {
    throw new Error("BROADCAST_TEST_SLOT_INVALID");
  }
  if (input.slot.targetMode === "production" &&
      input.slot.slotKey !== `${input.slot.localDate}/${input.slot.kind}`) {
    throw new Error("BROADCAST_PRODUCTION_SLOT_INVALID");
  }
}

function validateHash(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
