import { createHash } from "node:crypto";

import type {
  DailyCareClothingConcept,
  DailyCareSlot,
  DailyCareTemperatureFacts,
  DailyCareWeatherFacts,
} from "./types.js";
import type { LiveResearchBroker } from "../mcp/live-research-broker.js";
import type {
  OfficialResearchExecutor,
  VerifiedResearchEvidence,
} from "../mcp/official-research-executor.js";

const ACTUAL_SOURCE_NAME = "中国天气网（七日）";
const SOURCE_URL = "https://www.weather.com.cn/weather/101190112.shtml";
const SOURCE_TITLES = new Set([
  "示例城区天气预报,示例城区7天天气预报",
  "示例城区天气预报,示例城区7天天气预报,示例城区15天天气预报,示例城区天气查询",
]);
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const WEATHER_CONDITIONS = new Set([
  "晴", "多云", "阴", "小雨", "中雨", "大雨", "暴雨", "大暴雨", "特大暴雨",
  "阵雨", "雷阵雨", "小雪", "中雪", "大雪", "暴雪", "雨夹雪", "雾", "霾",
  "浮尘", "扬沙", "沙尘暴",
]);
const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export async function researchTodayQixiaWeather(input: {
  broker: LiveResearchBroker;
  executor: OfficialResearchExecutor;
  slot: DailyCareSlot;
  now?: () => Date;
}): Promise<DailyCareWeatherFacts> {
  if (input.slot.kind !== "morning") {
    throw new Error("DAILY_CARE_WEATHER_NOT_ALLOWED");
  }
  const now = input.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("DAILY_CARE_WEATHER_TIME_INVALID");
  }
  const slotDate = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input.slot.localDate);
  if (slotDate?.[2] === undefined || slotDate[3] === undefined) {
    throw new Error("DAILY_CARE_WEATHER_TIME_INVALID");
  }
  const decision = input.broker.authorizeLatestTrigger({
    triggerIdHash: sha256(`daily-care-weather-v1\0${input.slot.slotKey}`),
    messageText: `示例城市示例城区${String(Number(slotDate[2]))}月${String(Number(slotDate[3]))}日天气`,
  });
  if (decision.status !== "AUTHORIZED") {
    throw new Error("DAILY_CARE_WEATHER_UNVERIFIED");
  }
  let result;
  try {
    result = await input.executor.execute(decision.capability);
  } catch {
    throw new Error("DAILY_CARE_WEATHER_UNVERIFIED");
  }
  if (result.status !== "VERIFIED" || result.evidence.length !== 1) {
    throw new Error("DAILY_CARE_WEATHER_EVIDENCE_INVALID");
  }
  const checkedAt = Date.parse(result.checkedAt);
  if (!Number.isFinite(checkedAt) || now.getTime() - checkedAt > MAX_AGE_MS ||
      checkedAt - now.getTime() > MAX_FUTURE_SKEW_MS) {
    throw new Error("DAILY_CARE_WEATHER_STALE");
  }
  const parsed = parseEvidence(result.evidence[0] as VerifiedResearchEvidence, input.slot.localDate);
  const clothingConcepts = deriveClothingConcepts(parsed.condition, parsed.temperature);
  const factsWithoutHash = {
    localDate: input.slot.localDate,
    condition: parsed.condition,
    temperature: parsed.temperature,
    rainExpected: /雨|雪/u.test(parsed.condition),
    clothingConcepts,
    sourceName: ACTUAL_SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    checkedAt: result.checkedAt,
  } as const;
  return {
    ...factsWithoutHash,
    factHash: sha256(JSON.stringify(factsWithoutHash)),
  };
}

function parseEvidence(
  evidence: VerifiedResearchEvidence,
  expectedLocalDate: string,
): { condition: string; temperature: DailyCareTemperatureFacts } {
  if (evidence.sourceName !== ACTUAL_SOURCE_NAME ||
      evidence.url !== SOURCE_URL || !SOURCE_TITLES.has(evidence.title) || evidence.eventDate === null) {
    throw new Error("DAILY_CARE_WEATHER_EVIDENCE_INVALID");
  }
  const eventDate = new Date(evidence.eventDate);
  if (!Number.isFinite(eventDate.getTime()) || SHANGHAI_DATE.format(eventDate) !== expectedLocalDate) {
    throw new Error("DAILY_CARE_WEATHER_DATE_MISMATCH");
  }
  const headingPattern = "(\\d{1,2})日(?:（(?:今天|明天|后天|周[一二三四五六日天])）|\\((?:今天|明天|后天|周[一二三四五六日天])\\))";
  const rangeMatch = new RegExp(
    `^${headingPattern}：([^，]{1,8})，(-?\\d{1,2})℃\\/(-?\\d{1,2})℃$`,
    "u",
  ).exec(evidence.snippet);
  const lowOnlyMatch = new RegExp(
    `^${headingPattern}：([^，]{1,8})，最低(-?\\d{1,2})℃$`,
    "u",
  ).exec(evidence.snippet);
  if ((rangeMatch === null) === (lowOnlyMatch === null)) {
    throw new Error("DAILY_CARE_WEATHER_EVIDENCE_INVALID");
  }
  const match = rangeMatch ?? lowOnlyMatch;
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error("DAILY_CARE_WEATHER_EVIDENCE_INVALID");
  }
  const condition = match[2];
  const highC = rangeMatch === null ? null : Number(rangeMatch[3]);
  const lowDigits = rangeMatch === null ? lowOnlyMatch?.[3] : rangeMatch[4];
  const lowC = Number(lowDigits);
  const expectedDay = Number(expectedLocalDate.slice(8, 10));
  if (Number(match[1]) !== expectedDay || !WEATHER_CONDITIONS.has(condition) ||
      !Number.isInteger(lowC) || lowC < -50 || lowC > 60 ||
      (highC !== null &&
        (!Number.isInteger(highC) || highC < lowC || highC > 60))) {
    throw new Error("DAILY_CARE_WEATHER_EVIDENCE_INVALID");
  }
  const temperature: DailyCareTemperatureFacts = highC === null
    ? { kind: "low-only", lowC }
    : { kind: "range", highC, lowC };
  return { condition, temperature };
}

function deriveClothingConcepts(
  condition: string,
  temperature: DailyCareTemperatureFacts,
): DailyCareClothingConcept[] {
  const concepts: DailyCareClothingConcept[] = [];
  if (temperature.lowC <= 12) concepts.push("warmth");
  if (temperature.kind === "range" && temperature.highC >= 28) {
    concepts.push("breathable");
  }
  if (temperature.kind === "range" && /晴|多云/u.test(condition) &&
      temperature.highC >= 24) {
    concepts.push("sun-protection");
  }
  if (/雨|雪/u.test(condition)) concepts.push("rain-protection");
  return concepts;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
