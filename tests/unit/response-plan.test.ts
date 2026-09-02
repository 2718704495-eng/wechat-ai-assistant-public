import { describe, expect, it } from "vitest";

import {
  assertResponsePlanInvariants,
  responsePlanSchema,
} from "../../src/conversation/response-plan.js";

const base = {
  emotionalState: "negative" as const,
  intensity: "light" as const,
  storyComplete: false,
  orderedActs: [
    { kind: "colloquial-connect" as const, evidenceMessageIds: ["m1"] },
    { kind: "open-invite" as const, evidenceMessageIds: ["m1"] },
  ],
  voiceBlend: { userVoicePriority: "equal" as const, gentlePriority: "equal" as const },
  artifactIntent: null,
  missingInformation: [],
  evidenceMessageIds: ["m1"],
};

describe("ResponsePlan", () => {
  it("accepts a negative plan that connects before inviting", () => {
    expect(responsePlanSchema.parse(base)).toEqual(base);
    expect(() => assertResponsePlanInvariants(base)).not.toThrow();
  });

  it("rejects advice before an open invitation while the story is incomplete", () => {
    expect(() => assertResponsePlanInvariants({
      ...base,
      orderedActs: [
        { kind: "colloquial-connect", evidenceMessageIds: ["m1"] },
        { kind: "advise", evidenceMessageIds: ["m1"] },
        { kind: "open-invite", evidenceMessageIds: ["m1"] },
      ],
    })).toThrow("NEGATIVE_STORY_ADVICE_BEFORE_INVITE");
  });

  it("rejects a negative first act that skips colloquial connection", () => {
    expect(() => assertResponsePlanInvariants({
      ...base,
      orderedActs: [{ kind: "gentle-reflect", evidenceMessageIds: ["m1"] }],
    })).toThrow("NEGATIVE_FIRST_ACT_MUST_CONNECT");
  });

  it("rejects an incomplete negative plan that omits the open invitation", () => {
    expect(() => assertResponsePlanInvariants({
      ...base,
      orderedActs: [
        { kind: "colloquial-connect", evidenceMessageIds: ["m1"] },
      ],
    })).toThrow("NEGATIVE_INCOMPLETE_STORY_REQUIRES_INVITE");
  });
});
