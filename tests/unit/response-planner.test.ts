import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import { assertResponsePlanInvariants } from "../../src/conversation/response-plan.js";
import { planConversationResponse } from "../../src/conversation/response-planner.js";

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

function plan(text: string, recentTexts: string[] = []) {
  return planConversationResponse({
    current: incoming("current", text),
    recentMessages: recentTexts.map((recentText, index) => incoming(`recent-${index}`, recentText)),
    voiceExamples: [],
    interactionRules: [],
  });
}

describe("planConversationResponse", () => {
  it.each([
    "今天心情好烦",
    "遇到个特别离谱的人",
    "上了一天班累死了",
  ])("connects then invites on an open negative turn: %s", (text) => {
    const responsePlan = plan(text);

    expect(responsePlan.orderedActs.map(({ kind }) => kind)).toEqual([
      "colloquial-connect",
      "open-invite",
    ]);
    expect(() => assertResponsePlanInvariants(responsePlan)).not.toThrow();
  });

  it("reflects a concrete negative follow-up before inviting the next part", () => {
    const responsePlan = plan("他把活都丢给我，自己先走了", ["今天遇到个离谱的人"]);

    expect(responsePlan.orderedActs.map(({ kind }) => kind)).toEqual([
      "colloquial-connect",
      "gentle-reflect",
      "open-invite",
    ]);
    expect(() => assertResponsePlanInvariants(responsePlan)).not.toThrow();
  });

  it("places requested advice after the invitation", () => {
    const responsePlan = plan("那我接下来该怎么办", ["这事让我挺烦的"]);

    expect(responsePlan.orderedActs.map(({ kind }) => kind)).toEqual([
      "colloquial-connect",
      "open-invite",
      "advise",
    ]);
    expect(() => assertResponsePlanInvariants(responsePlan)).not.toThrow();
  });

  it.each(["示例城市今天多少度", "这个按钮是干什么的"])(
    "answers a neutral complete question without synthetic comfort: %s",
    (text) => {
      expect(plan(text).orderedActs.map(({ kind }) => kind)).toEqual(["answer"]);
    },
  );

  it.each([
    { recentTexts: [], label: "without prior context" },
    { recentTexts: ["我很难过"], label: "after an unrelated negative" },
  ])(
    "answers the same generic-pronoun question $label with only current evidence",
    ({ recentTexts }) => {
      const responsePlan = plan("这个按钮是干什么的", recentTexts);

      expect(responsePlan.orderedActs).toEqual([
        { kind: "answer", evidenceMessageIds: ["current"] },
      ]);
      expect(responsePlan.evidenceMessageIds).toEqual(["current"]);
    },
  );

  it("keeps inherited act evidence limited to the incoming signal and current turn", () => {
    const current = incoming("current", "这件事我还在想");
    const responsePlan = planConversationResponse({
      current,
      recentMessages: [
        incoming("unrelated", "我下午三点下班"),
        incoming("previous-negative", "我很难过"),
      ],
      voiceExamples: [],
      interactionRules: [],
    });

    expect(responsePlan.evidenceMessageIds).toEqual(["previous-negative", "current"]);
    expect(responsePlan.orderedActs).toEqual([
      {
        kind: "colloquial-connect",
        evidenceMessageIds: ["previous-negative", "current"],
      },
      {
        kind: "open-invite",
        evidenceMessageIds: ["previous-negative", "current"],
      },
    ]);
  });

  it("offers an artifact for an explicit artifact request", () => {
    expect(plan("帮我做个对比").orderedActs.map(({ kind }) => kind)).toEqual([
      "offer-artifact",
    ]);
  });
});
