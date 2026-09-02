import { describe, expect, test } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import {
  buildInitializationReport,
  buildStyleProfile,
} from "../../src/memory/profile-builder.js";

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "text">): ChatMessage {
  return {
    conversationId: "example-contact",
    direction: "incoming",
    kind: "text",
    occurredAt: "2026-08-19T00:00:00.000Z",
    source: "wechat",
    confidence: 0.99,
    ...overrides,
  };
}

describe("buildStyleProfile", () => {
  test("measures outgoing style without retaining complete message text", () => {
    const profile = buildStyleProfile([
      message({ id: "out-1", text: "哈哈好兄弟你咋又熬夜", direction: "outgoing" }),
      message({ id: "out-2", text: "行呗？", direction: "outgoing" }),
      message({ id: "in-1", text: "不算用户口吻", direction: "incoming" }),
      message({ id: "out-3", text: "😂", direction: "outgoing", kind: "emoji" }),
    ]);

    expect(profile).toMatchObject({
      sampleSize: 3,
      questionRatio: 1 / 3,
      emojiRatio: 1 / 3,
      sourceMessageIds: ["out-1", "out-2", "out-3"],
    });
    expect(profile.commonPhrases).toEqual(expect.arrayContaining(["哈哈", "好兄弟", "兄弟", "咋", "呗"]));
    expect(profile.hardOverrides).toEqual({
      bannedSubstrings: ["哈哈", "啊"],
      allowedParticles: ["呀", "啦", "哦"],
    });
    expect(JSON.stringify(profile)).not.toContain("哈哈好兄弟你咋又熬夜");
  });
});

describe("buildInitializationReport", () => {
  test("reports coverage, gaps, OCR confidence, memories and an unverified hypothesis", () => {
    const messages = [
      message({
        id: "gift",
        text: "生日礼物里有千纸鹤",
        occurredAt: "2020-08-19T00:00:00.000Z",
      }),
      message({
        id: "game",
        text: "以前一起打示例游戏",
        direction: "outgoing",
        occurredAt: "2021-08-19T00:00:00.000Z",
      }),
      message({
        id: "shift",
        text: "这个月上夜班",
        occurredAt: "2026-08-19T00:00:00.000Z",
        source: "douyin",
      }),
      message({
        id: "ocr-1",
        text: "图片识别结果",
        kind: "image-ocr",
        confidence: 0.9,
        occurredAt: "2026-08-18T00:00:00.000Z",
      }),
    ];

    const report = buildInitializationReport(messages);

    expect(report.coverage).toEqual({
      startAt: "2020-08-19T00:00:00.000Z",
      endAt: "2026-08-19T00:00:00.000Z",
      totalMessages: 4,
      bySource: { wechat: 3, douyin: 1 },
      byKind: { text: 3, emoji: 0, link: 0, "image-ocr": 1, "voice-transcript": 0 },
    });
    expect(report.missingKinds).toEqual(["emoji", "link", "voice-transcript"]);
    expect(report.ocrConfidence).toEqual({ count: 1, min: 0.9, max: 0.9, average: 0.9 });
    expect(report.sharedMemories).toEqual(
      expect.arrayContaining([
        { summary: "生日礼物与千纸鹤", sourceMessageIds: ["gift"] },
        { summary: "共同游戏经历", sourceMessageIds: ["game"] },
        { summary: "倒班与工作", sourceMessageIds: ["shift"] },
      ]),
    );
    expect(report.relationshipHypotheses).toEqual([
      { statement: "她可能喜欢我", status: "unverified", sourceMessageIds: [] },
    ]);
    expect(report.sourceMessageIds).toEqual(["gift", "game", "shift", "ocr-1"]);
    expect(JSON.stringify(report)).not.toContain("图片识别结果");
  });

  test("returns an explicit empty coverage report instead of inventing dates", () => {
    expect(buildInitializationReport([])).toMatchObject({
      coverage: {
        startAt: null,
        endAt: null,
        totalMessages: 0,
      },
      sourceMessageIds: [],
      sharedMemories: [],
    });
  });
});
