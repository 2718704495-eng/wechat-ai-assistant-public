import { validateUnsignedBroadcastCandidate } from "../daily-care/message-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { acquireKernelLease } from "../storage/kernel-lock.js";
import { resolveProductionSlot } from "../daily-care/schedule.js";
import type {
  DailyCareKind,
  DailyCareSlot,
  DailyCareWeatherFacts,
} from "../daily-care/types.js";
import {
  SingleDispatcherAdmission as DispatcherAdmission,
  type DispatcherOwner,
  type SingleDispatcherAdmission,
} from "./single-dispatcher-admission.js";
import {
  assertAuthorizedWechatTarget,
  assertContactDirectory,
  ContactDirectory,
  type AuthorizedWechatTarget,
} from "../contacts/contact-directory.js";
import {
  replyIntentSchema,
  type ReplyIntent,
} from "../conversation/personal-account-contract.js";
import {
  consumePreparedReplyClaim,
  type PreparedReplyClaim,
  type PreparedReplyClaimPayload,
} from "../conversation/realtime-reply-service.js";
import type { NativeAuthorizedConversationSnapshot } from "../adapters/native-wechat-surface.js";
import type { NativeSubmitConversationProof } from "../adapters/native-bridge.js";
import type {
  RealtimeReadbackBaseline,
  RealtimeReplyStateRepository,
} from "../storage/repositories.js";
import {
  acquireSharedLiveProductionRuntimeLease,
  type SharedLiveProductionRuntime,
} from "../mcp/live-bootstrap.js";

export const DAILY_CARE_WRITING_SKILL_ID =
  "daily-care-message-writing" as const;

export type P0SlotStatus =
  "pending" | "submitted-uncertain" | "verified" | "skipped";
export type ScheduledLane = "p0" | "p1" | "outside";

export interface P0SlotInspection {
  readonly status: P0SlotStatus;
}

export interface DailyCareCandidateGeneratorInput {
  readonly skillId: typeof DAILY_CARE_WRITING_SKILL_ID;
  readonly kind: DailyCareKind;
  readonly recentVerifiedTexts: readonly string[];
  readonly verifiedWeatherFacts: DailyCareWeatherFacts | null;
}

export interface DailyCareCandidateGenerator {
  readonly generate: (
    input: DailyCareCandidateGeneratorInput,
  ) => Promise<string>;
}

interface ScheduledP0Owner extends DispatcherOwner {
  readonly lane: "p0";
  readonly kind: DailyCareKind;
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

interface ScheduledP1DeliveryOperations {
  prepare(input: {
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
  }): Promise<{ readonly candidateToken: string }>;
  verifyDraft(candidateToken: string): Promise<unknown>;
  submit(input: {
    readonly candidateToken: string;
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
    readonly markSubmitStarted: () => Promise<boolean>;
    readonly signal: AbortSignal;
    readonly conversationProof: NativeSubmitConversationProof;
  }): Promise<{ readonly attempted: true } | { readonly attempted: false }>;
  verifySend(input: {
    readonly candidateToken: string;
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
  }): Promise<{ readonly status: "verified" | "submitted-uncertain" }>;
  readbackSubmitted(input: {
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
    readonly readbackBaseline: RealtimeReadbackBaseline | null;
  }): Promise<"verified" | "submitted-uncertain">;
}

interface ScheduledP1OwnerInput {
  readonly readLatest: ScheduledP1Owner["readLatest"];
  readonly replyToLatestIncomingOnce: ScheduledP1Owner["replyToLatestIncomingOnce"];
  readonly close: ScheduledP1Owner["close"];
  readonly deliveryOperations: ScheduledP1DeliveryOperations;
  readonly markSubmitStarted: ScheduledP1AdmissionOperations["markSubmitStarted"];
  readonly runPhase: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface ScheduledP1OwnerRecord {
  readonly deliveryOperations: ScheduledP1DeliveryOperations;
  readonly markSubmitStarted: ScheduledP1AdmissionOperations["markSubmitStarted"];
  readonly runPhase: <T>(operation: () => Promise<T>) => Promise<T>;
  operationTail: Promise<void>;
  active: boolean;
}

const scheduledP1OwnerRecords = new WeakMap<object, ScheduledP1OwnerRecord>();

function createScheduledP1Owner(
  input: ScheduledP1OwnerInput,
): ScheduledP1Owner {
  let closePromise: Promise<{ readonly gateReleased: boolean }> | null = null;
  const owner: ScheduledP1Owner = Object.freeze({
    lane: "p1",
    readLatest: () => runScheduledP1Phase(owner, input.readLatest),
    replyToLatestIncomingOnce: () =>
      runScheduledP1Phase(owner, input.replyToLatestIncomingOnce),
    close: () => {
      const record = scheduledP1OwnerRecords.get(owner);
      if (record !== undefined) record.active = false;
      closePromise ??= (record?.operationTail ?? Promise.resolve()).then(
        input.close,
      );
      return closePromise;
    },
  });
  scheduledP1OwnerRecords.set(owner, {
    deliveryOperations: Object.freeze({
      prepare: input.deliveryOperations.prepare.bind(input.deliveryOperations),
      verifyDraft: input.deliveryOperations.verifyDraft.bind(
        input.deliveryOperations,
      ),
      submit: input.deliveryOperations.submit.bind(input.deliveryOperations),
      verifySend: input.deliveryOperations.verifySend.bind(
        input.deliveryOperations,
      ),
      readbackSubmitted: input.deliveryOperations.readbackSubmitted.bind(
        input.deliveryOperations,
      ),
    }),
    markSubmitStarted: input.markSubmitStarted,
    runPhase: input.runPhase,
    operationTail: Promise.resolve(),
    active: true,
  });
  return owner;
}

function runScheduledP1Phase<T>(
  owner: ScheduledP1Owner,
  operation: () => Promise<T>,
): Promise<T> {
  const record = requireScheduledP1OwnerRecord(owner);
  const result = record.operationTail.then(() => {
    if (!record.active) {
      throw new Error("SCHEDULED_P1_OWNER_CAPABILITY_INVALID");
    }
    return record.runPhase(operation);
  });
  record.operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function requireScheduledP1DeliveryOperations(
  owner: ScheduledP1Owner,
): ScheduledP1DeliveryOperations {
  const record = scheduledP1OwnerRecords.get(owner);
  if (record === undefined || !record.active) {
    throw new Error("SCHEDULED_P1_OWNER_CAPABILITY_INVALID");
  }
  return record.deliveryOperations;
}

interface ScheduledP1AdmissionOperations {
  readonly readLatest: ScheduledP1Owner["readLatest"];
  readonly replyToLatestIncomingOnce: ScheduledP1Owner["replyToLatestIncomingOnce"];
  readonly close: ScheduledP1Owner["close"];
  readonly delivery: ScheduledP1DeliveryOperations;
  readonly markSubmitStarted: (input: {
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
    readonly readbackBaseline: RealtimeReadbackBaseline;
  }) => Promise<boolean>;
  readonly runPhase: <T>(operation: () => Promise<T>) => Promise<T>;
}

function createScheduledP1DispatcherAdmission(input: {
  readonly acquireP1Operations: () => Promise<ScheduledP1AdmissionOperations>;
  readonly hasPendingPriorityLane?: (
    lane: "p0" | "p1" | "acceptance",
  ) => Promise<boolean>;
}): SingleDispatcherAdmission<DispatcherOwner> {
  return new DispatcherAdmission<DispatcherOwner>({
    hasPendingPriorityLane: input.hasPendingPriorityLane,
    acquireOwner: async (lane) => {
      if (lane !== "p1") {
        return { close: () => Promise.resolve({ gateReleased: true }) };
      }
      const operations = await input.acquireP1Operations();
      return createScheduledP1Owner({
        readLatest: operations.readLatest,
        replyToLatestIncomingOnce: operations.replyToLatestIncomingOnce,
        close: operations.close,
        deliveryOperations: operations.delivery,
        markSubmitStarted: operations.markSubmitStarted,
        runPhase: operations.runPhase,
      });
    },
  });
}

interface ProductionScheduledP1Surface {
  prepareAuthorizedTextDraft(input: {
    readonly contactId: AuthorizedWechatTarget["contactId"];
    readonly expectedRevision: number;
    readonly text: string;
    readonly slotKey: string;
  }): Promise<unknown>;
  submitAuthorizedTextDraft(input: {
    readonly contactId: AuthorizedWechatTarget["contactId"];
    readonly expectedRevision: number;
    readonly markSubmitStarted: () => Promise<boolean>;
    readonly signal: AbortSignal;
    readonly conversationProof: NativeSubmitConversationProof;
  }): Promise<{ readonly attempted: boolean }>;
}

const scheduledP1DeliverySessionBrand: unique symbol = Symbol(
  "scheduled-p1-delivery-session",
);

interface ScheduledP1DeliverySession {
  readonly [scheduledP1DeliverySessionBrand]: true;
}

interface ProductionScheduledP1Composition {
  readonly admission: SingleDispatcherAdmission<DispatcherOwner>;
  readonly deliverySession: ScheduledP1DeliverySession;
}

interface ScheduledP1PhaseLease {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const scheduledP1DeliverySessions = new WeakMap<
  ScheduledP1DeliverySession,
  SingleDispatcherAdmission<DispatcherOwner>
>();

/** Production P1 composition with fixed phases and a repository-owned submit fence. */
function createProductionScheduledP1DispatcherAdmission(input: {
  readonly getSurface: () => ProductionScheduledP1Surface;
  readonly repository: Pick<RealtimeReplyStateRepository, "compareAndSet">;
  readonly now: () => Date;
  readonly readbackSubmitted: ScheduledP1DeliveryOperations["readbackSubmitted"];
  readonly hasPendingPriorityLane?: (
    lane: "p0" | "p1" | "acceptance",
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly acquirePhaseLease?: () => ScheduledP1PhaseLease;
}): ProductionScheduledP1Composition {
  const admission = createScheduledP1DispatcherAdmission({
    hasPendingPriorityLane: input.hasPendingPriorityLane,
    acquireP1Operations: () => {
      const phaseLease = input.acquirePhaseLease?.();
      return Promise.resolve({
        readLatest: () =>
          Promise.reject(new Error("REALTIME_OWNER_DIRECT_REPLY_FORBIDDEN")),
        replyToLatestIncomingOnce: () =>
          Promise.reject(new Error("REALTIME_OWNER_DIRECT_REPLY_FORBIDDEN")),
        delivery: productionP1DeliveryOperations(
          input.getSurface,
          input.readbackSubmitted,
        ),
        markSubmitStarted: ({ target, intent, readbackBaseline }) =>
          input.repository.compareAndSet({
            key: {
              contactId: target.contactId,
              contactRevision: target.revision,
              bindingHash: target.bindingHash,
              triggerId: intent.triggerId,
            },
            expectedStatus: "prepared",
            next: { status: "submit-started", readbackBaseline },
            now: input.now(),
          }),
        runPhase: <T>(operation: () => Promise<T>) =>
          phaseLease?.runExclusive(operation) ?? operation(),
        close: async () => {
          await phaseLease?.close();
          return { gateReleased: true };
        },
      });
    },
  });
  const deliverySession = Object.freeze({
    [scheduledP1DeliverySessionBrand]: true as const,
  });
  scheduledP1DeliverySessions.set(deliverySession, admission);
  return Object.freeze({ admission, deliverySession });
}

function productionP1DeliveryOperations(
  getSurface: () => ProductionScheduledP1Surface,
  readbackSubmitted: ScheduledP1DeliveryOperations["readbackSubmitted"],
): ScheduledP1DeliveryOperations {
  let prepared: {
    readonly candidateToken: string;
    readonly contactId: string;
    readonly contactRevision: number;
    readonly deliveryKey: string;
    readonly replyText: string;
  } | null = null;
  let draftVerified = false;
  let submitAttempted = false;
  let nativeSubmitVerified = false;
  const operations: ScheduledP1DeliveryOperations = {
    prepare: async ({ target, intent }) => {
      if (prepared !== null)
        throw new Error("REALTIME_OWNER_DRAFT_ALREADY_PREPARED");
      await getSurface().prepareAuthorizedTextDraft({
        contactId: target.contactId,
        expectedRevision: target.revision,
        text: intent.replyText,
        slotKey: `non-daily/${intent.deliveryKey}`,
      });
      prepared = {
        candidateToken: intent.deliveryKey,
        contactId: target.contactId,
        contactRevision: target.revision,
        deliveryKey: intent.deliveryKey,
        replyText: intent.replyText,
      };
      return { candidateToken: intent.deliveryKey };
    },
    verifyDraft: (candidateToken) => {
      const current = requirePreparedReply(prepared, candidateToken);
      if (current.deliveryKey !== candidateToken) {
        return Promise.reject(
          new Error("REALTIME_OWNER_DRAFT_IDENTITY_INVALID"),
        );
      }
      draftVerified = true;
      return Promise.resolve({ verified: true });
    },
    submit: async ({
      candidateToken,
      target,
      intent,
      markSubmitStarted,
      signal,
      conversationProof,
    }) => {
      const current = requirePreparedReply(prepared, candidateToken);
      assertPreparedReplyMatches(
        current,
        target.contactId,
        target.revision,
        intent.deliveryKey,
        intent.replyText,
      );
      if (!draftVerified || submitAttempted) {
        throw new Error("REALTIME_OWNER_DRAFT_NOT_VERIFIED");
      }
      try {
        const receipt = await getSurface().submitAuthorizedTextDraft({
          contactId: target.contactId,
          expectedRevision: target.revision,
          signal,
          conversationProof,
          markSubmitStarted: async () => {
            const marked = await markSubmitStarted();
            submitAttempted = marked;
            return marked;
          },
        });
        if (!receipt.attempted) return { attempted: false as const };
        nativeSubmitVerified = true;
      } catch (error: unknown) {
        if (!submitAttempted) throw error;
        return { attempted: true as const };
      }
      return { attempted: true as const };
    },
    verifySend: ({ candidateToken, target, intent }) => {
      const current = requirePreparedReply(prepared, candidateToken);
      assertPreparedReplyMatches(
        current,
        target.contactId,
        target.revision,
        intent.deliveryKey,
        intent.replyText,
      );
      if (!submitAttempted) {
        return Promise.reject(new Error("REALTIME_OWNER_SUBMIT_NOT_ATTEMPTED"));
      }
      return Promise.resolve({
        status: nativeSubmitVerified
          ? ("verified" as const)
          : ("submitted-uncertain" as const),
      });
    },
    readbackSubmitted,
  };
  return Object.freeze(operations);
}

function requirePreparedReply<T>(
  prepared: T | null,
  candidateToken: string,
): T & {
  readonly candidateToken: string;
} {
  if (
    prepared === null ||
    (prepared as { readonly candidateToken?: string }).candidateToken !==
      candidateToken
  ) {
    throw new Error("REALTIME_OWNER_DRAFT_IDENTITY_INVALID");
  }
  return prepared as T & { readonly candidateToken: string };
}

function assertPreparedReplyMatches(
  prepared: {
    readonly contactId: string;
    readonly contactRevision: number;
    readonly deliveryKey: string;
    readonly replyText: string;
  },
  contactId: string,
  contactRevision: number,
  deliveryKey: string,
  replyText: string,
): void {
  if (
    prepared.contactId !== contactId ||
    prepared.contactRevision !== contactRevision ||
    prepared.deliveryKey !== deliveryKey ||
    prepared.replyText !== replyText
  ) {
    throw new Error("REALTIME_OWNER_DRAFT_IDENTITY_INVALID");
  }
}

async function deliverScheduledP1(
  owner: ScheduledP1Owner,
  input: {
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
    readonly signal: AbortSignal;
  },
  beforeSubmit: () => Promise<RealtimeReadbackBaseline>,
  beforeFence: () => Promise<NativeSubmitConversationProof>,
  claimFence: PreparedReplyClaimPayload["markSubmitStarted"],
): Promise<{
  readonly status: "verified" | "submitted-uncertain";
  readonly submitCount: 1;
}> {
  const record = requireScheduledP1OwnerRecord(owner);
  requireScheduledP1OwnerRecord(owner);
  const prepared = await runScheduledP1Phase(owner, () =>
    record.deliveryOperations.prepare(input),
  );
  requireScheduledP1OwnerRecord(owner);
  if (!/^[a-f0-9]{64}$/u.test(prepared.candidateToken)) {
    throw new Error("MCP_DELIVERY_CANDIDATE_INVALID");
  }
  requireScheduledP1OwnerRecord(owner);
  await runScheduledP1Phase(owner, () =>
    record.deliveryOperations.verifyDraft(prepared.candidateToken),
  );
  requireScheduledP1OwnerRecord(owner);
  const readbackBaseline = await runScheduledP1Phase(owner, beforeSubmit);
  requireScheduledP1OwnerRecord(owner);
  const conversationProof = await runScheduledP1Phase(owner, beforeFence);
  requireScheduledP1OwnerRecord(owner);
  const markSubmitStarted = async (): Promise<boolean> => {
    requireScheduledP1OwnerRecord(owner);
    const marked = await claimFence(readbackBaseline);
    requireScheduledP1OwnerRecord(owner);
    return marked;
  };
  requireScheduledP1OwnerRecord(owner);
  const submit = await runScheduledP1Phase(owner, () =>
    record.deliveryOperations.submit({
      ...input,
      candidateToken: prepared.candidateToken,
      markSubmitStarted,
      signal: input.signal,
      conversationProof,
    }),
  );
  requireScheduledP1OwnerRecord(owner);
  if (!submit.attempted) throw new Error("MCP_DELIVERY_SUBMIT_NOT_ATTEMPTED");
  let status: "verified" | "submitted-uncertain" = "submitted-uncertain";
  try {
    requireScheduledP1OwnerRecord(owner);
    status = (
      await runScheduledP1Phase(owner, () =>
        record.deliveryOperations.verifySend({
          ...input,
          candidateToken: prepared.candidateToken,
        }),
      )
    ).status;
    requireScheduledP1OwnerRecord(owner);
  } catch {
    status = "submitted-uncertain";
  }
  requireScheduledP1OwnerRecord(owner);
  return { status, submitCount: 1 };
}

async function recoverScheduledP1(
  owner: ScheduledP1Owner,
  input: {
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
    readonly readbackBaseline: RealtimeReadbackBaseline | null;
  },
): Promise<"verified" | "submitted-uncertain"> {
  const record = requireScheduledP1OwnerRecord(owner);
  requireScheduledP1OwnerRecord(owner);
  const result = await runScheduledP1Phase(owner, () =>
    record.deliveryOperations.readbackSubmitted(input),
  );
  requireScheduledP1OwnerRecord(owner);
  return result;
}

async function deliverWithScheduledP1Session(
  sessionToken: ScheduledP1DeliverySession,
  input: {
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
  },
  signal: AbortSignal,
  validate: () => Promise<void>,
  beforeSubmit: () => Promise<RealtimeReadbackBaseline>,
  beforeFence: () => Promise<NativeSubmitConversationProof>,
  claimFence: PreparedReplyClaimPayload["markSubmitStarted"],
): Promise<{
  readonly status: "verified" | "submitted-uncertain";
  readonly submitCount: 1;
}> {
  const admission = requireScheduledP1DeliverySession(sessionToken);
  const session = await admission.admit("p1");
  const closeOnAbort = (): void => {
    void session.close().catch(() => undefined);
  };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    assertSessionSignal(signal);
    const owner = requireP1Owner(session.owner);
    await runScheduledP1Phase(owner, validate);
    requireScheduledP1OwnerRecord(owner);
    assertSessionSignal(signal);
    return await deliverScheduledP1(
      owner,
      { ...input, signal },
      beforeSubmit,
      beforeFence,
      claimFence,
    );
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await session.close();
  }
}

async function recoverWithScheduledP1Session(
  sessionToken: ScheduledP1DeliverySession,
  input: {
    readonly target: AuthorizedWechatTarget;
    readonly intent: ReplyIntent;
    readonly readbackBaseline: RealtimeReadbackBaseline | null;
  },
  signal: AbortSignal,
  validate: () => Promise<void>,
): Promise<"verified" | "submitted-uncertain"> {
  const admission = requireScheduledP1DeliverySession(sessionToken);
  const session = await admission.admit("p1");
  const closeOnAbort = (): void => {
    void session.close().catch(() => undefined);
  };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    assertSessionSignal(signal);
    const owner = requireP1Owner(session.owner);
    await runScheduledP1Phase(owner, validate);
    return await recoverScheduledP1(owner, input);
  } finally {
    signal.removeEventListener("abort", closeOnAbort);
    await session.close();
  }
}

function requireScheduledP1DeliverySession(
  sessionToken: ScheduledP1DeliverySession,
): SingleDispatcherAdmission<DispatcherOwner> {
  const admission = scheduledP1DeliverySessions.get(sessionToken);
  if (admission === undefined) {
    throw new Error("SCHEDULED_P1_DELIVERY_SESSION_INVALID");
  }
  return admission;
}

export interface RealtimeDispatcherControl {
  readonly announcePending: (lane: "p1") => () => void;
  readonly quarantine: () => void;
  readonly isQuarantined: () => boolean;
}

export interface ScheduledCycleGateSession {
  close(): Promise<{ readonly gateReleased: boolean }>;
}

export interface ScheduledCycleGate {
  admit(lane: "p0" | "p1"): Promise<ScheduledCycleGateSession>;
  cancelPendingAcquisition(): void;
  close(): Promise<void>;
}

export interface ContactBoundScheduledReplyDelivery {
  deliver(claim: PreparedReplyClaim): Promise<{
    readonly status: "verified" | "submitted-uncertain";
    readonly submitCount: 1;
  }>;
  recoverSubmitted(claim: PreparedReplyClaim): Promise<"verified" | "submitted-uncertain">;
}

const contactBoundScheduledReplyDeliveries = new WeakSet<object>();

export function assertContactBoundScheduledReplyDelivery(
  value: ContactBoundScheduledReplyDelivery,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !contactBoundScheduledReplyDeliveries.has(value)
  ) {
    throw new Error("SCHEDULED_P1_DELIVERY_FACADE_INVALID");
  }
}

export interface ProductionScheduledRuntime {
  readonly delivery: ContactBoundScheduledReplyDelivery;
  readonly realtimeControl: RealtimeDispatcherControl;
  readonly cycleGate: ScheduledCycleGate;
  createScheduler(
    options: Omit<SingleSchedulerOptions, "admission">,
  ): SingleScheduler;
}

export interface ProductionScheduledRuntimeOptions {
  readonly directory: ContactDirectory;
  readonly getSurface: () => ProductionScheduledP1Surface;
  readonly repository: Pick<RealtimeReplyStateRepository, "compareAndSet">;
  readonly now: () => Date;
  readonly readAuthorizedConversation: (
    target: AuthorizedWechatTarget,
  ) => Promise<NativeAuthorizedConversationSnapshot>;
  readonly isStopped: () => Promise<boolean>;
  readonly sharedRuntime?: SharedLiveProductionRuntime;
  readonly hasPendingPriorityLane?: (
    lane: "p0" | "p1" | "acceptance",
    signal?: AbortSignal,
  ) => Promise<boolean>;
}

/**
 * Production facade. The admission, owner and per-delivery session never leave
 * this closure; callers can only request a directory-bound delivery or a
 * scheduler already wired to the same dispatcher.
 */
export function createProductionScheduledRuntime(
  input: ProductionScheduledRuntimeOptions,
): ProductionScheduledRuntime {
  assertContactDirectory(input.directory);
  const composition = createProductionScheduledP1DispatcherAdmission({
    getSurface: input.getSurface,
    repository: input.repository,
    now: input.now,
    readbackSubmitted: async ({ target, intent, readbackBaseline }) => {
      if (readbackBaseline === null) return "submitted-uncertain";
      const current = await resolveCurrentTarget(input.directory, target, intent);
      const snapshot = await input.readAuthorizedConversation(current);
      return provesCandidateOutgoingAppend(snapshot, readbackBaseline)
        ? "verified"
        : "submitted-uncertain";
    },
    hasPendingPriorityLane: input.hasPendingPriorityLane,
    acquirePhaseLease:
      input.sharedRuntime === undefined
        ? undefined
        : () => acquireSharedLiveProductionRuntimeLease(input.sharedRuntime!),
  });

  const delivery: ContactBoundScheduledReplyDelivery = Object.freeze({
    deliver: async (claim: PreparedReplyClaim) => {
      const request = consumePreparedReplyClaim(claim);
      if (request.kind !== "delivery")
        throw new Error("REALTIME_PREPARED_CLAIM_INVALID");
      assertSessionSignal(request.signal);
      const validate = async (): Promise<void> => {
        assertDispatcherAvailable(composition.admission);
        const current = await resolveCurrentTarget(
          input.directory,
          request.target,
          request.intent,
        );
        await assertAuthorizedLatestIncoming(
          current,
          request.intent,
          input.readAuthorizedConversation,
          input.isStopped,
        );
        assertSessionSignal(request.signal);
      };
      const beforeSubmit = async (): Promise<RealtimeReadbackBaseline> => {
        assertDispatcherAvailable(composition.admission);
        const current = await resolveCurrentTarget(
          input.directory,
          request.target,
          request.intent,
        );
        const snapshot = await assertAuthorizedLatestIncoming(
          current,
          request.intent,
          input.readAuthorizedConversation,
          input.isStopped,
        );
        assertSessionSignal(request.signal);
        return readbackBaseline(snapshot, request.intent.replyText);
      };
      const beforeFence = async (): Promise<NativeSubmitConversationProof> => {
        assertDispatcherAvailable(composition.admission);
        const current = await resolveCurrentTarget(
          input.directory,
          request.target,
          request.intent,
        );
        const snapshot = await assertAuthorizedLatestIncoming(
          current,
          request.intent,
          input.readAuthorizedConversation,
          input.isStopped,
        );
        assertDispatcherAvailable(composition.admission);
        assertSessionSignal(request.signal);
        return nativeSubmitConversationProof(snapshot);
      };
      return deliverWithScheduledP1Session(
        composition.deliverySession,
        request,
        request.signal,
        validate,
        beforeSubmit,
        beforeFence,
        request.markSubmitStarted,
      );
    },
    recoverSubmitted: async (claim: PreparedReplyClaim) => {
      const request = consumePreparedReplyClaim(claim);
      if (request.kind !== "recovery")
        throw new Error("REALTIME_PREPARED_CLAIM_INVALID");
      assertSessionSignal(request.signal);
      const validate = async (): Promise<void> => {
        assertDispatcherAvailable(composition.admission);
        await resolveCurrentTarget(
          input.directory,
          request.target,
          request.intent,
        );
        assertSessionSignal(request.signal);
      };
      return recoverWithScheduledP1Session(
        composition.deliverySession,
        request,
        request.signal,
        validate,
      );
    },
  });
  contactBoundScheduledReplyDeliveries.add(delivery);
  const realtimeControl: RealtimeDispatcherControl = Object.freeze({
    announcePending: () => composition.admission.announcePending("p1"),
    quarantine: () => composition.admission.quarantine(),
    isQuarantined: () => composition.admission.isQuarantined(),
  });
  const cycleGate: ScheduledCycleGate = Object.freeze({
    admit: async (lane: "p0" | "p1") => {
      const session = await composition.admission.admit(lane);
      return Object.freeze({ close: () => session.close() });
    },
    cancelPendingAcquisition: () =>
      composition.admission.cancelPendingAcquisition(),
    close: () => Promise.resolve(),
  });
  return Object.freeze({
    delivery,
    realtimeControl,
    cycleGate,
    createScheduler: (options: Omit<SingleSchedulerOptions, "admission">) =>
      new SingleScheduler({ ...options, admission: composition.admission }),
  });
}

function assertDispatcherAvailable(
  admission: SingleDispatcherAdmission<DispatcherOwner>,
): void {
  if (admission.isQuarantined()) {
    throw new Error("SINGLE_DISPATCHER_QUARANTINED");
  }
}

async function resolveCurrentTarget(
  directory: ContactDirectory,
  target: AuthorizedWechatTarget,
  intentInput: ReplyIntent,
): Promise<AuthorizedWechatTarget> {
  assertAuthorizedWechatTarget(target);
  const intent = replyIntentSchema.parse(intentInput);
  if (
    target.contactId !== intent.contactId ||
    target.revision !== intent.contactRevision ||
    target.bindingHash !== intent.bindingHash
  ) {
    throw new Error("MCP_DELIVERY_TARGET_MISMATCH");
  }
  const current = await ContactDirectory.prototype.requireTextTarget.call(
    directory,
    target.contactId,
    target.revision,
  );
  assertAuthorizedWechatTarget(current);
  if (
    current.bindingHash !== target.bindingHash ||
    current.enrollmentFingerprint !== target.enrollmentFingerprint
  ) {
    throw new Error("MCP_DELIVERY_TARGET_MISMATCH");
  }
  return current;
}

async function assertAuthorizedLatestIncoming(
  target: AuthorizedWechatTarget,
  intent: ReplyIntent,
  readSnapshot: ProductionScheduledRuntimeOptions["readAuthorizedConversation"],
  isStopped: ProductionScheduledRuntimeOptions["isStopped"],
): Promise<NativeAuthorizedConversationSnapshot> {
  if (await isStopped()) throw new Error("CONTROL_STOPPED");
  const snapshot = await readSnapshot(target);
  if (
    snapshot.conversationId !== target.contactId ||
    snapshot.identity.conversationId !== target.contactId ||
    snapshot.identity.enrollmentFingerprint !== target.enrollmentFingerprint
  ) {
    throw new Error("MCP_DELIVERY_TARGET_MISMATCH");
  }
  const latest = snapshot.messages.at(-1);
  const expectedMessageId = intent.sourceMessageIds.at(-1);
  if (
    latest === undefined ||
    latest.direction !== "incoming" ||
    latest.id !== expectedMessageId ||
    snapshot.latestIncomingEvidence?.messageId !== expectedMessageId ||
    /^(?:STOP|停止|暂停)$/iu.test(latest.text.normalize("NFC").trim())
  ) {
    throw new Error("REALTIME_OWNER_REPLIED");
  }
  return snapshot;
}

function readbackBaseline(
  snapshot: NativeAuthorizedConversationSnapshot,
  replyText: string,
): RealtimeReadbackBaseline {
  return {
    version: 1,
    windowRevision: snapshot.windowRevision,
    expectedTextHash: sha256CanonicalReply(replyText),
    messages: snapshot.messages.map((message) => ({
      direction: message.direction,
      textHash: sha256CanonicalReply(message.text),
      confidence: message.confidence,
    })),
  };
}

function nativeSubmitConversationProof(
  snapshot: NativeAuthorizedConversationSnapshot,
): NativeSubmitConversationProof {
  const latest = snapshot.messages.at(-1);
  if (latest === undefined || latest.direction !== "incoming")
    throw new Error("REALTIME_OWNER_REPLIED");
  return Object.freeze({
    version: 1 as const,
    latestMessageId: latest.id,
    latestTextHash: sha256CanonicalReply(latest.text),
    latestDirection: "incoming" as const,
    controlRevision: createHash("sha256")
      .update(snapshot.messages.map((message) =>
        `${message.id}\0${message.direction}`
      ).join("\0"))
      .digest("hex"),
  });
}

function provesCandidateOutgoingAppend(
  snapshot: NativeAuthorizedConversationSnapshot,
  baseline: RealtimeReadbackBaseline,
): boolean {
  if (
    snapshot.windowRevision !== baseline.windowRevision ||
    snapshot.messages.length !== baseline.messages.length + 1
  ) {
    return false;
  }
  if (
    !baseline.messages.every((message, index) => {
      const current = snapshot.messages[index];
      return (
        current !== undefined &&
        current.direction === message.direction &&
        current.confidence === message.confidence &&
        sha256CanonicalReply(current.text) === message.textHash
      );
    })
  ) {
    return false;
  }
  const appended = snapshot.messages.at(-1);
  return (
    appended?.direction === "outgoing" &&
    sha256CanonicalReply(appended.text) === baseline.expectedTextHash
  );
}

function sha256CanonicalReply(value: string): string {
  return createHash("sha256")
    .update(value.normalize("NFC").replace(/\r\n?/gu, "\n"))
    .digest("hex");
}

function assertSessionSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("SCHEDULED_P1_SESSION_CLOSED");
  }
}

function requireScheduledP1OwnerRecord(
  owner: ScheduledP1Owner,
): ScheduledP1OwnerRecord {
  requireScheduledP1DeliveryOperations(owner);
  return scheduledP1OwnerRecords.get(owner)!;
}

export interface SingleSchedulerState {
  readonly version: 1;
  readonly lastTickKey: string | null;
  readonly activeCycle: {
    readonly id: string;
    readonly lane: "p0" | "p1";
    readonly startedAt: string;
  } | null;
  readonly p0Failures: number;
  readonly p1Failures: number;
  readonly p0CircuitOpenUntil: string | null;
  readonly p1CircuitOpenUntil: string | null;
}

export interface SingleSchedulerStateRepository {
  load(): Promise<SingleSchedulerState>;
  save(state: SingleSchedulerState): Promise<void>;
  transact?<T>(
    operation: (state: SingleSchedulerState) => Promise<{
      readonly state: SingleSchedulerState;
      readonly result: T;
    }>,
  ): Promise<T>;
}

export class InMemorySingleSchedulerStateRepository implements SingleSchedulerStateRepository {
  private state: SingleSchedulerState = initialState();
  private tail: Promise<void> = Promise.resolve();

  public load(): Promise<SingleSchedulerState> {
    return Promise.resolve(structuredClone(this.state));
  }

  public save(state: SingleSchedulerState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }

  public async transact<T>(
    operation: (state: SingleSchedulerState) => Promise<{
      readonly state: SingleSchedulerState;
      readonly result: T;
    }>,
  ): Promise<T> {
    const transaction = this.tail.then(async () => {
      const completed = await operation(await this.load());
      await this.save(completed.state);
      return completed.result;
    });
    this.tail = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }
}

export class FileSingleSchedulerStateRepository implements SingleSchedulerStateRepository {
  private readonly dataRoot: string;
  private readonly directory: string;
  private readonly statePath: string;

  public constructor(dataRoot: string) {
    if (
      typeof dataRoot !== "string" ||
      !path.isAbsolute(dataRoot) ||
      dataRoot.includes("\0")
    ) {
      throw new Error("SINGLE_SCHEDULER_STATE_ROOT_INVALID");
    }
    this.dataRoot = path.resolve(dataRoot);
    this.directory = path.join(this.dataRoot, "state");
    this.statePath = path.join(this.directory, "single-scheduler.json");
  }

  public async load(): Promise<SingleSchedulerState> {
    try {
      return decodeSchedulerState(
        JSON.parse(await readFile(this.statePath, "utf8")),
      );
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return initialState();
      throw error;
    }
  }

  public async save(state: SingleSchedulerState): Promise<void> {
    await this.ensureDirectory();
    const validated = decodeSchedulerState(state);
    const temporaryPath = path.join(
      this.directory,
      `.scheduler-${randomUUID()}.tmp`,
    );
    const temporary = await open(temporaryPath, "wx", 0o600);
    try {
      await temporary.writeFile(`${JSON.stringify(validated)}\n`);
      await temporary.sync();
      await temporary.close();
      await rename(temporaryPath, this.statePath);
      await syncDirectory(this.directory);
    } finally {
      await temporary.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  public async transact<T>(
    operation: (state: SingleSchedulerState) => Promise<{
      readonly state: SingleSchedulerState;
      readonly result: T;
    }>,
  ): Promise<T> {
    const lease = await acquireKernelLease({
      dataRoot: this.dataRoot,
      purpose: "encrypted-store-global",
    });
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await lease.runExclusive(async () => {
        await this.ensureDirectory();
        const completed = await operation(await this.load());
        await this.save(completed.state);
        return completed.result;
      });
    } catch (error: unknown) {
      operationError = error;
    }
    let closeError: unknown;
    try {
      await lease.close();
    } catch (error: unknown) {
      closeError = error;
    }
    if (operationError !== undefined) throw asError(operationError);
    if (closeError !== undefined) throw asError(closeError);
    return result as T;
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    const identity = await lstat(this.directory);
    if (
      !identity.isDirectory() ||
      identity.isSymbolicLink() ||
      identity.uid !== currentUid() ||
      (identity.mode & 0o777) !== 0o700
    ) {
      throw new Error("SINGLE_SCHEDULER_STATE_PATH_INVALID");
    }
  }
}

export interface SingleSchedulerOptions {
  readonly state: SingleSchedulerStateRepository;
  readonly inspectP0Slot: (
    slot: DailyCareSlot,
  ) => Promise<P0SlotInspection | null>;
  readonly admission?: SingleDispatcherAdmission<DispatcherOwner>;
  readonly candidateGenerator?: DailyCareCandidateGenerator;
  readonly circuitFailureThreshold?: number;
  readonly circuitDurationMs?: number;
  readonly hasPendingRealtimeReply?: () => Promise<boolean>;
  readonly hasRecentNaturalConversation?: (
    slot: DailyCareSlot,
    now: Date,
  ) => Promise<boolean>;
  readonly markP0Skipped?: (slot: DailyCareSlot, now: Date) => Promise<void>;
}

export class SingleScheduler {
  private readonly circuitFailureThreshold: number;
  private readonly circuitDurationMs: number;
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: SingleSchedulerOptions) {
    this.circuitFailureThreshold = options.circuitFailureThreshold ?? 3;
    this.circuitDurationMs = options.circuitDurationMs ?? 30 * 60 * 1000;
    if (
      !Number.isInteger(this.circuitFailureThreshold) ||
      this.circuitFailureThreshold < 1 ||
      this.circuitFailureThreshold > 10 ||
      !Number.isInteger(this.circuitDurationMs) ||
      this.circuitDurationMs < 1 ||
      this.circuitDurationMs > 60 * 60 * 1000
    ) {
      throw new Error("SINGLE_SCHEDULER_OPTIONS_INVALID");
    }
  }

  public tick(now: Date): Promise<SchedulerTickReceipt> {
    const result = this.tail.then(
      () => this.runTick(now),
      () => this.runTick(now),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public async beginScheduledTick<TPassive, TDaily>(
    now: Date,
    factories: {
      readonly createPassive: () => Promise<TPassive>;
      readonly createDailyCare: () => Promise<TDaily>;
    },
  ): Promise<
    | SchedulerRuntimeDecision<"p1", TPassive>
    | SchedulerRuntimeDecision<"p0", TDaily>
    | SchedulerOutsideDecision
  > {
    assertValidNow(now);
    const trustedNow = new Date(now.getTime());
    const lane = await this.inspectScheduledLane(trustedNow);
    if (lane === "outside") return outsideDecision();
    const tickKey = schedulerTickKey(trustedNow);
    const cycleId = randomUUID();
    const claim = (state: SingleSchedulerState) => {
      const recovered =
        state.activeCycle === null
          ? state
          : settleCycleState(
              state,
              state.activeCycle.lane,
              false,
              trustedNow,
              this.circuitFailureThreshold,
              this.circuitDurationMs,
            );
      if (recovered.lastTickKey === tickKey)
        throw new Error("SINGLE_SCHEDULER_TICK_CONSUMED");
      if (isCircuitOpen(recovered, lane, trustedNow)) {
        throw new Error("SINGLE_SCHEDULER_CIRCUIT_OPEN");
      }
      return Promise.resolve({
        state: {
          ...recovered,
          lastTickKey: tickKey,
          activeCycle: { id: cycleId, lane, startedAt: now.toISOString() },
        },
        result: lane,
      } as const);
    };
    const claimedLane =
      this.options.state.transact === undefined
        ? await (async () => {
            const completed = await claim(await this.options.state.load());
            await this.options.state.save(completed.state);
            return completed.result;
          })()
        : await this.options.state.transact(claim);
    const complete = this.createCompletion(cycleId, claimedLane, trustedNow);
    try {
      if (claimedLane === "p0") {
        return {
          lane: "p0",
          runtime: await factories.createDailyCare(),
          cycleId,
          complete,
        };
      }
      return {
        lane: "p1",
        runtime: await factories.createPassive(),
        cycleId,
        complete,
      };
    } catch (error: unknown) {
      await complete({ success: false });
      throw error;
    }
  }

  public async inspectScheduledLane(now: Date): Promise<ScheduledLane> {
    assertValidNow(now);
    return (await this.inspectLane(new Date(now.getTime()))).lane;
  }

  private createCompletion(
    cycleId: string,
    lane: "p0" | "p1",
    now: Date,
  ): (input: SchedulerCycleOutcome) => Promise<void> {
    let completed = false;
    return async (input) => {
      if (completed) return;
      assertCycleOutcome(input);
      const settle = (state: SingleSchedulerState) => {
        if (
          state.activeCycle?.id !== cycleId ||
          state.activeCycle.lane !== lane
        ) {
          return Promise.resolve({ state, result: false } as const);
        }
        return Promise.resolve({
          state: settleCycleState(
            state,
            lane,
            input.success,
            now,
            this.circuitFailureThreshold,
            this.circuitDurationMs,
          ),
          result: true,
        } as const);
      };
      const settled =
        this.options.state.transact === undefined
          ? await (async () => {
              const result = await settle(await this.options.state.load());
              if (result.result) await this.options.state.save(result.state);
              return result.result;
            })()
          : await this.options.state.transact(settle);
      completed = settled || completed;
    };
  }

  private async runTick(now: Date): Promise<SchedulerTickReceipt> {
    assertValidNow(now);
    const trustedNow = new Date(now.getTime());
    const { slot, inspection, lane } = await this.inspectLane(trustedNow);
    if (lane === "outside") return outsideReceipt();
    const tickKey = schedulerTickKey(trustedNow);
    let state = await this.options.state.load();
    if (state.lastTickKey === tickKey) {
      return { lane, status: "already-consumed", submitCount: 0 };
    }
    state = { ...state, lastTickKey: tickKey };
    await this.options.state.save(state);
    if (isCircuitOpen(state, lane, trustedNow)) {
      return { lane, status: "circuit-open", submitCount: 0 };
    }
    try {
      const receipt =
        lane === "p0"
          ? await this.runP0(slot as DailyCareSlot, inspection)
          : await this.runP1();
      await this.recordSuccess(lane);
      return receipt;
    } catch {
      await this.recordFailure(lane, trustedNow);
      return { lane, status: "failed", submitCount: 0 };
    }
  }

  private async inspectLane(now: Date): Promise<{
    slot: DailyCareSlot | null;
    inspection: P0SlotInspection | null;
    lane: ScheduledLane;
  }> {
    const slot = resolveProductionSlot(now);
    const inspection =
      slot === null ? null : await this.options.inspectP0Slot(slot);
    const selected = selectScheduledLane(now, inspection);
    if (selected !== "p0" || slot === null)
      return { slot, inspection, lane: selected };
    if ((await this.options.hasPendingRealtimeReply?.()) === true) {
      return { slot, inspection, lane: "outside" };
    }
    if (
      (await this.options.hasRecentNaturalConversation?.(slot, now)) === true
    ) {
      const markSkipped = this.options.markP0Skipped;
      if (markSkipped === undefined)
        throw new Error("SINGLE_SCHEDULER_SKIP_HANDLER_REQUIRED");
      await markSkipped(slot, now);
      return { slot, inspection: { status: "skipped" }, lane: "outside" };
    }
    return { slot, inspection, lane: "p0" };
  }

  private async runP0(
    slot: DailyCareSlot,
    inspection: P0SlotInspection | null,
  ): Promise<SchedulerTickReceipt> {
    const admission = this.options.admission;
    const candidateGenerator = this.options.candidateGenerator;
    if (admission === undefined || candidateGenerator === undefined) {
      throw new Error("SINGLE_SCHEDULER_EXECUTION_NOT_CONFIGURED");
    }
    const session = await admission.admit("p0");
    let result: SchedulerTickReceipt;
    let operationError: unknown;
    try {
      const owner = requireP0Owner(session.owner, slot.kind);
      if (inspection?.status === "submitted-uncertain") {
        const status = await owner.verifyOutgoingAfterUncertain();
        result = { lane: "p0", status, submitCount: 0 };
      } else {
        const weather =
          slot.kind === "morning" ? await optionalWeather(owner) : null;
        const recentVerifiedTexts = await owner.listRecentVerifiedTexts();
        const candidate = await candidateGenerator.generate({
          skillId: DAILY_CARE_WRITING_SKILL_ID,
          kind: slot.kind,
          recentVerifiedTexts,
          verifiedWeatherFacts: weather,
        });
        const validated = validateUnsignedBroadcastCandidate({
          kind: slot.kind,
          text: candidate,
          weather,
          recentVerifiedTexts,
        });
        const status = await owner.prepareAndSubmitCandidate(
          validated.text,
          weather,
        );
        result = { lane: "p0", status, submitCount: 1 };
      }
    } catch (error: unknown) {
      operationError = error;
      result = { lane: "p0", status: "failed", submitCount: 0 };
    }
    try {
      await session.close();
    } catch (error: unknown) {
      operationError = error;
    }
    if (operationError !== undefined) throw asError(operationError);
    return result;
  }

  private async runP1(): Promise<SchedulerTickReceipt> {
    const admission = this.options.admission;
    if (admission === undefined)
      throw new Error("SINGLE_SCHEDULER_EXECUTION_NOT_CONFIGURED");
    const session = await admission.admit("p1");
    let result: SchedulerTickReceipt;
    let operationError: unknown;
    try {
      const owner = requireP1Owner(session.owner);
      const latest = await owner.readLatest();
      if (latest.direction !== "incoming") {
        result = {
          lane: "p1",
          status: "wait",
          submitCount: 0,
          latestDirection: latest.direction,
        };
      } else {
        const sent = await owner.replyToLatestIncomingOnce();
        if (sent.submitCount !== 1)
          throw new Error("SINGLE_SCHEDULER_P1_RESULT_INVALID");
        result = {
          lane: "p1",
          status: sent.status,
          submitCount: 1,
          latestDirection: "incoming",
        };
      }
    } catch (error: unknown) {
      operationError = error;
      result = { lane: "p1", status: "failed", submitCount: 0 };
    }
    try {
      await session.close();
    } catch (error: unknown) {
      operationError = error;
    }
    if (operationError !== undefined) throw asError(operationError);
    return result;
  }

  private async recordSuccess(lane: "p0" | "p1"): Promise<void> {
    const state = await this.options.state.load();
    await this.options.state.save(
      lane === "p0"
        ? { ...state, p0Failures: 0, p0CircuitOpenUntil: null }
        : { ...state, p1Failures: 0, p1CircuitOpenUntil: null },
    );
  }

  private async recordFailure(lane: "p0" | "p1", now: Date): Promise<void> {
    const state = await this.options.state.load();
    const failures = (lane === "p0" ? state.p0Failures : state.p1Failures) + 1;
    const openUntil =
      failures >= this.circuitFailureThreshold
        ? new Date(now.getTime() + this.circuitDurationMs).toISOString()
        : null;
    await this.options.state.save(
      lane === "p0"
        ? { ...state, p0Failures: failures, p0CircuitOpenUntil: openUntil }
        : { ...state, p1Failures: failures, p1CircuitOpenUntil: openUntil },
    );
  }
}

export type SchedulerTickReceipt =
  | {
      readonly lane: "p0" | "p1";
      readonly status:
        | "verified"
        | "submitted-uncertain"
        | "wait"
        | "failed"
        | "circuit-open"
        | "already-consumed";
      readonly submitCount: 0 | 1;
      readonly latestDirection?: "incoming" | "outgoing" | "none";
    }
  | {
      readonly lane: "outside";
      readonly status: "outside-window";
      readonly submitCount: 0;
    };

export function isP0BlockingStatus(
  inspection: P0SlotInspection | null,
): boolean {
  return (
    inspection === null ||
    inspection.status === "pending" ||
    inspection.status === "submitted-uncertain"
  );
}

async function optionalWeather(
  owner: ScheduledP0Owner,
): Promise<DailyCareWeatherFacts | null> {
  try {
    return await owner.researchWeather();
  } catch {
    return null;
  }
}

function requireP0Owner(
  owner: DispatcherOwner,
  kind: DailyCareKind,
): ScheduledP0Owner {
  if (
    !("lane" in owner) ||
    owner.lane !== "p0" ||
    !("kind" in owner) ||
    owner.kind !== kind
  ) {
    throw new Error("SINGLE_SCHEDULER_OWNER_MISMATCH");
  }
  return owner as ScheduledP0Owner;
}

function requireP1Owner(owner: DispatcherOwner): ScheduledP1Owner {
  if (!("lane" in owner) || owner.lane !== "p1") {
    throw new Error("SINGLE_SCHEDULER_OWNER_MISMATCH");
  }
  return owner as ScheduledP1Owner;
}

function isCircuitOpen(
  state: SingleSchedulerState,
  lane: "p0" | "p1",
  now: Date,
): boolean {
  const value =
    lane === "p0" ? state.p0CircuitOpenUntil : state.p1CircuitOpenUntil;
  return value !== null && Date.parse(value) > now.getTime();
}

const SHANGHAI_TICK_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function schedulerTickKey(now: Date): string {
  const parts = Object.fromEntries(
    SHANGHAI_TICK_FORMATTER.formatToParts(now)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  const minute = Number(parts.minute);
  if (
    parts.year === undefined ||
    parts.month === undefined ||
    parts.day === undefined ||
    parts.hour === undefined ||
    !Number.isInteger(minute)
  ) {
    throw new Error("SINGLE_SCHEDULER_NOW_INVALID");
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${String(
    Math.floor(minute / 10) * 10,
  ).padStart(2, "0")}`;
}

export function selectScheduledLane(
  now: Date,
  inspection: P0SlotInspection | null,
): ScheduledLane {
  assertValidNow(now);
  if (resolveProductionSlot(now) !== null && isP0BlockingStatus(inspection)) {
    return "p0";
  }
  return "p1";
}

function initialState(): SingleSchedulerState {
  return {
    version: 1,
    lastTickKey: null,
    activeCycle: null,
    p0Failures: 0,
    p1Failures: 0,
    p0CircuitOpenUntil: null,
    p1CircuitOpenUntil: null,
  };
}

function assertValidNow(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("SINGLE_SCHEDULER_NOW_INVALID");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("SINGLE_SCHEDULER_OPERATION_FAILED", {
        cause: error,
      });
}

function decodeSchedulerState(value: unknown): SingleSchedulerState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SINGLE_SCHEDULER_STATE_INVALID");
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record).sort();
  const expected = [
    "activeCycle",
    "lastTickKey",
    "p0CircuitOpenUntil",
    "p0Failures",
    "p1CircuitOpenUntil",
    "p1Failures",
    "version",
  ].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    record.version !== 1 ||
    !isActiveCycle(record.activeCycle) ||
    (record.lastTickKey !== null && typeof record.lastTickKey !== "string") ||
    !Number.isInteger(record.p0Failures) ||
    !Number.isInteger(record.p1Failures) ||
    Number(record.p0Failures) < 0 ||
    Number(record.p1Failures) < 0 ||
    (record.p0CircuitOpenUntil !== null &&
      typeof record.p0CircuitOpenUntil !== "string") ||
    (record.p1CircuitOpenUntil !== null &&
      typeof record.p1CircuitOpenUntil !== "string")
  ) {
    throw new Error("SINGLE_SCHEDULER_STATE_INVALID");
  }
  return structuredClone(record) as unknown as SingleSchedulerState;
}

export interface SchedulerCycleOutcome {
  readonly success: boolean;
}

export interface SchedulerRuntimeDecision<Lane extends "p0" | "p1", Runtime> {
  readonly lane: Lane;
  readonly runtime: Runtime;
  readonly cycleId: string;
  readonly complete: (input: SchedulerCycleOutcome) => Promise<void>;
}

export interface SchedulerOutsideDecision {
  readonly lane: "outside";
  readonly status: "outside-window";
}

function outsideDecision(): SchedulerOutsideDecision {
  return { lane: "outside", status: "outside-window" };
}

function outsideReceipt(): SchedulerTickReceipt {
  return { ...outsideDecision(), submitCount: 0 };
}

function assertCycleOutcome(input: SchedulerCycleOutcome): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 1 ||
    typeof input.success !== "boolean"
  ) {
    throw new Error("SINGLE_SCHEDULER_OUTCOME_INVALID");
  }
}

function isActiveCycle(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Reflect.ownKeys(record).sort().join(",") === "id,lane,startedAt" &&
    typeof record.id === "string" &&
    /^[0-9a-f-]{36}$/u.test(record.id) &&
    (record.lane === "p0" || record.lane === "p1") &&
    typeof record.startedAt === "string" &&
    Number.isFinite(Date.parse(record.startedAt))
  );
}

function settleCycleState(
  state: SingleSchedulerState,
  lane: "p0" | "p1",
  success: boolean,
  now: Date,
  threshold: number,
  durationMs: number,
): SingleSchedulerState {
  if (success) {
    return lane === "p0"
      ? { ...state, activeCycle: null, p0Failures: 0, p0CircuitOpenUntil: null }
      : {
          ...state,
          activeCycle: null,
          p1Failures: 0,
          p1CircuitOpenUntil: null,
        };
  }
  const failures = (lane === "p0" ? state.p0Failures : state.p1Failures) + 1;
  const openUntil =
    failures >= threshold
      ? new Date(now.getTime() + durationMs).toISOString()
      : null;
  return lane === "p0"
    ? {
        ...state,
        activeCycle: null,
        p0Failures: failures,
        p0CircuitOpenUntil: openUntil,
      }
    : {
        ...state,
        activeCycle: null,
        p1Failures: failures,
        p1CircuitOpenUntil: openUntil,
      };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function currentUid(): number {
  if (typeof process.getuid !== "function")
    throw new Error("SINGLE_SCHEDULER_OWNER_UNVERIFIED");
  return process.getuid();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
