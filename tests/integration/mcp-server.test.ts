import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, GeneratedReply } from "../../src/domain/types.js";
import {
  createChatAssistantMcpServer,
  type ChatAssistantMcpDependencies,
} from "../../src/mcp/server.js";

const normal: ChatMessage = {
  id: "m-normal",
  conversationId: "example-contact",
  direction: "incoming",
  kind: "text",
  text: "今天上班好累",
  occurredAt: "2026-08-19T00:00:00.000Z",
  source: "wechat",
  confidence: 0.99,
};
const sensitive: ChatMessage = {
  ...normal,
  id: "m-sensitive",
  text: "你是不是喜欢我",
};

describe("chat assistant MCP server", () => {
  let client: Client;
  let close: () => Promise<void>;
  let dependencies: ChatAssistantMcpDependencies;
  let sendVerifiedReply: ReturnType<
    typeof vi.fn<(reply: string) => Promise<unknown>>
  >;

  beforeEach(async () => {
    sendVerifiedReply = vi.fn<(reply: string) => Promise<unknown>>().mockResolvedValue({ status: "verified" });
    dependencies = {
      config: {
        dataDir: "/synthetic",
        mode: "supervised-send",
        allowedWechatConversations: ["example-contact", "file-transfer"],
        douyinWriteEnabled: false,
      },
      getSendGateState: vi.fn().mockResolvedValue({ consentConfirmed: true, initializationReportApproved: true }),
      getRunState: vi.fn().mockResolvedValue({ stopped: false }),
      readNewMessages: vi.fn().mockResolvedValue([normal]),
      listMessages: vi.fn().mockResolvedValue([normal, sensitive]),
      sendVerifiedReply,
      pauseAndNotify: vi.fn().mockResolvedValue(undefined),
      buildDailyReview: vi.fn().mockResolvedValue({ status: "success" }),
      recordGeneratedReply: vi.fn().mockResolvedValue(undefined),
    };
    const server = createChatAssistantMcpServer(dependencies);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => Promise.all([client.close(), server.close()]).then(() => undefined);
  });

  afterEach(async () => close());

  it("exposes exactly the eight constrained tools", async () => {
    const result = await client.listTools();
    expect(result.tools.map(({ name }) => name).sort()).toEqual([
      "build_daily_review",
      "classify_pending",
      "get_run_state",
      "pause_and_notify",
      "read_new_messages",
      "record_generated_reply",
      "retrieve_context",
      "send_verified_reply",
    ]);
  });

  it("builds bounded context and rejects unsupported personal facts", async () => {
    const context = await call("retrieve_context", { messageId: "m-normal" });
    expect(context.isError).not.toBe(true);
    expect(JSON.stringify(context.content)).not.toContain("m-sensitive\"".repeat(9));

    const decision = json(await call("classify_pending", { messageId: "m-normal" })) as { decisionId: string };
    const result = await call("record_generated_reply", {
      decisionId: decision.decisionId,
      text: "我明天会去示例城市",
      citedMessageIds: [],
      claims: [],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("FACT_SOURCE_MISSING");
  });

  it("will not record or send a reply for a sensitive decision", async () => {
    const decision = json(await call("classify_pending", { messageId: "m-sensitive" })) as {
      decisionId: string;
      action: string;
    };
    expect(decision.action).toBe("pause");
    const result = await call("record_generated_reply", {
      decisionId: decision.decisionId,
      text: "我也喜欢你",
      citedMessageIds: [],
      claims: [],
    });
    expect(result.isError).toBe(true);
    expect(sendVerifiedReply).not.toHaveBeenCalled();
  });

  it("requires the exact one-time candidate and rechecks send gates", async () => {
    const decision = json(await call("classify_pending", { messageId: "m-normal" })) as { decisionId: string };
    const reply: GeneratedReply = { text: "辛苦了，早点歇会儿", citedMessageIds: ["m-normal"], claims: [] };
    const recorded = json(await call("record_generated_reply", { decisionId: decision.decisionId, ...reply })) as { writeToken: string };
    const sent = await call("send_verified_reply", { decisionId: decision.decisionId, writeToken: recorded.writeToken, ...reply });
    expect(sent.isError).not.toBe(true);
    expect(sendVerifiedReply).toHaveBeenCalledWith(reply.text);

    const replay = await call("send_verified_reply", { decisionId: decision.decisionId, writeToken: recorded.writeToken, ...reply });
    expect(replay.isError).toBe(true);
  });

  function call(name: string, args: Record<string, unknown>) {
    return client.callTool({ name, arguments: args });
  }
});

function json(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("EXPECTED_CONTENT_ARRAY");
  const block = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (block?.type !== "text") throw new Error("EXPECTED_TEXT_RESULT");
  if (typeof block.text !== "string") throw new Error("EXPECTED_TEXT_RESULT");
  return JSON.parse(block.text) as unknown;
}
