import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCurrentWechatForAdvice } from "../../src/mcp/current-client.js";
import { createCurrentWechatMcpServer } from "../../src/mcp/current-server.js";

describe("current WeChat MCP compatibility client", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const server = createCurrentWechatMcpServer({
      getConnectionState: () => Promise.resolve({
        connected: true,
        mode: "observe",
        targetSendReady: false,
      }),
      readTargetConversation: () => Promise.resolve({
        conversationId: "example-contact",
        messages: [{ direction: "incoming", text: "今天加班" }],
        draftEmpty: true,
      }),
    });
    client = new Client({ name: "current-client-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => Promise.all([client.close(), server.close()]).then(() => undefined);
  });

  afterEach(async () => close());

  it("reads state and the current target through the read-only MCP contract", async () => {
    await expect(readCurrentWechatForAdvice(client)).resolves.toEqual({
      state: {
        connected: true,
        mode: "observe",
        targetSendReady: false,
      },
      conversation: {
        conversationId: "example-contact",
        messages: [{ direction: "incoming", text: "今天加班" }],
        draftEmpty: true,
      },
    });
  });
});
