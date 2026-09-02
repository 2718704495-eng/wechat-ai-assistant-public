import path from "node:path";

import { z } from "zod";

import type { ConversationId, RunMode } from "../domain/types.js";

const environmentSchema = z.object({
  HOME: z.string().min(1),
  CHAT_ASSISTANT_MODE: z
    .enum(["dry-run", "observe", "supervised-send", "live"])
    .default("dry-run"),
});

export interface RuntimeConfig {
  dataDir: string;
  mode: RunMode;
  allowedWechatConversations: readonly ConversationId[];
  douyinWriteEnabled: false;
}

export interface SendGateState {
  consentConfirmed: boolean;
  initializationReportApproved: boolean;
}

const allowedWechatConversations = Object.freeze([
  "example-contact",
  "file-transfer",
] satisfies ConversationId[]);

export function loadRuntimeConfig(
  environment: Record<string, string | undefined>,
): RuntimeConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("INVALID_RUNTIME_CONFIG", { cause: parsed.error });
  }

  return {
    dataDir: path.join(parsed.data.HOME, "Desktop", "聊天助手"),
    mode: parsed.data.CHAT_ASSISTANT_MODE,
    allowedWechatConversations,
    douyinWriteEnabled: false,
  };
}

export function assertSendGate(
  config: RuntimeConfig,
  state: SendGateState,
): void {
  if (config.mode !== "supervised-send" && config.mode !== "live") {
    throw new Error("SEND_MODE_DISABLED");
  }
  if (!state.consentConfirmed) {
    throw new Error("CONSENT_NOT_CONFIRMED");
  }
  if (!state.initializationReportApproved) {
    throw new Error("INITIALIZATION_REPORT_NOT_APPROVED");
  }
}
