import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationId } from "../../src/domain/types.js";
import {
  createLiveWechatMcpServer,
  type LiveWechatMcpDependencies,
} from "../../src/mcp/live-server.js";

describe("live WeChat MCP server", () => {
  let client: Client;
  let close: () => Promise<void>;
  let dependencies: LiveWechatMcpDependencies;
  let readConversation: ReturnType<
    typeof vi.fn<(conversationId: ConversationId) => Promise<unknown>>
  >;
  let prepareDraft: ReturnType<
    typeof vi.fn<LiveWechatMcpDependencies["prepareDraft"]>
  >;
  let verifySend: ReturnType<
    typeof vi.fn<(candidateToken: string) => Promise<unknown>>
  >;
  let verifyDraft: ReturnType<
    typeof vi.fn<(candidateToken: string) => Promise<unknown>>
  >;
  let abortDraft: ReturnType<
    typeof vi.fn<(candidateToken: string) => Promise<unknown>>
  >;

  beforeEach(async () => {
    readConversation = vi.fn<(conversationId: ConversationId) => Promise<unknown>>().mockImplementation((conversationId) => Promise.resolve({ conversationId, addedIds: [], messages: [] }));
    prepareDraft = vi.fn<LiveWechatMcpDependencies["prepareDraft"]>().mockResolvedValue({ candidateToken: "b".repeat(64), prepared: true });
    verifyDraft = vi.fn<(candidateToken: string) => Promise<unknown>>().mockResolvedValue({ draftVerified: true });
    verifySend = vi.fn<(candidateToken: string) => Promise<unknown>>().mockResolvedValue({ status: "verified" });
    abortDraft = vi.fn<(candidateToken: string) => Promise<unknown>>().mockResolvedValue({ aborted: true });
    dependencies = {
      getLiveState: vi.fn().mockResolvedValue({ stopped: false, sendGateReady: true }),
      readConversation,
      prepareDraft,
      verifyDraft,
      abortDraft,
      verifySend,
    };
    const server = createLiveWechatMcpServer(dependencies);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => Promise.all([client.close(), server.close()]).then(() => undefined);
  });

  afterEach(async () => close());

  it("exposes only the six constrained live tools", async () => {
    expect((await client.listTools()).tools.map(({ name }) => name).sort()).toEqual([
      "abort_live_draft",
      "get_live_state",
      "prepare_live_draft",
      "read_live_conversation",
      "verify_live_draft",
      "verify_live_send",
    ]);
  });

  it("prepares but never submits a draft from the MCP process", async () => {
    const result = await client.callTool({
      name: "prepare_live_draft",
      arguments: { conversationId: "file-transfer", text: "连接测试" },
    });
    expect(result.isError).not.toBe(true);
    expect(prepareDraft).toHaveBeenCalledWith("file-transfer", "连接测试");
    const serialized = readTextContent(result.content);
    expect(serialized).toContain('"needsComputerUseTyping":true');
    expect(serialized).toContain('"returnAllowedBeforeVerification":false');
    expect(serialized).not.toMatch(
      /"(?:needsComputerUseReturn|readyForComputerUseReturn)":true/u,
    );
  });

  it("rejects unknown conversations before touching the native dependency", async () => {
    const result = await client.callTool({
      name: "read_live_conversation",
      arguments: { conversationId: "其他人" },
    });
    expect(result.isError).toBe(true);
    expect(readConversation).not.toHaveBeenCalled();
  });

  it("passes an opaque candidate token to post-send verification", async () => {
    const result = await client.callTool({
      name: "verify_live_send",
      arguments: { candidateToken: "a".repeat(64) },
    });
    expect(result.isError).not.toBe(true);
    expect(verifySend).toHaveBeenCalledWith("a".repeat(64));
  });

  it("verifies the externally typed draft before Return is allowed", async () => {
    const result = await client.callTool({
      name: "verify_live_draft",
      arguments: { candidateToken: "c".repeat(64) },
    });
    expect(result.isError).not.toBe(true);
    expect(verifyDraft).toHaveBeenCalledWith("c".repeat(64));
  });

  it("passes an opaque candidate token to bounded draft abort", async () => {
    const result = await client.callTool({
      name: "abort_live_draft",
      arguments: { candidateToken: "d".repeat(64) },
    });
    expect(result.isError).not.toBe(true);
    expect(abortDraft).toHaveBeenCalledWith("d".repeat(64));
  });
});

function readTextContent(content: unknown): string {
  if (!Array.isArray(content)) throw new Error("EXPECTED_CONTENT_ARRAY");
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
  throw new Error("EXPECTED_TEXT_RESULT");
}
