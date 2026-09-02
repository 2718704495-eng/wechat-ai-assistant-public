import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface CurrentWechatMcpDependencies {
  getConnectionState(): Promise<unknown>;
  readTargetConversation(): Promise<unknown>;
}

export function createCurrentWechatMcpServer(
  dependencies: CurrentWechatMcpDependencies,
): McpServer {
  const server = new McpServer({ name: "wechat-current-readonly", version: "0.1.0" });

  register(
    "get_current_wechat_state",
    "只读检查微信当前连接、停止状态和运行模式",
    () => dependencies.getConnectionState(),
  );
  register(
    "read_current_wechat_conversation",
    "只读获取白名单目标会话当前可见消息；不输入、不准备草稿、不发送",
    () => dependencies.readTargetConversation(),
  );

  return server;

  function register(
    name: string,
    description: string,
    handler: () => Promise<unknown>,
  ): void {
    const inputSchema = z.object({});
    server.registerTool<typeof inputSchema, typeof inputSchema>(
      name,
      { description, inputSchema },
      async (): Promise<CallToolResult> => {
        try {
          const result = await handler();
          return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] };
        } catch (error: unknown) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: error instanceof Error ? error.message : "UNKNOWN_ERROR",
            }],
          };
        }
      },
    );
  }
}

export async function connectCurrentWechatMcpStdio(
  dependencies: CurrentWechatMcpDependencies,
): Promise<McpServer> {
  const server = createCurrentWechatMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
  return server;
}
