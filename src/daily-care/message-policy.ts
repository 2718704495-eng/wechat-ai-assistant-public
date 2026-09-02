import { createHash } from "node:crypto";

import {
  ALL_ASSISTANT_SIGNATURES,
  ASSISTANT_SIGNATURE,
} from "../assistant-identity.js";
import type {
  DailyCareClothingConcept,
  DailyCareKind,
  DailyCareWeatherFacts,
  SameDayCareContext,
  SameDayCareSignal,
} from "./types.js";

const EMOJIS = ["☀️", "🌤️", "🌧️", "☔", "🧥", "👕", "💛", "🌙", "✨", "😴", "🍃"] as const;
const LOCATION_PATTERN = /示例城市|示例城区|西霞区/u;
const METADATA_PATTERN = /https?:\/\/|\b(?:source|reason|token)\s*=|<\/?marker>/iu;
const UNSUPPORTED_CLAIM_PATTERN = /我知道你今天|听说你今天|立刻回复|马上回复|必须回复|永远陪着你|一辈子陪着你/u;
const UNBOUND_PERSONAL_FACT_PATTERN =
  /十二个小时|两班倒|今天吃得很少|吃多了|按身体感觉|因为减肥所以/u;
const WEATHER_AT_NIGHT_PATTERN = /天气|温度|气温|℃|下雨|降雨|雨|雪|多云|晴|阴|雷|风力|湿度|高温|低温/u;
const SAFE_ACTION_IDIOM_PATTERN = /把烦恼放一放|放下心事|带着好心情/gu;
const PREPARATION_VERB = "(?:背|带(?:上)?|拿(?:好)?|装(?:好)?|戴(?:上|好)?|穿(?:上|好)?|换(?:上|好)?|备(?:上|好)?|携(?:带)?|准备(?:好)?|收(?:好|进|入|到)|放(?:好|进|到|在|上|一?(?:包|个|件|把|只|台|部|本|瓶|盒|条|双|枚|块)))";
const PREPARATION_ACTION_OBJECT_PATTERNS = [
  new RegExp(`把[^\u3002！？!?]{1,80}${PREPARATION_VERB}`, "iu"),
  new RegExp(`(?:出门|上班|通勤|离开|临走|临出)[^\u3002！？!?]{0,80}${PREPARATION_VERB}`, "iu"),
  new RegExp(`${PREPARATION_VERB}[^\u3002！？!?]{0,80}(?:出门|上班|通勤|离开|临走|临出)`, "iu"),
  new RegExp(`(?:记得|别忘|建议|最好|可以|顺手)[^\u3002！？!?]{0,80}${PREPARATION_VERB}`, "iu"),
] as const;
const POSITIVE_RAIN_PATTERN = /(?:会|有|可能|预计|将)?(?:下雨|降雨|阵雨|雷雨|小雨|中雨|大雨|暴雨)/u;
const NEGATED_RAIN_PATTERN = /(?:不|无|不会|没有)(?:下雨|降雨|雨)/u;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

const CLOTHING_PHRASES: Record<DailyCareClothingConcept, RegExp> = {
  warmth: /保暖|添衣|加件|外套|别着凉/u,
  breathable: /透气|轻薄|清爽/u,
  "sun-protection": /防晒|遮阳|太阳伞/u,
  "rain-protection": /带伞|雨伞|雨具|防雨/u,
};

export interface ValidateBroadcastCandidateInput {
  kind: DailyCareKind;
  text: string;
  weather: DailyCareWeatherFacts | null;
  recentVerifiedTexts: readonly string[];
  sameDayCareContext?: SameDayCareContext | null;
}

export interface ValidatedBroadcastCandidate {
  text: string;
  normalizedText: string;
  normalizedHash: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function splitSignedText(text: string): string {
  const suffix = `\n${ASSISTANT_SIGNATURE}`;
  if (!text.endsWith(suffix) || ALL_ASSISTANT_SIGNATURES.some((signature) =>
    text.slice(0, -suffix.length).includes(signature))) {
    return fail("BROADCAST_SIGNATURE_INVALID");
  }
  const body = text.slice(0, -suffix.length);
  if (body.length === 0 || body.includes("\n")) {
    return fail("BROADCAST_SIGNATURE_INVALID");
  }
  return body;
}

function collectAllowedEmojis(body: string): { count: number; withoutAllowed: string } {
  let rest = body;
  let count = 0;
  for (const emoji of EMOJIS) {
    const pieces = rest.split(emoji);
    count += pieces.length - 1;
    rest = pieces.join("");
  }
  return { count, withoutAllowed: rest };
}

function validateEmoji(kind: DailyCareKind, body: string): void {
  const { count, withoutAllowed } = collectAllowedEmojis(body);
  if ((kind === "morning" && (count < 1 || count > 2)) ||
      (kind === "night" && count > 1) || EMOJI_PATTERN.test(withoutAllowed)) {
    fail("BROADCAST_EMOJI_INVALID");
  }
}

function validateLength(kind: DailyCareKind, body: string): void {
  const count = Array.from(body).length;
  const [minimum, maximum] = [60, 120];
  if (count < minimum || count > maximum) {
    fail("BROADCAST_BODY_LENGTH_INVALID");
  }
}

function validateMorning(body: string, weather: DailyCareWeatherFacts | null): void {
  if (LOCATION_PATTERN.test(body)) {
    fail("BROADCAST_LOCATION_DISCLOSURE_FORBIDDEN");
  }
  if (weather === null) {
    if (WEATHER_AT_NIGHT_PATTERN.test(body) || /-?\d{1,2}\s*℃/u.test(body) ||
        containsUnverifiedActionObject(body)) {
      fail("BROADCAST_FALLBACK_WEATHER_FORBIDDEN");
    }
    if (!/(?:上班|通勤|出门工作)/u.test(body) ||
        !/(?:身体|喝水|喝(?:点)?温水|吃饭|吃点东西|休息|歇一会|喘口气|照顾好自己)/u
          .test(body)) {
      fail("BROADCAST_CARE_GUIDANCE_MISSING");
    }
    return;
  }
  if (!body.includes(weather.condition)) {
    fail("BROADCAST_WEATHER_FACT_MISMATCH");
  }
  const temperatures = [...body.matchAll(/-?\d{1,2}\s*℃/gu)]
    .map((match) => Number(match[0].replace(/\s*℃/u, "")));
  if (weather.temperature.kind === "range") {
    const { highC, lowC } = weather.temperature;
    const highPattern = new RegExp(`(?:最高|高温)\\s*${highC}\\s*℃`, "u");
    const lowPattern = new RegExp(`最低(?:气温)?\\s*${lowC}\\s*℃`, "u");
    if (!highPattern.test(body) || !lowPattern.test(body) || temperatures.length !== 2 ||
        temperatures.some((temperature) => temperature !== highC && temperature !== lowC)) {
      fail("BROADCAST_WEATHER_FACT_MISMATCH");
    }
  } else {
    const { lowC } = weather.temperature;
    const lowPattern = new RegExp(`最低(?:气温)?\\s*${lowC}\\s*℃`, "u");
    if (!lowPattern.test(body) || temperatures.length !== 1 || temperatures[0] !== lowC ||
        /最高|高温/u.test(body) ||
        CLOTHING_PHRASES.breathable.test(body) || CLOTHING_PHRASES["sun-protection"].test(body) ||
        weather.clothingConcepts.includes("breathable") ||
        weather.clothingConcepts.includes("sun-protection")) {
      fail("BROADCAST_WEATHER_FACT_MISMATCH");
    }
  }
  if ((!weather.rainExpected && POSITIVE_RAIN_PATTERN.test(body)) ||
      (weather.rainExpected && NEGATED_RAIN_PATTERN.test(body))) {
    fail("BROADCAST_WEATHER_FACT_MISMATCH");
  }
  if (!/(?:上班|通勤|出门工作)/u.test(body) || !/(?:身体|喝水|吃饭|休息|歇一会)/u.test(body)) {
    fail("BROADCAST_CARE_GUIDANCE_MISSING");
  }
  for (const concept of weather.clothingConcepts) {
    if (!CLOTHING_PHRASES[concept].test(body)) {
      fail("BROADCAST_CLOTHING_GUIDANCE_MISSING");
    }
  }
  if (weather.rainExpected && !CLOTHING_PHRASES["rain-protection"].test(body)) {
    fail("BROADCAST_CLOTHING_GUIDANCE_MISSING");
  }
}

type PersonalFactKey = string;

const PERSONAL_FACT_EXTRACTORS: readonly {
  key: PersonalFactKey;
  pattern: RegExp;
  signal?: SameDayCareSignal;
}[] = [
  { key: "discomfort:stomach", pattern: /(?:胃|肚子)[^。！？!?]*(?:不舒服|难受|疼|痛)/u,
    signal: "stated-discomfort" },
  { key: "discomfort:head", pattern: /(?:头|脑袋)[^。！？!?]*(?:不舒服|难受|疼|痛)/u,
    signal: "stated-discomfort" },
  { key: "discomfort:throat", pattern: /(?:嗓子|喉咙)[^。！？!?]*(?:不舒服|难受|疼|痛)/u,
    signal: "stated-discomfort" },
  { key: "discomfort:general", pattern: /身体[^。！？!?]*(?:不舒服|难受|疼|痛)/u,
    signal: "stated-discomfort" },
  { key: "illness:fever", pattern: /发烧|发热|高烧/u, signal: "stated-discomfort" },
  { key: "illness:cold", pattern: /感冒|着凉/u, signal: "stated-discomfort" },
  { key: "mood:low", pattern: /心情[^\u3002！？!?]*(?:不(?:太)?好|低落|难过|烦|糟糕)/u },
  { key: "fatigue:explicit", pattern: /(?:你今天[^。！？!?]*(?:累|疲惫|辛苦)|忙了一天)/u,
    signal: "expressed-fatigue" },
  { key: "rest:requested", pattern: /你今天[^。！？!?]*(?:想|要)[^。！？!?]*休息/u,
    signal: "requested-rest" },
  { key: "shift:night", pattern: /(?:上|值|轮到)[^。！？!?]*(?:夜班|晚班)|(?:夜班|晚班)[^。！？!?]*(?:上|值)/u },
  { key: "shift:morning", pattern: /(?:上|值|轮到)[^。！？!?]*(?:早班|白班)|(?:早班|白班)[^。！？!?]*(?:上|值)/u },
  { key: "shift:duration", pattern: /(?:上班|工作|值班)[^。！？!?]*\d+(?:个)?小时/u },
  { key: "diet:missed-meal", pattern: /(?:没|没有|来不及)[^。！？!?]*(?:吃饭|吃早饭|吃午饭|吃晚饭)|空着肚子/u },
  { key: "diet:limited", pattern: /(?:只吃|吃得很少|没怎么吃)[^。！？!?]*/u },
  { key: "diet:excess", pattern: /(?:吃多了|吃得太多)/u },
  { key: "cause:missed-meal", pattern: /(?:因为|由于|是)[^。！？!?]*(?:没吃|没有吃|空着肚子)[^。！？!?]*(?:所以|导致|才)?/u },
  { key: "cause:dieting", pattern: /(?:因为|由于)[^。！？!?]*减肥|减肥[^。！？!?]*(?:所以|导致)/u },
  { key: "cause:sleep", pattern: /(?:因为|由于)[^。！？!?]*(?:熬夜|没睡好)|(?:熬夜|没睡好)[^。！？!?]*(?:所以|导致)/u },
];

function validateNight(
  body: string,
  weather: DailyCareWeatherFacts | null,
  context: SameDayCareContext | null | undefined,
): void {
  if (weather !== null || WEATHER_AT_NIGHT_PATTERN.test(body)) {
    fail("BROADCAST_NIGHT_WEATHER_FORBIDDEN");
  }
  if (UNBOUND_PERSONAL_FACT_PATTERN.test(body)) {
    fail("BROADCAST_UNBOUND_PERSONAL_FACT");
  }
  validateSameDayCareContext(context);
  const candidateFacts = extractPersonalFacts(body);
  const evidenceFacts = context?.availability === "available"
    ? new Set(context.safeExcerpts.flatMap((excerpt) => extractPersonalFacts(excerpt)))
    : new Set<PersonalFactKey>();
  for (const fact of candidateFacts) {
    const extractor = PERSONAL_FACT_EXTRACTORS.find(({ key }) => key === fact);
    if (context?.availability !== "available" || !evidenceFacts.has(fact) ||
        (extractor?.signal !== undefined &&
          !context.explicitSignals.includes(extractor.signal))) {
      fail("BROADCAST_UNBOUND_PERSONAL_FACT");
    }
  }
  const sentences = body.split(/[。！？!?]/u).map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length < 3 || sentences.length > 4 ||
      !/(?:休息|睡|晚安|好梦|放松)/u.test(body) ||
      !/(?:惦记|关心|照顾好自己|安心|心疼)/u.test(body)) {
    fail("BROADCAST_CARE_GUIDANCE_MISSING");
  }
}

function containsUnverifiedActionObject(body: string): boolean {
  const withoutSafeIdioms = body.normalize("NFC").replace(SAFE_ACTION_IDIOM_PATTERN, "");
  return withoutSafeIdioms
    .split(/[。！？!?\r\n]/u)
    .map((sentence) => sentence.toLocaleLowerCase("en-US"))
    .some((sentence) => PREPARATION_ACTION_OBJECT_PATTERNS.some((pattern) =>
      pattern.test(sentence)));
}

function extractPersonalFacts(
  text: string,
  inspectAssertionClauses = true,
): PersonalFactKey[] {
  const normalized = text.normalize("NFC");
  const facts: PersonalFactKey[] = [];
  for (const extractor of PERSONAL_FACT_EXTRACTORS) {
    if (extractor.pattern.test(normalized)) facts.push(extractor.key);
  }
  const meal = mealQualifier(normalized);
  if (/(?:只吃|吃得很少|没怎么吃)/u.test(normalized)) {
    facts.push(`diet:limited:${meal}`);
  }
  if (/(?:没|没有|来不及)[^\u3002！？!?]*(?:吃饭|吃早饭|吃午饭|吃晚饭)|空着肚子/u.test(normalized)) {
    facts.push(`diet:missed-meal:${meal}`);
  }
  if (/(?:因为|由于|是因为|是)[^\u3002！？!?]*(?:没吃|没有吃|空着肚子)/u.test(normalized)) {
    facts.push(`cause:missed-meal:${meal}`);
  }
  if (/(?:因为|由于|是因为|是)[^\u3002！？!?]*(?:空调|冷风)/u.test(normalized)) {
    facts.push("cause:air-conditioning");
  }
  const duration = normalized.match(/(?:连续)?(?:上|工作|值班)[^\u3002！？!?]{0,24}?(\d+|一|两|二|三|四|五|六|七|八|九|十|十一|十二)(?:个)?小时/u);
  if (duration !== null) {
    const hours = normalizeHour(duration[1] ?? "");
    const shift = /(?:夜班|晚班)/u.test(normalized)
      ? "night"
      : /(?:早班|白班)/u.test(normalized) ? "morning" : "unspecified";
    facts.push(`shift:${shift}:duration:${hours}`);
  }
  const deduplicated = [...new Set(facts)];
  const assertionClauses = inspectAssertionClauses
    ? normalized.match(/(?:也)?(?:知道你今天|听你说今天|听说你今天|你今天|今天你)[^，。！？!?;；]*/gu) ?? []
    : [];
  if (assertionClauses.some((clause) => extractPersonalFacts(clause, false).length === 0)) {
    deduplicated.push("unclassified:personal-assertion");
  }
  return deduplicated.slice(0, 24);
}

function mealQualifier(text: string): "breakfast" | "lunch" | "dinner" | "unspecified" {
  if (/(?:早饭|早餐)/u.test(text)) return "breakfast";
  if (/(?:午饭|午餐)/u.test(text)) return "lunch";
  if (/(?:晚饭|晚餐)/u.test(text)) return "dinner";
  return "unspecified";
}

function normalizeHour(value: string): string {
  const values: Record<string, string> = {
    "一": "1", "两": "2", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6",
    "七": "7", "八": "8", "九": "9", "十": "10", "十一": "11", "十二": "12",
  };
  return values[value] ?? value;
}

function validateSameDayCareContext(context: SameDayCareContext | null | undefined): void {
  if (context === null || context === undefined) return;
  const allowedSignals = new Set<SameDayCareSignal>([
    "stated-discomfort", "expressed-fatigue", "requested-rest", "owner-already-sent-care",
  ]);
  if (typeof context !== "object" || Array.isArray(context) ||
      Reflect.ownKeys(context).sort().join(",") !==
        "availability,explicitSignals,localDate,proofHash,safeExcerpts" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(context.localDate) ||
      (context.availability !== "available" && context.availability !== "unavailable") ||
      !/^[a-f0-9]{64}$/u.test(context.proofHash) ||
      !Array.isArray(context.explicitSignals) || context.explicitSignals.length > 4 ||
      context.explicitSignals.some((signal) =>
        !allowedSignals.has(signal as SameDayCareSignal)) ||
      !Array.isArray(context.safeExcerpts) || context.safeExcerpts.length > 4 ||
      context.safeExcerpts.some((excerpt) => typeof excerpt !== "string" ||
        excerpt.length === 0 || Array.from(excerpt).length > 80) ||
      (context.availability === "unavailable" &&
        (context.explicitSignals.length !== 0 || context.safeExcerpts.length !== 0))) {
    fail("BROADCAST_CARE_CONTEXT_INVALID");
  }
}

export function normalizeBroadcastText(text: string): string {
  const normalized = text.normalize("NFC");
  const matchedSignature = ALL_ASSISTANT_SIGNATURES.find((signature) =>
    normalized.endsWith(`\n${signature}`));
  const unsigned = matchedSignature === undefined
    ? normalized
    : normalized.slice(0, -(`\n${matchedSignature}`.length));
  let withoutEmoji = unsigned;
  for (const emoji of EMOJIS) {
    withoutEmoji = withoutEmoji.split(emoji).join("");
  }
  return withoutEmoji.replace(/[\p{White_Space}\p{Punctuation}\p{Symbol}]/gu, "");
}

function bigramSet(value: string): Set<string> {
  const points = Array.from(normalizeBroadcastText(value));
  if (points.length < 2) {
    return new Set(points);
  }
  return new Set(points.slice(0, -1).map((point, index) => `${point}${points[index + 1] ?? ""}`));
}

export function bigramDiceSimilarity(a: string, b: string): number {
  const left = bigramSet(a);
  const right = bigramSet(b);
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1;
    }
  }
  return (2 * intersection) / (left.size + right.size);
}

export function validateBroadcastCandidate(
  input: ValidateBroadcastCandidateInput,
): ValidatedBroadcastCandidate {
  const text = input.text.normalize("NFC");
  const body = splitSignedText(text);
  validateLength(input.kind, body);
  validateEmoji(input.kind, body);
  if (METADATA_PATTERN.test(body)) {
    fail("BROADCAST_METADATA_FORBIDDEN");
  }
  if (UNSUPPORTED_CLAIM_PATTERN.test(body)) {
    fail("BROADCAST_UNSUPPORTED_CLAIM");
  }
  if (input.kind === "morning") {
    validateMorning(body, input.weather);
  } else {
    validateNight(body, input.weather, input.sameDayCareContext);
  }
  for (const previous of input.recentVerifiedTexts.slice(0, 14)) {
    if (bigramDiceSimilarity(text, previous) > 0.78) {
      fail("BROADCAST_TEXT_TOO_SIMILAR");
    }
  }
  const normalizedText = normalizeBroadcastText(text);
  return {
    text,
    normalizedText,
    normalizedHash: createHash("sha256").update(normalizedText).digest("hex"),
  };
}

export function validateUnsignedBroadcastCandidate(
  input: ValidateBroadcastCandidateInput,
): ValidatedBroadcastCandidate {
  const body = input.text.normalize("NFC");
  if (body.length === 0 || body.includes("\n") || body.includes("\r") ||
      ALL_ASSISTANT_SIGNATURES.some((signature) => body.includes(signature))) {
    fail("BROADCAST_CANDIDATE_SIGNATURE_FORBIDDEN");
  }
  const validated = validateBroadcastCandidate({
    ...input,
    text: `${body}\n${ASSISTANT_SIGNATURE}`,
  });
  return { ...validated, text: body };
}
