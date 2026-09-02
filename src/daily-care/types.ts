export type DailyCareKind = "morning" | "night";

export interface DailyCareSlot {
  slotKey: string;
  localDate: string;
  kind: DailyCareKind;
  targetMode: "production" | "test";
}

export type DailyCareClothingConcept =
  | "warmth"
  | "breathable"
  | "sun-protection"
  | "rain-protection";

export type DailyCareTemperatureFacts =
  | { readonly kind: "range"; readonly highC: number; readonly lowC: number }
  | { readonly kind: "low-only"; readonly lowC: number };

interface DailyCareWeatherFactsBase {
  localDate: string;
  condition: string;
  temperature: DailyCareTemperatureFacts;
  rainExpected: boolean;
  clothingConcepts: readonly DailyCareClothingConcept[];
  checkedAt: string;
  factHash: string;
}

export type DailyCareWeatherFacts = DailyCareWeatherFactsBase & (
  | {
      sourceName: "中国天气网（七日）";
      sourceUrl: "https://www.weather.com.cn/weather/101190112.shtml";
    }
  | {
      sourceName: "Apple Weather（系统）";
      sourceUrl: "weatherkit://nanjing-qixia-government";
    }
);

export type SameDayCareSignal =
  | "stated-discomfort"
  | "expressed-fatigue"
  | "requested-rest"
  | "owner-already-sent-care";

export interface SameDayCareContext {
  readonly localDate: string;
  readonly availability: "available" | "unavailable";
  readonly explicitSignals: readonly SameDayCareSignal[];
  readonly safeExcerpts: readonly string[];
  readonly proofHash: string;
}
