import { createHash } from "node:crypto";

import type { OCRLine } from "../adapters/native-bridge.js";
import {
  parseLatestIncomingEvidence,
  parseVisibleWechatMessages,
} from "../adapters/native-wechat-surface.js";
import type { ConversationSnapshot } from "../adapters/wechat.js";
import type {
  InboundSourceStatus,
  NormalizedInboundMessage,
} from "./personal-account-contract.js";
import { NativeOcrInboundSource } from "./native-ocr-inbound-source.js";

const testAccountVisibleName = "我";
const conversationListMaxX = 0.31;
const conversationHeaderMinX = 0.32;
const conversationHeaderMinY = 0.86;
const hex64Pattern = /^[a-f0-9]{64}$/u;

export interface NativeOcrCanaryFrame {
  lines: OCRLine[];
  capturedAt: Date;
  windowRevision: string;
}

export interface NativeOcrCanaryEventReceipt {
  messageId: string;
  sequence: number;
  direction: "incoming" | "outgoing";
  kind: "text" | "image" | "emoji" | "file" | "unsupported";
  occurredAt: string;
}

export interface NativeOcrCanaryReceipt {
  version: 1;
  mode: "test-only-readonly";
  accountLabelSha256: string;
  state: InboundSourceStatus["state"];
  reason: string | null;
  emittedCount: number;
  events: NativeOcrCanaryEventReceipt[];
}

/**
 * Read-only harness for the user's own test account. It accepts OCR frames only,
 * exposes no model callback or WeChat mutation surface, and never returns text.
 */
export class NativeOcrReadonlyCanary {
  private readonly source: NativeOcrInboundSource;
  private readonly pendingEvents: NativeOcrCanaryEventReceipt[] = [];

  public constructor(private readonly input: {
    sourceEpoch: string;
    readFrame: () => Promise<NativeOcrCanaryFrame>;
  }) {
    const sourceEpoch = input.sourceEpoch.trim();
    if (sourceEpoch.length === 0) throw new Error("CANARY_SOURCE_EPOCH_INVALID");
    this.source = new NativeOcrInboundSource({
      sourceEpoch,
      sessionId: `test-only:${sha256(testAccountVisibleName)}`,
      readSnapshot: () => this.readSnapshot(),
    });
  }

  public async start(): Promise<NativeOcrCanaryReceipt> {
    this.pendingEvents.length = 0;
    try {
      await this.source.start({
        onMessage: (message) => { this.pendingEvents.push(safeEvent(message)); },
        onStatus: () => undefined,
      });
      return this.receipt();
    } catch (error: unknown) {
      await this.source.close();
      throw error;
    }
  }

  public async poll(): Promise<NativeOcrCanaryReceipt> {
    this.pendingEvents.length = 0;
    try {
      await this.source.poll();
      return this.receipt();
    } catch (error: unknown) {
      await this.source.close();
      throw error;
    }
  }

  public close(): Promise<void> {
    this.pendingEvents.length = 0;
    return this.source.close();
  }

  private async readSnapshot(): Promise<ConversationSnapshot> {
    const frame = await this.input.readFrame();
    if (!Number.isFinite(frame.capturedAt.getTime()) || !hex64Pattern.test(frame.windowRevision)) {
      throw new Error("CANARY_FRAME_INVALID");
    }
    assertTestAccountIdentity(frame.lines);
    const messages = parseVisibleWechatMessages(frame.lines, "example-contact", frame.capturedAt);
    const latestIncomingEvidence = parseLatestIncomingEvidence(frame.lines, {
      conversationId: "example-contact",
      visibleName: testAccountVisibleName,
      messages,
      capturedAt: frame.capturedAt,
      windowRevision: frame.windowRevision,
    });
    // This identity normalization exists only inside the closed canary wrapper so
    // the production cursor can be exercised without widening its allowlist.
    return {
      conversationId: "example-contact",
      identity: {
        conversationId: "example-contact",
        visibleName: "示例联系人",
        avatarFingerprint: sha256("test-only-avatar"),
        recentMessageFingerprint: sha256("test-only-recent-message"),
        confidence: 0.99,
      },
      messages,
      draftText: "",
      composerEvidence: "proven-empty",
      unreadIndicator: null,
      windowRevision: frame.windowRevision,
      ...(latestIncomingEvidence === null ? {} : { latestIncomingEvidence }),
    };
  }

  private receipt(): NativeOcrCanaryReceipt {
    const status = this.source.getStatus();
    const events = this.pendingEvents.map((event) => ({ ...event }));
    return {
      version: 1,
      mode: "test-only-readonly",
      accountLabelSha256: sha256(testAccountVisibleName),
      state: status.state,
      reason: status.reason,
      emittedCount: events.length,
      events,
    };
  }
}

function assertTestAccountIdentity(lines: readonly OCRLine[]): void {
  const leftMatches = lines.filter((line) =>
    line.bounds.x < conversationListMaxX && line.confidence >= 0.9 &&
    normalizeLabel(line.text) === testAccountVisibleName
  );
  const headerMatches = lines.filter((line) =>
    line.bounds.x >= conversationHeaderMinX && line.bounds.y >= conversationHeaderMinY &&
    line.confidence >= 0.9 && normalizeLabel(line.text) === testAccountVisibleName
  );
  if (leftMatches.length !== 1 || headerMatches.length !== 1) {
    throw new Error("CANARY_TEST_ACCOUNT_IDENTITY_INVALID");
  }
}

function safeEvent(message: NormalizedInboundMessage): NativeOcrCanaryEventReceipt {
  return {
    messageId: message.messageId,
    sequence: message.sequence,
    direction: message.direction,
    kind: message.kind,
    occurredAt: message.occurredAt,
  };
}

function normalizeLabel(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
