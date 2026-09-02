import { describe, expect, test } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import { retrieveContext } from "../../src/memory/retriever.js";

function message(
  id: string,
  text: string,
  occurredAt: string,
  source: ChatMessage["source"] = "wechat",
  confidence = 0.99,
): ChatMessage {
  return {
    id,
    conversationId: "example-contact",
    direction: "incoming",
    kind: "text",
    text,
    occurredAt,
    source,
    confidence,
  };
}

describe("retrieveContext", () => {
  test("caps context at eight and ranks a shared topic above unrelated recency", () => {
    const messages = [
      message("birthday", "生日礼物里面放了很多千纸鹤", "2026-01-01T00:00:00.000Z"),
      ...Array.from({ length: 9 }, (_, index) =>
        message(
          `recent-${index}`,
          `今天普通工作消息${index}`,
          `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
    ];

    const result = retrieveContext("生日的千纸鹤礼物", messages, 20);

    expect(result.messages).toHaveLength(8);
    expect(result.messages[0]?.id).toBe("birthday");
    expect(result.citedMessageIds).toEqual(result.messages.map((item) => item.id));
  });

  test("keeps WeChat and Douyin citations in separate source groups", () => {
    const result = retrieveContext(
      "示例游戏游戏",
      [
        message("wx-game", "以前一起打示例游戏", "2026-08-17T00:00:00.000Z"),
        message("dy-game", "抖音分享了示例游戏视频", "2026-08-18T00:00:00.000Z", "douyin"),
      ],
      8,
    );

    expect(result.bySource).toEqual({
      wechat: ["wx-game"],
      douyin: ["dy-game"],
    });
    expect(result.messages.find((item) => item.id === "dy-game")?.source).toBe("douyin");
  });

  test("excludes low-confidence OCR from factual context", () => {
    const uncertain = message(
      "ocr-low",
      "生日可能是八月十九",
      "2026-08-19T00:00:00.000Z",
      "wechat",
      0.7,
    );
    uncertain.kind = "image-ocr";

    const result = retrieveContext("生日", [uncertain], 8);

    expect(result.messages).toEqual([]);
    expect(result.excludedLowConfidenceIds).toEqual(["ocr-low"]);
  });

  test("uses recent messages to break ties between equally relevant memories", () => {
    const result = retrieveContext(
      "夜班工作",
      [
        message("old", "夜班工作很累", "2025-08-19T00:00:00.000Z"),
        message("new", "夜班工作很累", "2026-08-19T00:00:00.000Z"),
      ],
      8,
    );

    expect(result.messages.map((item) => item.id)).toEqual(["new", "old"]);
  });
});
