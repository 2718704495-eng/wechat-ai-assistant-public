import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ConversationId } from "../domain/types.js";
import type {
  ControlBoundaryCheckpoint,
  TargetReplyTrigger,
} from "../storage/repositories.js";

const conversationIdSchema = z.enum(["example-contact", "file-transfer"]);

export interface LiveWechatMcpDependencies {
  getLiveState(): Promise<unknown>;
  readConversation(conversationId: ConversationId): Promise<unknown>;
  prepareDraft(conversationId: ConversationId, text: string): Promise<{
    candidateToken: string;
    [key: string]: unknown;
  }>;
  verifyDraft(candidateToken: string): Promise<unknown>;
  abortDraft(candidateToken: string): Promise<unknown>;
  verifySend(candidateToken: string): Promise<unknown>;
}

export interface LiveWechatRuntimeDependencies extends LiveWechatMcpDependencies {
  readTargetConversationForAdvice(): Promise<unknown>;
  establishControlBoundaryForSupervisor(): Promise<{
    status: "active";
    epoch: string;
    boundaryMessageId: string;
    consumedCount: number;
    prefixChainHash: string;
    markerOccurrenceCount: 1;
  }>;
  readControlForSupervisor(): Promise<{
    publicResult: unknown;
    proof: SupervisorControlProof;
  }>;
  readTargetForSupervisor(controlProof: SupervisorControlProof): Promise<{
    publicResult: unknown;
    proof: SupervisorTargetProof | null;
  }>;
  readTargetDirectForSupervisor(): Promise<{
    publicResult: unknown;
    controlProof: SupervisorControlProof | null;
    proof: SupervisorTargetProof | null;
  }>;
  prepareLatestReplyForSupervisor(
    text: string,
    controlProof: SupervisorControlProof,
    targetProof: SupervisorTargetProof,
  ): Promise<{ candidateToken: string; prepared: true; conversationId: "example-contact" }>;
  showComfortStationCardForSupervisor(
    controlProof: SupervisorControlProof,
    targetProof: SupervisorTargetProof,
  ): Promise<{
    status: "verified" | "already-handled" | "not-requested";
    conversationId: "example-contact";
  }>;
  showComfortStationCardForReleaseAcceptance?(): Promise<{
    status: "verified" | "already-handled";
    conversationId: "example-contact";
  }>;
  submitAuthorizedDraftForSupervisor(
    candidateToken: string,
    controlProof: SupervisorControlProof,
    targetProof: SupervisorTargetProof,
  ): Promise<{ submitted: true; conversationId: "example-contact" }>;
  abortPreparedDraftForSupervisor(
    candidateToken: string,
  ): Promise<{ aborted: true; conversationId: "example-contact" }>;
}

export interface SupervisorControlProof {
  capability: string;
  checkpoint: ControlBoundaryCheckpoint;
  verification: "ui-observed" | "persistent-stop-gate";
  gateRevision: string;
}

export interface SupervisorTargetProof {
  capability: string;
  trigger: TargetReplyTrigger;
  comfortStationRequested: boolean;
}

export function createLiveWechatMcpServer(
  dependencies: LiveWechatMcpDependencies,
): McpServer {
  const server = new McpServer({ name: "wechat-live", version: "0.1.0" });

  register("get_live_state", "读取微信实时连接、停止状态和发送门禁", {}, async () =>
    dependencies.getLiveState(),
  );
  register(
    "read_live_conversation",
    "读取并加密保存允许名单内会话的当前可见消息；文件传输助手会同步处理停止/继续命令",
    { conversationId: conversationIdSchema },
    async ({ conversationId }) => dependencies.readConversation(conversationId),
  );
  register(
    "prepare_live_draft",
    "校验会话、空输入框和发送门禁后锁定候选文本并聚焦输入框；本工具不输入文本也不按回车",
    { conversationId: conversationIdSchema, text: z.string().trim().min(1).max(500) },
    async ({ conversationId, text }) => ({
      ...(await dependencies.prepareDraft(conversationId, text)),
      needsComputerUseTyping: true,
      returnAllowedBeforeVerification: false,
    }),
  );
  register(
    "verify_live_draft",
    "电脑控制层输入候选文本后，读回并核验草稿完全一致；只有成功后才允许按回车",
    { candidateToken: z.string().length(64).regex(/^[a-f0-9]+$/u) },
    async ({ candidateToken }) => dependencies.verifyDraft(candidateToken),
  );
  register(
    "abort_live_draft",
    "仅在候选未核验且输入框读回为空时，使用一次性令牌清除匹配候选并释放其发送占用",
    { candidateToken: z.string().length(64).regex(/^[a-f0-9]+$/u) },
    async ({ candidateToken }) => dependencies.abortDraft(candidateToken),
  );
  register(
    "verify_live_send",
    "电脑控制层按一次回车后，使用一次性令牌读回并核验发送结果",
    { candidateToken: z.string().length(64).regex(/^[a-f0-9]+$/u) },
    async ({ candidateToken }) => dependencies.verifySend(candidateToken),
  );

  return server;

  function register<T extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: T,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
  ): void {
    const schema = z.object(inputSchema);
    server.registerTool<typeof schema, typeof schema>(
      name,
      { description, inputSchema: schema },
      async (input): Promise<CallToolResult> => {
        try {
          const result = await handler(input);
          return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] };
        } catch (error: unknown) {
          return {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : "UNKNOWN_ERROR" }],
          };
        }
      },
    );
  }
}

export async function connectLiveWechatMcpStdio(
  dependencies: LiveWechatMcpDependencies,
): Promise<McpServer> {
  const server = createLiveWechatMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
  return server;
}
