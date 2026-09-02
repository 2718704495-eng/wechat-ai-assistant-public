import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface HistoryMcpDependencies {
  locateTargetWindow(): Promise<unknown>;
  captureTargetOcr(): Promise<unknown>;
  scrollTarget(deltaY: number): Promise<void>;
  dragTargetScrollbar(fromY: number, toY: number): Promise<void>;
  scanTargetBatch(actions: HistoryNavigationAction[]): Promise<unknown>;
  listImportedMessages(offset: number, limit: number): Promise<unknown>;
  getCheckpoint(): Promise<unknown>;
}

export type HistoryNavigationAction =
  | { type: "scroll"; deltaY: number }
  | { type: "drag"; fromY: number; toY: number };

const navigationActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scroll"), deltaY: z.number().int().min(-1200).max(1200).refine((value) => value !== 0) }),
  z.object({ type: z.literal("drag"), fromY: z.number().int().min(40), toY: z.number().int().max(690) })
    .refine(({ fromY, toY }) => toY > fromY && toY - fromY <= 600),
]);

export function createHistoryMcpServer(dependencies: HistoryMcpDependencies): McpServer {
  const server = new McpServer({ name: "wechat-history-readonly", version: "0.1.0" });

  register("get_wechat_history_window", "定位白名单微信聊天记录窗口", {}, () => dependencies.locateTargetWindow());
  register("capture_wechat_history_ocr", "截取目标窗口、返回结构化 OCR 并清理截图", {}, () => dependencies.captureTargetOcr());
  register(
    "scroll_wechat_history",
    "对白名单聊天记录窗口执行有界只读滚动",
    { deltaY: z.number().int().min(-1200).max(1200).refine((value) => value !== 0) },
    async ({ deltaY }) => {
      await dependencies.scrollTarget(deltaY);
      return { ok: true };
    },
  );
  register(
    "drag_wechat_history_scrollbar",
    "仅拖动白名单聊天记录窗口的右侧滚动条向下",
    { fromY: z.number().int().min(40), toY: z.number().int().max(690) },
    async ({ fromY, toY }) => {
      if (toY <= fromY || toY - fromY > 600) throw new Error("READ_ONLY_SCROLLBAR_DRAG_NOT_ALLOWED");
      await dependencies.dragTargetScrollbar(fromY, toY);
      return { ok: true };
    },
  );
  register(
    "list_imported_messages",
    "分页读取本地加密消息库",
    { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100) },
    ({ offset, limit }) => dependencies.listImportedMessages(offset, limit),
  );
  register(
    "scan_wechat_history_batch",
    "一次执行最多二十个只读导航动作，逐步 OCR 并自动清理截图",
    { actions: z.array(navigationActionSchema).min(1).max(20) },
    ({ actions }) => dependencies.scanTargetBatch(actions),
  );
  register("get_history_checkpoint", "读取微信历史采集检查点", {}, () => dependencies.getCheckpoint());

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

export async function connectHistoryMcpStdio(dependencies: HistoryMcpDependencies): Promise<McpServer> {
  const server = createHistoryMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
  return server;
}
