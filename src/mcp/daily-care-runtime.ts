import { createHash, randomBytes } from "node:crypto";

import type { WeChatSurface } from "../adapters/wechat.js";
import {
  ALL_ASSISTANT_SIGNATURES,
  ASSISTANT_SIGNATURE,
} from "../assistant-identity.js";
import { validateBroadcastCandidate } from "../daily-care/message-policy.js";
import {
  createTestSlot,
  resolveExpiredProductionSlot,
  resolveProductionSlot,
} from "../daily-care/schedule.js";
import type {
  DailyCareKind,
  DailyCareSlot,
  DailyCareWeatherFacts,
  SameDayCareContext,
  SameDayCareSignal,
} from "../daily-care/types.js";
import type { DailyCareBroadcastRepository } from "../storage/daily-care-broadcast-repository.js";
import type {
  DailyCareProductionRuntimeDependencies,
  DailyCareRuntimeDependencies,
  DailyCareWeatherPublicResult,
  DailyCareWeatherUnavailableResult,
} from "./daily-care-session.js";

export interface CreateDailyCareRuntimeOptions {
  repository: DailyCareBroadcastRepository;
  surface: WeChatSurface;
  researchWeather(slot: DailyCareSlot): Promise<DailyCareWeatherFacts>;
  isStopped(): Promise<boolean>;
  release(): Promise<void>;
  now?: () => Date;
  txid?: () => string;
}

export interface CreateDailyCareProductionRuntimeOptions {
  repository: DailyCareBroadcastRepository;
  surface: WeChatSurface;
  researchWeather(slot: DailyCareSlot): Promise<DailyCareWeatherFacts>;
  isStopped(): Promise<boolean>;
  release(): Promise<void>;
  readSameDayCareContext?(input: {
    conversationId: "example-contact";
    localDate: string;
  }): Promise<SameDayCareContext>;
  now?: () => Date;
  sessionDeadlineMs?: number;
}

type RuntimePhase = "idle" | "begun" | "researched" | "prepared" | "draft-verified" | "submitted" | "verified" | "aborted";

export function createDailyCareRuntime(
  options: CreateDailyCareRuntimeOptions,
): DailyCareRuntimeDependencies {
  const now = options.now ?? (() => new Date());
  const txid = options.txid ?? (() => randomBytes(32).toString("hex"));
  let phase: RuntimePhase = "idle";
  let slot: DailyCareSlot | null = null;
  let weather: DailyCareWeatherFacts | null = null;
  let candidateText: string | null = null;
  let validationFailures = 0;
  let closed = false;
  let releasePromise: Promise<void> | null = null;

  return {
    beginTestPreview,
    researchMorningWeather,
    prepareBroadcast,
    verifyDraft,
    submitAuthorizedBroadcast,
    verifySend,
    abortDraft,
    close,
  };

  async function beginTestPreview(kind: DailyCareKind) {
    assertOpen();
    assertPhase("idle");
    const claimedSlot = createTestSlot(kind, now(), txid());
    await options.repository.claimSlot({
      slot: claimedSlot,
      targetConversationId: "file-transfer",
      targetModeHash: sha256("test:file-transfer"),
    });
    slot = claimedSlot;
    phase = "begun";
    return {
      kind,
      target: "file-transfer" as const,
      weatherRequired: kind === "morning",
      bodyLength: kind === "morning"
        ? { minimum: 60 as const, maximum: 120 as const }
        : { minimum: 60 as const, maximum: 120 as const },
      signature: ASSISTANT_SIGNATURE,
      maximumRegenerations: 2 as const,
    };
  }

  async function researchMorningWeather(): Promise<DailyCareWeatherPublicResult> {
    assertOpen();
    assertPhase("begun");
    const currentSlot = requireSlot();
    if (currentSlot.kind !== "morning") throw new Error("DAILY_CARE_WEATHER_NOT_ALLOWED");
    const researched = await options.researchWeather(currentSlot);
    if (researched.localDate !== currentSlot.localDate) {
      throw new Error("DAILY_CARE_WEATHER_DATE_MISMATCH");
    }
    weather = researched;
    phase = "researched";
    return publicWeather(researched);
  }

  async function prepareBroadcast(text: string) {
    assertOpen();
    const currentSlot = requireSlot();
    if ((currentSlot.kind === "morning" && phase !== "researched") ||
        (currentSlot.kind === "night" && phase !== "begun")) {
      if (currentSlot.kind === "morning" && weather === null) {
        throw new Error("DAILY_CARE_WEATHER_REQUIRED");
      }
      throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
    }
    await assertSendingAllowed();
    const recent = await options.repository.listRecentVerifiedTexts(currentSlot.kind, 14);
    let validated;
    try {
      validated = validateBroadcastCandidate({
        kind: currentSlot.kind,
        text: signCandidateAtRuntime(text),
        weather,
        recentVerifiedTexts: recent,
      });
    } catch (error: unknown) {
      validationFailures += 1;
      if (validationFailures >= 3) {
        await options.repository.markSkipped(currentSlot.slotKey, "candidate-validation-failed");
        phase = "aborted";
      }
      throw error instanceof Error ? error : new Error("BROADCAST_CANDIDATE_INVALID");
    }
    await options.repository.saveCandidate(currentSlot.slotKey, {
      text: validated.text,
      normalizedHash: validated.normalizedHash,
      weatherFactHash: weather?.factHash ?? null,
    });
    candidateText = validated.text;
    await options.surface.replaceDraft("file-transfer", validated.text, createToken());
    await assertExactDraft(validated.text);
    phase = "prepared";
    return { prepared: true as const, conversationId: "file-transfer" as const };
  }

  async function verifyDraft() {
    assertOpen();
    assertPhase("prepared");
    const text = requireCandidate();
    await assertExactDraft(text);
    await options.repository.markDraftVerified(requireSlot().slotKey);
    phase = "draft-verified";
    return { draftVerified: true as const, conversationId: "file-transfer" as const };
  }

  async function submitAuthorizedBroadcast() {
    assertOpen();
    assertPhase("draft-verified");
    await assertSendingAllowed();
    const text = requireCandidate();
    await assertExactDraft(text);
    await options.repository.markSubmitStarted(requireSlot().slotKey);
    phase = "submitted";
    await options.surface.submitDraft("file-transfer", createToken());
    return { submitted: true as const, conversationId: "file-transfer" as const };
  }

  async function verifySend() {
    assertOpen();
    assertPhase("submitted");
    const snapshot = await options.surface.locateConversation("file-transfer");
    assertFileTransferSnapshot(snapshot);
    const expected = normalizeLineEndings(requireCandidate());
    const latestOutgoing = [...snapshot.messages].reverse().find(({ direction }) => direction === "outgoing");
    if (latestOutgoing === undefined || normalizeLineEndings(latestOutgoing.text) !== expected) {
      throw new Error("DAILY_CARE_SEND_NOT_VERIFIED");
    }
    await options.repository.markVerified(requireSlot().slotKey);
    phase = "verified";
    return { status: "verified" as const, conversationId: "file-transfer" as const };
  }

  async function abortDraft() {
    assertOpen();
    if (phase !== "prepared" && phase !== "draft-verified") {
      throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
    }
    await options.surface.clearDraft("file-transfer", createToken());
    const snapshot = await options.surface.locateConversation("file-transfer");
    assertFileTransferSnapshot(snapshot);
    if (snapshot.composerEvidence !== "proven-empty" || snapshot.draftText !== "") {
      throw new Error("DAILY_CARE_DRAFT_CLEAR_NOT_VERIFIED");
    }
    await options.repository.markSkipped(requireSlot().slotKey, "aborted");
    phase = "aborted";
    candidateText = null;
    return { aborted: true as const, conversationId: "file-transfer" as const };
  }

  function close(): Promise<void> {
    if (releasePromise !== null) return releasePromise;
    closed = true;
    candidateText = null;
    weather = null;
    releasePromise = (async () => {
      let stateError: unknown;
      try {
        if ((phase === "begun" || phase === "researched") && slot !== null) {
          await options.repository.markSkipped(slot.slotKey, "session-closed-before-draft");
          phase = "aborted";
        }
      } catch (error: unknown) {
        stateError = error;
      }
      try {
        await options.release();
      } catch (releaseError: unknown) {
        if (stateError !== undefined) {
          throw new AggregateError(
            [asError(stateError), asError(releaseError)],
            "DAILY_CARE_CLOSE_FAILED",
          );
        }
        throw asError(releaseError);
      }
      if (stateError !== undefined) throw asError(stateError);
    })();
    return releasePromise;
  }

  async function assertExactDraft(expected: string): Promise<void> {
    const snapshot = await options.surface.locateConversation("file-transfer");
    assertFileTransferSnapshot(snapshot);
    if (snapshot.composerEvidence !== "meaningful-content" ||
        normalizeLineEndings(snapshot.draftText) !== normalizeLineEndings(expected)) {
      throw new Error("DAILY_CARE_DRAFT_NOT_VERIFIED");
    }
  }

  async function assertSendingAllowed(): Promise<void> {
    if (await options.isStopped()) throw new Error("SYSTEM_STOPPED");
  }

  function assertOpen(): void {
    if (closed) throw new Error("DAILY_CARE_RUNTIME_CLOSED");
  }

  function assertPhase(expected: RuntimePhase): void {
    if (phase !== expected) throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
  }

  function requireSlot(): DailyCareSlot {
    if (slot === null) throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
    return slot;
  }

  function requireCandidate(): string {
    if (candidateText === null) throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
    return candidateText;
  }
}

export function createDailyCareProductionRuntime(
  options: CreateDailyCareProductionRuntimeOptions,
): DailyCareProductionRuntimeDependencies {
  const now = options.now ?? (() => new Date());
  const sessionDeadlineMs = options.sessionDeadlineMs ?? 180_000;
  if (!Number.isFinite(sessionDeadlineMs) || sessionDeadlineMs <= 0 || sessionDeadlineMs > 180_000) {
    throw new Error("DAILY_CARE_SESSION_DEADLINE_INVALID");
  }
  let phase: RuntimePhase = "idle";
  let slot: DailyCareSlot | null = null;
  let weather: DailyCareWeatherFacts | null = null;
  let candidateText: string | null = null;
  let sameDayCareContext: SameDayCareContext | null = null;
  let validationFailures = 0;
  let closing = false;
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  let sessionStartedAt: number | null = null;
  let deadlineReached = false;
  let deadlineSignal: Promise<never> | null = null;
  let rejectDeadline: ((error: Error) => void) | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    beginCurrentSlot: () => enqueue(beginCurrentSlot),
    researchMorningWeather: () => enqueue(researchMorningWeather),
    prepareBroadcast: (text) => enqueue(() => prepareBroadcast(text)),
    verifyDraft: () => enqueue(verifyDraft),
    submitAuthorizedBroadcast: () => enqueue(submitAuthorizedBroadcast),
    verifySend: () => enqueue(verifySend),
    abortDraft: () => enqueue(abortDraft),
    close,
  };

  async function beginCurrentSlot() {
    assertPhase("idle");
    const observedAt = now();
    const currentSlot = resolveProductionSlot(observedAt);
    if (currentSlot === null) {
      const expiredSlot = resolveExpiredProductionSlot(observedAt);
      if (expiredSlot !== null) {
        await options.repository.terminalizeExpiredPendingSlot(expiredSlot);
      }
      throw new Error("DAILY_CARE_OUTSIDE_PRODUCTION_WINDOW");
    }
    const record = await options.repository.claimOrHydrateSlot({
      slot: currentSlot,
      targetConversationId: "example-contact",
      targetModeHash: sha256("production:example-contact"),
    });
    if (record.draftQuarantined) {
      options.repository.releaseSessionSlot(currentSlot.slotKey);
      throw new Error("DAILY_CARE_DRAFT_QUARANTINED");
    }
    if (record.status === "submitted-uncertain" || record.phase === "submit-started") {
      options.repository.releaseSessionSlot(currentSlot.slotKey);
      throw new Error("DAILY_CARE_SUBMITTED_UNCERTAIN");
    }
    if (record.status === "skipped" && record.skipReason === "retry-limit-exhausted") {
      options.repository.releaseSessionSlot(currentSlot.slotKey);
      throw new Error("DAILY_CARE_RETRY_LIMIT_EXHAUSTED");
    }
    if (record.status === "verified" || record.status === "skipped" || record.phase === "terminal") {
      options.repository.releaseSessionSlot(currentSlot.slotKey);
      throw new Error("DAILY_CARE_SLOT_TERMINAL");
    }
    slot = currentSlot;
    sessionStartedAt = now().getTime();
    startDeadlineTimer();
    if (currentSlot.kind === "night") {
      sameDayCareContext = record.sameDayCareContext ??
        await readAndPersistSameDayCareContext(currentSlot);
    }
    if (record.phase === "claimed") {
      phase = "begun";
    } else {
      if (record.candidateText === null || record.normalizedHash === null) {
        options.repository.releaseSessionSlot(currentSlot.slotKey);
        throw new Error("DAILY_CARE_RECOVERY_RECORD_INVALID");
      }
      if (currentSlot.kind === "night" &&
          record.careContextProofHash !== sameDayCareContext?.proofHash) {
        options.repository.releaseSessionSlot(currentSlot.slotKey);
        throw new Error("DAILY_CARE_CONTEXT_RECOVERY_MISMATCH");
      }
      candidateText = record.candidateText;
      phase = record.phase === "draft-verified" ? "draft-verified" : "prepared";
      if (phase === "prepared") await verifyOrRestorePreparedDraft();
    }
    return {
      kind: currentSlot.kind,
      weatherRequired: currentSlot.kind === "morning",
      skillId: "daily-care-message-writing" as const,
      bodyLength: currentSlot.kind === "morning"
        ? { minimum: 60 as const, maximum: 120 as const }
        : { minimum: 60 as const, maximum: 120 as const },
      signature: ASSISTANT_SIGNATURE,
      maximumRegenerations: 2 as const,
      ...(currentSlot.kind === "night" && sameDayCareContext !== null
        ? { sameDayCareContext }
        : {}),
      ...(record.phase === "claimed" ? {} : { recoveredPhase: record.phase }),
    };
  }

  async function researchMorningWeather(): Promise<
    DailyCareWeatherPublicResult | DailyCareWeatherUnavailableResult
  > {
    assertPhase("begun");
    const currentSlot = requireSlot();
    if (currentSlot.kind !== "morning") throw new Error("DAILY_CARE_WEATHER_NOT_ALLOWED");
    let researched: DailyCareWeatherFacts;
    try {
      researched = await options.researchWeather(currentSlot);
    } catch (error: unknown) {
      if (isPermanentWeatherFailure(error)) {
        await options.repository.markSkipped(currentSlot.slotKey, "weather-permanent");
        phase = "aborted";
        throw new Error("DAILY_CARE_WEATHER_PERMANENT", { cause: error });
      }
      weather = null;
      phase = "researched";
      return { availability: "unavailable" as const };
    }
    if (researched.localDate !== currentSlot.localDate) {
      await options.repository.markSkipped(currentSlot.slotKey, "weather-permanent");
      phase = "aborted";
      throw new Error("DAILY_CARE_WEATHER_PERMANENT");
    }
    weather = researched;
    phase = "researched";
    return publicWeather(researched);
  }

  async function prepareBroadcast(text: string) {
    const currentSlot = requireSlot();
    if ((currentSlot.kind === "morning" && phase !== "researched") ||
        (currentSlot.kind === "night" && phase !== "begun")) {
      if (currentSlot.kind === "morning" && weather === null) {
        throw new Error("DAILY_CARE_WEATHER_REQUIRED");
      }
      throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
    }
    await assertCurrentBoundary("prepare");
    await assertSendingAllowed();
    const recent = await options.repository.listRecentVerifiedTexts(currentSlot.kind, 14);
    let validated;
    try {
      validated = validateBroadcastCandidate({
        kind: currentSlot.kind,
        text: signCandidateAtRuntime(text),
        weather,
        recentVerifiedTexts: recent,
        sameDayCareContext: currentSlot.kind === "night" ? sameDayCareContext : null,
      });
    } catch (error: unknown) {
      validationFailures += 1;
      if (validationFailures >= 3) {
        await options.repository.markSkipped(currentSlot.slotKey, "candidate-validation-failed");
        phase = "aborted";
      }
      throw error instanceof Error ? error : new Error("BROADCAST_CANDIDATE_INVALID");
    }
    await options.repository.saveCandidate(currentSlot.slotKey, {
      text: validated.text,
      normalizedHash: validated.normalizedHash,
      weatherFactHash: weather?.factHash ?? null,
      careContextProofHash: currentSlot.kind === "night"
        ? sameDayCareContext?.proofHash ?? null
        : null,
    });
    candidateText = validated.text;
    phase = "prepared";
    bindDailyCareWriteContext(validated.text);
    await assertProductionConversation();
    await options.surface.replaceDraft("example-contact", validated.text, createToken());
    await assertExactProductionDraft(validated.text);
    return { prepared: true as const };
  }

  async function verifyDraft() {
    assertPhase("prepared");
    await assertCurrentBoundary("verify");
    await assertExactProductionDraft(requireCandidate());
    await options.repository.markDraftVerified(requireSlot().slotKey);
    phase = "draft-verified";
    return { draftVerified: true as const };
  }

  async function submitAuthorizedBroadcast() {
    assertPhase("draft-verified");
    await assertCurrentBoundary("submit");
    await assertSendingAllowed();
    await assertExactProductionDraft(requireCandidate());
    await options.repository.markSubmitStarted(requireSlot().slotKey);
    phase = "submitted";
    await options.surface.submitDraft("example-contact", createToken());
    return { submitted: true as const };
  }

  async function verifySend() {
    assertPhase("submitted");
    const snapshot = await options.surface.locateConversation("example-contact");
    assertProductionSnapshot(snapshot);
    const expected = normalizeLineEndings(requireCandidate());
    const latestOutgoing = [...snapshot.messages].reverse().find(({ direction }) => direction === "outgoing");
    if (latestOutgoing === undefined || normalizeLineEndings(latestOutgoing.text) !== expected) {
      throw new Error("DAILY_CARE_SEND_NOT_VERIFIED");
    }
    await options.repository.markVerified(requireSlot().slotKey);
    phase = "verified";
    return { status: "verified" as const };
  }

  async function abortDraft() {
    if (phase !== "prepared" && phase !== "draft-verified") {
      throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
    }
    await clearPreparedDraft("aborted");
    return { aborted: true as const };
  }

  function close(): Promise<void> {
    if (closePromise !== null) return closePromise;
    closing = true;
    closePromise = tail.then(closeAfterInflight, closeAfterInflight);
    tail = closePromise.then(() => undefined, () => undefined);
    return closePromise;
  }

  async function closeAfterInflight(): Promise<void> {
    let stateError: unknown;
    try {
      if ((phase === "begun" || phase === "researched") && slot !== null) {
        phase = "aborted";
      } else if (phase === "prepared" || phase === "draft-verified") {
        try {
          await clearPreparedDraft("session-closed-before-submit");
        } catch (error: unknown) {
          try {
            await options.repository.markDraftQuarantined(
              requireSlot().slotKey,
              "draft-clear-failed",
            );
          } catch (quarantineError: unknown) {
            throw new AggregateError(
              [asError(error), asError(quarantineError)],
              "DAILY_CARE_DRAFT_QUARANTINE_FAILED",
            );
          }
          throw error;
        }
      }
    } catch (error: unknown) {
      stateError = error;
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      deadlineTimer = null;
      candidateText = null;
      weather = null;
      sameDayCareContext = null;
    }
    try {
      await options.release();
    } catch (releaseError: unknown) {
      if (stateError !== undefined) {
        throw new AggregateError(
          [asError(stateError), asError(releaseError)],
          "DAILY_CARE_CLOSE_FAILED",
        );
      }
      throw asError(releaseError);
    }
    const closingSlot = slot;
    if (closingSlot !== null) options.repository.releaseSessionSlot(closingSlot.slotKey);
    slot = null;
    if (stateError !== undefined) throw asError(stateError);
  }

  async function clearPreparedDraft(reason: string): Promise<void> {
    await assertProductionConversation();
    await options.surface.clearDraft("example-contact", createToken());
    const snapshot = await options.surface.locateConversation("example-contact");
    assertProductionSnapshot(snapshot);
    if (snapshot.composerEvidence !== "proven-empty" || snapshot.draftText !== "") {
      throw new Error("DAILY_CARE_DRAFT_CLEAR_NOT_VERIFIED");
    }
    await options.repository.markSkipped(requireSlot().slotKey, reason);
    phase = "aborted";
    candidateText = null;
  }

  async function assertProductionConversation(): Promise<void> {
    const snapshot = await options.surface.locateConversation("example-contact");
    assertProductionSnapshot(snapshot);
  }

  async function assertExactProductionDraft(expected: string): Promise<void> {
    const snapshot = await options.surface.locateConversation("example-contact");
    assertProductionSnapshot(snapshot);
    if (snapshot.composerEvidence !== "meaningful-content" ||
        normalizeLineEndings(snapshot.draftText) !== normalizeLineEndings(expected)) {
      throw new Error("DAILY_CARE_DRAFT_NOT_VERIFIED");
    }
  }

  async function assertSendingAllowed(): Promise<void> {
    assertDeadline();
    if (await options.isStopped()) throw new Error("SYSTEM_STOPPED");
  }

  async function readAndPersistSameDayCareContext(
    currentSlot: DailyCareSlot,
  ): Promise<SameDayCareContext> {
    let context: SameDayCareContext;
    try {
      context = options.readSameDayCareContext === undefined
        ? unavailableSameDayCareContext(currentSlot.localDate)
        : validateSameDayCareContext(await options.readSameDayCareContext({
          conversationId: "example-contact",
          localDate: currentSlot.localDate,
        }), currentSlot.localDate);
    } catch {
      context = unavailableSameDayCareContext(currentSlot.localDate);
    }
    await options.repository.saveSameDayCareContext(currentSlot.slotKey, context);
    return context;
  }

  function assertPhase(expected: RuntimePhase): void {
    if (phase !== expected) throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
  }

  function requireSlot(): DailyCareSlot {
    if (slot === null) throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
    return slot;
  }

  function requireCandidate(): string {
    if (candidateText === null) throw new Error("DAILY_CARE_RUNTIME_SEQUENCE_ERROR");
    return candidateText;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) {
      return Promise.reject(new Error(deadlineReached
        ? "DAILY_CARE_SESSION_DEADLINE_EXCEEDED"
        : "DAILY_CARE_RUNTIME_CLOSED"));
    }
    const operationResult = tail.then(operation, operation);
    const result = deadlineSignal === null
      ? operationResult
      : Promise.race([operationResult, deadlineSignal]);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function startDeadlineTimer(): void {
    if (deadlineSignal !== null) return;
    deadlineSignal = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    void deadlineSignal.catch(() => undefined);
    deadlineTimer = setTimeout(() => {
      if (deadlineReached) return;
      deadlineReached = true;
      rejectDeadline?.(new Error("DAILY_CARE_SESSION_DEADLINE_EXCEEDED"));
      void close().catch(() => undefined);
    }, sessionDeadlineMs);
  }

  function assertDeadline(): void {
    const started = sessionStartedAt;
    if (deadlineReached || (started !== null && now().getTime() - started > sessionDeadlineMs)) {
      deadlineReached = true;
      throw new Error("DAILY_CARE_SESSION_DEADLINE_EXCEEDED");
    }
  }

  async function assertCurrentBoundary(boundary: "prepare" | "verify" | "submit"): Promise<void> {
    assertDeadline();
    const currentSlot = requireSlot();
    const resolved = resolveProductionSlot(now());
    if (resolved !== null && resolved.slotKey === currentSlot.slotKey) return;
    if (phase === "prepared" || phase === "draft-verified") {
      await clearPreparedDraft(`slot-expired-before-${boundary}`);
    } else {
      await options.repository.markSkipped(currentSlot.slotKey, `slot-expired-before-${boundary}`);
      phase = "aborted";
    }
    throw new Error("DAILY_CARE_SLOT_EXPIRED");
  }

  function bindDailyCareWriteContext(text: string): void {
    const binder = options.surface as WeChatSurface & {
      bindDailyCareWriteContext?: (context: {
        slotKey: string;
        candidateHash: string;
        expiresAt: string;
      }) => void;
    };
    const started = sessionStartedAt ?? now().getTime();
    binder.bindDailyCareWriteContext?.({
      slotKey: requireSlot().slotKey,
      candidateHash: sha256(normalizeLineEndings(text)),
      expiresAt: new Date(started + sessionDeadlineMs).toISOString(),
    });
  }

  async function verifyOrRestorePreparedDraft(): Promise<void> {
    await assertCurrentBoundary("prepare");
    await assertSendingAllowed();
    const text = requireCandidate();
    bindDailyCareWriteContext(text);
    const snapshot = await options.surface.locateConversation("example-contact");
    assertProductionSnapshot(snapshot);
    if (snapshot.composerEvidence === "meaningful-content" &&
        normalizeLineEndings(snapshot.draftText) === normalizeLineEndings(text)) {
      return;
    }
    if (snapshot.composerEvidence !== "proven-empty" || snapshot.draftText !== "") {
      await options.surface.clearDraft("example-contact", createToken());
      await options.repository.markDraftQuarantined(
        requireSlot().slotKey,
        "recovery-draft-mismatch",
      );
      throw new Error("DAILY_CARE_RECOVERY_DRAFT_MISMATCH");
    }
    await options.surface.replaceDraft("example-contact", text, createToken());
    await assertExactProductionDraft(text);
  }
}

function signCandidateAtRuntime(candidate: string): string {
  const normalized = candidate.normalize("NFC");
  if (normalized.length === 0 || normalized.includes("\n") || normalized.includes("\r") ||
      ALL_ASSISTANT_SIGNATURES.some((signature) => normalized.includes(signature))) {
    throw new Error("BROADCAST_CANDIDATE_SIGNATURE_FORBIDDEN");
  }
  return `${normalized}\n${ASSISTANT_SIGNATURE}`;
}

function assertFileTransferSnapshot(snapshot: Awaited<ReturnType<WeChatSurface["locateConversation"]>>): void {
  if (snapshot.conversationId !== "file-transfer" ||
      snapshot.identity.conversationId !== "file-transfer" ||
      snapshot.identity.visibleName !== "文件传输助手" ||
      snapshot.identity.confidence < 0.95) {
    throw new Error("DAILY_CARE_TARGET_IDENTITY_MISMATCH");
  }
}

function assertProductionSnapshot(snapshot: Awaited<ReturnType<WeChatSurface["locateConversation"]>>): void {
  if (snapshot.conversationId !== "example-contact" ||
      snapshot.identity.conversationId !== "example-contact" ||
      snapshot.identity.visibleName !== "示例联系人" ||
      snapshot.identity.confidence < 0.95) {
    throw new Error("DAILY_CARE_TARGET_IDENTITY_MISMATCH");
  }
}

const sameDayCareSignals = new Set<SameDayCareSignal>([
  "stated-discomfort",
  "expressed-fatigue",
  "requested-rest",
  "owner-already-sent-care",
]);

function validateSameDayCareContext(
  value: unknown,
  expectedLocalDate: string,
): SameDayCareContext {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Reflect.ownKeys(value).sort().join(",") !==
        "availability,explicitSignals,localDate,proofHash,safeExcerpts") {
    throw new Error("DAILY_CARE_CONTEXT_INVALID");
  }
  const record = value as Record<string, unknown>;
  const localDate = record.localDate;
  const availability = record.availability;
  const proofHash = record.proofHash;
  const rawSignals = record.explicitSignals;
  const rawExcerpts = record.safeExcerpts;
  if (localDate !== expectedLocalDate ||
      (availability !== "available" && availability !== "unavailable") ||
      typeof proofHash !== "string" || !/^[a-f0-9]{64}$/u.test(proofHash) ||
      !Array.isArray(rawSignals) || rawSignals.length > 4 ||
      !Array.isArray(rawExcerpts) || rawExcerpts.length > 3) {
    throw new Error("DAILY_CARE_CONTEXT_INVALID");
  }
  const explicitSignals: SameDayCareSignal[] = [];
  for (const signal of rawSignals) {
    if (typeof signal !== "string" || !sameDayCareSignals.has(signal as SameDayCareSignal)) {
      throw new Error("DAILY_CARE_CONTEXT_INVALID");
    }
    explicitSignals.push(signal as SameDayCareSignal);
  }
  const safeExcerpts: string[] = [];
  for (const excerpt of rawExcerpts) {
    if (typeof excerpt !== "string" || excerpt.length === 0 ||
        Array.from(excerpt).length > 80 || /[\r\n]/u.test(excerpt)) {
      throw new Error("DAILY_CARE_CONTEXT_INVALID");
    }
    safeExcerpts.push(excerpt);
  }
  if (new Set(explicitSignals).size !== explicitSignals.length ||
      (availability === "unavailable" &&
        (explicitSignals.length !== 0 || safeExcerpts.length !== 0)) ||
      (availability === "available" &&
        explicitSignals.length === 0 && safeExcerpts.length === 0)) {
    throw new Error("DAILY_CARE_CONTEXT_INVALID");
  }
  return Object.freeze({
    localDate,
    availability,
    explicitSignals: Object.freeze(explicitSignals),
    safeExcerpts: Object.freeze(safeExcerpts),
    proofHash,
  });
}

function unavailableSameDayCareContext(localDate: string): SameDayCareContext {
  return Object.freeze({
    localDate,
    availability: "unavailable" as const,
    explicitSignals: Object.freeze([]),
    safeExcerpts: Object.freeze([]),
    proofHash: sha256(`same-day-care-context\0${localDate}\0unavailable`),
  });
}

function publicWeather(weather: DailyCareWeatherFacts): DailyCareWeatherPublicResult {
  const temperature = weather.temperature.kind === "range"
    ? Object.freeze({
        kind: "range" as const,
        highC: weather.temperature.highC,
        lowC: weather.temperature.lowC,
      })
    : Object.freeze({ kind: "low-only" as const, lowC: weather.temperature.lowC });
  return Object.freeze({
    localDate: weather.localDate,
    condition: weather.condition,
    temperature,
    rainExpected: weather.rainExpected,
    clothingConcepts: Object.freeze([...weather.clothingConcepts]),
    checkedAt: weather.checkedAt,
  });
}

function normalizeLineEndings(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/gu, "\n");
}

function createToken(): string {
  return randomBytes(32).toString("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("DAILY_CARE_UNKNOWN_ERROR", { cause: error });
}

function isPermanentWeatherFailure(error: unknown): boolean {
  return error instanceof Error && [
    "DAILY_CARE_WEATHER_TIME_INVALID",
    "DAILY_CARE_WEATHER_NOT_ALLOWED",
  ].includes(error.message);
}
