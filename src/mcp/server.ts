import { randomBytes, randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { assertReplyFacts, buildReplyContext } from "../application/context.js";
import { assertSendGate, type RuntimeConfig, type SendGateState } from "../config/runtime-config.js";
import type { ChatMessage, GeneratedReply } from "../domain/types.js";
import { buildStyleProfile } from "../memory/profile-builder.js";
import { classifyMessage } from "../policy/classifier.js";

export interface ChatAssistantMcpDependencies {
  config: RuntimeConfig;
  getSendGateState(): Promise<SendGateState>;
  getRunState(): Promise<unknown>;
  readNewMessages(): Promise<ChatMessage[]>;
  listMessages(): Promise<ChatMessage[]>;
  sendVerifiedReply(reply: string): Promise<unknown>;
  pauseAndNotify(reason: string): Promise<void>;
  buildDailyReview(): Promise<unknown>;
  recordGeneratedReply(reply: GeneratedReply): Promise<void>;
}

interface PendingDecision {
  message: ChatMessage;
  action: "reply" | "clarify" | "pause" | "wait";
  reason: string;
}

interface Candidate {
  decisionId: string;
  reply: GeneratedReply;
  writeToken: string;
}

const generatedReplySchema = z.object({
  text: z.string().min(1).max(1000),
  citedMessageIds: z.array(z.string()),
  claims: z.array(z.object({ text: z.string().min(1), sourceMessageId: z.string() })),
});

export function createChatAssistantMcpServer(
  dependencies: ChatAssistantMcpDependencies,
): McpServer {
  const server = new McpServer({ name: "wechat-ai-assistant-public", version: "0.1.0" });
  const decisions = new Map<string, PendingDecision>();
  const candidates = new Map<string, Candidate>();

  register("get_run_state", "读取运行状态", {}, async () => dependencies.getRunState());
  register("read_new_messages", "读取目标会话的新消息", {}, async () => dependencies.readNewMessages());
  register(
    "retrieve_context",
    "为当前消息构建至多八条、带来源的最小上下文",
    { messageId: z.string() },
    async ({ messageId }) => {
      const history = await dependencies.listMessages();
      const current = requireMessage(history, messageId);
      return buildReplyContext(current, history, buildStyleProfile(history), dependencies.config.mode);
    },
  );
  register(
    "classify_pending",
    "对待回复消息执行敏感内容分类",
    { messageId: z.string() },
    async ({ messageId }) => {
      const message = requireMessage(await dependencies.listMessages(), messageId);
      const decision = classifyMessage(message, {});
      const decisionId = randomUUID();
      decisions.set(decisionId, { message, ...decision });
      return { decisionId, ...decision };
    },
  );
  register(
    "record_generated_reply",
    "校验并记录候选回复；返回一次性写令牌",
    { decisionId: z.string().uuid(), ...generatedReplySchema.shape },
    async ({ decisionId, ...reply }) => {
      requireReplyDecision(decisions, decisionId);
      const available = await dependencies.listMessages();
      assertReplyFacts(reply, available);
      const writeToken = randomBytes(32).toString("hex");
      const candidate = { decisionId, reply, writeToken };
      candidates.set(decisionId, candidate);
      await dependencies.recordGeneratedReply(reply);
      return { writeToken };
    },
  );
  register(
    "send_verified_reply",
    "复核策略、事实和门禁后发送候选回复",
    { decisionId: z.string().uuid(), writeToken: z.string().length(64), ...generatedReplySchema.shape },
    async ({ decisionId, writeToken, ...reply }) => {
      const decision = requireReplyDecision(decisions, decisionId);
      const candidate = candidates.get(decisionId);
      if (candidate === undefined || candidate.writeToken !== writeToken || stable(candidate.reply) !== stable(reply)) {
        throw new Error("WRITE_TOKEN_OR_CANDIDATE_MISMATCH");
      }
      const rechecked = classifyMessage(decision.message, {});
      if (rechecked.action !== "reply") throw new Error("POLICY_RECHECK_FAILED");
      assertReplyFacts(reply, await dependencies.listMessages());
      assertSendGate(dependencies.config, await dependencies.getSendGateState());
      candidates.delete(decisionId);
      return dependencies.sendVerifiedReply(reply.text);
    },
  );
  register(
    "pause_and_notify",
    "暂停自动回复并通过文件传输助手通知用户",
    { reason: z.string().min(1) },
    async ({ reason }) => {
      await dependencies.pauseAndNotify(reason);
      return { paused: true };
    },
  );
  register("build_daily_review", "生成当日复盘", {}, async () => dependencies.buildDailyReview());

  return server;

  function register<T extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: T,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
  ): void {
    const schema = z.object(inputSchema);
    server.registerTool<typeof schema, typeof schema>(name, { description, inputSchema: schema }, async (input): Promise<CallToolResult> => {
      try {
        const result = await handler(input);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) ?? "null" }] };
      } catch (error: unknown) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : "UNKNOWN_ERROR" }],
        };
      }
    });
  }
}

export async function connectChatAssistantMcpStdio(
  dependencies: ChatAssistantMcpDependencies,
): Promise<McpServer> {
  const server = createChatAssistantMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
  return server;
}

function requireMessage(messages: ChatMessage[], id: string): ChatMessage {
  const message = messages.find((entry) => entry.id === id);
  if (message === undefined) throw new Error("MESSAGE_NOT_FOUND");
  return message;
}

function requireReplyDecision(
  decisions: Map<string, PendingDecision>,
  id: string,
): PendingDecision {
  const decision = decisions.get(id);
  if (decision === undefined) throw new Error("DECISION_NOT_FOUND");
  if (decision.action !== "reply") throw new Error("POLICY_DECISION_NOT_REPLY");
  return decision;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}
