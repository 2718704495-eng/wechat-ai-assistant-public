import { describe, expect, it } from "vitest";

import {
  assertReplyStyle,
  validateReplyStyle,
} from "../../src/memory/style-guard.js";

describe("validateReplyStyle", () => {
  it.each([
    ["哈哈你今天咋样", "BANNED_LAUGHTER"],
    ["行啊", "BANNED_A_PARTICLE"],
    ["怎么不回", "PRESSURE_FOR_REPLY"],
    ["为什么不回", "PRESSURE_FOR_REPLY"],
    ["失踪了吗", "PRESSURE_FOR_REPLY"],
    ["人呢", "PRESSURE_FOR_REPLY"],
    ["咋还不回我", "PRESSURE_FOR_REPLY"],
    ["看到了就回我", "PRESSURE_FOR_REPLY"],
    ["爱回不回", "PASSIVE_AGGRESSION"],
    ["随便你", "PASSIVE_AGGRESSION"],
    ["当我没说", "PASSIVE_AGGRESSION"],
    ["终于舍得回了", "PASSIVE_AGGRESSION"],
    ["不想理我就直说", "PASSIVE_AGGRESSION"],
  ])("rejects %s with %s", (text, reason) => {
    expect(validateReplyStyle(text)).toMatchObject({ ok: false, reasons: [reason] });
  });

  it("reports every hard-rule violation in one candidate", () => {
    expect(validateReplyStyle("哈哈，怎么不回啊？你忙完了吗？")).toEqual({
      ok: false,
      reasons: [
        "BANNED_LAUGHTER",
        "BANNED_A_PARTICLE",
        "PRESSURE_FOR_REPLY",
        "TOO_MANY_QUESTIONS",
      ],
    });
  });

  it("allows approved particles without requiring one", () => {
    expect(validateReplyStyle("辛苦啦，早点休息")).toEqual({ ok: true, reasons: [] });
    expect(validateReplyStyle("辛苦，早点休息")).toEqual({ ok: true, reasons: [] });
  });

  it("treats mixed Chinese and ASCII question marks as one shared limit", () => {
    expect(validateReplyStyle("忙完了？准备休息了吗?")).toMatchObject({
      ok: false,
      reasons: ["TOO_MANY_QUESTIONS"],
    });
  });

  it.each(["哈 哈", `哈\u200b哈`, `哈\u200d哈`])(
    "rejects separated laughter: %s",
    (text) => {
      expect(validateReplyStyle(text)).toMatchObject({
        ok: false,
        reasons: ["BANNED_LAUGHTER"],
      });
    },
  );

  it.each([
    "怎么还没回",
    "怎么还没有回",
    "怎么一直没回",
    "怎么都不回复",
    "怎么到现在还没回",
    "为什么这么久不回复",
    "咋还一直没有回复",
    "怎么到现在都没有给我回消息",
    "为什么这么久一直都不愿意回复",
    "为什么你从昨天晚上到现在一直都没有给我回消息",
    "怎么到现在都没有哪怕抽出一分钟时间给我回消息",
    "你为什么一直都不愿意回复我",
    "你看到了就回我",
    "等你看到了就回我",
    "你看到了，就回我",
    "你怎么一直不搭理我",
    "看到消息记得给我回复",
    "你看到了记得给我回复",
    "你看到后给我回个消息",
    "怎么没回复",
    "不回就算了",
    "不回复就算了",
    "不回复的话就算了",
    "已读不回",
    "你倒是回句话",
  ])("rejects reply pressure variant: %s", (text) => {
    expect(validateReplyStyle(text).ok).toBe(false);
  });

  it.each([
    "麻烦你赶紧回我",
    "请你记得给我回复",
    "有空的话你记得给我回个消息",
    "忙完以后你记得给我回复",
    "麻烦你看到消息后给我回复",
  ])("rejects a recipient command after a polite or time prefix: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({
      ok: false,
      reasons: ["PRESSURE_FOR_REPLY"],
    });
  });

  it.each([
    "明天记得给我回复",
    "麻烦你赶紧回我哦",
    "会议结束以后记得给我回个消息呀",
  ])("rejects a recipient command despite open modifiers: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({
      ok: false,
      reasons: ["PRESSURE_FOR_REPLY"],
    });
  });

  it.each([
    "有时间记得给我回复",
    "临时有空记得给我回个消息",
    "有时候记得给我回复哦",
    "有时间慢慢给我回复",
    "明天早早给我回复",
  ])("rejects a recipient command without splitting ordinary words: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({
      ok: false,
      reasons: ["PRESSURE_FOR_REPLY"],
    });
  });

  it.each([
    "会议结束以后尽快给我回复",
    "培训结束之后尽早给我回个消息哦",
    "周会结束尽快给我回复",
    "工作处理完成尽早给我回个消息",
  ])(
    "keeps a post-adjunct command adverb under the reply-pressure gate: %s",
    (text) => {
      expect(validateReplyStyle(text)).toEqual({
        ok: false,
        reasons: ["PRESSURE_FOR_REPLY"],
      });
    },
  );

  it.each([
    "会议结束以后千万记得给我回复",
    "开完会以后一定记得给我回复",
    "工作结束请给我回复",
    "如果方便请给我回复",
  ])(
    "rejects a default-recipient command without promoting its modifier to a subject: %s",
    (text) => {
      expect(validateReplyStyle(text)).toEqual({
        ok: false,
        reasons: ["PRESSURE_FOR_REPLY"],
      });
    },
  );

  it.each([
    "下班后研发负责人记得给我回复",
    "午休结束后设计负责人说会给我回个消息哦",
  ])("fails closed for an open third-party reply target: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({
      ok: false,
      reasons: ["PRESSURE_FOR_REPLY"],
    });
  });

  it.each([
    "项目主管刚刚给我回复",
    "客服负责人匆匆给我回个消息",
    "值班经理已经给我回复",
  ])("fails closed for a completed third-party reply target: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({
      ok: false,
      reasons: ["PRESSURE_FOR_REPLY"],
    });
  });

  it.each([
    "项目主管刚给我回复",
    "技术主管才给我回个消息",
    "会议结束以后项目主管刚给我回复",
    "市场主管又给我回复",
    "项目主管刚才给我回复",
  ])(
    "fails closed for a positional third-party reply target: %s",
    (text) => {
      expect(validateReplyStyle(text)).toEqual({
        ok: false,
        reasons: ["PRESSURE_FOR_REPLY"],
      });
    },
  );

  it.each([
    "看到消息后小王记得给我回复了",
    "看见消息后项目经理记得给我回个消息了",
    "忙完以后值班组长记得给我回复了",
    "麻烦看到消息后新同事说会给我回复",
  ])("fails closed for a suffixed third-party reply target: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({
      ok: false,
      reasons: ["PRESSURE_FOR_REPLY"],
    });
  });

  it.each(["老板刚回我消息了", "等我回我家"])(
    "fails closed for an ambiguous 回我 target: %s",
    (text) => {
      expect(validateReplyStyle(text)).toEqual({
        ok: false,
        reasons: ["PRESSURE_FOR_REPLY"],
      });
    },
  );

  it.each([
    "会议结束以后务必要记得给我回复",
    "工作处理完成才给我回复",
    "为什么他没有回复我",
  ])("rejects a reply-to-speaker target under any open prefix: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({
      ok: false,
      reasons: ["PRESSURE_FOR_REPLY"],
    });
  });

  it.each([
    "我刚收到项目主管的回复",
    "项目主管刚发来消息",
    "研发负责人已经回复了",
  ])("allows an unambiguous third-party rewrite: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({ ok: true, reasons: [] });
  });

  it("does not combine pressure fragments across sentence boundaries", () => {
    expect(validateReplyStyle("为什么这么久。老板没回复客户消息")).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it.each([
    "看到了。老板刚发来消息了",
    "看到了；老板刚发来消息了",
    "看到了\n老板刚发来消息了",
    "看见了！老板刚发来消息了",
    "算了。今天不用回公司",
    "看到了.老板刚发来消息了",
    "看到了\r老板刚发来消息了",
    "不想理我.他就直说了",
    "算了.今天不用回公司",
    "为什么这样，老板没有让我回复客户",
    "不想理我，但他就直说了",
    "算了，今天不用回公司",
    "我看到了，老板刚发来的消息",
    "看到了:老板刚发来消息了",
  ])("keeps compound pressure matching sentence-local: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    "为什么老板没有让我回复客户",
    "我看到了老板刚发来的消息",
    "为什么他没有回复你",
    "老板为什么没有让我回复客户",
    "为什么最近老板没有让我回复客户",
    "你知道为什么老板没有让我回复客户",
    "妈妈为啥还不回复你",
    "小王已读不回她",
    "客户催小王赶紧回消息",
    "小王失踪了吗",
    "妈妈人呢",
  ])("allows third-party reply narratives: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    "小王为什么没有回复我",
    "妈妈为什么没有回复我",
    "小王怎么还不回我",
  ])("fails closed for a third-party reply-to-speaker target: %s", (text) => {
    expect(validateReplyStyle(text)).toEqual({
      ok: false,
      reasons: ["PRESSURE_FOR_REPLY"],
    });
  });
});

describe("assertReplyStyle", () => {
  it("prevents a rejected candidate from proceeding", () => {
    expect(() => assertReplyStyle("怎么不回")).toThrowError(
      "STYLE_GUARD_REJECTED:PRESSURE_FOR_REPLY",
    );
  });

  it("returns normally for an accepted candidate", () => {
    expect(() => assertReplyStyle("早点休息哦")).not.toThrow();
  });
});
