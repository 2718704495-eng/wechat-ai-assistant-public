import { describe, expect, test } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import { classifyMessage } from "../../src/policy/classifier.js";

function incoming(text: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "incoming-1",
    conversationId: "example-contact",
    direction: "incoming",
    kind: "text",
    text,
    occurredAt: "2026-08-19T01:00:00.000Z",
    source: "wechat",
    confidence: 0.99,
    ...overrides,
  };
}

describe("classifyMessage", () => {
  test.each([
    ["表白", "我其实一直都喜欢你"],
    ["关系定义", "我们现在到底算什么关系"],
    ["约见", "要不我们哪天碰个面"],
    ["行程", "你买好来示例城市的票了吗"],
    ["争执", "你是不是还在生气"],
    ["道歉", "这件事你应该认真道歉"],
    ["前任", "你前女友后来怎么样了"],
    ["性话题", "你会想和喜欢的人接吻吗"],
    ["金钱", "你能先借我两千块钱吗"],
    ["隐私", "把你身份证号码发给我"],
    ["AI 身份", "你这句话是不是机器人帮你写的"],
  ])("pauses %s instead of generating a relationship-changing reply", (_topic, text) => {
    expect(classifyMessage(incoming(text), {})).toMatchObject({ action: "pause" });
  });

  test("clarifies an image OCR result below the confidence threshold", () => {
    expect(
      classifyMessage(incoming("今天上？班", { kind: "image-ocr", confidence: 0.84 }), {}),
    ).toEqual({ action: "clarify", reason: "LOW_CONFIDENCE_CONTENT" });
  });

  test("pauses when a reply would require an unknown real-world fact", () => {
    expect(classifyMessage(incoming("你现在在哪里"), { requiresUserFact: true })).toEqual({
      action: "pause",
      reason: "USER_FACT_REQUIRED",
    });
  });

  test("allows ordinary banter and general knowledge questions", () => {
    expect(classifyMessage(incoming("你怎么又熬夜了哈哈"), {})).toEqual({
      action: "reply",
      reason: "EVERYDAY_CONVERSATION",
    });
    expect(classifyMessage(incoming("千纸鹤最早是哪里的传统呀"), {})).toEqual({
      action: "reply",
      reason: "GENERAL_KNOWLEDGE",
    });
  });

  test("does not mistake the word 性格 for sexual content", () => {
    expect(classifyMessage(incoming("你这个人性格还是老样子"), {})).toMatchObject({
      action: "reply",
    });
  });
});
