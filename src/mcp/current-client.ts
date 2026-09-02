import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const requiredToolNames = [
  "get_current_wechat_state",
  "read_current_wechat_conversation",
] as const;

export interface CurrentWechatAdviceRead {
  state: unknown;
  conversation: unknown;
}

export async function readCurrentWechatForAdvice(
  client: Pick<Client, "listTools" | "callTool">,
): Promise<CurrentWechatAdviceRead> {
  const available = new Set((await client.listTools()).tools.map(({ name }) => name));
  for (const required of requiredToolNames) {
    if (!available.has(required)) {
      throw new Error(`WECHAT_CURRENT_TOOL_MISSING:${required}`);
    }
  }

  const state = parseToolResult(await client.callTool({
    name: "get_current_wechat_state",
    arguments: {},
  }));
  const conversation = parseToolResult(await client.callTool({
    name: "read_current_wechat_conversation",
    arguments: {},
  }));
  return { state, conversation };
}

function parseToolResult(result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    throw new Error("WECHAT_CURRENT_TOOL_INVALID_RESULT");
  }
  const content = "content" in result ? result.content : undefined;
  const isError = "isError" in result && result.isError === true;
  const text = readTextBlock(content);
  if (isError) {
    throw new Error(text.length > 0 ? text : "WECHAT_CURRENT_TOOL_FAILED");
  }
  if (text.length === 0) throw new Error("WECHAT_CURRENT_TOOL_EMPTY_RESULT");
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error("WECHAT_CURRENT_TOOL_INVALID_JSON", { cause: error });
  }
}

function readTextBlock(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const blocks: unknown[] = content;
  for (const block of blocks) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return "";
}
