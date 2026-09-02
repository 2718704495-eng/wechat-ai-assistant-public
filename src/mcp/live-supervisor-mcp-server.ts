import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { LiveWechatRuntimeDependencies } from "./live-server.js";
import { createLiveSupervisorSession } from "./live-supervisor-session.js";

export type LiveSupervisorMcpDependencies = LiveWechatRuntimeDependencies;

export interface LiveSupervisorMcpLifecycle {
  onCloseRequested(): Promise<void> | void;
}

const prepareTextSchema = z.string()
  .min(1)
  .max(500)
  .refine((text) => text.trim().length > 0)
  .refine((text) => !/[\r\n]/u.test(text));
const prepareInputShape = { text: prepareTextSchema };

export function createLiveSupervisorMcpServer(
  dependencies: LiveSupervisorMcpDependencies,
  lifecycle: LiveSupervisorMcpLifecycle,
): McpServer {
  const server = new McpServer({ name: "chat-assistant-supervisor", version: "1.0.0" });
  const session = createLiveSupervisorSession(dependencies);
  let closeRequested = false;

  register("establish-control-boundary", {}, async () =>
    session.execute({ op: "establish-control-boundary" }));
  register("read-control", {}, async () =>
    session.execute({ op: "read-control" }));
  register("read-target", {}, async () =>
    session.execute({ op: "read-target" }));
  register("prepare-latest-reply", prepareInputShape, async ({ text }) =>
    session.execute({ op: "prepare-latest-reply", text }));
  register("show-comfort-station", {}, async () =>
    session.execute({ op: "show-comfort-station" }));
  register("verify-draft", {}, async () =>
    session.execute({ op: "verify-draft" }));
  register("submit-authorized-draft", {}, async () =>
    session.execute({ op: "submit-authorized-draft" }));
  register("abort-draft", {}, async () =>
    session.execute({ op: "abort-draft" }));
  register("verify-send", {}, async () =>
    session.execute({ op: "verify-send" }));
  register("close", {}, async () => {
    const result = await session.execute({ op: "close" });
    if (!closeRequested) {
      closeRequested = true;
      setImmediate(() => {
        void Promise.resolve(lifecycle.onCloseRequested()).catch(() => undefined);
      });
    }
    return result;
  });

  return server;

  function register<T extends z.ZodRawShape>(
    name: string,
    inputShape: T,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
  ): void {
    const inputSchema = z.object(inputShape).strict();
    server.registerTool<typeof inputSchema, typeof inputSchema>(
      name,
      { inputSchema },
      async (input): Promise<CallToolResult> => {
        try {
          const result = await handler(input);
          return {
            content: [{ type: "text", text: JSON.stringify(result) ?? "null" }],
          };
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: "SUPERVISOR_OPERATION_FAILED" }],
          };
        }
      },
    );
  }
}

export async function connectLiveSupervisorMcpStdio(
  dependencies: LiveSupervisorMcpDependencies,
  lifecycle: LiveSupervisorMcpLifecycle,
): Promise<McpServer> {
  const server = createLiveSupervisorMcpServer(dependencies, lifecycle);
  await server.connect(new StdioServerTransport());
  return server;
}
