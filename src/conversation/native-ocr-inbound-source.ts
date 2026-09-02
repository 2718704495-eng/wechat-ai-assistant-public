import { createHash } from "node:crypto";

import type { ConversationSnapshot } from "../adapters/wechat.js";
import type { AuthorizedWechatTarget } from "../contacts/contact-directory.js";
import type { ContactId } from "../contacts/contact-schema.js";
import type { ChatMessage } from "../domain/types.js";
import {
  isLiveOperationChildAdmission,
  type LiveOperationChildAdmission,
  type LiveOperationChildFence,
} from "../mcp/live-operation-coordinator.js";
import type {
  InboundCursor,
  InboundCursorRepository,
} from "../storage/inbound-cursor-repository.js";
import {
  inboundSourceStatusSchema,
  normalizedInboundMessageSchema,
  type InboundMessageSource,
  type InboundMessageSourceHandlers,
  type InboundSourceStatus,
} from "./personal-account-contract.js";

const hex64Pattern = /^[a-f0-9]{64}$/u;
export interface NativeOcrConversationMessage {
  readonly id: string;
  readonly conversationId: ContactId;
  readonly direction: "incoming" | "outgoing";
  readonly kind: ChatMessage["kind"];
  readonly text: string;
  readonly occurredAt: string;
  readonly confidence: number;
}

export interface NativeOcrConversationSnapshot {
  readonly conversationId: ContactId;
  readonly identity: {
    readonly conversationId: ContactId;
    readonly visibleName: string;
    readonly enrollmentFingerprint: string;
    readonly confidence: number;
  };
  readonly messages: readonly NativeOcrConversationMessage[];
  readonly windowRevision: string;
  readonly latestIncomingEvidence?: {
    readonly version: 1;
    readonly proofId: string;
    readonly messageId: string;
    readonly observedMinute: string;
    readonly confidence: number;
    readonly contactId: ContactId;
    readonly contactRevision: number;
    readonly windowRevision: string;
  };
}

interface DynamicSourceOptions {
  readonly sourceEpoch: string;
  readonly sessionId: string;
  readonly target: AuthorizedWechatTarget;
  readonly directory: {
    requireActiveAutoReplyTarget(contactId: ContactId): Promise<AuthorizedWechatTarget>;
  };
  readonly cursorRepository: InboundCursorRepository;
  readonly deliveryAdmission: LiveOperationChildAdmission;
  readonly readSnapshot: () => Promise<NativeOcrConversationSnapshot>;
}

interface LegacySourceOptions {
  readonly sourceEpoch: string;
  readonly sessionId: string;
  readonly readSnapshot: () => Promise<ConversationSnapshot>;
}

export class NativeOcrInboundSource implements InboundMessageSource {
  private readonly sourceEpoch: string;
  private readonly sessionId: string;
  private readonly dynamic: DynamicSourceOptions | null;
  private readonly readLegacySnapshot: (() => Promise<ConversationSnapshot>) | null;
  private status: InboundSourceStatus;
  private handlers: InboundMessageSourceHandlers | null = null;
  private baseline: string[] = [];
  private readonly consumedFreshEvidenceIds = new Set<string>();
  private nextSequence = 1;
  private cursor: InboundCursor | null = null;
  private closed = false;
  private lifecycleGeneration = 0;

  public constructor(input: DynamicSourceOptions | LegacySourceOptions) {
    this.sourceEpoch = input.sourceEpoch.trim();
    this.sessionId = input.sessionId.trim();
    if (this.sourceEpoch.length === 0 || this.sessionId.length === 0) {
      throw new Error("OCR_SOURCE_BINDING_INVALID");
    }
    if ("target" in input) {
      if (!isLiveOperationChildAdmission(input.deliveryAdmission)) {
        throw new Error("OCR_DELIVERY_ADMISSION_REQUIRED");
      }
      this.dynamic = input;
      this.readLegacySnapshot = null;
    } else {
      this.dynamic = null;
      this.readLegacySnapshot = input.readSnapshot;
    }
    this.status = this.makeStatus("stopped", "SOURCE_NOT_STARTED", null);
  }

  public getStatus(): InboundSourceStatus {
    return { ...this.status };
  }

  public async start(handlers: InboundMessageSourceHandlers): Promise<void> {
    if (this.closed) throw new Error("OCR_SOURCE_CLOSED");
    if (this.handlers !== null) return;
    const generation = this.lifecycleGeneration + 1;
    this.lifecycleGeneration = generation;
    this.handlers = handlers;
    await this.setStatus("starting", null, null);
    this.assertLifecycle(generation, handlers);
    try {
      if (this.dynamic === null) await this.startLegacy(generation, handlers);
      else await this.startDynamic(generation, handlers);
      this.assertLifecycle(generation, handlers);
      await this.setStatus("waiting", null, null);
      this.assertLifecycle(generation, handlers);
    } catch (error: unknown) {
      if (!this.isLifecycleCurrent(generation, handlers)) throw error;
      this.handlers = null;
      this.lifecycleGeneration += 1;
      if (this.status.state === "starting") {
        await this.setStatus("blocked", "OCR_TARGET_IDENTITY_INVALID", null);
      }
      throw error;
    }
  }

  public async poll(): Promise<void> {
    const handlers = this.handlers;
    if (handlers === null || !["waiting", "degraded"].includes(this.status.state)) {
      throw new Error("OCR_SOURCE_NOT_READY");
    }
    const generation = this.lifecycleGeneration;
    await this.setStatus("processing", null, this.status.lastEventAt);
    this.assertLifecycle(generation, handlers);
    try {
      if (this.dynamic === null) await this.pollLegacy(handlers, generation);
      else await this.pollDynamic(handlers, generation);
    } catch (error: unknown) {
      if (isOwnerFenceError(error)) {
        this.status = this.makeStatus("blocked", "OCR_OWNER_CLOSED", this.status.lastEventAt);
        throw error;
      }
      if (this.isLifecycleCurrent(generation, handlers) && this.getStatus().state === "processing") {
        await this.setStatus("degraded", "OCR_POLL_FAILED", this.status.lastEventAt);
      }
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.closed || this.handlers === null) return;
    this.lifecycleGeneration += 1;
    this.handlers = null;
    await this.setStatus("stopped", "SOURCE_STOPPED", this.status.lastEventAt);
  }

  public close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.lifecycleGeneration += 1;
    this.handlers = null;
    this.status = this.makeStatus("stopped", "SOURCE_CLOSED", this.status.lastEventAt);
    return Promise.resolve();
  }

  private async startDynamic(
    generation: number,
    handlers: InboundMessageSourceHandlers,
  ): Promise<void> {
    const input = this.requireDynamic();
    await this.requireCurrentTarget(input);
    this.assertLifecycle(generation, handlers);
    const snapshot = await input.readSnapshot();
    this.assertLifecycle(generation, handlers);
    await this.requireCurrentTarget(input);
    this.assertLifecycle(generation, handlers);
    assertDynamicSnapshot(snapshot, input.target);
    this.cursor = await input.cursorRepository.establishBaseline({
      contactId: input.target.contactId,
      contactRevision: input.target.revision,
      sourceEpoch: this.sourceEpoch,
      sessionId: this.sessionId,
      baselineHashes: snapshot.messages.map(messageSignatureHash),
      proofIds: validDynamicProof(snapshot, input.target) === null
        ? []
        : [snapshot.latestIncomingEvidence?.proofId ?? ""],
    });
    this.assertLifecycle(generation, handlers);
  }

  private async pollDynamic(
    handlers: InboundMessageSourceHandlers,
    generation: number,
  ): Promise<void> {
    const input = this.requireDynamic();
    try {
      await input.deliveryAdmission.runExclusive((fence) =>
        this.pollDynamicUnderAdmission(input, handlers, generation, fence));
      this.assertLifecycle(generation, handlers);
    } catch (error: unknown) {
      if (isOwnerFenceError(error)) throw error;
      if (!this.isLifecycleCurrent(generation, handlers)) throw error;
      if (isAuthorizationError(error)) {
        await this.setStatus("blocked", "OCR_TARGET_AUTHORIZATION_CHANGED", this.status.lastEventAt);
      } else if (error instanceof Error && error.message === "OCR_TARGET_IDENTITY_INVALID") {
        await this.setStatus("blocked", "OCR_TARGET_IDENTITY_INVALID", this.status.lastEventAt);
      }
      throw error;
    }
  }

  private async pollDynamicUnderAdmission(
    input: DynamicSourceOptions,
    handlers: InboundMessageSourceHandlers,
    generation: number,
    fence: LiveOperationChildFence,
  ): Promise<void> {
    fence.assertCurrent();
    this.assertLifecycle(generation, handlers);
    await this.requireCurrentTarget(input);
    fence.assertCurrent();
    this.assertLifecycle(generation, handlers);
    const snapshot = await input.readSnapshot();
    fence.assertCurrent();
    this.assertLifecycle(generation, handlers);
    await this.requireCurrentTarget(input);
    fence.assertCurrent();
    this.assertLifecycle(generation, handlers);
    assertDynamicSnapshot(snapshot, input.target);
    fence.assertCurrent();
    let cursor = await input.cursorRepository.read(input.target.contactId);
    fence.assertCurrent();
    this.assertLifecycle(generation, handlers);
    if (cursor === null || !cursorMatches(cursor, input, this.sourceEpoch, this.sessionId)) {
      fence.assertCurrent();
      await this.setStatus("blocked", "OCR_CURSOR_IDENTITY_INVALID", this.status.lastEventAt);
      fence.assertCurrent();
      this.assertLifecycle(generation, handlers);
      return;
    }
    const currentHashes = snapshot.messages.map(messageSignatureHash);
    let appended: readonly NativeOcrConversationMessage[] | null;
    let recovered = false;
    if (isPrefix(cursor.baselineHashes, currentHashes)) {
      appended = snapshot.messages.slice(cursor.baselineHashes.length);
    } else {
      appended = recoverFreshLatestIncoming(snapshot, cursor, input.target);
      recovered = appended !== null;
    }
    if (appended === null) {
      fence.assertCurrent();
      await this.setStatus("degraded", "OCR_BASELINE_DISCONTINUITY", this.status.lastEventAt);
      fence.assertCurrent();
      this.assertLifecycle(generation, handlers);
      return;
    }
    if (appended.length === 0) {
      const proofId = validDynamicProof(snapshot, input.target);
      if (proofId !== null && !cursor.consumedProofIds.includes(proofId)) {
        fence.assertCurrent();
        this.assertLifecycle(generation, handlers);
        cursor = await input.cursorRepository.refreshBaseline({
          contactId: input.target.contactId,
          contactRevision: input.target.revision,
          sourceEpoch: this.sourceEpoch,
          sessionId: this.sessionId,
          expectedSequence: cursor.nextSequence,
          baselineHashes: currentHashes,
          proofIds: [proofId],
        });
        fence.assertCurrent();
        this.assertLifecycle(generation, handlers);
      }
    }
    let lastEventAt = this.status.lastEventAt;
    const startingBaselineLength = cursor.baselineHashes.length;
    for (let index = 0; index < appended.length; index += 1) {
      const message = appended[index];
      if (message === undefined) continue;
      const sequence = cursor.nextSequence;
      const signatureHash = messageSignatureHash(message);
      const normalized = normalizedInboundMessageSchema.parse({
        contractVersion: 1,
        source: "native-ocr",
        sourceEpoch: this.sourceEpoch,
        sessionId: this.sessionId,
        conversationId: input.target.contactId,
        messageId: sha256([
          "native-ocr-message-v2",
          input.target.contactId,
          String(input.target.revision),
          this.sourceEpoch,
          sha256([this.sessionId]),
          String(sequence),
          signatureHash,
        ]),
        sequence,
        occurredAt: message.occurredAt,
        direction: message.direction,
        kind: normalizeKind(message.kind),
        text: message.text,
      });
      try {
        fence.assertCurrent();
        this.assertLifecycle(generation, handlers);
        await handlers.onMessage(normalized);
        fence.assertCurrent();
        this.assertLifecycle(generation, handlers);
      } catch (error: unknown) {
        if (isOwnerFenceError(error)) throw error;
        if (this.isLifecycleCurrent(generation, handlers)) {
          await this.setStatus("degraded", "OCR_HANDLER_FAILED", lastEventAt);
        }
        throw error;
      }
      const baselineHashes = recovered
        ? currentHashes
        : currentHashes.slice(0, startingBaselineLength + index + 1);
      const evidence = snapshot.latestIncomingEvidence;
      const boundProofId = validDynamicProof(snapshot, input.target);
      const proofId = evidence !== undefined && evidence.messageId === message.id
        ? boundProofId
        : null;
      fence.assertCurrent();
      cursor = await input.cursorRepository.commitDelivered({
        contactId: input.target.contactId,
        contactRevision: input.target.revision,
        sourceEpoch: this.sourceEpoch,
        sessionId: this.sessionId,
        expectedSequence: sequence,
        baselineHashes,
        proofId,
      });
      fence.assertCurrent();
      this.assertLifecycle(generation, handlers);
      lastEventAt = normalized.occurredAt;
    }
    fence.assertCurrent();
    this.assertLifecycle(generation, handlers);
    this.cursor = cursor;
    await this.setStatus("waiting", null, lastEventAt);
    fence.assertCurrent();
    this.assertLifecycle(generation, handlers);
  }

  private async requireCurrentTarget(input: DynamicSourceOptions): Promise<void> {
    const current = await input.directory.requireActiveAutoReplyTarget(input.target.contactId);
    if (!sameTarget(current, input.target)) throw new Error("CONTACT_REVISION_MISMATCH");
  }

  private requireDynamic(): DynamicSourceOptions {
    if (this.dynamic === null) throw new Error("OCR_DYNAMIC_SOURCE_REQUIRED");
    return this.dynamic;
  }

  private async startLegacy(
    generation: number,
    handlers: InboundMessageSourceHandlers,
  ): Promise<void> {
    const snapshot = await this.readLegacy();
    this.assertLifecycle(generation, handlers);
    if (!isVerifiedLegacyTarget(snapshot)) throw new Error("OCR_TARGET_IDENTITY_INVALID");
    this.baseline = snapshot.messages.map(legacyMessageSignature);
    this.rememberFreshEvidence(snapshot.latestIncomingEvidence?.proofId);
    this.nextSequence = 1;
  }

  private async pollLegacy(
    handlers: InboundMessageSourceHandlers,
    generation: number,
  ): Promise<void> {
    const snapshot = await this.readLegacy();
    this.assertLifecycle(generation, handlers);
    if (!isVerifiedLegacyTarget(snapshot)) {
      await this.setStatus("blocked", "OCR_TARGET_IDENTITY_INVALID", this.status.lastEventAt);
      this.assertLifecycle(generation, handlers);
      return;
    }
    const current = snapshot.messages.map(legacyMessageSignature);
    const appended = isPrefix(this.baseline, current)
      ? snapshot.messages.slice(this.baseline.length)
      : this.recoverFreshLatestIncomingLegacy(snapshot);
    if (appended === null) {
      await this.setStatus("degraded", "OCR_BASELINE_DISCONTINUITY", this.status.lastEventAt);
      this.assertLifecycle(generation, handlers);
      return;
    }
    let lastEventAt = this.status.lastEventAt;
    for (const message of appended) {
      const sequence = this.nextSequence;
      const normalized = normalizedInboundMessageSchema.parse({
        contractVersion: 1,
        source: "native-ocr",
        sourceEpoch: this.sourceEpoch,
        sessionId: this.sessionId,
        conversationId: "example-contact",
        messageId: sha256(["native-ocr-message-v1", this.sourceEpoch, this.sessionId,
          String(sequence), legacyMessageSignature(message)]),
        sequence,
        occurredAt: message.occurredAt,
        direction: message.direction,
        kind: normalizeKind(message.kind),
        text: message.text,
      });
      this.assertLifecycle(generation, handlers);
      await handlers.onMessage(normalized);
      this.assertLifecycle(generation, handlers);
      this.nextSequence += 1;
      lastEventAt = normalized.occurredAt;
    }
    this.baseline = current;
    this.rememberFreshEvidence(snapshot.latestIncomingEvidence?.proofId);
    await this.setStatus("waiting", null, lastEventAt);
    this.assertLifecycle(generation, handlers);
  }

  private isLifecycleCurrent(
    generation: number,
    handlers: InboundMessageSourceHandlers,
  ): boolean {
    return !this.closed && this.lifecycleGeneration === generation && this.handlers === handlers;
  }

  private assertLifecycle(
    generation: number,
    handlers: InboundMessageSourceHandlers,
  ): void {
    if (!this.isLifecycleCurrent(generation, handlers)) {
      throw new Error("OCR_SOURCE_LIFECYCLE_CHANGED");
    }
  }

  private readLegacy(): Promise<ConversationSnapshot> {
    if (this.readLegacySnapshot === null) throw new Error("OCR_LEGACY_SOURCE_REQUIRED");
    return this.readLegacySnapshot();
  }

  private async setStatus(
    state: InboundSourceStatus["state"], reason: string | null, lastEventAt: string | null,
  ): Promise<void> {
    this.status = this.makeStatus(state, reason, lastEventAt);
    await this.handlers?.onStatus(this.getStatus());
  }

  private makeStatus(
    state: InboundSourceStatus["state"], reason: string | null, lastEventAt: string | null,
  ): InboundSourceStatus {
    return inboundSourceStatusSchema.parse({
      contractVersion: 1, source: "native-ocr", sourceEpoch: this.sourceEpoch,
      state, lastEventAt, reason,
    });
  }

  private recoverFreshLatestIncomingLegacy(snapshot: ConversationSnapshot): ChatMessage[] | null {
    const evidence = snapshot.latestIncomingEvidence;
    const latest = snapshot.messages.at(-1);
    if (evidence === undefined || validProofId(evidence) === null ||
        this.consumedFreshEvidenceIds.has(evidence.proofId) || latest === undefined ||
        latest.id !== evidence.messageId || latest.direction !== "incoming") return null;
    return [latest];
  }

  private rememberFreshEvidence(proofId: string | undefined): void {
    if (proofId === undefined || !hex64Pattern.test(proofId)) return;
    if (this.consumedFreshEvidenceIds.size >= 512) {
      const oldest = this.consumedFreshEvidenceIds.values().next().value;
      if (oldest !== undefined) this.consumedFreshEvidenceIds.delete(oldest);
    }
    this.consumedFreshEvidenceIds.add(proofId);
  }
}

function assertDynamicSnapshot(
  snapshot: NativeOcrConversationSnapshot,
  target: AuthorizedWechatTarget,
): void {
  if (snapshot.conversationId !== target.contactId ||
      snapshot.identity.conversationId !== target.contactId ||
      snapshot.identity.visibleName.normalize("NFC") !== target.displayName.normalize("NFC") ||
      snapshot.identity.enrollmentFingerprint !== target.enrollmentFingerprint ||
      !Number.isFinite(snapshot.identity.confidence) || snapshot.identity.confidence < 0.95 ||
      !hex64Pattern.test(snapshot.windowRevision) ||
      snapshot.messages.some((message) => message.conversationId !== target.contactId)) {
    throw new Error("OCR_TARGET_IDENTITY_INVALID");
  }
}

function recoverFreshLatestIncoming(
  snapshot: NativeOcrConversationSnapshot,
  cursor: InboundCursor,
  target: AuthorizedWechatTarget,
): readonly NativeOcrConversationMessage[] | null {
  const evidence = snapshot.latestIncomingEvidence;
  const latest = snapshot.messages.at(-1);
  if (evidence === undefined || validDynamicProof(snapshot, target) === null ||
      cursor.consumedProofIds.includes(evidence.proofId) || latest === undefined ||
      latest.id !== evidence.messageId || latest.direction !== "incoming") return null;
  return [latest];
}

function validDynamicProof(
  snapshot: NativeOcrConversationSnapshot,
  target: AuthorizedWechatTarget,
): string | null {
  const evidence = snapshot.latestIncomingEvidence;
  if (validProofId(evidence) === null || evidence === undefined ||
      evidence.contactId !== target.contactId || evidence.contactRevision !== target.revision ||
      evidence.windowRevision !== snapshot.windowRevision) return null;
  return evidence.proofId;
}

function validProofId(evidence: {
  version: number;
  proofId: string;
  observedMinute: string;
  confidence: number;
} | undefined): string | null {
  if (evidence === undefined || evidence.version !== 1 || !hex64Pattern.test(evidence.proofId) ||
      !isClockMinute(evidence.observedMinute) ||
      !Number.isFinite(evidence.confidence) || evidence.confidence < 0.5) return null;
  return evidence.proofId;
}

function isClockMinute(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return Number.isInteger(hour) && Number.isInteger(minute) && hour <= 23 && minute <= 59;
}

function cursorMatches(
  cursor: InboundCursor,
  input: DynamicSourceOptions,
  sourceEpoch: string,
  sessionId: string,
): boolean {
  return cursor.contactId === input.target.contactId && cursor.contactRevision === input.target.revision &&
    cursor.sourceEpoch === sourceEpoch && cursor.sessionIdHash === sha256([sessionId]);
}

function sameTarget(left: AuthorizedWechatTarget, right: AuthorizedWechatTarget): boolean {
  return left.contactId === right.contactId && left.revision === right.revision &&
    left.displayName.normalize("NFC") === right.displayName.normalize("NFC") &&
    left.enrollmentFingerprint === right.enrollmentFingerprint && left.bindingHash === right.bindingHash;
}

function isAuthorizationError(error: unknown): boolean {
  return error instanceof Error && /^(?:CONTACT_|WECHAT_IDENTITY_)/u.test(error.message);
}

function isOwnerFenceError(error: unknown): boolean {
  return error instanceof Error && error.message === "LIVE_RUNTIME_CLOSED";
}

function isVerifiedLegacyTarget(snapshot: ConversationSnapshot): boolean {
  return snapshot.conversationId === "example-contact" && snapshot.identity.conversationId === "example-contact" &&
    snapshot.identity.visibleName === "示例联系人" && snapshot.identity.confidence >= 0.95;
}

function messageSignatureHash(message: NativeOcrConversationMessage): string {
  return sha256([message.conversationId, message.direction, message.kind, message.text]);
}

function legacyMessageSignature(message: ChatMessage): string {
  return [message.conversationId, message.direction, message.kind, message.text].join("\0");
}

function isPrefix(previous: readonly string[], current: readonly string[]): boolean {
  return previous.length <= current.length && previous.every((value, index) => current[index] === value);
}

function normalizeKind(kind: ChatMessage["kind"]): "text" | "image" | "emoji" | "unsupported" {
  if (kind === "text") return "text";
  if (kind === "image-ocr") return "image";
  if (kind === "emoji") return "emoji";
  return "unsupported";
}

function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
