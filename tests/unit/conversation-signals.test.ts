import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import { analyzeConversationSignals } from "../../src/conversation/conversation-signals.js";

function incoming(id: string, text: string): ChatMessage {
  return {
    id,
    conversationId: "example-contact",
    direction: "incoming",
    kind: "text",
    text,
    occurredAt: "2026-08-20T09:00:00.000Z",
    source: "wechat",
    confidence: 0.99,
  };
}

describe("analyzeConversationSignals", () => {
  it.each([
    "今天整个人好烦",
    "上了一天班累死了",
    "这事真的挺委屈的",
    "碰到一个很离谱的人",
    "我累了",
    "我烦死了",
    "我很难过",
  ])("recognizes an open negative variant: %s", (text) => {
    expect(analyzeConversationSignals(incoming("m1", text), [])).toMatchObject({
      emotionalState: "negative",
      storyComplete: false,
      adviceRequested: false,
    });
  });

  it.each([
    "示例城市今天二十六度",
    "我下午三点下班",
    "千纸鹤最早从哪来的",
  ])("does not force comfort onto a neutral fact or question: %s", (text) => {
    expect(analyzeConversationSignals(incoming("m1", text), []).emotionalState).not.toBe("negative");
  });

  it.each([
    ["累计", "neutral"],
    ["烦请", "neutral"],
    ["累计销量多少？", "uncertain"],
    ["烦请告诉我结果", "neutral"],
  ] as const)("does not treat a token collision as negative emotion: %s", (text, emotionalState) => {
    expect(analyzeConversationSignals(incoming("m1", text), [])).toMatchObject({ emotionalState });
  });

  it.each([
    { recent: [] },
    { recent: [incoming("m0", "今天整个人好烦")] },
  ])("does not inherit unrelated negative context into the same neutral current turn", ({ recent }) => {
    expect(analyzeConversationSignals(incoming("m1", "我想吃面"), recent)).toMatchObject({
      emotionalState: "neutral",
    });
  });

  it("does not inherit a negative outgoing message even when the current turn refers back", () => {
    expect(analyzeConversationSignals(
      incoming("m2", "这件事我还在想"),
      [{ ...incoming("m1", "今天整个人好烦"), direction: "outgoing" }],
    )).toMatchObject({ emotionalState: "neutral" });
  });

  it.each([
    { recent: [], label: "without prior context" },
    { recent: [incoming("previous-negative", "我很难过")], label: "after an unrelated negative" },
  ])(
    "keeps the same generic-pronoun question neutral $label",
    ({ recent }) => {
      expect(analyzeConversationSignals(
        incoming("current", "这个按钮是干什么的"),
        recent,
      )).toMatchObject({
        emotionalState: "neutral",
        evidenceMessageIds: ["current"],
      });
    },
  );

  it("inherits an incoming negative only through an explicit discourse continuation", () => {
    expect(analyzeConversationSignals(
      incoming("current", "这件事我还在想"),
      [incoming("previous-negative", "我很难过")],
    )).toMatchObject({
      emotionalState: "negative",
      storyComplete: false,
      evidenceMessageIds: ["previous-negative", "current"],
    });
  });

  it("excludes unrelated recent messages from inherited emotional evidence", () => {
    expect(analyzeConversationSignals(
      incoming("current", "这件事我还在想"),
      [
        incoming("unrelated", "我下午三点下班"),
        incoming("previous-negative", "我很难过"),
      ],
    ).evidenceMessageIds).toEqual(["previous-negative", "current"]);
  });

  it("uses only the current id when the current message supplies the negative signal", () => {
    expect(analyzeConversationSignals(
      incoming("current", "我很难过"),
      [incoming("unrelated", "我下午三点下班")],
    ).evidenceMessageIds).toEqual(["current"]);
  });

  it("uses the recent turn to mark a described event as complete", () => {
    const recent = [incoming("m1", "今天碰到个离谱的人")];

    expect(analyzeConversationSignals(
      incoming("m2", "他把所有人的工都推给我，自己先走了"),
      recent,
    )).toMatchObject({
      emotionalState: "negative",
      storyComplete: true,
      evidenceMessageIds: ["m1", "m2"],
    });
  });

  it.each([
    ["因为我还在等对方回复，所以不知道怎么继续，心里一直没底。", false],
    ["然后事情已经解决了。", false],
    ["事情已经解决了。", true],
  ] as const)("distinguishes incomplete continuation from a terminal event: %s", (text, storyComplete) => {
    expect(analyzeConversationSignals(incoming("m1", text), []).storyComplete).toBe(storyComplete);
  });

  it.each([
    "你觉得我现在该怎么办",
    "那我接下来怎么处理比较好",
  ])("recognizes an explicit advice request: %s", (text) => {
    expect(analyzeConversationSignals(
      incoming("m2", text),
      [incoming("m1", "这事挺烦的")],
    )).toMatchObject({ adviceRequested: true });
  });

  it("keeps an explanatory how-to question out of the advice branch", () => {
    expect(analyzeConversationSignals(incoming("m1", "这个流程怎么处理"), [])).toMatchObject({
      adviceRequested: false,
      directQuestion: true,
    });
  });

  it("marks a direct question without treating it as an advice request", () => {
    expect(analyzeConversationSignals(incoming("m1", "这个大概多少钱？"), [])).toMatchObject({
      emotionalState: "uncertain",
      directQuestion: true,
      adviceRequested: false,
    });
  });

  it("recognizes a direct question without a question mark", () => {
    expect(analyzeConversationSignals(incoming("m1", "这件事该怎么做"), [])).toMatchObject({
      directQuestion: true,
    });
  });

  it.each([
    ["帮我整理三天旅行攻略", { kind: "travel-guide", trigger: "explicit" }],
    ["我想去玩三天", { kind: "travel-guide", trigger: "implicit" }],
  ] as const)("infers an artifact intent from a structural request: %s", (text, artifactIntent) => {
    expect(analyzeConversationSignals(incoming("m1", text), []).artifactIntent).toEqual(artifactIntent);
  });

  it.each([
    "这份文件坏了",
    "我玩游戏三天了",
  ])("does not infer an artifact from a non-request mention: %s", (text) => {
    expect(analyzeConversationSignals(incoming("m1", text), []).artifactIntent).toBeNull();
  });

  it.each([
    ["帮我做个对比", { kind: "comparison", trigger: "explicit" }],
    ["请给我列个清单", { kind: "checklist", trigger: "explicit" }],
  ] as const)("maps an explicit requested artifact to its reachable kind: %s", (text, artifactIntent) => {
    expect(analyzeConversationSignals(incoming("m1", text), []).artifactIntent).toEqual(artifactIntent);
  });
});
