import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  createDailyCareProductionSession,
  createDailyCareSession,
  type DailyCareProductionRuntimeDependencies,
  type DailyCareRuntimeDependencies,
} from "./daily-care-session.js";

export interface DailyCareMcpLifecycle {
  onCloseRequested(): Promise<void> | void;
}

export function createDailyCareMcpServer(
  runtime: DailyCareRuntimeDependencies,
  lifecycle: DailyCareMcpLifecycle,
): McpServer {
  const server = new McpServer({ name: "daily-care-file-transfer-test", version: "1.0.0" });
  const session = createDailyCareSession(runtime);
  let closeNotified = false;

  register("begin-test-preview", { kind: z.enum(["morning", "night"]) }, ({ kind }) =>
    session.execute({ op: "begin-test-preview", kind }));
  register("research-morning-weather", {}, () =>
    session.execute({ op: "research-morning-weather" }));
  register("prepare-broadcast", { text: z.string().min(1).max(1_000) }, ({ text }) =>
    session.execute({ op: "prepare-broadcast", text }));
  register("verify-draft", {}, () => session.execute({ op: "verify-draft" }));
  register("submit-authorized-broadcast", {}, () =>
    session.execute({ op: "submit-authorized-broadcast" }));
  register("verify-send", {}, () => session.execute({ op: "verify-send" }));
  register("abort-draft", {}, () => session.execute({ op: "abort-draft" }));
  register("close", {}, async () => {
    const result = await session.execute({ op: "close" });
    if (!closeNotified) {
      closeNotified = true;
      setImmediate(() => { void Promise.resolve(lifecycle.onCloseRequested()).catch(() => undefined); });
    }
    return result;
  });
  return server;

  function register<T extends z.ZodRawShape>(
    name: string,
    shape: T,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
  ): void {
    const inputSchema = z.object(shape).strict();
    server.registerTool<typeof inputSchema, typeof inputSchema>(
      name,
      { inputSchema },
      async (input): Promise<CallToolResult> => {
        try {
          const result = await handler(input);
          return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] };
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: "DAILY_CARE_OPERATION_FAILED" }],
          };
        }
      },
    );
  }
}

export function createDailyCareProductionMcpServer(
  runtime: DailyCareProductionRuntimeDependencies,
  lifecycle: DailyCareMcpLifecycle,
): McpServer {
  const server = new McpServer({ name: "daily-care-supervisor", version: "1.0.0" });
  const session = createDailyCareProductionSession(runtime);
  let closeNotified = false;

  register("begin-current-slot", {}, () => session.execute({ op: "begin-current-slot" }));
  register("research-morning-weather", {}, () =>
    session.execute({ op: "research-morning-weather" }));
  register("prepare-broadcast", { text: z.string().min(1).max(1_000) }, ({ text }) =>
    session.execute({ op: "prepare-broadcast", text }));
  register("verify-draft", {}, () => session.execute({ op: "verify-draft" }));
  register("submit-authorized-broadcast", {}, () =>
    session.execute({ op: "submit-authorized-broadcast" }));
  register("verify-send", {}, () => session.execute({ op: "verify-send" }));
  register("abort-draft", {}, () => session.execute({ op: "abort-draft" }));
  register("close", {}, async () => {
    const result = await session.execute({ op: "close" });
    if (!closeNotified) {
      closeNotified = true;
      setImmediate(() => { void Promise.resolve(lifecycle.onCloseRequested()).catch(() => undefined); });
    }
    return result;
  });
  return server;

  function register<T extends z.ZodRawShape>(
    name: string,
    shape: T,
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
  ): void {
    const inputSchema = z.object(shape).strict();
    server.registerTool<typeof inputSchema, typeof inputSchema>(
      name,
      { inputSchema },
      async (input): Promise<CallToolResult> => {
        try {
          const result = await handler(input);
          return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] };
        } catch {
          return {
            isError: true,
            content: [{ type: "text", text: "DAILY_CARE_OPERATION_FAILED" }],
          };
        }
      },
    );
  }
}

export async function connectDailyCareMcpStdio(
  runtime: DailyCareRuntimeDependencies,
  lifecycle: DailyCareMcpLifecycle,
): Promise<McpServer> {
  const server = createDailyCareMcpServer(runtime, lifecycle);
  await server.connect(new StdioServerTransport());
  return server;
}

export async function connectDailyCareProductionMcpStdio(
  runtime: DailyCareProductionRuntimeDependencies,
  lifecycle: DailyCareMcpLifecycle,
): Promise<McpServer> {
  const server = createDailyCareProductionMcpServer(runtime, lifecycle);
  await server.connect(new StdioServerTransport());
  return server;
}
