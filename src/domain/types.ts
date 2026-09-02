export type ConversationId = "example-contact" | "file-transfer";

export type { MemoryScenario } from "../memory/schema.js";

export type RunMode =
  | "dry-run"
  | "observe"
  | "supervised-send"
  | "live";

export type MessageKind =
  | "text"
  | "emoji"
  | "link"
  | "image-ocr"
  | "voice-transcript";

export interface ChatMessage {
  id: string;
  conversationId: ConversationId;
  direction: "incoming" | "outgoing";
  kind: MessageKind;
  text: string;
  occurredAt: string;
  source: "wechat" | "douyin";
  confidence: number;
}

export interface IdentityEvidence {
  conversationId: ConversationId;
  visibleName: string;
  avatarFingerprint: string;
  recentMessageFingerprint: string;
  confidence: number;
}

export type Decision =
  | { action: "reply"; reason: string; triggerMessageId?: string }
  | { action: "clarify"; reason: string }
  | { action: "pause"; reason: string }
  | { action: "wait"; reason: string };

export interface GeneratedReply {
  text: string;
  citedMessageIds: string[];
  claims: Array<{ text: string; sourceMessageId: string }>;
}

export interface RunResult {
  status: "success" | "warning" | "error" | "blocked";
  summary: string;
  evidence: string[];
  nextActions: string[];
  artifacts: string[];
}
