import { describe, expect, it } from "vitest";

import {
  decidePublicResearch,
  decideResearch,
} from "../../src/memory/research-policy.js";

describe("decideResearch", () => {
  it.each([
    ["示例城市示例城区天气", "weather", "示例城市示例城区", "示例城市示例城区 实时天气与短时预报"],
    ["上海明天天气", "weather", "示例城市示例城区", "示例城市示例城区 明天 实时天气与短时预报"],
    ["今天是什么节气", "calendar", null, "今天 日期 星期 节气 节日"],
    ["今天周几", "calendar", null, "今天 日期 星期 节气 节日"],
  ] as const)(
    "builds only fixed-safe weather or calendar research for %s",
    (query, topic, location, externalQuery) => {
      expect(decideResearch({ scenario: "proactive-share", query })).toEqual({
        required: true,
        topic,
        location,
        privacyMode: "sanitized-external",
        externalQuery,
        mayExternalizeRawQuery: false,
      });
    },
  );

  it.each([
    ["小王8月20日出差，明天天气", "weather"],
    ["小王9月21日出差，明天天气", "weather"],
    ["小王8月20日出差，今天周几", "calendar"],
    ["小王9月21日出差，今天周几", "calendar"],
  ] as const)(
    "requires a closed public time slot even without a known private marker: %s",
    (query, topic) => {
      expect(decideResearch({ scenario: "proactive-share", query })).toMatchObject({
        required: true,
        topic,
        location: null,
        externalQuery: null,
        mayExternalizeRawQuery: false,
        needsClarification: true,
        reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
      });
    },
  );

  it.each([
    ["她生日8月20日，明天天气", "weather"],
    ["她生日9月21日，明天天气", "weather"],
    ["她明天去医院，今天天气", "weather"],
    ["她后天去医院，今天天气", "weather"],
    ["她生日8月20日，今天周几", "calendar"],
    ["她生日9月21日，今天周几", "calendar"],
    ["她明天去医院，今天周几", "calendar"],
    ["她后天去医院，今天周几", "calendar"],
  ] as const)(
    "never derives a fixed-safe external time from mixed private text: %s",
    (query, topic) => {
      expect(decideResearch({ scenario: "proactive-share", query })).toEqual({
        required: true,
        topic,
        location: null,
        privacyMode: "mixed-sanitized",
        externalQuery: null,
        mayExternalizeRawQuery: false,
        needsClarification: true,
        reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
      });
    },
  );

  it.each([
    "她之前说喜欢什么游戏",
    "她几点上班",
    "她最近明确说过想吃什么",
    "她住址有更新吗",
    "她的手机号最近换了吗",
    "她工作单位有更新吗",
    "她的手机号最近有更新吗",
    "她的病史最近有更新吗",
    "她的住院记录最近有更新吗",
    "她的过敏记录最近有更新吗",
    "她的康复档案近期有变化吗",
    "她的设备偏好近期有变化吗",
    "她病史最近有更新吗",
    "她的示例游戏账号最近有变更吗",
    "对象健康档案近期有什么变化吗",
    "对象的和平精英账号当前有变化吗",
    "她病史最近更新了没有",
    "她的示例游戏账号最近更新了没有",
    "对象健康档案近期改过没有",
    "对象的和平精英账号当前是谁更新的",
    "她喜欢什么天气",
    "她说过示例城市哪个景点好玩",
    "她喜欢什么游戏",
    "她喜欢什么节日",
    "她说过喜欢哪个节气",
  ])("keeps a stable personal fact local: %s", (query) => {
    expect(decideResearch({ scenario: "ordinary-reply", query })).toEqual({
      required: false,
      topic: null,
      location: null,
      privacyMode: "local-personal-only",
      externalQuery: null,
      mayExternalizeRawQuery: false,
    });
  });

  it.each([
    "她病史最近更新完没有",
    "她的示例游戏账号最近更新完没有",
    "对象健康档案近期整理好没有",
    "对象的和平精英账号当前版本配置好没有",
  ])(
    "keeps a result-complement negative personal question local: %s",
    (query) => {
      expect(decideResearch({ scenario: "ordinary-reply", query })).toEqual({
        required: false,
        topic: null,
        location: null,
        privacyMode: "local-personal-only",
        externalQuery: null,
        mayExternalizeRawQuery: false,
      });
    },
  );

  it.each([
    "她的示例游戏账号最近更新完没有呀",
    "她的示例游戏账号最近更新完没",
  ])(
    "keeps a conversational result-complement personal question local: %s",
    (query) => {
      expect(decideResearch({ scenario: "ordinary-reply", query })).toEqual({
        required: false,
        topic: null,
        location: null,
        privacyMode: "local-personal-only",
        externalQuery: null,
        mayExternalizeRawQuery: false,
      });
    },
  );

  it.each([
    ["示例城市博物院明天开门吗", "place", "示例城市博物院 明天 营业时间"],
    ["明天示例城市博物院开门吗", "place", "示例城市博物院 明天 营业时间"],
    ["示例城市博物院明晚开门吗", "place", "示例城市博物院 明晚 营业时间"],
    ["示例城市总统府8月20日开门吗", "place", "示例城市总统府 8月20日 营业时间"],
    ["8月20日示例城市总统府开放吗", "place", "示例城市总统府 8月20日 营业时间"],
    ["示例游戏最近什么活动", "game", "示例游戏荣耀 最近 活动"],
    ["示例游戏荣耀最近有什么活动", "game", "示例游戏荣耀 最近 活动"],
    ["最近和平精英有什么活动", "game", "和平精英 最近 活动"],
    ["我的世界最近有什么活动", "game", "我的世界 最近 活动"],
    ["示例游戏新赛季什么时候更新", "game", "示例游戏荣耀 赛季更新"],
  ] as const)(
    "resolves an entire strict public query through the closed catalog: %s",
    (query, topic, externalQuery) => {
      const decision = decideResearch({ scenario: "proactive-share", query });

      expect(decision).toEqual({
        required: true,
        topic,
        location: null,
        privacyMode: "sanitized-external",
        externalQuery,
        mayExternalizeRawQuery: false,
      });
      expect(decision.externalQuery).not.toBe(query);
    },
  );

  it.each([
    ["示例联系人在示例城市示例城区示例商圈，示例城市博物院明天开门吗", "place"],
    ["联系人A常去示例医院，示例城市博物院明天开门吗", "place"],
    ["对象周末常去示例景点，示例城市博物院明天开门吗", "place"],
    ["alice @ example.com，示例城市博物院明天开门吗", "place"],
    ["她在示例城市示例城区示例商圈，示例城市博物院明天开门吗", "place"],
    ["她常去示例医院，示例城市博物院明天开门吗", "place"],
    ["她在示例城市示例城区示例商圈示例城市博物院明天开门吗", "place"],
    ["她喜欢示例游戏最近有什么活动", "game"],
    ["她喜欢示例游戏有什么活动", "game"],
    ["示例联系人在示例商圈示例城市博物院开放吗", "place"],
    ["她喜欢示例游戏，最近有什么活动", "game"],
    ["示例城市博物院，明天开门吗", "place"],
    ["明天正常开门吗，示例城市博物院", "place"],
    ["帮我查示例城市博物院明天开门吗", "place"],
  ] as const)(
    "never externalizes mixed, private, multi-clause, or extra text: %s",
    (query, topic) => {
      const decision = decideResearch({ scenario: "proactive-share", query });

      expect(decision).toMatchObject({
        required: true,
        topic,
        externalQuery: null,
        mayExternalizeRawQuery: false,
        needsClarification: true,
        reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
      });
      expect(JSON.stringify(decision)).not.toMatch(
        /示例联系人|联系人A|对象|alice|example|示例商圈|示例医院|示例景点|示例城市博物院|示例游戏/u,
      );
    },
  );

  it.each([
    ["紫金山明天开放吗", "place"],
    ["原神最近有什么活动", "game"],
    ["明天开放吗", "place"],
    ["最近这个游戏有什么活动", "game"],
    ["最近那个手游有什么活动", "game"],
    ["最近它的活动有哪些", "game"],
    ["明天这个景点开门吗", "place"],
    ["明天那家店开门吗", "place"],
    ["最近和平精英都有哪些新活动", "game"],
    ["最近有啥活动，它", "game"],
    ["紫金山今天几点关门", "place"],
    ["那个场馆今晚几点关门", "place"],
    ["和平精英当前有什么新内容", "game"],
    ["和平精英当前有什么新皮肤", "game"],
    ["示例城市博物院现在有什么新安排", "place"],
    ["那个场馆当前有什么新规定", null],
    ["我的世界最新有什么坐骑", "game"],
    ["那个应用现在有什么变化", null],
    ["和平精英当前的新皮肤是什么", "game"],
    ["示例城市博物院现在客流如何", "place"],
    ["那个服务最新状态怎样", null],
    ["那个接口现在能不能用", null],
    ["那个服务现在恢复了没有", null],
    ["和平精英当前的新皮肤是谁设计的", "game"],
    ["那个接口当前上线过没有", null],
    ["那个服务当前是啥团队维护的", null],
  ] as const)(
    "clarifies unknown, vague, or unsupported current query: %s",
    (query, topic) => {
      expect(decideResearch({ scenario: "proactive-share", query })).toMatchObject({
        required: true,
        topic,
        location: null,
        externalQuery: null,
        mayExternalizeRawQuery: false,
        needsClarification: true,
        reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
      });
    },
  );

  it.each([
    ["那个服务现在恢复完没有", null],
    ["那个接口当前部署好没有", null],
  ] as const)(
    "clarifies a current result-complement negative question: %s",
    (query, topic) => {
      expect(decideResearch({ scenario: "proactive-share", query })).toEqual({
        required: true,
        topic,
        location: null,
        privacyMode: "sanitized-external",
        externalQuery: null,
        mayExternalizeRawQuery: false,
        needsClarification: true,
        reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
      });
    },
  );

  it.each([
    ["那个服务现在恢复完没有呀", null],
    ["那个服务现在恢复完没", null],
  ] as const)(
    "clarifies a conversational current result-complement question: %s",
    (query, topic) => {
      expect(decideResearch({ scenario: "proactive-share", query })).toEqual({
        required: true,
        topic,
        location: null,
        privacyMode: "sanitized-external",
        externalQuery: null,
        mayExternalizeRawQuery: false,
        needsClarification: true,
        reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
      });
    },
  );

  it.each([
    "那个服务现在一个备用节点都没有",
    "那个服务现在一个备用节点也没有",
    "那个服务现在一个备用节点都没有呀",
    "那个服务现在一个备用节点也没有呢",
    "那个服务现在一个备用节点也没有呢。",
    "那个服务现在一个备用节点都没有啦！",
    "那个服务现在一个备用节点也没有呀。！",
    "那个服务现在一个备用节点也没有呢！！",
    "那个服务现在一个备用节点都没有啦！。",
    "那个服务现在一个备用节点都没有啊。!",
    "那个服务现在一个备用节点也没有哦！！ ",
  ])(
    "does not promote an existential-negative declaration to a current question: %s",
    (query) => {
      expect(
        decideResearch({
          scenario: "proactive-share",
          query,
        }),
      ).toEqual({
        required: false,
        topic: null,
        location: null,
        privacyMode: "none",
        externalQuery: null,
        mayExternalizeRawQuery: false,
      });
    },
  );

  it.each([
    "那个服务现在一个备用节点都没有吗",
    "那个服务现在一个备用节点也没有？",
    "那个服务现在一个备用节点都没有呀？",
    "那个服务现在一个备用节点都没有吗。",
    "那个服务现在一个备用节点都没有么！",
    "那个服务现在一个备用节点都没有嘛。",
    "那个服务现在一个备用节点都没有吗 ",
    "那个服务现在一个备用节点都没有吗。！",
    "那个服务现在一个备用节点都没有么！！",
    "那个服务现在一个备用节点都没有嘛！。",
    "那个服务现在一个备用节点都没有吗。!   ",
  ])(
    "still clarifies an explicit existential-negative question: %s",
    (query) => {
      expect(
        decideResearch({
          scenario: "proactive-share",
          query,
        }),
      ).toEqual({
        required: true,
        topic: null,
        location: null,
        privacyMode: "sanitized-external",
        externalQuery: null,
        mayExternalizeRawQuery: false,
        needsClarification: true,
        reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
      });
    },
  );

  it("still clarifies an explicit current polar question", () => {
    expect(
      decideResearch({
        scenario: "proactive-share",
        query: "那个服务现在还有备用节点吗",
      }),
    ).toEqual({
      required: true,
      topic: null,
      location: null,
      privacyMode: "sanitized-external",
      externalQuery: null,
      mayExternalizeRawQuery: false,
      needsClarification: true,
      reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
    });
  });

  it.each([
    ["place", "place"],
    ["game", "game"],
  ] as const)("requires clarification for an unstructured explicit %s scenario", (scenario, topic) => {
    expect(decideResearch({ scenario, query: "" })).toMatchObject({
      required: true,
      topic,
      externalQuery: null,
      needsClarification: true,
      reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
    });
  });

  it("keeps explicit weather fixed to 示例城市示例城区", () => {
    expect(decideResearch({ scenario: "weather", query: "" })).toEqual({
      required: true,
      topic: "weather",
      location: "示例城市示例城区",
      privacyMode: "sanitized-external",
      externalQuery: "示例城市示例城区 实时天气与短时预报",
      mayExternalizeRawQuery: false,
    });
  });
});

describe("decidePublicResearch", () => {
  it.each([
    [
      {
        subjectId: "nanjing-museum",
        time: { kind: "relative", value: "tomorrow" },
        action: "place-hours",
      },
      "place",
      "示例城市博物院 明天 营业时间",
    ],
    [
      {
        subjectId: "nanjing-presidential-palace",
        time: { kind: "month-day", month: 8, day: 20 },
        action: "place-hours",
      },
      "place",
      "示例城市总统府 8月20日 营业时间",
    ],
    [
      {
        subjectId: "honor-of-kings",
        time: { kind: "relative", value: "recent" },
        action: "game-events",
      },
      "game",
      "示例游戏荣耀 最近 活动",
    ],
    [
      {
        subjectId: "peace-elite",
        time: { kind: "relative", value: "recent" },
        action: "game-events",
      },
      "game",
      "和平精英 最近 活动",
    ],
    [
      {
        subjectId: "minecraft",
        time: { kind: "relative", value: "recent" },
        action: "game-events",
      },
      "game",
      "我的世界 最近 活动",
    ],
  ] as const)(
    "builds a catalog-owned query from trusted structured input %#",
    (input, topic, externalQuery) => {
      expect(decidePublicResearch(input)).toEqual({
        required: true,
        topic,
        location: null,
        privacyMode: "sanitized-external",
        externalQuery,
        mayExternalizeRawQuery: false,
      });
    },
  );

  it.each([
    {
      subjectId: "unknown-subject",
      time: { kind: "relative", value: "recent" },
      action: "game-events",
    },
    {
      subjectId: "nanjing-museum",
      time: { kind: "relative", value: "recent" },
      action: "game-events",
    },
    {
      subjectId: "nanjing-presidential-palace",
      time: { kind: "month-day", month: 13, day: 40 },
      action: "place-hours",
    },
    {
      subjectId: "peace-elite",
      time: { kind: "relative", value: "someday" },
      action: "game-events",
    },
  ])("rejects malformed or incompatible structured input %#", (input) => {
    expect(decidePublicResearch(input as never)).toMatchObject({
      required: true,
      externalQuery: null,
      mayExternalizeRawQuery: false,
      needsClarification: true,
      reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
    });
  });

  it.each([
    {
      subjectId: "nanjing-museum",
      time: { kind: "relative", value: "today", month: 2, day: 31 },
      action: "place-hours",
    },
    {
      subjectId: "nanjing-museum",
      time: { kind: "month-day", month: 8, day: 20, value: "today" },
      action: "place-hours",
    },
    {
      subjectId: "nanjing-museum",
      time: { kind: "relative", value: "today", label: "today" },
      action: "place-hours",
    },
    {
      subjectId: "nanjing-museum",
      time: { kind: "month-day", month: 8, day: 20, label: "date" },
      action: "place-hours",
    },
    {
      subjectId: "nanjing-museum",
      time: { kind: "relative", value: "today", month: undefined },
      action: "place-hours",
    },
    {
      subjectId: "nanjing-museum",
      time: { kind: "month-day", month: 8, day: 20, value: undefined },
      action: "place-hours",
    },
  ])("rejects contradictory or extra time-union fields %#", (input) => {
    expect(decidePublicResearch(input)).toEqual({
      required: true,
      topic: "place",
      location: null,
      privacyMode: "sanitized-external",
      externalQuery: null,
      mayExternalizeRawQuery: false,
      needsClarification: true,
      reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
    });
  });

  it.each([
    [null, null],
    [undefined, null],
    [[], null],
    [
      {
        subjectId: "nanjing-museum",
        time: null,
        action: "place-hours",
      },
      "place",
    ],
    [
      {
        subjectId: "nanjing-museum",
        time: "tomorrow",
        action: "place-hours",
      },
      "place",
    ],
    [
      {
        subjectId: "nanjing-museum",
        time: { kind: "month-day", month: 2, day: 31 },
        action: "place-hours",
      },
      "place",
    ],
    [
      {
        subjectId: "nanjing-presidential-palace",
        time: { kind: "month-day", month: 4, day: 31 },
        action: "place-hours",
      },
      "place",
    ],
  ] as const)(
    "fails closed for runtime-invalid structured input %#",
    (input, topic) => {
      expect(decidePublicResearch(input as never)).toEqual({
        required: true,
        topic,
        location: null,
        privacyMode: "sanitized-external",
        externalQuery: null,
        mayExternalizeRawQuery: false,
        needsClarification: true,
        reason: "SAFE_EXTERNAL_QUERY_UNAVAILABLE",
      });
    },
  );

  it("accepts February 29 when the structured date has no year", () => {
    expect(
      decidePublicResearch({
        subjectId: "nanjing-museum",
        time: { kind: "month-day", month: 2, day: 29 },
        action: "place-hours",
      }),
    ).toEqual({
      required: true,
      topic: "place",
      location: null,
      privacyMode: "sanitized-external",
      externalQuery: "示例城市博物院 2月29日 营业时间",
      mayExternalizeRawQuery: false,
    });
  });
});
