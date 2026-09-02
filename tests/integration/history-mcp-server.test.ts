import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHistoryMcpServer,
  type HistoryMcpDependencies,
} from "../../src/mcp/history-server.js";

describe("read-only history MCP server", () => {
  let client: Client;
  let close: () => Promise<void>;
  let dependencies: HistoryMcpDependencies;
  let dragTargetScrollbar: ReturnType<
    typeof vi.fn<(fromY: number, toY: number) => Promise<void>>
  >;
  let listImportedMessages: ReturnType<
    typeof vi.fn<(offset: number, limit: number) => Promise<unknown>>
  >;

  beforeEach(async () => {
    dragTargetScrollbar = vi.fn<(fromY: number, toY: number) => Promise<void>>().mockResolvedValue(undefined);
    listImportedMessages = vi.fn<(offset: number, limit: number) => Promise<unknown>>().mockResolvedValue([{ id: "m1", text: "你好" }]);
    dependencies = {
      locateTargetWindow: vi.fn().mockResolvedValue({ windowID: 42, title: "与“示例联系人”的聊天记录" }),
      captureTargetOcr: vi.fn().mockResolvedValue([{ text: "今天上班好累", confidence: 0.99 }]),
      scrollTarget: vi.fn().mockResolvedValue(undefined),
      dragTargetScrollbar,
      scanTargetBatch: vi.fn().mockResolvedValue({ pages: [{ index: 0, lines: [{ text: "去年" }] }] }),
      listImportedMessages,
      getCheckpoint: vi.fn().mockResolvedValue({ cursor: "native-page-006", complete: false }),
    };
    const server = createHistoryMcpServer(dependencies);
    client = new Client({ name: "history-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => Promise.all([client.close(), server.close()]).then(() => undefined);
  });

  afterEach(async () => close());

  it("exposes only read-only history tools", async () => {
    const result = await client.listTools();
    expect(result.tools.map(({ name }) => name).sort()).toEqual([
      "capture_wechat_history_ocr",
      "drag_wechat_history_scrollbar",
      "get_history_checkpoint",
      "get_wechat_history_window",
      "list_imported_messages",
      "scan_wechat_history_batch",
      "scroll_wechat_history",
    ]);
  });

  it("captures structured OCR and delegates bounded navigation", async () => {
    const captured = await client.callTool({ name: "capture_wechat_history_ocr", arguments: {} });
    expect(captured.isError).not.toBe(true);
    expect(JSON.stringify(captured.content)).toContain("今天上班好累");

    await client.callTool({ name: "drag_wechat_history_scrollbar", arguments: { fromY: 350, toY: 600 } });
    expect(dragTargetScrollbar).toHaveBeenCalledWith(350, 600);
  });

  it("bounds encrypted message pagination", async () => {
    await client.callTool({ name: "list_imported_messages", arguments: { offset: 0, limit: 100 } });
    expect(listImportedMessages).toHaveBeenCalledWith(0, 100);

    const rejected = await client.callTool({ name: "list_imported_messages", arguments: { offset: 0, limit: 1000 } });
    expect(rejected.isError).toBe(true);
  });

  it("scans multiple OCR pages in one bounded call", async () => {
    const result = await client.callTool({
      name: "scan_wechat_history_batch",
      arguments: {
        actions: [
          { type: "scroll", deltaY: 1200 },
          { type: "drag", fromY: 350, toY: 600 },
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("去年");
  });
});
