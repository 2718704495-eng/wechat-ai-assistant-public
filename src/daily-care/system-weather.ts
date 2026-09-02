import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  DailyCareClothingConcept,
  DailyCareSlot,
  DailyCareTemperatureFacts,
  DailyCareWeatherFacts,
} from "./types.js";

const SOURCE_NAME = "Apple Weather（系统）";
const SOURCE_URL = "weatherkit://nanjing-qixia-government";
const MAX_AGE_MS = 45 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

export const systemWeatherSnapshotSchema = z.object({
  version: z.literal(1),
  locationId: z.literal("nanjing-qixia-government"),
  observedAt: z.string().datetime(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  conditionCode: z.string().min(1).max(64).regex(/^[A-Za-z]+$/u),
  temperatureC: z.number().finite().min(-50).max(60),
  highC: z.number().finite().min(-50).max(60),
  lowC: z.number().finite().min(-50).max(60),
  precipitationChance: z.number().finite().min(0).max(1),
}).strict().superRefine((value, context) => {
  if (value.highC < value.lowC) {
    context.addIssue({ code: "custom", message: "SYSTEM_WEATHER_TEMPERATURE_INVALID" });
  }
});

export type SystemWeatherSnapshot = z.infer<typeof systemWeatherSnapshotSchema>;

const CONDITION_MAP: Readonly<Record<string, string>> = Object.freeze({
  clear: "晴",
  mostlyClear: "晴",
  partlyCloudy: "多云",
  mostlyCloudy: "多云",
  cloudy: "阴",
  foggy: "雾",
  haze: "霾",
  smoky: "霾",
  blowingDust: "浮尘",
  drizzle: "小雨",
  rain: "中雨",
  heavyRain: "大雨",
  isolatedThunderstorms: "雷阵雨",
  scatteredThunderstorms: "雷阵雨",
  strongStorms: "雷阵雨",
  flurries: "小雪",
  sunFlurries: "小雪",
  snow: "中雪",
  heavySnow: "大雪",
  sleet: "雨夹雪",
  freezingDrizzle: "雨夹雪",
  freezingRain: "雨夹雪",
  wintryMix: "雨夹雪",
  blizzard: "暴雪",
});

export async function researchTodayQixiaSystemWeather(input: {
  slot: DailyCareSlot;
  readSnapshot: () => Promise<unknown>;
  now?: () => Date;
}): Promise<DailyCareWeatherFacts> {
  if (input.slot.kind !== "morning") throw new Error("DAILY_CARE_WEATHER_NOT_ALLOWED");
  const now = input.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("DAILY_CARE_WEATHER_TIME_INVALID");
  let snapshot: SystemWeatherSnapshot;
  try {
    snapshot = systemWeatherSnapshotSchema.parse(await input.readSnapshot());
  } catch {
    throw new Error("DAILY_CARE_SYSTEM_WEATHER_INVALID");
  }
  const observedAt = Date.parse(snapshot.observedAt);
  if (snapshot.eventDate !== input.slot.localDate || !Number.isFinite(observedAt) ||
      now.getTime() - observedAt > MAX_AGE_MS || observedAt - now.getTime() > MAX_FUTURE_SKEW_MS) {
    throw new Error("DAILY_CARE_SYSTEM_WEATHER_STALE");
  }
  const condition = CONDITION_MAP[snapshot.conditionCode];
  if (condition === undefined) throw new Error("DAILY_CARE_SYSTEM_WEATHER_CONDITION_INVALID");
  const temperature: DailyCareTemperatureFacts = {
    kind: "range",
    highC: Math.round(snapshot.highC),
    lowC: Math.round(snapshot.lowC),
  };
  if (temperature.highC < temperature.lowC) {
    throw new Error("DAILY_CARE_SYSTEM_WEATHER_TEMPERATURE_INVALID");
  }
  const clothingConcepts = deriveClothingConcepts(condition, temperature);
  const factsWithoutHash = {
    localDate: input.slot.localDate,
    condition,
    temperature,
    rainExpected: /雨|雪/u.test(condition),
    clothingConcepts,
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    checkedAt: snapshot.observedAt,
  } as const;
  return {
    ...factsWithoutHash,
    factHash: createHash("sha256").update(JSON.stringify(factsWithoutHash)).digest("hex"),
  };
}

function deriveClothingConcepts(
  condition: string,
  temperature: DailyCareTemperatureFacts,
): DailyCareClothingConcept[] {
  const concepts: DailyCareClothingConcept[] = [];
  if (temperature.lowC <= 12) concepts.push("warmth");
  if (temperature.kind === "range" && temperature.highC >= 28) concepts.push("breathable");
  if (temperature.kind === "range" && /晴|多云/u.test(condition) && temperature.highC >= 24) {
    concepts.push("sun-protection");
  }
  if (/雨|雪/u.test(condition)) concepts.push("rain-protection");
  return concepts;
}
