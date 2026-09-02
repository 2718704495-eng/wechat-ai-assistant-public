import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCurrentWechatMcpServer,
  type CurrentWechatMcpDependencies,
} from "../../src/mcp/current-server.js";

describe("current WeChat read-only MCP server", () => {
  let client: Client;
  let close: () => Promise<void>;
  let dependencies: CurrentWechatMcpDependencies;
  let readTargetConversation: ReturnType<typeof vi.fn<() => Promise<unknown>>>;

  beforeEach(async () => {
    readTargetConversation = vi.fn<() => Promise<unknown>>().mockResolvedValue({
      conversationId: "example-contact",
      messages: [{ direction: "incoming", text: "今天加班" }],
    });
    dependencies = {
      getConnectionState: vi.fn().mockResolvedValue({ connected: true, mode: "observe" }),
      readTargetConversation,
    };
    const server = createCurrentWechatMcpServer(dependencies);
    client = new Client({ name: "current-wechat-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => Promise.all([client.close(), server.close()]).then(() => undefined);
  });

  afterEach(async () => close());

  it("exposes only connection state and target-conversation reads", async () => {
    expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual([
      "get_current_wechat_state",
      "read_current_wechat_conversation",
    ]);
  });

  it("reads only the fixed target conversation without accepting a conversation id", async () => {
    const result = await client.callTool({
      name: "read_current_wechat_conversation",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(readTargetConversation).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.content)).toContain("今天加班");
  });

  it("returns bounded errors without exposing a write-capable fallback", async () => {
    readTargetConversation.mockRejectedValueOnce(new Error("WECHAT_MAIN_WINDOW_NOT_FOUND"));

    const result = await client.callTool({
      name: "read_current_wechat_conversation",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("WECHAT_MAIN_WINDOW_NOT_FOUND");
  });
});
