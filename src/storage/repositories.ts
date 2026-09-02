import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import type { ChatMessage } from "../domain/types.js";
import type { AuthorizedWechatTarget } from "../contacts/contact-directory.js";
import { contactIdSchema, type ContactId } from "../contacts/contact-schema.js";
import {
  deriveConversationTriggerId,
  inboundSourceKindSchema,
  normalizedInboundMessageSchema,
  replyIntentSchema,
  type InboundSourceKind,
  type NormalizedInboundMessage,
  type ReplyIntent,
} from "../conversation/personal-account-contract.js";
import { encryptedStoreRoot, type EncryptedStore } from "./encrypted-store.js";

const chatMessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.enum(["example-contact", "file-transfer"]),
  direction: z.enum(["incoming", "outgoing"]),
  kind: z.enum(["text", "emoji", "link", "image-ocr", "voice-transcript"]),
  text: z.string(),
  occurredAt: z.string().datetime(),
  source: z.enum(["wechat", "douyin"]),
  confidence: z.number().min(0).max(1),
});

const messageDocumentSchema = z.object({
  messages: z.array(chatMessageSchema),
});

const outgoingStateSchema = z.object({
  status: z.enum(["claimed", "verified", "uncertain"]),
  updatedAt: z.string().datetime(),
});

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const controlBoundaryCheckpointSchema = z.object({
  epoch: hex64Schema,
  boundaryMessageId: hex64Schema,
  consumedCount: z.number().int().min(0),
  prefixChainHash: hex64Schema,
});
const controlBoundaryStateSchema = controlBoundaryCheckpointSchema.extend({
  status: z.enum(["awaiting-boundary", "active"]),
  nonce: hex64Schema,
});

const protocolV2ControlStateSchema = z.object({
  controlProtocolVersion: z.literal(2),
  stopped: z.boolean(),
  stopReason: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
  controlBoundary: controlBoundaryStateSchema,
  outgoing: z.record(z.string(), outgoingStateSchema),
});

const controlStateSchema = z.object({
  controlProtocolVersion: z.literal(3),
  gateRevision: hex64Schema,
  stopped: z.boolean(),
  stopReason: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
  controlBoundary: controlBoundaryStateSchema,
  outgoing: z.record(z.string(), outgoingStateSchema),
});

const legacyControlStateSchema = z.object({
  stopped: z.boolean(),
  stopReason: z.string().nullable(),
  updatedAt: z.string().datetime().nullable(),
  controlCursor: z.string().nullable().default(null),
  outgoing: z.record(z.string(), outgoingStateSchema),
});
const storedControlStateSchema = z.union([
  controlStateSchema,
  protocolV2ControlStateSchema,
  legacyControlStateSchema,
]);

const targetReplyBaselineSchema = z.object({
  epoch: hex64Schema,
  orderedSequenceHash: hex64Schema,
  visibleMessageIds: z.array(z.string().min(1)),
  latestMessageId: z.string().min(1).nullable(),
  latestDirection: z.enum(["incoming", "outgoing"]).nullable(),
  unreadIndicator: z.boolean().nullable(),
});
const targetReplyTriggerSchema = z.object({
  triggerId: hex64Schema,
  baselineEpoch: hex64Schema,
  orderedSequenceHash: hex64Schema,
  triggerMessageId: z.string().min(1),
  controlCheckpoint: controlBoundaryCheckpointSchema,
  gateRevision: hex64Schema,
  createdAt: z.string().datetime(),
});
const legacyTargetReplyTriggerSchema = targetReplyTriggerSchema.omit({ gateRevision: true });
const ownerNoticeKeySchema = z.object({
  noticeKeyHash: hex64Schema,
  triggerIdHash: hex64Schema,
  reasonCode: z.string().regex(/^[A-Z0-9_]{1,80}$/u),
  noticeIdHash: hex64Schema,
  status: z.literal("claimed"),
});
const legacyTargetReplyStateSchema = z.object({
  version: z.literal(1),
  baseline: targetReplyBaselineSchema.nullable(),
  pendingTrigger: legacyTargetReplyTriggerSchema.nullable(),
  lastOwnerNoticeKey: ownerNoticeKeySchema.nullable(),
});
const targetReplyStateSchema = z.object({
  version: z.literal(2),
  baseline: targetReplyBaselineSchema.nullable(),
  pendingTrigger: targetReplyTriggerSchema.nullable(),
  lastOwnerNoticeKey: ownerNoticeKeySchema.nullable(),
});
const storedTargetReplyStateSchema = z.union([
  targetReplyStateSchema,
  legacyTargetReplyStateSchema,
]);

const auditRecordSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  occurredAt: z.string().datetime(),
  details: z.record(z.string(), z.unknown()),
});

const auditDocumentSchema = z.object({
  records: z.array(auditRecordSchema),
});

const pendingSendSchema = z.object({
  conversationId: z.enum(["example-contact", "file-transfer"]),
  text: z.string().min(1),
  tokenHash: z.string().length(64),
  fingerprint: z.string().length(64).nullable(),
  baselineMessageIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  draftVerifiedAt: z.string().datetime().nullable(),
});
const pendingSendDocumentSchema = pendingSendSchema.nullable();

const abortIntentSchema = z.object({
  intentId: z.string().regex(/^[a-f0-9]{64}$/u),
  candidateId: z.string().regex(/^[a-f0-9]{64}$/u),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  conversationId: z.enum(["example-contact", "file-transfer"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  textHash: z.string().regex(/^[a-f0-9]{64}$/u),
  auditId: z.string().uuid(),
});
const abortIntentDocumentSchema = abortIntentSchema.nullable();

const realtimeReplyStatusSchema = z.enum([
  "new",
  "generating",
  "prepared",
  "submit-started",
  "verified",
  "submitted-uncertain",
  "cancelled",
  "failed",
]);
const realtimeReplyReasonSchema = z.enum([
  "OWNER_REPLIED",
  "CONTACT_CHANGED",
  "SUPERSEDED",
  "NO_REPLY",
  "SOURCE_BLOCKED",
  "RECOVERY_CANCELLED",
]);
const realtimeReadbackBaselineSchema = z.object({
  version: z.literal(1),
  windowRevision: hex64Schema,
  expectedTextHash: hex64Schema,
  messages: z.array(z.object({
    direction: z.enum(["incoming", "outgoing"]),
    textHash: hex64Schema,
    confidence: z.number().min(0).max(1),
  }).strict()).max(100),
}).strict();
const realtimeReplyRecordSchema = z.object({
  version: z.literal(1),
  contactId: contactIdSchema,
  contactRevision: z.number().int().positive(),
  bindingHash: hex64Schema,
  triggerId: hex64Schema,
  source: inboundSourceKindSchema,
  sourceEpoch: z.string().trim().min(1).max(512),
  sessionId: z.string().trim().min(1).max(512),
  messages: z.array(normalizedInboundMessageSchema).min(1).max(100),
  intent: replyIntentSchema.nullable(),
  status: realtimeReplyStatusSchema,
  reason: realtimeReplyReasonSchema.nullable(),
  readbackBaseline: realtimeReadbackBaselineSchema.nullable().default(null),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.messages.some((message) => message.conversationId !== value.contactId)) {
    context.addIssue({ code: "custom", message: "REALTIME_MESSAGE_CONTACT_MISMATCH" });
  }
  if (value.status === "prepared" && value.intent === null) {
    context.addIssue({ code: "custom", message: "REALTIME_PREPARED_INTENT_REQUIRED" });
  }
  if (value.intent !== null && (
    value.intent.contactId !== value.contactId ||
    value.intent.contactRevision !== value.contactRevision ||
    value.intent.bindingHash !== value.bindingHash ||
    value.intent.triggerId !== value.triggerId
  )) {
    context.addIssue({ code: "custom", message: "REALTIME_INTENT_BINDING_MISMATCH" });
  }
  if (["cancelled", "failed"].includes(value.status) && value.reason === null) {
    context.addIssue({ code: "custom", message: "REALTIME_TERMINAL_REASON_REQUIRED" });
  }
});
const realtimeBufferedBatchSchema = z.object({
  version: z.literal(1),
  contactId: contactIdSchema,
  contactRevision: z.number().int().positive(),
  bindingHash: hex64Schema,
  source: inboundSourceKindSchema,
  sourceEpoch: z.string().trim().min(1).max(512),
  sessionId: z.string().trim().min(1).max(512),
  messages: z.array(normalizedInboundMessageSchema).min(1).max(100),
  deadlineAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.messages.some((message) => message.conversationId !== value.contactId ||
      message.source !== value.source || message.sourceEpoch !== value.sourceEpoch ||
      message.sessionId !== value.sessionId)) {
    context.addIssue({ code: "custom", message: "REALTIME_BUFFER_BINDING_MISMATCH" });
  }
});
const realtimeReplyDocumentSchema = z.object({
  version: z.literal(1),
  records: z.array(realtimeReplyRecordSchema),
  batches: z.array(realtimeBufferedBatchSchema).default([]),
}).strict();

export type ControlState = z.infer<typeof controlStateSchema>;
export type ControlBoundaryState = z.infer<typeof controlBoundaryStateSchema>;
export type ControlBoundaryCheckpoint = z.infer<typeof controlBoundaryCheckpointSchema>;
export interface PersistentStopGate {
  gateRevision: string;
  checkpoint: ControlBoundaryCheckpoint;
}
export type TargetReplyState = z.infer<typeof targetReplyStateSchema>;
export type TargetReplyTrigger = z.infer<typeof targetReplyTriggerSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type PendingSend = z.infer<typeof pendingSendSchema>;
export type AbortIntent = z.infer<typeof abortIntentSchema>;
export type RealtimeReplyStatus = z.infer<typeof realtimeReplyStatusSchema>;
export type RealtimeReplyReason = z.infer<typeof realtimeReplyReasonSchema>;
export type RealtimeReplyRecord = z.infer<typeof realtimeReplyRecordSchema>;
export type RealtimeBufferedBatch = z.infer<typeof realtimeBufferedBatchSchema>;
export type RealtimeReadbackBaseline = z.infer<typeof realtimeReadbackBaselineSchema>;

export interface RealtimeReplyKey {
  readonly contactId: ContactId;
  readonly contactRevision: number;
  readonly bindingHash: string;
  readonly triggerId: string;
}

export interface ClaimRealtimeReplyInput {
  readonly target: AuthorizedWechatTarget;
  readonly triggerId: string;
  readonly source: InboundSourceKind;
  readonly sourceEpoch: string;
  readonly sessionId: string;
  readonly messages: readonly NormalizedInboundMessage[];
  readonly now: Date;
}

export type RealtimeReplyTransition =
  | { readonly status: "generating" | "verified" |
      "submitted-uncertain" }
  | { readonly status: "submit-started"; readonly readbackBaseline?: RealtimeReadbackBaseline }
  | { readonly status: "prepared"; readonly intent: ReplyIntent }
  | { readonly status: "cancelled" | "failed"; readonly reason: RealtimeReplyReason };

export interface RealtimeReplyStateRepository {
  claim(input: ClaimRealtimeReplyInput): Promise<{ claimed: boolean; record: RealtimeReplyRecord }>;
  compareAndSet(input: {
    readonly key: RealtimeReplyKey;
    readonly expectedStatus: RealtimeReplyStatus;
    readonly next: RealtimeReplyTransition;
    readonly now: Date;
  }): Promise<boolean>;
  cancelPreSubmit(
    contactId: ContactId,
    reason: Extract<RealtimeReplyReason, "OWNER_REPLIED" | "SUPERSEDED" | "CONTACT_CHANGED">,
    now: Date,
    exceptTriggerId?: string,
  ): Promise<number>;
  get(key: RealtimeReplyKey): Promise<RealtimeReplyRecord | null>;
  list(): Promise<readonly RealtimeReplyRecord[]>;
  listRecoverable(): Promise<readonly RealtimeReplyRecord[]>;
  appendBufferedMessage(input: {
    readonly target: AuthorizedWechatTarget;
    readonly message: NormalizedInboundMessage;
    readonly deadline: Date;
    readonly now: Date;
  }): Promise<RealtimeBufferedBatch>;
  clearBufferedBatch(contactId: ContactId): Promise<boolean>;
  listBufferedBatches(): Promise<readonly RealtimeBufferedBatch[]>;
  claimBufferedBatch(contactId: ContactId, now: Date): Promise<{
    readonly claimed: boolean;
    readonly record: RealtimeReplyRecord | null;
  }>;
  hasActiveForContact(contactId: ContactId): Promise<boolean>;
  hasPendingWork(): Promise<boolean>;
  hasRecentConversation(now: Date, windowMs: number): Promise<boolean>;
}

export interface AuditEvent {
  type: string;
  details: Record<string, unknown>;
}

export interface NonStopControlBatch {
  expectedBoundary: ControlBoundaryCheckpoint;
  nextBoundary: ControlBoundaryCheckpoint;
  resumeMessageIds: string[];
}

export interface TargetReplyEvaluationInput {
  messages: Array<{ id: string; direction: "incoming" | "outgoing" }>;
  addedIds: string[];
  unreadIndicator: boolean | null;
  controlCheckpoint: ControlBoundaryCheckpoint;
  expectedGateRevision: string;
}

export interface TargetReplyDecision {
  action: "reply-latest-incoming" | "wait";
  triggerMessageId: string | null;
  reason:
    | "BASELINE_ESTABLISHED_NO_SEND"
    | "LATEST_VISIBLE_INCOMING"
    | "LATEST_VISIBLE_OUTGOING"
    | "NO_VISIBLE_MESSAGE"
    | "NO_NEW_INCOMING";
}

class SerialExecutor {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const stateExecutors = new Map<string, SerialExecutor>();

export class MessageRepository {
  private readonly serial = new SerialExecutor();

  public constructor(private readonly store: EncryptedStore) {}

  public appendUnique(messages: ChatMessage[]): Promise<string[]> {
    return this.serial.run(async () => {
      const document = await this.load();
      const knownIds = new Set(document.messages.map((message) => message.id));
      const addedIds: string[] = [];

      for (const message of messages) {
        const validated = chatMessageSchema.parse(message);
        if (knownIds.has(validated.id)) {
          continue;
        }
        knownIds.add(validated.id);
        document.messages.push(validated);
        addedIds.push(validated.id);
      }

      if (addedIds.length > 0) {
        await this.store.write("vault/messages.enc", document);
      }
      return addedIds;
    });
  }

  public list(): Promise<ChatMessage[]> {
    return this.serial.run(async () => {
      const document = await this.load();
      return document.messages;
    });
  }

  public replaceSource(source: ChatMessage["source"], messages: ChatMessage[]): Promise<void> {
    return this.serial.run(async () => {
      const document = await this.load();
      const replacements = new Map<string, ChatMessage>();
      for (const message of messages) {
        const validated = chatMessageSchema.parse(message);
        if (validated.source !== source) throw new Error("MESSAGE_SOURCE_MISMATCH");
        replacements.set(validated.id, validated);
      }
      document.messages = [
        ...document.messages.filter((message) => message.source !== source),
        ...replacements.values(),
      ];
      await this.store.write("vault/messages.enc", document);
    });
  }

  private async load(): Promise<z.infer<typeof messageDocumentSchema>> {
    return (
      (await this.store.read("vault/messages.enc", messageDocumentSchema)) ?? {
        messages: [],
      }
    );
  }
}

export class StateRepository {
  private readonly serial: SerialExecutor;

  public constructor(
    private readonly store: EncryptedStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    const coordinationKey = encryptedStoreCoordinationKey(store);
    const existing = stateExecutors.get(coordinationKey);
    this.serial = existing ?? new SerialExecutor();
    if (existing === undefined) stateExecutors.set(coordinationKey, this.serial);
  }

  public getControlState(): Promise<ControlState> {
    return this.serial.run(() => this.load());
  }

  public peekControlState(): Promise<ControlState | null> {
    return this.serial.run(async () => {
      const stored = await this.store.read("state/control.enc", storedControlStateSchema);
      if (stored === null || !("controlProtocolVersion" in stored) ||
          stored.controlProtocolVersion !== 3) {
        return null;
      }
      return controlStateSchema.parse(stored);
    });
  }

  public getControlBoundaryCheckpoint(): Promise<ControlBoundaryCheckpoint> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (state.controlBoundary.status !== "active") {
        throw new Error("CONTROL_BOUNDARY_REQUIRED");
      }
      return checkpointOf(state.controlBoundary);
    });
  }

  public getPersistentStopGate(): Promise<PersistentStopGate> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (state.stopped) throw new Error("CONTROL_CHANGED");
      if (state.controlBoundary.status !== "active") {
        throw new Error("CONTROL_BOUNDARY_REQUIRED");
      }
      return {
        gateRevision: state.gateRevision,
        checkpoint: checkpointOf(state.controlBoundary),
      };
    });
  }

  public assertPersistentStopGate(expected: PersistentStopGate): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      assertPersistentGate(state, expected);
    });
  }

  public issueControlBoundary(): Promise<{
    markerText: string;
    boundaryMessageId: string;
    epoch: string;
  }> {
    return this.serial.run(async () => {
      const state = await this.load();
      const boundary = state.controlBoundary;
      return {
        markerText: controlBoundaryMarker(boundary.nonce),
        boundaryMessageId: boundary.boundaryMessageId,
        epoch: boundary.epoch,
      };
    });
  }

  public activateControlBoundary(input: {
    expectedEpoch: string;
    boundaryMessageId: string;
    markerOccurrenceCount: number;
  }): Promise<{
    status: "active";
    epoch: string;
    boundaryMessageId: string;
    consumedCount: number;
    prefixChainHash: string;
    markerOccurrenceCount: 1;
  }> {
    return this.serial.run(async () => {
      const state = await this.load();
      const boundary = state.controlBoundary;
      if (
        input.markerOccurrenceCount !== 1 ||
        boundary.epoch !== input.expectedEpoch ||
        boundary.boundaryMessageId !== input.boundaryMessageId
      ) {
        throw new Error("CONTROL_BOUNDARY_AMBIGUOUS");
      }
      if (boundary.status === "awaiting-boundary") {
        boundary.status = "active";
        if (state.stopped && state.stopReason === "CONTROL_BOUNDARY_REQUIRED") {
          state.stopped = false;
          state.stopReason = null;
          rotateGateRevision(state);
        }
        state.updatedAt = this.now().toISOString();
        await this.save(state);
      }
      return {
        status: "active",
        ...checkpointOf(boundary),
        markerOccurrenceCount: 1,
      };
    });
  }

  public setStopped(reason: string): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      state.stopped = true;
      state.stopReason = reason;
      rotateGateRevision(state);
      state.updatedAt = this.now().toISOString();
      await this.save(state);
    });
  }

  public resume(): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      state.stopped = false;
      state.stopReason = null;
      rotateGateRevision(state);
      state.updatedAt = this.now().toISOString();
      await this.save(state);
    });
  }

  public beginUserStopControlBatch(expectedBoundary: ControlBoundaryCheckpoint): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      assertControlBoundary(state, expectedBoundary);
      state.stopped = true;
      state.stopReason = "user-command";
      rotateGateRevision(state);
      state.updatedAt = this.now().toISOString();
      await this.save(state);
    });
  }

  public beginAmbiguousUserStopControlBatch(): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      state.stopped = true;
      state.stopReason = "user-command";
      rotateGateRevision(state);
      state.updatedAt = this.now().toISOString();
      await this.save(state);
    });
  }

  public completeUserStopControlBatch(
    expectedBoundary: ControlBoundaryCheckpoint,
    nextBoundary: ControlBoundaryCheckpoint,
  ): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      assertControlBoundary(state, expectedBoundary);
      if (
        !state.stopped ||
        state.stopReason !== "user-command"
      ) {
        throw new Error("CONTROL_STOP_STATE_MISMATCH");
      }
      state.controlBoundary = withBoundaryCheckpoint(state.controlBoundary, nextBoundary);
      state.updatedAt = this.now().toISOString();
      await this.save(state);
    });
  }

  public consumeNonStopControlBatch(
    batch: NonStopControlBatch,
  ): Promise<ControlCommandResult | null> {
    return this.serial.run(async () => {
      const state = await this.load();
      assertControlBoundary(state, batch.expectedBoundary);
      let result: ControlCommandResult | null = null;

      const resumeMessageId = batch.resumeMessageIds.at(-1);
      if (
        resumeMessageId !== undefined &&
        state.stopped &&
        state.stopReason === "user-command"
      ) {
        state.stopped = false;
        state.stopReason = null;
        rotateGateRevision(state);
        result = { command: "resume", messageId: resumeMessageId };
      }

      state.controlBoundary = withBoundaryCheckpoint(
        state.controlBoundary,
        batch.nextBoundary,
      );
      state.updatedAt = this.now().toISOString();
      await this.save(state);
      return result;
    });
  }

  public getTargetReplyState(): Promise<TargetReplyState> {
    return this.serial.run(() => this.loadTargetReplyState());
  }

  public evaluateTargetReply(input: TargetReplyEvaluationInput): Promise<{
    decision: TargetReplyDecision;
    trigger: TargetReplyTrigger | null;
  }> {
    return this.serial.run(async () => {
      const control = await this.load();
      assertPersistentGate(control, {
        gateRevision: input.expectedGateRevision,
        checkpoint: input.controlCheckpoint,
      });
      const state = await this.loadTargetReplyState();
      const current = targetBaselineFrom(input.messages, input.unreadIndicator);
      const previous = state.baseline;
      if (previous === null || !hasTargetContinuity(previous, current)) {
        state.baseline = current;
        state.pendingTrigger = null;
        await this.saveTargetReplyState(state);
        return {
          decision: waitDecision("BASELINE_ESTABLISHED_NO_SEND"),
          trigger: null,
        };
      }
      current.epoch = previous.epoch;

      const latest = input.messages.at(-1);
      if (latest === undefined) {
        state.baseline = current;
        state.pendingTrigger = null;
        await this.saveTargetReplyState(state);
        return { decision: waitDecision("NO_VISIBLE_MESSAGE"), trigger: null };
      }
      if (latest.direction === "outgoing") {
        state.baseline = current;
        state.pendingTrigger = null;
        await this.saveTargetReplyState(state);
        return { decision: waitDecision("LATEST_VISIBLE_OUTGOING"), trigger: null };
      }

      const existing = state.pendingTrigger;
      if (
        existing !== null &&
        (
          existing.gateRevision !== input.expectedGateRevision ||
          JSON.stringify(existing.controlCheckpoint) !==
            JSON.stringify(input.controlCheckpoint)
        )
      ) {
        state.baseline = current;
        state.pendingTrigger = null;
        await this.saveTargetReplyState(state);
        return { decision: waitDecision("NO_NEW_INCOMING"), trigger: null };
      }
      if (
        existing !== null &&
        existing.triggerMessageId === latest.id &&
        existing.orderedSequenceHash === current.orderedSequenceHash
      ) {
        state.baseline = current;
        await this.saveTargetReplyState(state);
        return {
          decision: {
            action: "reply-latest-incoming",
            triggerMessageId: latest.id,
            reason: "LATEST_VISIBLE_INCOMING",
          },
          trigger: existing,
        };
      }

      const isBaselineRelativeAdded =
        previous.latestMessageId !== latest.id && input.addedIds.includes(latest.id);
      const isUnreadTransition =
        previous.orderedSequenceHash === current.orderedSequenceHash &&
        previous.unreadIndicator === false &&
        current.unreadIndicator === true;
      if (!isBaselineRelativeAdded && !isUnreadTransition) {
        state.baseline = current;
        state.pendingTrigger = null;
        await this.saveTargetReplyState(state);
        return { decision: waitDecision("NO_NEW_INCOMING"), trigger: null };
      }

      const trigger = targetReplyTriggerSchema.parse({
        triggerId: randomBytes(32).toString("hex"),
        baselineEpoch: previous.epoch,
        orderedSequenceHash: current.orderedSequenceHash,
        triggerMessageId: latest.id,
        controlCheckpoint: input.controlCheckpoint,
        gateRevision: input.expectedGateRevision,
        createdAt: this.now().toISOString(),
      });
      state.baseline = current;
      state.pendingTrigger = trigger;
      await this.saveTargetReplyState(state);
      return {
        decision: {
          action: "reply-latest-incoming",
          triggerMessageId: latest.id,
          reason: "LATEST_VISIBLE_INCOMING",
        },
        trigger,
      };
    });
  }

  public consumeTargetReplyTrigger(triggerId: string): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.loadTargetReplyState();
      if (state.pendingTrigger?.triggerId !== triggerId) {
        throw new Error("TARGET_TRIGGER_CHANGED");
      }
      state.pendingTrigger = null;
      await this.saveTargetReplyState(state);
    });
  }

  public claimOwnerNotice(input: {
    triggerIdHash: string;
    reasonCode: string;
  }): Promise<{
    triggerIdHash: string;
    reasonCode: string;
    noticeId: string;
  } | null> {
    return this.serial.run(async () => {
      const triggerIdHash = hex64Schema.parse(input.triggerIdHash);
      const reasonCode = z.string().regex(/^[A-Z0-9_]{1,80}$/u).parse(input.reasonCode);
      const noticeKeyHash = sha256(`${triggerIdHash}\0${reasonCode}`);
      const noticeId = randomBytes(32).toString("hex");
      const claimed = await this.store.createExclusiveMarker(
        `state/owner-notice-claims/${noticeKeyHash}.claim`,
      );
      if (!claimed) return null;
      return { triggerIdHash, reasonCode, noticeId };
    });
  }

  public claimOutgoing(
    fingerprint: string,
    expectedGate?: PersistentStopGate,
  ): Promise<boolean> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (expectedGate !== undefined) assertPersistentGate(state, expectedGate);
      if (state.stopped) {
        throw new Error("SYSTEM_STOPPED");
      }
      if (state.outgoing[fingerprint] !== undefined) {
        return false;
      }
      state.outgoing[fingerprint] = {
        status: "claimed",
        updatedAt: this.now().toISOString(),
      };
      await this.save(state);
      return true;
    });
  }

  public markOutgoingVerified(fingerprint: string): Promise<void> {
    return this.setOutgoingStatus(fingerprint, "verified");
  }

  public markOutgoingUncertain(fingerprint: string): Promise<void> {
    return this.setOutgoingStatus(fingerprint, "uncertain");
  }

  public releaseOutgoingClaim(fingerprint: string): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (state.outgoing[fingerprint]?.status !== "claimed") {
        throw new Error("OUTGOING_NOT_CLAIMED");
      }
      delete state.outgoing[fingerprint];
      await this.save(state);
    });
  }

  public assertOutgoingClaimed(fingerprint: string): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (state.outgoing[fingerprint]?.status !== "claimed") {
        throw new Error("OUTGOING_NOT_CLAIMED");
      }
    });
  }

  public releaseOutgoingClaimForAbort(fingerprint: string): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      const outgoing = state.outgoing[fingerprint];
      if (outgoing === undefined) return;
      if (outgoing.status !== "claimed") {
        throw new Error("OUTGOING_NOT_CLAIMED");
      }
      delete state.outgoing[fingerprint];
      await this.save(state);
    });
  }

  private setOutgoingStatus(
    fingerprint: string,
    status: "verified" | "uncertain",
  ): Promise<void> {
    return this.serial.run(async () => {
      const state = await this.load();
      if (state.outgoing[fingerprint]?.status !== "claimed") {
        throw new Error("OUTGOING_NOT_CLAIMED");
      }
      state.outgoing[fingerprint] = {
        status,
        updatedAt: this.now().toISOString(),
      };
      await this.save(state);
    });
  }

  private async load(): Promise<ControlState> {
    const stored = await this.store.read("state/control.enc", storedControlStateSchema);
    const isCurrent =
      stored !== null &&
      "controlProtocolVersion" in stored &&
      stored.controlProtocolVersion === 3;
    const isProtocolV2 =
      stored !== null &&
      "controlProtocolVersion" in stored &&
      stored.controlProtocolVersion === 2;
    const protocolV2 = isProtocolV2
      ? protocolV2ControlStateSchema.parse(stored)
      : null;
    let current: ControlState;
    if (isCurrent) {
      current = controlStateSchema.parse(stored);
    } else {
      current = controlStateSchema.parse({
        controlProtocolVersion: 3,
        gateRevision: randomGateRevision(),
        stopped: protocolV2?.stopped ?? true,
        stopReason:
          protocolV2 !== null ? protocolV2.stopReason : (
            stored?.stopped === true && stored.stopReason !== null
              ? stored.stopReason
              : "CONTROL_BOUNDARY_REQUIRED"
          ),
        updatedAt: this.now().toISOString(),
        controlBoundary: protocolV2?.controlBoundary ?? createAwaitingControlBoundary(),
        outgoing: stored?.outgoing ?? {},
      });
    }
    const hadAutomaticGlobalStop =
      current.stopped && current.stopReason === "SEND_RESULT_UNCERTAIN";
    if (hadAutomaticGlobalStop) {
      current.stopped = false;
      current.stopReason = null;
      rotateGateRevision(current);
      current.updatedAt = this.now().toISOString();
    }
    if (!isCurrent || hadAutomaticGlobalStop) await this.save(current);
    return current;
  }

  private save(state: ControlState): Promise<void> {
    return this.store.write("state/control.enc", controlStateSchema.parse(state));
  }

  private async loadTargetReplyState(): Promise<TargetReplyState> {
    const stored = await this.store.read("state/target-reply.enc", storedTargetReplyStateSchema);
    if (stored === null) {
      return {
        version: 2,
        baseline: null,
        pendingTrigger: null,
        lastOwnerNoticeKey: null,
      };
    }
    if (stored.version === 2) return stored;
    const migrated = targetReplyStateSchema.parse({
      version: 2,
      baseline: stored.baseline,
      pendingTrigger: null,
      lastOwnerNoticeKey: stored.lastOwnerNoticeKey,
    });
    await this.saveTargetReplyState(migrated);
    return migrated;
  }

  private saveTargetReplyState(state: TargetReplyState): Promise<void> {
    return this.store.write(
      "state/target-reply.enc",
      targetReplyStateSchema.parse(state),
    );
  }
}

type ControlCommandResult = { command: "resume"; messageId: string };

function assertControlBoundary(
  state: ControlState,
  expected: ControlBoundaryCheckpoint,
): void {
  if (
    state.controlBoundary.status !== "active" ||
    JSON.stringify(checkpointOf(state.controlBoundary)) !== JSON.stringify(expected)
  ) {
    throw new Error("CONTROL_CHANGED");
  }
}

function assertPersistentGate(
  state: ControlState,
  expected: PersistentStopGate,
): void {
  if (
    state.stopped ||
    state.gateRevision !== expected.gateRevision ||
    state.controlBoundary.status !== "active" ||
    JSON.stringify(checkpointOf(state.controlBoundary)) !==
      JSON.stringify(expected.checkpoint)
  ) {
    throw new Error("CONTROL_CHANGED");
  }
}

function randomGateRevision(): string {
  return randomBytes(32).toString("hex");
}

function rotateGateRevision(state: ControlState): void {
  state.gateRevision = randomGateRevision();
}

function checkpointOf(boundary: ControlBoundaryState): ControlBoundaryCheckpoint {
  return {
    epoch: boundary.epoch,
    boundaryMessageId: boundary.boundaryMessageId,
    consumedCount: boundary.consumedCount,
    prefixChainHash: boundary.prefixChainHash,
  };
}

function withBoundaryCheckpoint(
  current: ControlBoundaryState,
  checkpoint: ControlBoundaryCheckpoint,
): ControlBoundaryState {
  return controlBoundaryStateSchema.parse({
    ...current,
    ...checkpoint,
    status: "active",
  });
}

function createAwaitingControlBoundary(): ControlBoundaryState {
  const nonce = randomBytes(32).toString("hex");
  const markerText = controlBoundaryMarker(nonce);
  const boundaryMessageId = sha256(`file-transfer\0outgoing\0${markerText}`);
  return {
    status: "awaiting-boundary",
    epoch: randomBytes(32).toString("hex"),
    nonce,
    boundaryMessageId,
    consumedCount: 0,
    prefixChainHash: boundaryMessageId,
  };
}

function controlBoundaryMarker(nonce: string): string {
  return `聊天助手控制边界 ${nonce}`;
}

function targetBaselineFrom(
  messages: TargetReplyEvaluationInput["messages"],
  unreadIndicator: boolean | null,
): z.infer<typeof targetReplyBaselineSchema> {
  const latest = messages.at(-1);
  return {
    epoch: randomBytes(32).toString("hex"),
    orderedSequenceHash: sha256(messages.map((message) =>
      `${message.id}\0${message.direction}`
    ).join("\0")),
    visibleMessageIds: messages.map((message) => message.id),
    latestMessageId: latest?.id ?? null,
    latestDirection: latest?.direction ?? null,
    unreadIndicator,
  };
}

function hasTargetContinuity(
  previous: z.infer<typeof targetReplyBaselineSchema>,
  current: z.infer<typeof targetReplyBaselineSchema>,
): boolean {
  if (previous.orderedSequenceHash === current.orderedSequenceHash) return true;
  if (previous.latestMessageId === null) return current.visibleMessageIds.length === 0;
  return current.visibleMessageIds.filter((id) => id === previous.latestMessageId).length === 1;
}

function waitDecision(reason: TargetReplyDecision["reason"]): TargetReplyDecision {
  return { action: "wait", triggerMessageId: null, reason };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encryptedStoreCoordinationKey(store: EncryptedStore): string {
  return encryptedStoreRoot(store);
}

export class AuditRepository {
  private readonly serial = new SerialExecutor();

  public constructor(
    private readonly store: EncryptedStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public record(event: AuditEvent): Promise<string> {
    return this.serial.run(async () => {
      const id = randomUUID();
      await this.append(id, event);
      return id;
    });
  }

  public recordOnce(id: string, event: AuditEvent): Promise<string> {
    return this.serial.run(async () => {
      const document = await this.load();
      const existing = document.records.find((record) => record.id === id);
      if (existing !== undefined) {
        if (
          existing.type !== event.type ||
          JSON.stringify(existing.details) !== JSON.stringify(event.details)
        ) {
          throw new Error("AUDIT_ID_CONFLICT");
        }
        return id;
      }
      const record = auditRecordSchema.parse({
        id,
        type: event.type,
        occurredAt: this.now().toISOString(),
        details: event.details,
      });
      document.records.push(record);
      await this.store.write("logs/audit.enc", document);
      return id;
    });
  }

  public list(): Promise<AuditRecord[]> {
    return this.serial.run(async () => (await this.load()).records);
  }

  private async load(): Promise<z.infer<typeof auditDocumentSchema>> {
    return (
      (await this.store.read("logs/audit.enc", auditDocumentSchema)) ?? {
        records: [],
      }
    );
  }

  private async append(id: string, event: AuditEvent): Promise<void> {
    const document = await this.load();
    document.records.push(auditRecordSchema.parse({
      id,
      type: event.type,
      occurredAt: this.now().toISOString(),
      details: event.details,
    }));
    await this.store.write("logs/audit.enc", document);
  }
}

export class PendingSendRepository {
  private readonly serial = new SerialExecutor();

  public constructor(private readonly store: EncryptedStore) {}

  public get(): Promise<PendingSend | null> {
    return this.serial.run(async () =>
      (await this.store.read("state/pending-send.enc", pendingSendDocumentSchema)) ?? null,
    );
  }

  public put(candidate: PendingSend): Promise<void> {
    return this.serial.run(async () => {
      if ((await this.store.read("state/pending-send.enc", pendingSendDocumentSchema)) !== null) {
        throw new Error("PENDING_SEND_EXISTS");
      }
      await this.store.write("state/pending-send.enc", pendingSendSchema.parse(candidate));
    });
  }

  public clearMatching(tokenHash: string): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.store.read("state/pending-send.enc", pendingSendDocumentSchema);
      if (current === null || current.tokenHash !== tokenHash) {
        throw new Error("PENDING_SEND_TOKEN_MISMATCH");
      }
      await this.store.write("state/pending-send.enc", null);
    });
  }

  public clearMatchingIfPresent(tokenHash: string): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.store.read("state/pending-send.enc", pendingSendDocumentSchema);
      if (current === null) return;
      if (current.tokenHash !== tokenHash) {
        throw new Error("PENDING_SEND_TOKEN_MISMATCH");
      }
      await this.store.write("state/pending-send.enc", null);
    });
  }

  public markDraftVerified(tokenHash: string, verifiedAt: string): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.store.read("state/pending-send.enc", pendingSendDocumentSchema);
      if (current === null || current.tokenHash !== tokenHash) {
        throw new Error("PENDING_SEND_TOKEN_MISMATCH");
      }
      current.draftVerifiedAt = verifiedAt;
      await this.store.write("state/pending-send.enc", pendingSendSchema.parse(current));
    });
  }
}


export class AbortIntentRepository {
  private readonly serial = new SerialExecutor();

  public constructor(private readonly store: EncryptedStore) {}

  public get(): Promise<AbortIntent | null> {
    return this.serial.run(async () =>
      (await this.store.read("state/abort-intent.enc", abortIntentDocumentSchema)) ?? null,
    );
  }

  public put(intent: AbortIntent): Promise<void> {
    return this.serial.run(async () => {
      const validated = abortIntentSchema.parse(intent);
      const current = await this.store.read(
        "state/abort-intent.enc",
        abortIntentDocumentSchema,
      );
      if (current !== null) {
        if (JSON.stringify(current) !== JSON.stringify(validated)) {
          throw new Error("ABORT_INTENT_CONFLICT");
        }
        return;
      }
      await this.store.write("state/abort-intent.enc", validated);
    });
  }

  public clearMatching(intentId: string): Promise<void> {
    return this.serial.run(async () => {
      const current = await this.store.read(
        "state/abort-intent.enc",
        abortIntentDocumentSchema,
      );
      if (current === null || current.intentId !== intentId) {
        throw new Error("ABORT_INTENT_CONFLICT");
      }
      await this.store.write("state/abort-intent.enc", null);
    });
  }
}

export class InMemoryRealtimeReplyRepository implements RealtimeReplyStateRepository {
  private document: z.infer<typeof realtimeReplyDocumentSchema> = {
    version: 1, records: [], batches: [],
  };
  private readonly serial = new SerialExecutor();

  public claim(input: ClaimRealtimeReplyInput): Promise<{
    claimed: boolean;
    record: RealtimeReplyRecord;
  }> {
    return this.serial.run(() => {
      const result = claimRealtimeRecord(this.document, input);
      this.document = result.document;
      return Promise.resolve(result.result);
    });
  }

  public compareAndSet(input: {
    readonly key: RealtimeReplyKey;
    readonly expectedStatus: RealtimeReplyStatus;
    readonly next: RealtimeReplyTransition;
    readonly now: Date;
  }): Promise<boolean> {
    return this.serial.run(() => {
      const result = transitionRealtimeRecord(this.document, input);
      this.document = result.document;
      return Promise.resolve(result.result);
    });
  }

  public cancelPreSubmit(
    contactId: ContactId,
    reason: Extract<RealtimeReplyReason, "OWNER_REPLIED" | "SUPERSEDED" | "CONTACT_CHANGED">,
    now: Date,
    exceptTriggerId?: string,
  ): Promise<number> {
    return this.serial.run(() => {
      const result = cancelRealtimePreSubmit(
        this.document, contactId, reason, now, exceptTriggerId,
      );
      this.document = result.document;
      return Promise.resolve(result.result);
    });
  }

  public get(key: RealtimeReplyKey): Promise<RealtimeReplyRecord | null> {
    return this.serial.run(() => Promise.resolve(findRealtimeRecord(this.document, key)));
  }

  public list(): Promise<readonly RealtimeReplyRecord[]> {
    return this.serial.run(() => Promise.resolve(cloneRealtimeRecords(this.document.records)));
  }

  public listRecoverable(): Promise<readonly RealtimeReplyRecord[]> {
    return this.serial.run(() => Promise.resolve(recoverableRealtimeRecords(this.document)));
  }

  public appendBufferedMessage(input: AppendBufferedMessageInput): Promise<RealtimeBufferedBatch> {
    return this.serial.run(() => {
      const result = appendRealtimeBufferedMessage(this.document, input);
      this.document = result.document;
      return Promise.resolve(result.result);
    });
  }

  public clearBufferedBatch(contactId: ContactId): Promise<boolean> {
    return this.serial.run(() => {
      const result = clearRealtimeBufferedBatch(this.document, contactId);
      this.document = result.document;
      return Promise.resolve(result.result);
    });
  }

  public listBufferedBatches(): Promise<readonly RealtimeBufferedBatch[]> {
    return this.serial.run(() => Promise.resolve(cloneRealtimeBatches(this.document.batches)));
  }

  public claimBufferedBatch(contactId: ContactId, now: Date): Promise<{
    readonly claimed: boolean;
    readonly record: RealtimeReplyRecord | null;
  }> {
    return this.serial.run(() => {
      const result = claimRealtimeBufferedBatch(this.document, contactId, now);
      this.document = result.document;
      return Promise.resolve(result.result);
    });
  }

  public hasPendingWork(): Promise<boolean> {
    return this.serial.run(() => Promise.resolve(hasRealtimePendingWork(this.document)));
  }

  public hasActiveForContact(contactId: ContactId): Promise<boolean> {
    return this.serial.run(() => Promise.resolve(
      findActiveRealtimeRecord(this.document, contactId) !== undefined,
    ));
  }

  public hasRecentConversation(now: Date, windowMs: number): Promise<boolean> {
    return this.serial.run(() => Promise.resolve(
      hasRecentRealtimeConversation(this.document, now, windowMs),
    ));
  }
}

export class RealtimeReplyRepository implements RealtimeReplyStateRepository {
  public constructor(private readonly store: EncryptedStore) {}

  public claim(input: ClaimRealtimeReplyInput): Promise<{
    claimed: boolean;
    record: RealtimeReplyRecord;
  }> {
    return this.transact((document) => claimRealtimeRecord(document, input));
  }

  public compareAndSet(input: {
    readonly key: RealtimeReplyKey;
    readonly expectedStatus: RealtimeReplyStatus;
    readonly next: RealtimeReplyTransition;
    readonly now: Date;
  }): Promise<boolean> {
    return this.transact((document) => transitionRealtimeRecord(document, input));
  }

  public cancelPreSubmit(
    contactId: ContactId,
    reason: Extract<RealtimeReplyReason, "OWNER_REPLIED" | "SUPERSEDED" | "CONTACT_CHANGED">,
    now: Date,
    exceptTriggerId?: string,
  ): Promise<number> {
    return this.transact((document) =>
      cancelRealtimePreSubmit(document, contactId, reason, now, exceptTriggerId));
  }

  public get(key: RealtimeReplyKey): Promise<RealtimeReplyRecord | null> {
    return this.store.runExclusiveTransaction("state/realtime-replies.lock", async () =>
      findRealtimeRecord(await this.load(), key));
  }

  public list(): Promise<readonly RealtimeReplyRecord[]> {
    return this.store.runExclusiveTransaction("state/realtime-replies.lock", async () =>
      cloneRealtimeRecords((await this.load()).records));
  }

  public listRecoverable(): Promise<readonly RealtimeReplyRecord[]> {
    return this.store.runExclusiveTransaction("state/realtime-replies.lock", async () =>
      recoverableRealtimeRecords(await this.load()));
  }

  public appendBufferedMessage(input: AppendBufferedMessageInput): Promise<RealtimeBufferedBatch> {
    return this.transact((document) => appendRealtimeBufferedMessage(document, input));
  }

  public clearBufferedBatch(contactId: ContactId): Promise<boolean> {
    return this.transact((document) => clearRealtimeBufferedBatch(document, contactId));
  }

  public listBufferedBatches(): Promise<readonly RealtimeBufferedBatch[]> {
    return this.store.runExclusiveTransaction("state/realtime-replies.lock", async () =>
      cloneRealtimeBatches((await this.load()).batches));
  }

  public claimBufferedBatch(contactId: ContactId, now: Date): Promise<{
    readonly claimed: boolean;
    readonly record: RealtimeReplyRecord | null;
  }> {
    return this.transact((document) => claimRealtimeBufferedBatch(document, contactId, now));
  }

  public hasPendingWork(): Promise<boolean> {
    return this.store.runExclusiveTransaction("state/realtime-replies.lock", async () =>
      hasRealtimePendingWork(await this.load()));
  }

  public hasActiveForContact(contactId: ContactId): Promise<boolean> {
    return this.store.runExclusiveTransaction("state/realtime-replies.lock", async () =>
      findActiveRealtimeRecord(await this.load(), contactId) !== undefined);
  }

  public hasRecentConversation(now: Date, windowMs: number): Promise<boolean> {
    return this.store.runExclusiveTransaction("state/realtime-replies.lock", async () =>
      hasRecentRealtimeConversation(await this.load(), now, windowMs));
  }

  private async transact<T>(operation: (
    document: z.infer<typeof realtimeReplyDocumentSchema>,
  ) => {
    document: z.infer<typeof realtimeReplyDocumentSchema>;
    result: T;
    changed: boolean;
  }): Promise<T> {
    return this.store.runExclusiveTransaction("state/realtime-replies.lock", async () => {
      const completed = operation(await this.load());
      if (completed.changed) {
        await this.store.write(
          "state/realtime-replies.enc",
          realtimeReplyDocumentSchema.parse(completed.document),
        );
      }
      return completed.result;
    });
  }

  private async load(): Promise<z.infer<typeof realtimeReplyDocumentSchema>> {
    return (await this.store.read(
      "state/realtime-replies.enc",
      realtimeReplyDocumentSchema,
    )) ?? { version: 1, records: [], batches: [] };
  }
}

type AppendBufferedMessageInput = {
  readonly target: AuthorizedWechatTarget;
  readonly message: NormalizedInboundMessage;
  readonly deadline: Date;
  readonly now: Date;
};

function appendRealtimeBufferedMessage(
  documentInput: z.infer<typeof realtimeReplyDocumentSchema>,
  input: AppendBufferedMessageInput,
): {
  document: z.infer<typeof realtimeReplyDocumentSchema>;
  result: RealtimeBufferedBatch;
  changed: boolean;
} {
  assertRealtimeNow(input.now);
  assertRealtimeNow(input.deadline);
  if (input.deadline.getTime() < input.now.getTime()) {
    throw new Error("REALTIME_BUFFER_DEADLINE_INVALID");
  }
  const message = normalizedInboundMessageSchema.parse(input.message);
  if (message.direction !== "incoming" || message.conversationId !== input.target.contactId) {
    throw new Error("REALTIME_BUFFER_MESSAGE_INVALID");
  }
  const document = structuredClone(documentInput);
  const index = document.batches.findIndex(({ contactId }) =>
    contactId === input.target.contactId);
  const existing = index === -1 ? undefined : document.batches[index];
  const bindingChanged = existing !== undefined && (
    existing.contactRevision !== input.target.revision ||
    existing.bindingHash !== input.target.bindingHash ||
    existing.source !== message.source ||
    existing.sourceEpoch !== message.sourceEpoch ||
    existing.sessionId !== message.sessionId
  );
  const messages = existing === undefined || bindingChanged
    ? [message]
    : [...existing.messages.filter(({ messageId }) => messageId !== message.messageId), message]
      .sort((left, right) => left.sequence - right.sequence);
  const timestamp = input.now.toISOString();
  const batch = realtimeBufferedBatchSchema.parse({
    version: 1,
    contactId: input.target.contactId,
    contactRevision: input.target.revision,
    bindingHash: input.target.bindingHash,
    source: message.source,
    sourceEpoch: message.sourceEpoch,
    sessionId: message.sessionId,
    messages,
    deadlineAt: input.deadline.toISOString(),
    createdAt: existing === undefined || bindingChanged ? timestamp : existing.createdAt,
    updatedAt: timestamp,
  });
  if (index === -1) document.batches.push(batch);
  else document.batches[index] = batch;
  return {
    document: realtimeReplyDocumentSchema.parse(document),
    result: structuredClone(batch),
    changed: true,
  };
}

function clearRealtimeBufferedBatch(
  documentInput: z.infer<typeof realtimeReplyDocumentSchema>,
  contactIdInput: ContactId,
): {
  document: z.infer<typeof realtimeReplyDocumentSchema>;
  result: boolean;
  changed: boolean;
} {
  const contactId = contactIdSchema.parse(contactIdInput);
  const document = structuredClone(documentInput);
  const before = document.batches.length;
  document.batches = document.batches.filter((batch) => batch.contactId !== contactId);
  const changed = before !== document.batches.length;
  return { document: realtimeReplyDocumentSchema.parse(document), result: changed, changed };
}

function claimRealtimeBufferedBatch(
  documentInput: z.infer<typeof realtimeReplyDocumentSchema>,
  contactIdInput: ContactId,
  now: Date,
): {
  document: z.infer<typeof realtimeReplyDocumentSchema>;
  result: { claimed: boolean; record: RealtimeReplyRecord | null };
  changed: boolean;
} {
  assertRealtimeNow(now);
  const contactId = contactIdSchema.parse(contactIdInput);
  const document = structuredClone(documentInput);
  const batchIndex = document.batches.findIndex((batch) => batch.contactId === contactId);
  const batch = document.batches[batchIndex];
  if (batch === undefined) {
    return { document, result: { claimed: false, record: null }, changed: false };
  }
  const active = findActiveRealtimeRecord(document, contactId);
  if (active !== undefined) {
    return {
      document,
      result: { claimed: false, record: structuredClone(active) },
      changed: false,
    };
  }
  const triggerId = deriveConversationTriggerId({
    contactId: batch.contactId,
    contactRevision: batch.contactRevision,
    bindingHash: batch.bindingHash,
    source: batch.source,
    sourceEpoch: batch.sourceEpoch,
    sessionId: batch.sessionId,
    sourceMessageIds: batch.messages.map(({ messageId }) => messageId),
  });
  const timestamp = now.toISOString();
  const record = realtimeReplyRecordSchema.parse({
    version: 1,
    contactId: batch.contactId,
    contactRevision: batch.contactRevision,
    bindingHash: batch.bindingHash,
    triggerId,
    source: batch.source,
    sourceEpoch: batch.sourceEpoch,
    sessionId: batch.sessionId,
    messages: batch.messages,
    intent: null,
    status: "new",
    reason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  document.records.push(record);
  document.batches.splice(batchIndex, 1);
  return {
    document: realtimeReplyDocumentSchema.parse(document),
    result: { claimed: true, record: structuredClone(record) },
    changed: true,
  };
}

function cloneRealtimeBatches(
  batches: readonly RealtimeBufferedBatch[],
): readonly RealtimeBufferedBatch[] {
  return Object.freeze(batches.map((batch) => Object.freeze(structuredClone(batch))));
}

function hasRealtimePendingWork(
  document: z.infer<typeof realtimeReplyDocumentSchema>,
): boolean {
  return document.batches.length > 0 || document.records.some((record) =>
    isActiveRealtimeStatus(record.status));
}

function hasRecentRealtimeConversation(
  document: z.infer<typeof realtimeReplyDocumentSchema>,
  now: Date,
  windowMs: number,
): boolean {
  assertRealtimeNow(now);
  if (!Number.isInteger(windowMs) || windowMs < 1 || windowMs > 24 * 60 * 60 * 1_000) {
    throw new Error("REALTIME_RECENT_WINDOW_INVALID");
  }
  const cutoff = now.getTime() - windowMs;
  return document.batches.some((batch) => Date.parse(batch.updatedAt) >= cutoff) ||
    document.records.some((record) => Date.parse(record.updatedAt) >= cutoff);
}

function isActiveRealtimeStatus(status: RealtimeReplyStatus): boolean {
  return ["new", "generating", "prepared", "submit-started", "submitted-uncertain"]
    .includes(status);
}

function findActiveRealtimeRecord(
  document: z.infer<typeof realtimeReplyDocumentSchema>,
  contactId: ContactId,
): RealtimeReplyRecord | undefined {
  return document.records.find((record) =>
    record.contactId === contactId && isActiveRealtimeStatus(record.status));
}

function claimRealtimeRecord(
  documentInput: z.infer<typeof realtimeReplyDocumentSchema>,
  input: ClaimRealtimeReplyInput,
): {
  document: z.infer<typeof realtimeReplyDocumentSchema>;
  result: { claimed: boolean; record: RealtimeReplyRecord };
  changed: boolean;
} {
  assertRealtimeNow(input.now);
  const document = structuredClone(documentInput);
  const key = realtimeKeyFromClaim(input);
  const existing = document.records.find((record) => realtimeKeysEqual(record, key));
  if (existing !== undefined) {
    return { document, result: { claimed: false, record: structuredClone(existing) }, changed: false };
  }
  const active = findActiveRealtimeRecord(document, key.contactId);
  if (active !== undefined) {
    return {
      document,
      result: { claimed: false, record: structuredClone(active) },
      changed: false,
    };
  }
  const timestamp = input.now.toISOString();
  const record = realtimeReplyRecordSchema.parse({
    version: 1,
    ...key,
    source: input.source,
    sourceEpoch: input.sourceEpoch,
    sessionId: input.sessionId,
    messages: input.messages,
    intent: null,
    status: "new",
    reason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  document.records.push(record);
  return {
    document: realtimeReplyDocumentSchema.parse(document),
    result: { claimed: true, record: structuredClone(record) },
    changed: true,
  };
}

function transitionRealtimeRecord(
  documentInput: z.infer<typeof realtimeReplyDocumentSchema>,
  input: {
    readonly key: RealtimeReplyKey;
    readonly expectedStatus: RealtimeReplyStatus;
    readonly next: RealtimeReplyTransition;
    readonly now: Date;
  },
): {
  document: z.infer<typeof realtimeReplyDocumentSchema>;
  result: boolean;
  changed: boolean;
} {
  assertRealtimeNow(input.now);
  const key = parseRealtimeKey(input.key);
  const document = structuredClone(documentInput);
  const index = document.records.findIndex((record) => realtimeKeysEqual(record, key));
  const current = document.records[index];
  if (current === undefined || current.status !== input.expectedStatus) {
    return { document, result: false, changed: false };
  }
  assertRealtimeTransition(current.status, input.next.status);
  const next = realtimeReplyRecordSchema.parse({
    ...current,
    status: input.next.status,
    intent: input.next.status === "prepared" ? input.next.intent : current.intent,
    reason: input.next.status === "cancelled" || input.next.status === "failed"
      ? input.next.reason
      : null,
    readbackBaseline:
      input.next.status === "submit-started"
        ? input.next.readbackBaseline ?? current.readbackBaseline
        : current.readbackBaseline,
    updatedAt: input.now.toISOString(),
  });
  document.records[index] = next;
  return {
    document: realtimeReplyDocumentSchema.parse(document),
    result: true,
    changed: true,
  };
}

function cancelRealtimePreSubmit(
  documentInput: z.infer<typeof realtimeReplyDocumentSchema>,
  contactIdInput: ContactId,
  reason: Extract<RealtimeReplyReason, "OWNER_REPLIED" | "SUPERSEDED" | "CONTACT_CHANGED">,
  now: Date,
  exceptTriggerId?: string,
): {
  document: z.infer<typeof realtimeReplyDocumentSchema>;
  result: number;
  changed: boolean;
} {
  assertRealtimeNow(now);
  const document = structuredClone(documentInput);
  const count = cancelRealtimePreSubmitMutable(
    document,
    contactIdSchema.parse(contactIdInput),
    realtimeReplyReasonSchema.parse(reason),
    now.toISOString(),
    exceptTriggerId,
  );
  return {
    document: realtimeReplyDocumentSchema.parse(document),
    result: count,
    changed: count > 0,
  };
}

function cancelRealtimePreSubmitMutable(
  document: z.infer<typeof realtimeReplyDocumentSchema>,
  contactId: ContactId,
  reason: RealtimeReplyReason,
  now: string,
  exceptTriggerId?: string,
): number {
  let count = 0;
  for (let index = 0; index < document.records.length; index += 1) {
    const record = document.records[index];
    if (record === undefined || record.contactId !== contactId ||
        record.triggerId === exceptTriggerId ||
        !["new", "generating", "prepared"].includes(record.status)) continue;
    document.records[index] = realtimeReplyRecordSchema.parse({
      ...record,
      status: "cancelled",
      reason,
      updatedAt: now,
    });
    count += 1;
  }
  return count;
}

function recoverableRealtimeRecords(
  document: z.infer<typeof realtimeReplyDocumentSchema>,
): readonly RealtimeReplyRecord[] {
  return cloneRealtimeRecords(document.records.filter((record) => [
    "new", "generating", "prepared", "submit-started", "submitted-uncertain",
  ].includes(record.status)));
}

function findRealtimeRecord(
  document: z.infer<typeof realtimeReplyDocumentSchema>,
  keyInput: RealtimeReplyKey,
): RealtimeReplyRecord | null {
  const key = parseRealtimeKey(keyInput);
  const record = document.records.find((candidate) => realtimeKeysEqual(candidate, key));
  return record === undefined ? null : structuredClone(record);
}

function cloneRealtimeRecords(
  records: readonly RealtimeReplyRecord[],
): readonly RealtimeReplyRecord[] {
  return Object.freeze(records.map((record) => Object.freeze(structuredClone(record))));
}

function realtimeKeyFromClaim(input: ClaimRealtimeReplyInput): RealtimeReplyKey {
  return parseRealtimeKey({
    contactId: input.target.contactId,
    contactRevision: input.target.revision,
    bindingHash: input.target.bindingHash,
    triggerId: input.triggerId,
  });
}

function parseRealtimeKey(input: RealtimeReplyKey): RealtimeReplyKey {
  return {
    contactId: contactIdSchema.parse(input.contactId),
    contactRevision: z.number().int().positive().parse(input.contactRevision),
    bindingHash: hex64Schema.parse(input.bindingHash),
    triggerId: hex64Schema.parse(input.triggerId),
  };
}

function realtimeKeysEqual(left: RealtimeReplyKey, right: RealtimeReplyKey): boolean {
  return left.contactId === right.contactId &&
    left.contactRevision === right.contactRevision &&
    left.bindingHash === right.bindingHash &&
    left.triggerId === right.triggerId;
}

function assertRealtimeTransition(
  current: RealtimeReplyStatus,
  next: RealtimeReplyStatus,
): void {
  const allowed: Record<RealtimeReplyStatus, readonly RealtimeReplyStatus[]> = {
    new: ["generating", "cancelled", "failed"],
    generating: ["prepared", "cancelled", "failed"],
    prepared: ["submit-started", "cancelled", "failed"],
    "submit-started": ["verified", "submitted-uncertain"],
    "submitted-uncertain": ["verified", "submitted-uncertain"],
    verified: [],
    cancelled: [],
    failed: [],
  };
  if (!allowed[current].includes(next)) throw new Error("REALTIME_STATE_TRANSITION_INVALID");
}

function assertRealtimeNow(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("REALTIME_TIMESTAMP_INVALID");
  }
}
