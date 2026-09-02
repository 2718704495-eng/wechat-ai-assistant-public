import { createHash, randomBytes } from "node:crypto";

import type {
  ChatMessage,
  ConversationId,
  IdentityEvidence,
} from "../domain/types.js";
import type { StateRepository } from "../storage/repositories.js";
import type { ControlBoundaryCheckpoint } from "../storage/repositories.js";

export interface IdentityProfile {
  visibleName: string;
  avatarFingerprint: string;
  recentMessageFingerprint: string;
}

export type ComposerEvidence =
  | "proven-empty"
  | "meaningful-content"
  | "ambiguous";

export interface LatestIncomingEvidence {
  version: 1;
  proofId: string;
  messageId: string;
  observedMinute: string;
  confidence: number;
}

export interface ConversationSnapshot {
  conversationId: ConversationId;
  identity: IdentityEvidence;
  messages: ChatMessage[];
  draftText: string;
  draftAlternatives?: string[];
  composerEvidence: ComposerEvidence;
  unreadIndicator: boolean | null;
  windowRevision: string;
  latestIncomingEvidence?: LatestIncomingEvidence;
}

export interface WeChatSurface {
  locateConversation(id: ConversationId): Promise<ConversationSnapshot>;
  focusConversation(id: ConversationId, windowRevision: string): Promise<void>;
  replaceDraft(id: ConversationId, text: string, token: string): Promise<void>;
  clearDraft(id: ConversationId, token: string): Promise<void>;
  submitDraft(id: ConversationId, token: string): Promise<void>;
  sendComfortStationCard?(input: {
    path: string;
    sha256: string;
    width: 1080;
    height: 1350;
    deliveryKey: string;
    token: string;
  }): Promise<{
    imageSha256: string;
    submitted: true;
    outgoingImageMatched: true;
    visualFingerprintVersion: "vision-featureprint-v1";
  }>;
}

export type ControlCommandResult =
  | { command: "stop"; messageId: string }
  | { command: "resume"; messageId: string };

export interface ControlConversationRead {
  snapshot: ConversationSnapshot;
  control: ControlCommandResult | null;
  controlCheckpoint: ControlBoundaryCheckpoint;
}

export type SendResult =
  | { status: "verified"; fingerprint: string }
  | { status: "duplicate"; fingerprint: string }
  | { status: "uncertain"; fingerprint: string; reason: string };

const allowedConversations = new Set<ConversationId>([
  "example-contact",
  "file-transfer",
]);
const identityConfidenceThreshold = 0.95;
const nativeIdentityFingerprintPattern = /^[a-f0-9]{64}$/u;

export class WeChatAdapter {
  public constructor(
    private readonly surface: WeChatSurface,
    private readonly state: StateRepository,
    private readonly identities: Record<ConversationId, IdentityProfile>,
  ) {}

  public async readConversation(id: ConversationId): Promise<ConversationSnapshot> {
    assertAllowedConversation(id);
    if (id === "example-contact" && (await this.state.getControlState()).stopped) {
      throw new Error("SYSTEM_STOPPED");
    }
    return this.readAndValidate(id);
  }

  public readConversationForOwnerAdvice(
    id: ConversationId,
  ): Promise<ConversationSnapshot> {
    if (id !== "example-contact") {
      return Promise.reject(new Error("OWNER_ADVICE_TARGET_NOT_ALLOWED"));
    }
    return this.readAndValidate(id);
  }

  public async readControlCommand(): Promise<ControlCommandResult | null> {
    return (await this.readControlConversation()).control;
  }

  public async readControlConversation(): Promise<ControlConversationRead> {
    const snapshot = await this.readAndValidate("file-transfer");
    let controlState = await this.state.getControlState();
    let boundary = controlState.controlBoundary;
    let boundaryIndexes = snapshot.messages.flatMap((message, index) =>
      message.id === boundary.boundaryMessageId ? [index] : []
    );
    if (boundary.status === "awaiting-boundary") {
      if (boundaryIndexes.length !== 1) {
        await this.failSafeAmbiguousStop(
          snapshot,
          boundaryIndexes.length > 1
            ? "CONTROL_BOUNDARY_AMBIGUOUS"
            : "CONTROL_BOUNDARY_REQUIRED",
        );
      }
      await this.state.activateControlBoundary({
        expectedEpoch: boundary.epoch,
        boundaryMessageId: boundary.boundaryMessageId,
        markerOccurrenceCount: boundaryIndexes.length,
      });
      controlState = await this.state.getControlState();
      boundary = controlState.controlBoundary;
      boundaryIndexes = snapshot.messages.flatMap((message, index) =>
        message.id === boundary.boundaryMessageId ? [index] : []
      );
    }
    if (boundaryIndexes.length !== 1) {
      await this.failSafeAmbiguousStop(snapshot, "CONTROL_BOUNDARY_AMBIGUOUS");
    }
    const boundaryIndex = boundaryIndexes[0];
    if (boundaryIndex === undefined) throw new Error("CONTROL_BOUNDARY_AMBIGUOUS");
    const suffix = snapshot.messages.slice(boundaryIndex + 1);
    if (suffix.length < boundary.consumedCount) {
      await this.failSafeAmbiguousStop(snapshot, "CONTROL_BOUNDARY_AMBIGUOUS");
    }
    let recomputed = boundary.boundaryMessageId;
    for (let index = 0; index < boundary.consumedCount; index += 1) {
      const message = suffix[index];
      if (message === undefined) {
        return this.failSafeAmbiguousStop(snapshot, "CONTROL_BOUNDARY_AMBIGUOUS");
      }
      recomputed = extendControlPrefix(recomputed, index, message.id);
    }
    if (recomputed !== boundary.prefixChainHash) {
      await this.failSafeAmbiguousStop(snapshot, "CONTROL_BOUNDARY_AMBIGUOUS");
    }
    const unseen = suffix.slice(boundary.consumedCount);
    const latest = unseen.at(-1);
    const expectedBoundary = checkpointFrom(boundary);
    if (latest === undefined) {
      return { snapshot, control: null, controlCheckpoint: expectedBoundary };
    }

    let nextHash = boundary.prefixChainHash;
    for (let offset = 0; offset < unseen.length; offset += 1) {
      const message = unseen[offset];
      if (message === undefined) throw new Error("CONTROL_BOUNDARY_AMBIGUOUS");
      nextHash = extendControlPrefix(
        nextHash,
        boundary.consumedCount + offset,
        message.id,
      );
    }
    const nextBoundary: ControlBoundaryCheckpoint = {
      ...expectedBoundary,
      consumedCount: boundary.consumedCount + unseen.length,
      prefixChainHash: nextHash,
    };
    const stop = [...unseen].reverse().find((message) =>
      message.text.trim() === "停止继续生成"
    );
    if (stop !== undefined) {
      await this.state.beginUserStopControlBatch(expectedBoundary);
      await this.surface.clearDraft("example-contact", createWriteToken());
      const cleared = await this.readAndValidate("example-contact");
      if (!isComposerProvenEmpty(cleared)) {
        throw new Error("DRAFT_CLEAR_NOT_VERIFIED");
      }
      await this.state.completeUserStopControlBatch(expectedBoundary, nextBoundary);
      return {
        snapshot,
        control: { command: "stop", messageId: stop.id },
        controlCheckpoint: nextBoundary,
      };
    }
    const result = await this.state.consumeNonStopControlBatch({
      expectedBoundary,
      nextBoundary,
      resumeMessageIds: unseen
        .filter((message) => message.text.trim() === "继续生成")
        .map((message) => message.id),
    });
    return { snapshot, control: result, controlCheckpoint: nextBoundary };
  }

  public async sendAndVerify(id: ConversationId, reply: string): Promise<SendResult> {
    assertAllowedConversation(id);
    if ((await this.state.getControlState()).stopped) {
      throw new Error("SYSTEM_STOPPED");
    }
    const initial = await this.readAndValidate(id);
    if (!isComposerProvenEmpty(initial)) {
      throw new Error("INPUT_NOT_EMPTY");
    }

    const fingerprint = fingerprintReply(id, reply);
    if (!(await this.state.claimOutgoing(fingerprint))) {
      return { status: "duplicate", fingerprint };
    }
    const token = createWriteToken();

    try {
      await this.surface.focusConversation(id, initial.windowRevision);
      await this.surface.replaceDraft(id, reply, token);
      const beforeSubmit = await this.readAndValidate(id);
      if (beforeSubmit.windowRevision !== initial.windowRevision) {
        await this.surface.clearDraft(id, token);
        return this.lockUncertain(fingerprint, "WINDOW_CHANGED_BEFORE_SEND");
      }

      await this.surface.submitDraft(id, token);
      const afterSubmit = await this.readAndValidate(id);
      const latestOutgoing = [...afterSubmit.messages]
        .reverse()
        .find((message) => message.direction === "outgoing");
      if (latestOutgoing?.text !== reply) {
        return this.lockUncertain(fingerprint, "SEND_RESULT_NOT_VERIFIED");
      }

      await this.state.markOutgoingVerified(fingerprint);
      return { status: "verified", fingerprint };
    } catch (error: unknown) {
      await this.state.markOutgoingUncertain(fingerprint);
      throw error;
    }
  }

  private async readAndValidate(id: ConversationId): Promise<ConversationSnapshot> {
    const snapshot = await this.surface.locateConversation(id);
    const expected = this.identities[id];
    const matchesConfiguredIdentity =
      snapshot.identity.avatarFingerprint === expected.avatarFingerprint &&
      snapshot.identity.recentMessageFingerprint === expected.recentMessageFingerprint;
    const matchesNativeWindowIdentity =
      snapshot.identity.avatarFingerprint === snapshot.identity.recentMessageFingerprint &&
      nativeIdentityFingerprintPattern.test(snapshot.identity.avatarFingerprint);
    if (
      snapshot.conversationId !== id ||
      snapshot.identity.conversationId !== id ||
      snapshot.identity.visibleName !== expected.visibleName ||
      (!matchesConfiguredIdentity && !matchesNativeWindowIdentity) ||
      snapshot.identity.confidence < identityConfidenceThreshold
    ) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    return snapshot;
  }

  private async lockUncertain(fingerprint: string, reason: string): Promise<SendResult> {
    await this.state.markOutgoingUncertain(fingerprint);
    return { status: "uncertain", fingerprint, reason };
  }

  private async failSafeAmbiguousStop(
    snapshot: ConversationSnapshot,
    errorCode: "CONTROL_BOUNDARY_REQUIRED" | "CONTROL_BOUNDARY_AMBIGUOUS",
  ): Promise<never> {
    const stop = [...snapshot.messages].reverse().find((message) =>
      message.text.trim() === "停止继续生成"
    );
    if (stop !== undefined) {
      await this.state.beginAmbiguousUserStopControlBatch();
      await this.surface.clearDraft("example-contact", createWriteToken());
      const cleared = await this.readAndValidate("example-contact");
      if (!isComposerProvenEmpty(cleared)) {
        throw new Error("DRAFT_CLEAR_NOT_VERIFIED");
      }
    }
    throw new Error(errorCode);
  }
}

function isComposerProvenEmpty(snapshot: ConversationSnapshot): boolean {
  return (
    snapshot.composerEvidence === "proven-empty" &&
    snapshot.draftText.length === 0 &&
    (snapshot.draftAlternatives?.every((draft) => draft.length === 0) ?? true)
  );
}

function assertAllowedConversation(id: ConversationId): void {
  if (!allowedConversations.has(id)) {
    throw new Error("CONVERSATION_NOT_ALLOWED");
  }
}

function fingerprintReply(id: ConversationId, reply: string): string {
  return createHash("sha256").update(id).update("\0").update(reply).digest("hex");
}

function createWriteToken(): string {
  return randomBytes(32).toString("hex");
}

function extendControlPrefix(previous: string, index: number, messageId: string): string {
  return createHash("sha256")
    .update(previous)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(messageId)
    .digest("hex");
}

function checkpointFrom(boundary: {
  epoch: string;
  boundaryMessageId: string;
  consumedCount: number;
  prefixChainHash: string;
}): ControlBoundaryCheckpoint {
  return {
    epoch: boundary.epoch,
    boundaryMessageId: boundary.boundaryMessageId,
    consumedCount: boundary.consumedCount,
    prefixChainHash: boundary.prefixChainHash,
  };
}
