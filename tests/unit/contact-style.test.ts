import { describe, expect, it } from "vitest";

import {
  mergeContactStyle,
  type EffectiveContactStyle,
} from "../../src/conversation/contact-style.js";

const globalStyle: Omit<EffectiveContactStyle, "appendSignature"> = {
  salutation: "嗨",
  tone: "natural",
  preferredLength: "medium",
  emojiPolicy: "light",
  bannedTopics: ["隐私"],
};

describe("mergeContactStyle", () => {
  it("applies contact bans above global preferences", () => {
    const style = mergeContactStyle(globalStyle, {
      salutation: null,
      tone: null,
      preferredLength: "short",
      emojiPolicy: null,
      bannedTopics: ["转账"],
    });

    expect(style).toEqual({
      salutation: "嗨",
      tone: "natural",
      preferredLength: "short",
      emojiPolicy: "light",
      bannedTopics: ["隐私", "转账"],
      appendSignature: false,
    });
  });

  it("returns an isolated style snapshot", () => {
    const globalTopics = ["隐私"];
    const contactTopics = ["转账"];
    const style = mergeContactStyle({ ...globalStyle, bannedTopics: globalTopics }, {
      salutation: null,
      tone: null,
      preferredLength: null,
      emojiPolicy: null,
      bannedTopics: contactTopics,
    });
    globalTopics.push("全局后续变更");
    contactTopics.push("联系人后续变更");

    expect(style.bannedTopics).toEqual(["隐私", "转账"]);
    expect(style.appendSignature).toBe(false);
  });
});
