import { describe, expect, it } from "vitest";

import {
  LiveResearchBroker,
  type ResearchCapability,
} from "../../src/mcp/live-research-broker.js";

describe("LiveResearchBroker", () => {
  it.each([
    ["示例城市示例城区明天天气", "weather"],
    ["示例城市博物院明天开门吗", "place"],
    ["示例游戏荣耀本周有什么活动", "game"],
  ] as const)(
    "authorizes only a normalized public %s intent",
    (messageText, topic) => {
      const broker = new LiveResearchBroker({ now: () => 1_777_777_777_000 });

      const result = broker.authorizeLatestTrigger({
        triggerIdHash: "a".repeat(64),
        messageText,
      });

      expect(result.status).toBe("AUTHORIZED");
      if (result.status !== "AUTHORIZED") throw new Error("expected capability");

      const intent = broker.redeemForExecutor(result.capability);
      expect(intent).toMatchObject({ topic, triggerIdHash: "a".repeat(64) });
      expect(intent?.normalizedQuery.length).toBeGreaterThan(0);
    },
  );

  it.each([
    "她住在PRIVATE_OWNER_CANARY，示例城市博物院明天开门吗",
    "她最近需要去医院，帮我查怎么治疗",
    "帮她判断这个合同是否合法",
    "帮我看看这只股票现在能买吗",
    "帮她预约示例城市博物院",
    "帮我买示例城市博物院的票",
    "她的手机号最近换了吗",
  ])("refuses unsafe or mixed-private text without minting a capability: %s", (messageText) => {
    const broker = new LiveResearchBroker();

    const result = broker.authorizeLatestTrigger({
      triggerIdHash: "b".repeat(64),
      messageText,
    });

    expect(result).toEqual({ status: "NO_SAFE_RESEARCH_RESULT" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OWNER_CANARY");
  });

  it("rejects a weather location mismatch instead of silently rewriting it to Nanjing", () => {
    const broker = new LiveResearchBroker();

    const result = broker.authorizeLatestTrigger({
      triggerIdHash: "9".repeat(64),
      messageText: "上海明天天气",
    });

    expect(result).toEqual({ status: "NO_SAFE_RESEARCH_RESULT" });
  });

  it("rejects malformed internal trigger envelopes without evaluating extra text", () => {
    const broker = new LiveResearchBroker();
    const malformed = {
      triggerIdHash: "c".repeat(64),
      messageText: "示例城市示例城区明天天气",
      query: "PRIVATE_EXTRA_CANARY",
    };

    const result = broker.authorizeLatestTrigger(malformed);

    expect(result).toEqual({ status: "NO_SAFE_RESEARCH_RESULT" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_EXTRA_CANARY");
  });

  it("keeps the capability and normalized query out of serialization", () => {
    const broker = new LiveResearchBroker();
    const result = broker.authorizeLatestTrigger({
      triggerIdHash: "d".repeat(64),
      messageText: "示例城市博物院明天开门吗",
    });

    expect(result.status).toBe("AUTHORIZED");
    if (result.status !== "AUTHORIZED") throw new Error("expected capability");

    const serialized = JSON.stringify(result);
    expect(serialized).toBe('{"status":"AUTHORIZED","capability":{}}');
    expect(serialized).not.toContain("示例城市博物院");
  });

  it("expires capabilities after two minutes and consumes them at most once", () => {
    let now = 1_777_777_777_000;
    const broker = new LiveResearchBroker({ now: () => now });
    const first = broker.authorizeLatestTrigger({
      triggerIdHash: "e".repeat(64),
      messageText: "示例城市示例城区明天天气",
    });
    const second = broker.authorizeLatestTrigger({
      triggerIdHash: "f".repeat(64),
      messageText: "示例城市博物院明天开门吗",
    });
    expect(first.status).toBe("AUTHORIZED");
    expect(second.status).toBe("AUTHORIZED");
    if (first.status !== "AUTHORIZED" || second.status !== "AUTHORIZED") {
      throw new Error("expected capabilities");
    }

    expect(broker.redeemForExecutor(first.capability)?.topic).toBe("weather");
    expect(broker.redeemForExecutor(first.capability)).toBeNull();

    now += 120_000;
    expect(broker.redeemForExecutor(second.capability)).toBeNull();
  });

  it("rejects forged capability objects", () => {
    const broker = new LiveResearchBroker();

    expect(broker.redeemForExecutor({} as ResearchCapability)).toBeNull();
  });
});
