import { describe, expect, it } from "vitest";

import {
  bigramDiceSimilarity,
  normalizeBroadcastText,
  validateBroadcastCandidate,
} from "../../src/daily-care/message-policy.js";
import type { DailyCareWeatherFacts } from "../../src/daily-care/types.js";

const weather: DailyCareWeatherFacts = {
  localDate: "2026-08-23",
  condition: "多云",
  temperature: { kind: "range", highC: 32, lowC: 25 },
  rainExpected: false,
  clothingConcepts: ["breathable", "sun-protection"],
  sourceName: "中国天气网（七日）",
  sourceUrl: "https://www.weather.com.cn/weather/101190112.shtml",
  checkedAt: "2026-08-22T22:01:00.000Z",
  factHash: "f".repeat(64),
};

const validMorning =
  "今天多云，最高32℃，最低25℃。上班通勤记得穿透气些，出门也做好防晒。忙起来别忘了喝水和按时吃饭，累了就稍微歇一会儿，照顾好身体呀。🌤️💛\n——示例用户";
const validNight =
  "想认真和你说声晚安。无论今天过得怎样，都希望这会儿的你能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙\n——示例用户";
const validFallbackMorning =
  "早上好，上班路上别太赶，忙起来也记得按时吃饭、喝点温水，给自己留一点喘口气的时间，好好照顾身体，愿今天从容顺利，也记得对自己温柔一点。☀️💛\n——示例用户";
const lowOnlyWeather: DailyCareWeatherFacts = {
  ...weather,
  condition: "小雨",
  temperature: { kind: "low-only", lowC: 7 },
  rainExpected: true,
  clothingConcepts: ["warmth", "rain-protection"],
};
const validLowOnlyMorning =
  "今天小雨，最低7℃。上班路上注意保暖，也别忘了带伞，忙起来记得喝水和按时吃饭，累了就稍微歇一会儿，好好照顾身体，愿今天顺顺利利。🌧️💛\n——示例用户";

describe("daily-care message policy", () => {
  it("accepts a fact-bound morning message without exposing the location", () => {
    const result = validateBroadcastCandidate({
      kind: "morning",
      text: validMorning,
      weather,
      recentVerifiedTexts: [],
    });
    expect(result.text).toBe(validMorning);
    expect(result.normalizedHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts a low-only morning without inventing a high temperature", () => {
    expect(validateBroadcastCandidate({
      kind: "morning",
      text: validLowOnlyMorning,
      weather: lowOnlyWeather,
      recentVerifiedTexts: [],
    }).normalizedHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["highest label", validLowOnlyMorning.replace("最低7℃", "最高7℃")],
    ["extra temperature", validLowOnlyMorning.replace("最低7℃", "最低7℃、12℃")],
    ["bare temperature", validLowOnlyMorning.replace("最低7℃", "7℃")],
    ["high-derived advice", validLowOnlyMorning.replace("注意保暖", "注意保暖，也穿得轻薄")],
    ["wrong condition", validLowOnlyMorning.replace("小雨", "多云")],
  ])("rejects low-only copy with %s", (_name, text) => {
    expect(() => validateBroadcastCandidate({
      kind: "morning",
      text,
      weather: lowOnlyWeather,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_WEATHER_FACT_MISMATCH");
  });

  it("still forbids location disclosure in low-only copy", () => {
    expect(() => validateBroadcastCandidate({
      kind: "morning",
      text: validLowOnlyMorning.replace("今天小雨", "今天示例城区小雨"),
      weather: lowOnlyWeather,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_LOCATION_DISCLOSURE_FORBIDDEN");
  });

  it("accepts a longer weather-free night message", () => {
    expect(validateBroadcastCandidate({
      kind: "night",
      text: validNight,
      weather: null,
      recentVerifiedTexts: [],
    }).normalizedHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts a weather-free morning fallback when verified facts are unavailable", () => {
    expect(validateBroadcastCandidate({
      kind: "morning",
      text: validFallbackMorning,
      weather: null,
      recentVerifiedTexts: [],
    }).normalizedHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(["今天适合穿外套", "今天适合穿轻薄短袖", "出门记得带雨具"])(
    "rejects a specific clothing or rain assertion from weather-free fallback: %s",
    (claim) => {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: validFallbackMorning.replace("上班路上", `${claim}，上班路上`),
        weather: null,
        recentVerifiedTexts: [],
      })).toThrow("BROADCAST_FALLBACK_WEATHER_FORBIDDEN");
    },
  );

  it.each(["今天天气很好，", "今天最高28℃，", "今天可能下雨，", "今天风力不大，"])(
    "rejects an unverified weather claim from the fallback: %s",
    (claim) => {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: validFallbackMorning.replace("早上好，", `早上好，${claim}`),
        weather: null,
        recentVerifiedTexts: [],
      })).toThrow("BROADCAST_FALLBACK_WEATHER_FORBIDDEN");
    },
  );

  it.each(["示例城市", "示例城区", "西霞区"])("never discloses the internal location: %s", (place) => {
    expect(() => validateBroadcastCandidate({
      kind: "morning",
      text: validMorning.replace("今天多云", `今天${place}多云`),
      weather,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_LOCATION_DISCLOSURE_FORBIDDEN");
  });

  it("rejects a morning message that changes a verified weather fact", () => {
    expect(() => validateBroadcastCandidate({
      kind: "morning",
      text: validMorning.replace("32℃", "35℃"),
      weather,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_WEATHER_FACT_MISMATCH");
  });

  it("requires rain protection when rain is expected", () => {
    expect(() => validateBroadcastCandidate({
      kind: "morning",
      text: validMorning.replace("多云", "小雨"),
      weather: {
        ...weather,
        condition: "小雨",
        rainExpected: true,
        clothingConcepts: ["breathable", "rain-protection"],
      },
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_CLOTHING_GUIDANCE_MISSING");
  });

  it("forbids weather content and weather facts at night", () => {
    expect(() => validateBroadcastCandidate({
      kind: "night",
      text: validNight,
      weather,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_NIGHT_WEATHER_FORBIDDEN");
    expect(() => validateBroadcastCandidate({
      kind: "night",
      text: validNight.replace("无论今天过得怎样", "今晚天气很好，无论今天过得怎样"),
      weather: null,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_NIGHT_WEATHER_FORBIDDEN");
  });

  it.each(["今晚多云，", "今晚气温舒服，", "今晚不会降雨，"])(
    "rejects every night weather assertion: %s",
    (weatherClaim) => {
      expect(() => validateBroadcastCandidate({
        kind: "night",
        text: validNight.replace("无论今天过得怎样", `${weatherClaim}无论今天过得怎样`),
        weather: null,
        recentVerifiedTexts: [],
      })).toThrow("BROADCAST_NIGHT_WEATHER_FORBIDDEN");
    },
  );

  it.each([
    "另外最低18℃，",
    "另外最高35℃，",
    "而且今天会下雨，",
  ])("rejects an extra morning weather claim that conflicts with verified facts: %s", (claim) => {
    expect(() => validateBroadcastCandidate({
      kind: "morning",
      text: validMorning.replace("上班通勤", `${claim}上班通勤`),
      weather,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_WEATHER_FACT_MISMATCH");
  });

  it.each([
    validMorning.replace("\n——示例用户", " ——示例用户"),
    validMorning.replace("——示例用户", "——别的助手"),
    `${validMorning}\n多余内容`,
  ])("requires the exact signature on its own final line", (text) => {
    expect(() => validateBroadcastCandidate({
      kind: "morning",
      text,
      weather,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_SIGNATURE_INVALID");
  });

  it.each([
    validMorning.replace("🌤️💛", ""),
    validMorning.replace("🌤️💛", "🌤️💛✨"),
    validMorning.replace("🌤️💛", "❤️"),
  ])("allows exactly one or two lightweight allowlisted emojis", (text) => {
    expect(() => validateBroadcastCandidate({
      kind: "morning",
      text,
      weather,
      recentVerifiedTexts: [],
    })).toThrow("BROADCAST_EMOJI_INVALID");
  });

  it.each(["https://example.com", "source=网页", "reason=天气", "token=abc", "<marker>"])(
    "rejects transport or research metadata: %s",
    (fragment) => {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: validMorning.replace("照顾好身体呀", `照顾好身体呀${fragment}`),
        weather,
        recentVerifiedTexts: [],
      })).toThrow("BROADCAST_METADATA_FORBIDDEN");
    },
  );

  it.each(["我知道你今天加班了", "你要立刻回复我", "我会永远陪着你"])(
    "rejects invented facts, pressure, or relationship promises: %s",
    (claim) => {
      expect(() => validateBroadcastCandidate({
        kind: "night",
        text: validNight.replace("想认真和你说声晚安", claim),
        weather: null,
        recentVerifiedTexts: [],
      })).toThrow("BROADCAST_UNSUPPORTED_CLAIM");
    },
  );

  it("rejects an exact or near-duplicate of recent verified text", () => {
    expect(() => validateBroadcastCandidate({
      kind: "night",
      text: validNight,
      weather: null,
      recentVerifiedTexts: [validNight],
    })).toThrow("BROADCAST_TEXT_TOO_SIMILAR");
    expect(bigramDiceSimilarity(validNight, validNight.replace("安心休息", "好好休息")))
      .toBeGreaterThan(0.78);
  });

  it("normalizes punctuation, whitespace, signature, and allowed emoji before comparison", () => {
    expect(normalizeBroadcastText("晚安，早点休息。🌙\n——示例用户")).toBe("晚安早点休息");
  });
});
