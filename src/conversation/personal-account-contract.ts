import { createHash } from "node:crypto";

import { z } from "zod";

import {
  contactIdSchema,
  type ContactId,
} from "../contacts/contact-schema.js";
import { ContactDirectory, type AuthorizedWechatTarget } from "../contacts/contact-directory.js";

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonBlankIdSchema = z.string().trim().min(1).max(512);
const replyTextSchema = z.string().trim().min(1).max(4_000);

export const inboundSourceKindSchema = z.enum([
  "native-ocr",
  "weflow-sse",
]);

export const inboundSourceStatusSchema = z.object({
  contractVersion: z.literal(1),
  source: inboundSourceKindSchema,
  sourceEpoch: nonBlankIdSchema,
  state: z.enum([
    "stopped",
    "starting",
    "waiting",
    "processing",
    "blocked",
    "degraded",
  ]),
  lastEventAt: z.iso.datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(1).max(160).nullable(),
}).strict().superRefine((value, context) => {
  const ready = value.state === "waiting" || value.state === "processing";
  if (ready && value.reason !== null) {
    context.addIssue({ code: "custom", message: "READY_SOURCE_MUST_NOT_HAVE_REASON" });
  }
  if (!ready && value.state !== "starting" && value.reason === null) {
    context.addIssue({ code: "custom", message: "UNAVAILABLE_SOURCE_REQUIRES_REASON" });
  }
});

export const normalizedInboundMessageSchema = z.object({
  contractVersion: z.literal(1),
  source: inboundSourceKindSchema,
  sourceEpoch: nonBlankIdSchema,
  sessionId: nonBlankIdSchema,
  conversationId: contactIdSchema,
  messageId: hex64Schema,
  sequence: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime({ offset: true }),
  direction: z.enum(["incoming", "outgoing"]),
  kind: z.enum(["text", "image", "emoji", "file", "unsupported"]),
  text: z.string().max(8_000),
}).strict();

const conversationEngineMessageSchema = z.object({
  messageId: hex64Schema,
  direction: z.enum(["incoming", "outgoing"]),
  kind: z.enum(["text", "image", "emoji", "file", "unsupported"]),
  text: z.string().max(8_000),
  occurredAt: z.iso.datetime({ offset: true }),
}).strict();

export const conversationEngineRequestSchema = z.object({
  contractVersion: z.literal(1),
  triggerId: hex64Schema,
  conversationId: contactIdSchema,
  contactId: contactIdSchema,
  contactRevision: z.number().int().positive(),
  bindingHash: hex64Schema,
  source: inboundSourceKindSchema,
  sourceEpoch: nonBlankIdSchema,
  sessionId: nonBlankIdSchema,
  latestIncomingMessageId: hex64Schema,
  messages: z.array(conversationEngineMessageSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.conversationId !== value.contactId) {
    context.addIssue({ code: "custom", message: "CONVERSATION_CONTACT_MISMATCH" });
  }
  if (value.triggerId !== deriveConversationTriggerId({
    contactId: value.contactId,
    contactRevision: value.contactRevision,
    bindingHash: value.bindingHash,
    source: value.source,
    sourceEpoch: value.sourceEpoch,
    sessionId: value.sessionId,
    sourceMessageIds: value.messages.map(({ messageId }) => messageId),
  })) {
    context.addIssue({ code: "custom", message: "TRIGGER_ID_MISMATCH" });
  }
  const latestIncoming = [...value.messages].reverse().find((message) =>
    message.direction === "incoming"
  );
  if (latestIncoming === undefined) {
    context.addIssue({ code: "custom", message: "LATEST_INCOMING_REQUIRED" });
  } else if (value.latestIncomingMessageId !== latestIncoming.messageId) {
    context.addIssue({ code: "custom", message: "LATEST_INCOMING_MISMATCH" });
  }
});

export const conversationEngineResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("reply"),
    text: replyTextSchema,
  }).strict(),
  z.object({
    status: z.literal("refused"),
    reason: z.enum([
      "POLICY_BLOCKED",
      "MODEL_UNAVAILABLE",
      "NO_REPLY_NEEDED",
    ]),
  }).strict(),
]);

export const replyIntentSchema = z.object({
  contractVersion: z.literal(1),
  status: z.literal("prepared"),
  triggerId: hex64Schema,
  conversationId: contactIdSchema,
  contactId: contactIdSchema,
  contactRevision: z.number().int().positive(),
  bindingHash: hex64Schema,
  source: inboundSourceKindSchema,
  sourceEpoch: nonBlankIdSchema,
  sessionId: nonBlankIdSchema,
  replyText: replyTextSchema,
  sourceMessageIds: z.array(hex64Schema).min(1).max(100),
  deliveryKey: hex64Schema,
}).strict().superRefine((value, context) => {
  if (value.conversationId !== value.contactId) {
    context.addIssue({ code: "custom", message: "CONVERSATION_CONTACT_MISMATCH" });
  }
  if (value.triggerId !== deriveConversationTriggerId({
    contactId: value.contactId,
    contactRevision: value.contactRevision,
    bindingHash: value.bindingHash,
    source: value.source,
    sourceEpoch: value.sourceEpoch,
    sessionId: value.sessionId,
    sourceMessageIds: value.sourceMessageIds,
  })) {
    context.addIssue({ code: "custom", message: "TRIGGER_ID_MISMATCH" });
  }
  if (value.deliveryKey !== deriveReplyDeliveryKey({
    triggerId: value.triggerId,
    contactId: value.contactId,
    contactRevision: value.contactRevision,
    bindingHash: value.bindingHash,
    replyText: value.replyText,
  })) {
    context.addIssue({ code: "custom", message: "DELIVERY_KEY_MISMATCH" });
  }
});

export const targetBindingSchema = z.object({
  contactId: contactIdSchema,
  contactRevision: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(64),
  source: inboundSourceKindSchema,
  sourceEpoch: nonBlankIdSchema,
  sessionId: nonBlankIdSchema,
  bindingHash: hex64Schema,
}).strict();

export type InboundSourceKind = z.infer<typeof inboundSourceKindSchema>;
export type InboundSourceStatus = z.infer<typeof inboundSourceStatusSchema>;
export type NormalizedInboundMessage = z.infer<typeof normalizedInboundMessageSchema>;
export type ConversationEngineRequest = z.infer<typeof conversationEngineRequestSchema>;
export type ConversationEngineResponse = z.infer<typeof conversationEngineResponseSchema>;
export type ReplyIntent = z.infer<typeof replyIntentSchema>;
export type TargetBinding = z.infer<typeof targetBindingSchema>;

export function deriveConversationTriggerId(input: {
  contactId: ContactId;
  contactRevision: number;
  bindingHash: string;
  source: InboundSourceKind;
  sourceEpoch: string;
  sessionId: string;
  sourceMessageIds: readonly string[];
}): string {
  return sha256([
    "personal-account-trigger-v2",
    contactIdSchema.parse(input.contactId),
    z.number().int().positive().parse(input.contactRevision).toString(),
    hex64Schema.parse(input.bindingHash),
    inboundSourceKindSchema.parse(input.source),
    nonBlankIdSchema.parse(input.sourceEpoch),
    nonBlankIdSchema.parse(input.sessionId),
    ...input.sourceMessageIds.map((messageId) => hex64Schema.parse(messageId)),
  ]);
}

export function deriveReplyDeliveryKey(input: {
  triggerId: string;
  contactId: ContactId;
  contactRevision: number;
  bindingHash: string;
  replyText: string;
}): string {
  return sha256([
    "personal-account-delivery-v2",
    hex64Schema.parse(input.triggerId),
    contactIdSchema.parse(input.contactId),
    z.number().int().positive().parse(input.contactRevision).toString(),
    hex64Schema.parse(input.bindingHash),
    replyTextSchema.parse(input.replyText),
  ]);
}

function createTargetBinding(input: {
  target: AuthorizedWechatTarget;
  source: InboundSourceKind;
  sourceEpoch: string;
  sessionId: string;
}): TargetBinding {
  return targetBindingSchema.parse({
    contactId: input.target.contactId,
    contactRevision: input.target.revision,
    displayName: input.target.displayName,
    source: input.source,
    sourceEpoch: input.sourceEpoch,
    sessionId: input.sessionId,
    bindingHash: input.target.bindingHash,
  });
}

export interface InboundMessageSourceHandlers {
  onMessage(message: NormalizedInboundMessage): Promise<void> | void;
  onStatus(status: InboundSourceStatus): Promise<void> | void;
}

export interface InboundMessageSource {
  getStatus(): InboundSourceStatus;
  start(handlers: InboundMessageSourceHandlers): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export interface ConversationEngine {
  generate(request: ConversationEngineRequest): Promise<ConversationEngineResponse>;
}

export type PersonalAccountCoordinatorResult =
  | { status: "reply-intent"; intent: ReplyIntent }
  | {
    status: "ignored";
    reason:
      | "DUPLICATE_MESSAGE"
      | "OUT_OF_ORDER_MESSAGE"
      | "TARGET_NOT_ALLOWED"
      | "LATEST_OUTGOING"
      | "EMPTY_BATCH"
      | "UNSUPPORTED_MESSAGE"
      | "ENGINE_REFUSED";
  }
  | {
    status: "blocked";
    reason:
      | "SOURCE_NOT_READY"
      | "SOURCE_BINDING_MISMATCH"
      | "PENDING_REPLY_EXISTS";
  }
  | { status: "cancelled"; reason: "OWNER_REPLIED"; triggerId: string };

export class OfflinePersonalAccountCoordinator {
  private sourceStatus: InboundSourceStatus;
  private readonly seenMessageIds = new Set<string>();
  private highWaterSequence: number | null = null;
  private pendingIntent: ReplyIntent | null = null;
  private readonly targetBinding: TargetBinding;
  private processing = Promise.resolve();

  private constructor(input: {
    engine: ConversationEngine;
    targetBinding: TargetBinding;
  }, token: symbol) {
    if (token !== coordinatorConstructionToken) throw new Error("COORDINATOR_FACTORY_REQUIRED");
    this.engine = input.engine;
    this.targetBinding = targetBindingSchema.parse(input.targetBinding);
    this.sourceStatus = {
      contractVersion: 1,
      source: this.targetBinding.source,
      sourceEpoch: this.targetBinding.sourceEpoch,
      state: "stopped",
      lastEventAt: null,
      reason: "SOURCE_NOT_STARTED",
    };
  }

  private readonly engine: ConversationEngine;

  public static async create(input: {
    directory: ContactDirectory;
    contactId: ContactId;
    expectedRevision: number;
    engine: ConversationEngine;
    source: InboundSourceKind;
    sourceEpoch: string;
    sessionId: string;
  }): Promise<OfflinePersonalAccountCoordinator> {
    const target = await input.directory.requireTextTarget(input.contactId, input.expectedRevision);
    return new OfflinePersonalAccountCoordinator({
      engine: input.engine,
      targetBinding: createTargetBinding({
        target,
        source: input.source,
        sourceEpoch: input.sourceEpoch,
        sessionId: input.sessionId,
      }),
    }, coordinatorConstructionToken);
  }

  public updateSourceStatus(input: InboundSourceStatus): void {
    const status = inboundSourceStatusSchema.parse(input);
    if (
      status.source !== this.targetBinding.source
      || status.sourceEpoch !== this.targetBinding.sourceEpoch
    ) {
      throw new Error("SOURCE_BINDING_MISMATCH");
    }
    this.sourceStatus = status;
  }

  public async process(
    input: readonly unknown[],
  ): Promise<PersonalAccountCoordinatorResult> {
    const result = this.processing.then(() => this.processOne(input));
    this.processing = result.then(() => undefined, () => undefined);
    return result;
  }

  private async processOne(
    input: readonly unknown[],
  ): Promise<PersonalAccountCoordinatorResult> {
    if (!isReady(this.sourceStatus)) {
      return { status: "blocked", reason: "SOURCE_NOT_READY" };
    }
    if (input.length === 0) {
      return { status: "ignored", reason: "EMPTY_BATCH" };
    }

    const messages = input.map((value) => {
      const parsed = normalizedInboundMessageSchema.safeParse(value);
      if (!parsed.success) throw new Error("INBOUND_MESSAGE_INVALID");
      return parsed.data;
    });

    if (messages.some(({ conversationId }) => conversationId !== this.targetBinding.contactId)) {
      return { status: "ignored", reason: "TARGET_NOT_ALLOWED" };
    }
    if (messages.some((message) => !this.matchesBinding(message))) {
      return { status: "blocked", reason: "SOURCE_BINDING_MISMATCH" };
    }
    if (messages.some(({ messageId }) => this.seenMessageIds.has(messageId))) {
      return { status: "ignored", reason: "DUPLICATE_MESSAGE" };
    }
    if (!this.isStrictlyNewSequence(messages)) {
      return { status: "ignored", reason: "OUT_OF_ORDER_MESSAGE" };
    }

    const latest = messages.at(-1);
    if (latest === undefined) {
      return { status: "ignored", reason: "EMPTY_BATCH" };
    }
    if (latest.direction === "outgoing") {
      this.markProcessed(messages);
      if (this.pendingIntent !== null) {
        const triggerId = this.pendingIntent.triggerId;
        this.pendingIntent = null;
        return { status: "cancelled", reason: "OWNER_REPLIED", triggerId };
      }
      return { status: "ignored", reason: "LATEST_OUTGOING" };
    }
    if (latest.kind !== "text" || latest.text.trim().length === 0) {
      this.markProcessed(messages);
      return { status: "ignored", reason: "UNSUPPORTED_MESSAGE" };
    }
    if (this.pendingIntent !== null) {
      return { status: "blocked", reason: "PENDING_REPLY_EXISTS" };
    }

    const triggerId = deriveConversationTriggerId({
      contactId: this.targetBinding.contactId,
      contactRevision: this.targetBinding.contactRevision,
      bindingHash: this.targetBinding.bindingHash,
      source: this.targetBinding.source,
      sourceEpoch: this.targetBinding.sourceEpoch,
      sessionId: this.targetBinding.sessionId,
      sourceMessageIds: messages.map(({ messageId }) => messageId),
    });
    const request = conversationEngineRequestSchema.parse({
      contractVersion: 1,
      triggerId,
      conversationId: this.targetBinding.contactId,
      contactId: this.targetBinding.contactId,
      contactRevision: this.targetBinding.contactRevision,
      bindingHash: this.targetBinding.bindingHash,
      source: this.targetBinding.source,
      sourceEpoch: this.targetBinding.sourceEpoch,
      sessionId: this.targetBinding.sessionId,
      latestIncomingMessageId: latest.messageId,
      messages: messages.map(({ messageId, direction, kind, text, occurredAt }) => ({
        messageId,
        direction,
        kind,
        text,
        occurredAt,
      })),
    });

    const responseResult = conversationEngineResponseSchema.safeParse(
      await this.engine.generate(request),
    );
    if (!responseResult.success) throw new Error("ENGINE_RESPONSE_INVALID");

    this.markProcessed(messages);
    if (responseResult.data.status === "refused") {
      return { status: "ignored", reason: "ENGINE_REFUSED" };
    }

    const intent = replyIntentSchema.parse({
      contractVersion: 1,
      status: "prepared",
      triggerId,
      conversationId: this.targetBinding.contactId,
      contactId: this.targetBinding.contactId,
      contactRevision: this.targetBinding.contactRevision,
      bindingHash: this.targetBinding.bindingHash,
      source: this.targetBinding.source,
      sourceEpoch: this.targetBinding.sourceEpoch,
      sessionId: this.targetBinding.sessionId,
      replyText: responseResult.data.text,
      sourceMessageIds: messages.map(({ messageId }) => messageId),
      deliveryKey: deriveReplyDeliveryKey({
        triggerId,
        contactId: this.targetBinding.contactId,
        contactRevision: this.targetBinding.contactRevision,
        bindingHash: this.targetBinding.bindingHash,
        replyText: responseResult.data.text,
      }),
    });
    this.pendingIntent = intent;
    return { status: "reply-intent", intent };
  }

  private matchesBinding(message: NormalizedInboundMessage): boolean {
    return (
      message.conversationId === this.targetBinding.contactId
      &&
      message.source === this.targetBinding.source
      && message.sourceEpoch === this.targetBinding.sourceEpoch
      && message.sessionId === this.targetBinding.sessionId
    );
  }

  private isStrictlyNewSequence(messages: readonly NormalizedInboundMessage[]): boolean {
    let previous = this.highWaterSequence;
    for (const message of messages) {
      if (previous !== null && message.sequence <= previous) return false;
      previous = message.sequence;
    }
    return true;
  }

  private markProcessed(messages: readonly NormalizedInboundMessage[]): void {
    for (const message of messages) this.seenMessageIds.add(message.messageId);
    this.highWaterSequence = messages.at(-1)?.sequence ?? this.highWaterSequence;
  }
}

const coordinatorConstructionToken = Symbol("coordinator-construction-token");

function isReady(status: InboundSourceStatus): boolean {
  return status.state === "waiting" || status.state === "processing";
}

function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
