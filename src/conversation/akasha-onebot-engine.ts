import { createHash } from "node:crypto";

import { z } from "zod";

import { contactIdSchema, type ContactId } from "../contacts/contact-schema.js";
import { ContactDirectory } from "../contacts/contact-directory.js";

import {
  conversationEngineRequestSchema,
  deriveReplyDeliveryKey,
  targetBindingSchema,
  type ConversationEngine,
  type ConversationEngineRequest,
  type ConversationEngineResponse,
  type TargetBinding,
} from "./personal-account-contract.js";

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const oneBotIdSchema = z.number().int().positive().max(2_147_483_647);
const echoScalarSchema = z.union([
  z.string().trim().min(1).max(512),
  z.number().int().nonnegative().safe(),
]);
export const oneBotEchoSchema = z.union([
  echoScalarSchema,
  z.object({ seq: echoScalarSchema }).strict(),
]);
const replyTextSchema = z.string().max(4_000);

const oneBotTextSegmentSchema = z.object({
  type: z.literal("text"),
  data: z.object({ text: replyTextSchema }).strict(),
}).strict();

const oneBotMessageSchema = z.union([
  replyTextSchema,
  z.array(oneBotTextSegmentSchema).min(1).max(100),
]);

export const oneBotPrivateMessageEventSchema = z.object({
  time: z.number().int().nonnegative(),
  self_id: oneBotIdSchema,
  post_type: z.literal("message"),
  message_type: z.literal("private"),
  sub_type: z.literal("friend"),
  message_id: hex64Schema,
  user_id: oneBotIdSchema,
  message: z.array(oneBotTextSegmentSchema).min(1).max(100),
  raw_message: z.string().max(8_000),
  sender: z.object({
    user_id: oneBotIdSchema,
    nickname: z.string().trim().min(1).max(64),
  }).strict(),
}).strict();

const sendMessageActionSchema = z.object({
  action: z.literal("send_msg"),
  params: z.object({
    message_type: z.literal("private"),
    self_id: oneBotIdSchema.optional(),
    user_id: oneBotIdSchema,
    trigger_id: hex64Schema,
    message: oneBotMessageSchema,
  }).strict(),
  echo: oneBotEchoSchema,
}).strict();

const sendPrivateMessageActionSchema = z.object({
  action: z.literal("send_private_msg"),
  params: z.object({
    self_id: oneBotIdSchema.optional(),
    user_id: oneBotIdSchema,
    trigger_id: hex64Schema,
    message: oneBotMessageSchema,
  }).strict(),
  echo: oneBotEchoSchema,
}).strict();

const sendGroupMessageActionSchema = z.object({
  action: z.literal("send_group_msg"),
  params: z.object({
    self_id: oneBotIdSchema.optional(),
    group_id: oneBotIdSchema,
    message: oneBotMessageSchema,
  }).strict(),
  echo: oneBotEchoSchema,
}).strict();

export const oneBotActionRequestSchema = z.discriminatedUnion("action", [
  sendMessageActionSchema,
  sendPrivateMessageActionSchema,
  sendGroupMessageActionSchema,
]);

export const oneBotDeliveryReceiptSchema = z.discriminatedUnion("status", [
  z.object({
    contractVersion: z.literal(1),
    triggerId: hex64Schema,
    contactId: contactIdSchema,
    contactRevision: z.number().int().positive(),
    bindingHash: hex64Schema,
    deliveryKey: hex64Schema,
    status: z.literal("verified"),
  }).strict(),
  z.object({
    contractVersion: z.literal(1),
    triggerId: hex64Schema,
    contactId: contactIdSchema,
    contactRevision: z.number().int().positive(),
    bindingHash: hex64Schema,
    deliveryKey: hex64Schema,
    status: z.literal("uncertain"),
  }).strict(),
  z.object({
    contractVersion: z.literal(1),
    triggerId: hex64Schema,
    contactId: contactIdSchema,
    contactRevision: z.number().int().positive(),
    bindingHash: hex64Schema,
    deliveryKey: hex64Schema,
    status: z.literal("failed"),
  }).strict(),
]);

export const oneBotApiResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    retcode: z.literal(0),
    data: z.object({ message_id: hex64Schema }).strict(),
    message: z.literal("DELIVERY_VERIFIED"),
    echo: oneBotEchoSchema,
  }).strict(),
  z.object({
    status: z.literal("failed"),
    retcode: z.number().int().positive(),
    data: z.null(),
    message: z.enum([
      "TARGET_NOT_ALLOWED",
      "SELF_ID_MISMATCH",
      "GROUP_SEND_FORBIDDEN",
      "STALE_TRIGGER",
      "DUPLICATE_ECHO",
      "EMPTY_REPLY",
      "SEND_RESULT_UNCERTAIN",
      "SEND_FAILED",
      "ENGINE_STOPPED",
    ]),
    echo: oneBotEchoSchema,
  }).strict(),
]);

export const oneBotEngineStatusSchema = z.object({
  contractVersion: z.literal(1),
  state: z.enum(["stopped", "starting", "ready", "processing", "degraded", "closed"]),
  selfId: oneBotIdSchema,
  targetUserId: oneBotIdSchema,
  pendingTriggerId: hex64Schema.nullable(),
  reason: z.enum([
    "ONEBOT_ACTION_INVALID",
    "ONEBOT_CONNECTION_CLOSED",
    "ONEBOT_TRANSPORT_FAILED",
  ]).nullable(),
}).strict();

export type OneBotPrivateMessageEvent = z.infer<typeof oneBotPrivateMessageEventSchema>;
export type OneBotActionRequest = z.infer<typeof oneBotActionRequestSchema>;
export type OneBotDeliveryReceipt = z.infer<typeof oneBotDeliveryReceiptSchema>;
export type OneBotApiResponse = z.infer<typeof oneBotApiResponseSchema>;
export type OneBotEngineStatus = z.infer<typeof oneBotEngineStatusSchema>;
export type OneBotEcho = z.infer<typeof oneBotEchoSchema>;

export interface OneBotContactMapping {
  readonly target: TargetBinding;
  readonly selfId: number;
  readonly userId: number;
}

const oneBotContactMappingSchema = z.object({
  target: targetBindingSchema,
  selfId: oneBotIdSchema,
  userId: oneBotIdSchema,
}).strict().superRefine((value, context) => {
  if (value.selfId === value.userId) {
    context.addIssue({ code: "custom", message: "ONEBOT_ID_COLLISION" });
  }
});

const activeMappingReservations = new Map<number, Map<number, { binding: string; count: number }>>();

export interface OneBotReverseTransportHandlers {
  onOpen(): Promise<void> | void;
  onMessage(payload: unknown): Promise<void> | void;
  onClose(reason: string): Promise<void> | void;
}

export interface OneBotReverseTransport {
  connect(handlers: OneBotReverseTransportHandlers): Promise<void>;
  send(payload: unknown): Promise<void>;
  disconnect(): Promise<void>;
  close(): Promise<void>;
}

export interface OneBotWebSocketClient {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type OneBotWebSocketFactory = (input: {
  url: string;
  headers: Readonly<Record<string, string>>;
}) => OneBotWebSocketClient;

export class OneBotReverseWebSocketTransport implements OneBotReverseTransport {
  private readonly url: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly createSocket: OneBotWebSocketFactory;
  private readonly lifecycleTimeoutMs: number;
  private socket: OneBotWebSocketClient | null = null;
  private handlers: OneBotReverseTransportHandlers | null = null;
  private state: "idle" | "connecting" | "open" | "closing" | "closed" = "idle";
  private closeWaiter: {
    resolve: () => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;
  private messageChain = Promise.resolve();

  public constructor(input: {
    url: string;
    selfId: number;
    accessToken?: string;
    createSocket: OneBotWebSocketFactory;
    lifecycleTimeoutMs?: number;
  }) {
    this.url = parseLoopbackWebSocketUrl(input.url);
    const selfId = oneBotIdSchema.parse(input.selfId);
    const accessToken = input.accessToken === undefined
      ? null
      : z.string().trim().min(1).max(512).parse(input.accessToken);
    this.headers = Object.freeze({
      "X-Self-ID": String(selfId),
      "X-Client-Role": "Universal",
      "User-Agent": "OneBot/11",
      ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
    });
    this.createSocket = input.createSocket;
    this.lifecycleTimeoutMs = z.number().int().positive().max(120_000).parse(
      input.lifecycleTimeoutMs ?? 10_000,
    );
  }

  public async connect(handlers: OneBotReverseTransportHandlers): Promise<void> {
    if (this.state === "closed") throw new Error("ONEBOT_TRANSPORT_CLOSED");
    if (this.state !== "idle") throw new Error("ONEBOT_TRANSPORT_ALREADY_CONNECTED");
    this.handlers = handlers;
    this.state = "connecting";

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: OneBotWebSocketClient;
      try {
        socket = this.createSocket({ url: this.url, headers: this.headers });
      } catch (error) {
        this.resetSocket("idle");
        reject(asError(error, "ONEBOT_SOCKET_FACTORY_FAILED"));
        return;
      }
      this.socket = socket;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.resetSocket("idle");
        socket.close();
        reject(new Error("ONEBOT_CONNECT_TIMEOUT"));
      }, this.lifecycleTimeoutMs);

      socket.onopen = () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        clearTimeout(timeout);
        this.state = "open";
        let opened: Promise<void> | void;
        try {
          opened = handlers.onOpen();
        } catch (error) {
          this.resetSocket("idle");
          socket.close();
          reject(asError(error, "ONEBOT_OPEN_HANDLER_FAILED"));
          return;
        }
        Promise.resolve(opened).then(() => {
          if (this.socket !== socket || this.state !== "open") {
            reject(new Error("ONEBOT_CONNECTION_CLOSED"));
            return;
          }
          resolve();
        }, (error: unknown) => {
          this.resetSocket("idle");
          socket.close();
          reject(asError(error, "ONEBOT_OPEN_HANDLER_FAILED"));
        });
      };
      socket.onmessage = ({ data }) => {
        if (this.socket !== socket || this.state !== "open") return;
        let payload: unknown;
        try {
          payload = JSON.parse(data) as unknown;
        } catch {
          socket.close();
          return;
        }
        this.messageChain = this.messageChain
          .then(() => handlers.onMessage(payload))
          .catch(() => {
            socket.close();
          });
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.resetSocket("idle");
        socket.close();
        reject(new Error("ONEBOT_CONNECT_FAILED"));
      };
      socket.onclose = ({ reason }) => {
        clearTimeout(timeout);
        const closedBeforeOpen = !settled;
        settled = true;
        this.handleSocketClose(socket, reason || "ONEBOT_SOCKET_CLOSED");
        if (closedBeforeOpen) reject(new Error("ONEBOT_CONNECTION_CLOSED"));
      };
    });
  }

  public send(payload: unknown): Promise<void> {
    if (this.state !== "open" || this.socket === null) {
      return Promise.reject(new Error("ONEBOT_TRANSPORT_NOT_OPEN"));
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return Promise.reject(new Error("ONEBOT_PAYLOAD_SERIALIZE_FAILED"));
    }
    try {
      this.socket.send(serialized);
      return Promise.resolve();
    } catch {
      return Promise.reject(new Error("ONEBOT_TRANSPORT_SEND_FAILED"));
    }
  }

  public async disconnect(): Promise<void> {
    if (this.state === "closed" || this.state === "idle") return;
    if (this.state === "closing") throw new Error("ONEBOT_DISCONNECT_IN_PROGRESS");
    const socket = this.socket;
    if (socket === null) {
      this.state = "idle";
      return;
    }
    this.state = "closing";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.closeWaiter === null) return;
        this.closeWaiter = null;
        this.resetSocket("idle");
        reject(new Error("ONEBOT_DISCONNECT_TIMEOUT"));
      }, this.lifecycleTimeoutMs);
      this.closeWaiter = { resolve, timeout };
      socket.close();
    });
  }

  public async close(): Promise<void> {
    if (this.state === "closed") return;
    await this.disconnect();
    this.handlers = null;
    this.state = "closed";
  }

  private handleSocketClose(socket: OneBotWebSocketClient, reason: string): void {
    if (this.socket !== socket) return;
    const handlers = this.handlers;
    this.resetSocket("idle");
    const waiter = this.closeWaiter;
    this.closeWaiter = null;
    if (waiter !== null) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    if (handlers !== null) {
      void Promise.resolve(handlers.onClose(reason)).catch(() => undefined);
    }
  }

  private resetSocket(state: "idle"): void {
    if (this.socket !== null) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
    }
    this.socket = null;
    this.state = state;
  }
}

interface PendingReply {
  lease: ConnectionLease;
  request: ConversationEngineRequest;
  stage: "awaiting-command" | "awaiting-delivery";
  echo: OneBotEcho | null;
  expectedDeliveryKey: string | null;
  resolve: (response: ConversationEngineResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type ConnectionPhase = "connecting" | "ready" | "disconnecting" | "disconnected";

interface ConnectionLease {
  phase: ConnectionPhase;
  disconnectPromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
}

const RETCODE = {
  targetNotAllowed: 14_403,
  selfIdMismatch: 14_404,
  groupSendForbidden: 14_405,
  staleTrigger: 14_409,
  duplicateEcho: 14_410,
  emptyReply: 14_422,
  deliveryUncertain: 15_001,
  deliveryFailed: 15_002,
  engineStopped: 15_003,
} as const;

const MAX_REMEMBERED_ECHOS = 256;

export function stableOneBotId(identity: string): number {
  const normalized = z.string().trim().min(1).max(512).parse(identity);
  const digest = createHash("sha256")
    .update("personal-account-onebot-id-v1\0")
    .update(normalized)
    .digest();
  const value = digest.readUInt32BE(0) & 0x7fff_ffff;
  return value === 0 ? 1 : value;
}

export class AstrBotOneBotEngine implements ConversationEngine {
  public readonly selfId: number;
  public readonly targetUserId: number;

  private readonly transport: OneBotReverseTransport;
  private readonly mapping: OneBotContactMapping;
  private readonly responseTimeoutMs: number;
  private readonly now: () => Date;
  private state: OneBotEngineStatus["state"] = "stopped";
  private reason: OneBotEngineStatus["reason"] = null;
  private pending: PendingReply | null = null;
  private currentLease: ConnectionLease | null = null;
  private mappingReleased = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly seenEchoes = new Set<string>();
  private readonly seenEchoOrder: string[] = [];

  private constructor(input: {
    transport: OneBotReverseTransport;
    mapping: OneBotContactMapping;
    responseTimeoutMs?: number;
    now?: () => Date;
  }, token: symbol) {
    if (token !== engineConstructionToken) throw new Error("ONEBOT_ENGINE_FACTORY_REQUIRED");
    this.transport = input.transport;
    this.mapping = oneBotContactMappingSchema.parse(input.mapping);
    this.selfId = this.mapping.selfId;
    this.targetUserId = this.mapping.userId;
    this.responseTimeoutMs = z.number().int().positive().max(120_000).parse(
      input.responseTimeoutMs ?? 30_000,
    );
    this.now = input.now ?? (() => new Date());
  }

  public static async create(input: {
    directory: ContactDirectory;
    contactId: ContactId;
    expectedRevision: number;
    ownerIdentity: string;
    source: TargetBinding["source"];
    sourceEpoch: string;
    sessionId: string;
    transport: OneBotReverseTransport;
    responseTimeoutMs?: number;
    now?: () => Date;
  }): Promise<AstrBotOneBotEngine> {
    const target = await input.directory.requireTextTarget(input.contactId, input.expectedRevision);
    const binding = targetBindingSchema.parse({
      contactId: target.contactId,
      contactRevision: target.revision,
      displayName: target.displayName,
      source: input.source,
      sourceEpoch: input.sourceEpoch,
      sessionId: input.sessionId,
      bindingHash: target.bindingHash,
    });
    const mapping = oneBotContactMappingSchema.parse({
      target: binding,
      selfId: stableOneBotId(input.ownerIdentity),
      userId: deriveOneBotContactUserId(binding),
    });
    reserveMapping(mapping);
    try {
      return new AstrBotOneBotEngine({
        transport: input.transport,
        mapping,
        responseTimeoutMs: input.responseTimeoutMs,
        now: input.now,
      }, engineConstructionToken);
    } catch (error) {
      releaseMapping(mapping);
      throw error;
    }
  }

  public getStatus(): OneBotEngineStatus {
    return oneBotEngineStatusSchema.parse({
      contractVersion: 1,
      state: this.state,
      selfId: this.selfId,
      targetUserId: this.targetUserId,
      pendingTriggerId: this.pending?.request.triggerId ?? null,
      reason: this.reason,
    });
  }

  public async start(): Promise<void> {
    if (this.isClosingOrClosed()) throw new Error("ONEBOT_ENGINE_CLOSED");
    if (this.currentLease !== null && this.currentLease.disconnectPromise !== null) {
      throw new Error("ONEBOT_DISCONNECT_IN_PROGRESS");
    }
    if (this.state !== "stopped") return;
    if (this.currentLease !== null) throw new Error("ONEBOT_DISCONNECT_IN_PROGRESS");
    const lease: ConnectionLease = {
      phase: "connecting",
      disconnectPromise: null,
      stopPromise: null,
    };
    this.currentLease = lease;
    this.state = "starting";
    this.reason = null;
    try {
      await this.transport.connect({
        onOpen: () => {
          if (!this.isCurrentLeaseInPhase(lease, "connecting")) return;
          lease.phase = "ready";
          this.state = "ready";
          this.reason = null;
        },
        onMessage: (payload) => this.handleMessage(lease, payload),
        onClose: () => this.handleClose(lease),
      });
      if (!this.isCurrentLease(lease)) return;
      if (lease.phase === "connecting") {
        this.invalidateLease(lease, "ONEBOT_CONNECTION_CLOSED");
      }
    } catch {
      if (
        this.isCurrentLease(lease)
        && (lease.phase === "connecting" || lease.phase === "ready")
      ) {
        this.invalidateLease(lease, "ONEBOT_TRANSPORT_FAILED");
      }
      throw new Error("ONEBOT_CONNECT_FAILED");
    }
  }

  public stop(): Promise<void> {
    if (this.state === "closed" || this.state === "stopped") return Promise.resolve();
    const lease = this.currentLease;
    if (lease === null) {
      if (!this.isClosingOrClosed()) {
        this.state = "stopped";
        this.reason = null;
      }
      return Promise.resolve();
    }
    return this.stopLease(lease, this.pending);
  }

  public close(): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    let failure: unknown = null;
    try {
      await this.stop();
    } catch (error) {
      failure = error;
    }
    try {
      await this.transport.close();
    } catch (error) {
      if (failure === null) failure = error;
    } finally {
      this.clearPendingForClose();
      this.releaseMappingReservation();
      const lease = this.currentLease;
      if (lease !== null) this.invalidateLease(lease, null);
      this.currentLease = null;
      this.state = "closed";
      this.reason = null;
    }
    if (failure !== null) throw asError(failure, "ONEBOT_CLOSE_FAILED");
  }

  public async generate(input: ConversationEngineRequest): Promise<ConversationEngineResponse> {
    const request = conversationEngineRequestSchema.parse(input);
    const lease = this.currentLease;
    if (
      this.isClosingOrClosed()
      || lease === null
      || !this.isCurrentLeaseInPhase(lease, "ready")
      || !this.matchesMapping(request)
      || this.state !== "ready"
      || this.pending !== null
    ) {
      return { status: "refused", reason: "MODEL_UNAVAILABLE" };
    }

    let resolveResponse: ((response: ConversationEngineResponse) => void) | null = null;
    const response = new Promise<ConversationEngineResponse>((resolve) => {
      resolveResponse = resolve;
    });
    if (resolveResponse === null) throw new Error("ONEBOT_RESPONSE_PROMISE_INVALID");

    const timeout = setTimeout(() => {
      if (!this.isCurrentLeaseInPhase(lease, "ready")) return;
      if (this.pending?.request.triggerId !== request.triggerId) return;
      this.pending.resolve({ status: "refused", reason: "MODEL_UNAVAILABLE" });
      this.pending = null;
      this.state = "ready";
      this.reason = null;
    }, this.responseTimeoutMs);
    this.pending = {
      lease,
      request,
      stage: "awaiting-command",
      echo: null,
      expectedDeliveryKey: null,
      resolve: resolveResponse,
      timeout,
    };
    this.state = "processing";
    this.reason = null;

    try {
      await this.transport.send(this.toPrivateMessageEvent(request));
    } catch {
      if (!this.isCurrentLeaseInPhase(lease, "ready")) return response;
      if (this.pending?.request.triggerId !== request.triggerId) return response;
      this.clearPendingForLease(lease);
      this.state = "degraded";
      this.reason = "ONEBOT_TRANSPORT_FAILED";
    }
    return response;
  }

  public async completeDelivery(input: unknown): Promise<void> {
    if (this.isClosingOrClosed()) throw new Error("ONEBOT_ENGINE_CLOSED");
    const lease = this.currentLease;
    if (lease === null || !this.isCurrentLeaseInPhase(lease, "ready")) {
      throw new Error("ONEBOT_ENGINE_CLOSED");
    }
    const receipt = oneBotDeliveryReceiptSchema.parse(input);
    const pending = this.pending;
    if (
      pending === null
      || pending.lease !== lease
      || pending.stage !== "awaiting-delivery"
      || pending.echo === null
      || pending.request.triggerId !== receipt.triggerId
      || !this.matchesMapping(receipt)
    ) {
      throw new Error("DELIVERY_TRIGGER_MISMATCH");
    }
    if (pending.expectedDeliveryKey !== receipt.deliveryKey) {
      throw new Error("DELIVERY_KEY_MISMATCH");
    }

    try {
      if (this.isClosingOrClosed()) throw new Error("ONEBOT_ENGINE_CLOSED");
      if (receipt.status === "verified") {
        await this.transport.send(oneBotApiResponseSchema.parse({
          status: "ok",
          retcode: 0,
          data: { message_id: receipt.deliveryKey },
          message: "DELIVERY_VERIFIED",
          echo: pending.echo,
        }));
      } else if (receipt.status === "uncertain") {
        await this.sendFailure(
          pending.echo,
          "SEND_RESULT_UNCERTAIN",
          RETCODE.deliveryUncertain,
          lease,
        );
      } else {
        await this.sendFailure(pending.echo, "SEND_FAILED", RETCODE.deliveryFailed, lease);
      }
      if (!this.isCurrentLeaseInPhase(lease, "ready") || this.pending !== pending) {
        throw new Error("ONEBOT_LEASE_INACTIVE");
      }
      this.pending = null;
      this.state = "ready";
      this.reason = null;
    } catch {
      if (this.isClosingOrClosed()) throw new Error("ONEBOT_ENGINE_CLOSED");
      if (!this.isCurrentLeaseInPhase(lease, "ready") || this.pending !== pending) {
        throw new Error("ONEBOT_RESPONSE_SEND_FAILED");
      }
      this.pending = null;
      this.state = "degraded";
      this.reason = "ONEBOT_TRANSPORT_FAILED";
      throw new Error("ONEBOT_RESPONSE_SEND_FAILED");
    }
  }

  private toPrivateMessageEvent(request: ConversationEngineRequest): OneBotPrivateMessageEvent {
    const rawMessage = request.messages
      .filter(({ direction, kind }) => direction === "incoming" && kind === "text")
      .map(({ text }) => text)
      .join("\n")
      .slice(0, 8_000);
    return oneBotPrivateMessageEventSchema.parse({
      time: Math.floor(this.now().getTime() / 1_000),
      self_id: this.selfId,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: request.triggerId,
      user_id: this.targetUserId,
      message: [{ type: "text", data: { text: rawMessage } }],
      raw_message: rawMessage,
      sender: { user_id: this.targetUserId, nickname: this.mapping.target.displayName },
    });
  }

  private async handleMessage(lease: ConnectionLease, payload: unknown): Promise<void> {
    if (!this.isCurrentLeaseInPhase(lease, "ready")) return;
    const result = oneBotActionRequestSchema.safeParse(payload);
    if (!result.success) {
      this.state = "degraded";
      this.reason = "ONEBOT_ACTION_INVALID";
      return;
    }

    const action = result.data;
    if (action.action === "send_group_msg") {
      await this.sendFailure(
        action.echo,
        "GROUP_SEND_FORBIDDEN",
        RETCODE.groupSendForbidden,
        lease,
      );
      return;
    }
    if (this.seenEchoes.has(oneBotEchoKey(action.echo))) {
      await this.sendFailure(action.echo, "DUPLICATE_ECHO", RETCODE.duplicateEcho, lease);
      return;
    }
    if (action.params.self_id !== undefined && action.params.self_id !== this.selfId) {
      await this.sendFailure(action.echo, "SELF_ID_MISMATCH", RETCODE.selfIdMismatch, lease);
      return;
    }
    if (action.params.user_id !== this.targetUserId) {
      await this.sendFailure(action.echo, "TARGET_NOT_ALLOWED", RETCODE.targetNotAllowed, lease);
      return;
    }

    const pending = this.pending;
    if (pending === null || pending.lease !== lease || pending.stage !== "awaiting-command") {
      await this.sendFailure(action.echo, "STALE_TRIGGER", RETCODE.staleTrigger, lease);
      return;
    }
    if (action.params.trigger_id !== pending.request.triggerId) {
      await this.sendFailure(action.echo, "STALE_TRIGGER", RETCODE.staleTrigger, lease);
      return;
    }
    const replyText = extractReplyText(action.params.message);
    if (replyText === null) {
      await this.sendFailure(action.echo, "EMPTY_REPLY", RETCODE.emptyReply, lease);
      return;
    }

    this.rememberEcho(action.echo);
    clearTimeout(pending.timeout);
    pending.stage = "awaiting-delivery";
    pending.echo = action.echo;
    pending.expectedDeliveryKey = deriveReplyDeliveryKey({
      triggerId: pending.request.triggerId,
      contactId: pending.request.contactId,
      contactRevision: pending.request.contactRevision,
      bindingHash: pending.request.bindingHash,
      replyText,
    });
    pending.resolve({ status: "reply", text: replyText });
    this.state = "processing";
    this.reason = null;
  }

  private handleClose(lease: ConnectionLease): void {
    if (!this.isCurrentLease(lease)) return;
    if (lease.phase === "disconnecting") {
      lease.phase = "disconnected";
      return;
    }
    if (lease.phase !== "connecting" && lease.phase !== "ready") return;
    this.invalidateLease(lease, "ONEBOT_CONNECTION_CLOSED");
  }

  private clearPendingForLease(lease: ConnectionLease): void {
    const pending = this.pending;
    if (pending === null || pending.lease !== lease) return;
    clearTimeout(pending.timeout);
    if (pending.stage === "awaiting-command") {
      pending.resolve({ status: "refused", reason: "MODEL_UNAVAILABLE" });
    }
    this.pending = null;
  }

  private rememberEcho(echo: OneBotEcho): void {
    const key = oneBotEchoKey(echo);
    this.seenEchoes.add(key);
    this.seenEchoOrder.push(key);
    if (this.seenEchoOrder.length <= MAX_REMEMBERED_ECHOS) return;
    const oldest = this.seenEchoOrder.shift();
    if (oldest !== undefined) this.seenEchoes.delete(oldest);
  }

  private async sendFailure(
    echo: OneBotEcho,
    message: Extract<OneBotApiResponse, { status: "failed" }>["message"],
    retcode: number,
    lease?: ConnectionLease,
    leasePhase: ConnectionPhase = "ready",
  ): Promise<void> {
    if (this.isClosingOrClosed()) throw new Error("ONEBOT_ENGINE_CLOSED");
    if (lease !== undefined && !this.isCurrentLeaseInPhase(lease, leasePhase)) {
      throw new Error("ONEBOT_LEASE_INACTIVE");
    }
    await this.transport.send(oneBotApiResponseSchema.parse({
      status: "failed",
      retcode,
      data: null,
      message,
      echo,
    }));
  }

  private matchesMapping(input: {
    conversationId?: string;
    contactId: string;
    contactRevision: number;
    bindingHash: string;
  }): boolean {
    return (
      (input.conversationId === undefined || input.conversationId === this.mapping.target.contactId)
      && input.contactId === this.mapping.target.contactId
      && input.contactRevision === this.mapping.target.contactRevision
      && input.bindingHash === this.mapping.target.bindingHash
    );
  }

  private releaseMappingReservation(): void {
    if (this.mappingReleased) return;
    this.mappingReleased = true;
    releaseMapping(this.mapping);
  }

  private clearPendingForClose(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.clearPendingForLease(pending.lease);
  }

  private invalidateLease(
    lease: ConnectionLease,
    reason: OneBotEngineStatus["reason"],
  ): void {
    if (this.currentLease !== lease) return;
    lease.phase = "disconnected";
    this.clearPendingForLease(lease);
    if (reason !== null && !this.isClosingOrClosed()) {
      this.state = "degraded";
      this.reason = reason;
    }
  }

  private stopLease(lease: ConnectionLease, pending: PendingReply | null): Promise<void> {
    if (lease.stopPromise !== null) return lease.stopPromise;
    lease.phase = "disconnecting";
    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    const stopPromise = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    lease.stopPromise = stopPromise;

    const notificationEcho = (
      !this.closing
      && pending !== null
      && pending.lease === lease
      && pending.stage === "awaiting-delivery"
      && pending.echo !== null
    ) ? pending.echo : null;
    this.clearPendingForLease(lease);
    const notificationPromise = notificationEcho !== null
      ? this.sendFailure(
        notificationEcho,
        "ENGINE_STOPPED",
        RETCODE.engineStopped,
        lease,
        "disconnecting",
      )
      : Promise.resolve();
    const disconnectPromise = this.disconnectLease(lease);
    void Promise.allSettled([notificationPromise, disconnectPromise]).then((results) => {
      this.finalizeStoppedLease(lease);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure === undefined) resolveStop();
      else rejectStop(failure.reason);
    });
    return stopPromise;
  }

  private finalizeStoppedLease(lease: ConnectionLease): void {
    lease.phase = "disconnected";
    if (this.currentLease !== lease) return;
    this.currentLease = null;
    if (this.isClosingOrClosed()) return;
    this.state = "stopped";
    this.reason = null;
  }

  private disconnectLease(lease: ConnectionLease): Promise<void> {
    if (lease.disconnectPromise !== null) return lease.disconnectPromise;
    lease.phase = "disconnecting";
    let resolveDisconnect!: () => void;
    let rejectDisconnect!: (error: unknown) => void;
    const disconnectPromise = new Promise<void>((resolve, reject) => {
      resolveDisconnect = resolve;
      rejectDisconnect = reject;
    });
    lease.disconnectPromise = disconnectPromise;
    try {
      void this.transport.disconnect().then(resolveDisconnect, rejectDisconnect);
    } catch (error) {
      rejectDisconnect(asError(error, "ONEBOT_DISCONNECT_FAILED"));
    }
    return disconnectPromise;
  }

  private isCurrentLease(lease: ConnectionLease): boolean {
    return (
      !this.isClosingOrClosed()
      && this.currentLease === lease
    );
  }

  private isCurrentLeaseInPhase(lease: ConnectionLease, phase: ConnectionPhase): boolean {
    return this.isCurrentLease(lease) && lease.phase === phase;
  }

  private isClosingOrClosed(): boolean {
    return this.closing || this.state === "closed";
  }
}

const engineConstructionToken = Symbol("onebot-engine-construction-token");

function deriveOneBotContactUserId(target: TargetBinding): number {
  return stableOneBotId([
    "personal-account-onebot-contact-user-v1",
    target.contactId,
    String(target.contactRevision),
    target.bindingHash,
  ].join("\0"));
}

function mappingReservationKey(mapping: OneBotContactMapping): string {
  return [
    mapping.target.contactId,
    String(mapping.target.contactRevision),
    mapping.target.bindingHash,
  ].join("\0");
}

function reserveMapping(mapping: OneBotContactMapping): void {
  const byUserId = activeMappingReservations.get(mapping.selfId) ??
    new Map<number, { binding: string; count: number }>();
  const current = byUserId.get(mapping.userId);
  const binding = mappingReservationKey(mapping);
  if (current !== undefined && current.binding !== binding) {
    throw new Error("ONEBOT_CONTACT_ID_COLLISION");
  }
  byUserId.set(mapping.userId, { binding, count: (current?.count ?? 0) + 1 });
  activeMappingReservations.set(mapping.selfId, byUserId);
}

function releaseMapping(mapping: OneBotContactMapping): void {
  const byUserId = activeMappingReservations.get(mapping.selfId);
  const current = byUserId?.get(mapping.userId);
  if (current === undefined || current.binding !== mappingReservationKey(mapping)) return;
  if (current.count > 1) {
    byUserId?.set(mapping.userId, { ...current, count: current.count - 1 });
    return;
  }
  byUserId?.delete(mapping.userId);
  if (byUserId?.size === 0) activeMappingReservations.delete(mapping.selfId);
}

function extractReplyText(message: z.infer<typeof oneBotMessageSchema>): string | null {
  const text = typeof message === "string"
    ? message
    : message.map(({ data }) => data.text).join("");
  const normalized = text.trim();
  return normalized.length === 0 ? null : normalized;
}

function oneBotEchoKey(echo: OneBotEcho): string {
  if (typeof echo === "string") return `string:${echo}`;
  if (typeof echo === "number") return `number:${String(echo)}`;
  return typeof echo.seq === "string"
    ? `seq-string:${echo.seq}`
    : `seq-number:${String(echo.seq)}`;
}

function parseLoopbackWebSocketUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("ONEBOT_URL_PROTOCOL_INVALID");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("ONEBOT_URL_MUST_BE_LOOPBACK");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("ONEBOT_URL_CREDENTIALS_FORBIDDEN");
  }
  return url.toString();
}

function asError(input: unknown, fallback: string): Error {
  return input instanceof Error ? input : new Error(fallback);
}
