import type {
  LiveResearchBroker,
  ResearchCapability,
} from "./live-research-broker.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 192 * 1_024;
const MAX_REDIRECTS = 3;
const MAX_FORECAST_CYCLE_PAST_AGE_MS = 36 * 60 * 60 * 1_000;
const MAX_FORECAST_CYCLE_FUTURE_MS = 12 * 60 * 60 * 1_000;
const MAX_EVENT_PAST_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_EVENT_FUTURE_MS = 366 * 24 * 60 * 60 * 1_000;

export type OfficialFetch = (
  url: string,
  init: RequestInit & { redirect: "manual" },
) => Promise<Response>;

export interface VerifiedResearchEvidence {
  sourceName: string;
  url: string;
  title: string;
  publishedAt: string | null;
  eventDate: string | null;
  snippet: string;
}

export type VerifiedResearchResult =
  | {
      status: "VERIFIED";
      checkedAt: string;
      evidence: VerifiedResearchEvidence[];
    }
  | {
      status: "NO_SAFE_RESEARCH_RESULT";
      checkedAt: string;
      evidence: [];
    };

interface OfficialResearchExecutorOptions {
  broker: LiveResearchBroker;
  fetch: OfficialFetch;
  now?: () => number;
  timeoutMs?: number;
}

interface SourceSpec {
  sourceName: string;
  initialUrl: string;
  allowedUrls: ReadonlySet<string>;
}

interface ParsedDocument {
  title: string;
  snippet: string;
  publishedAt: string | null;
  eventDate: string | null;
}

interface FetchedDocument {
  finalUrl: string;
  body: string;
}

const weatherSevenDayUrl =
  "https://www.weather.com.cn/weather/101190112.shtml";
const weatherPageTitles = new Set([
  "示例城区天气预报,示例城区7天天气预报",
  "示例城区天气预报,示例城区7天天气预报,示例城区15天天气预报,示例城区天气查询",
]);
const weatherConditions = new Set([
  "晴",
  "多云",
  "阴",
  "小雨",
  "中雨",
  "大雨",
  "暴雨",
  "大暴雨",
  "特大暴雨",
  "阵雨",
  "雷阵雨",
  "小雪",
  "中雪",
  "大雪",
  "暴雪",
  "雨夹雪",
  "雾",
  "霾",
  "浮尘",
  "扬沙",
  "沙尘暴",
]);

const weatherSources: readonly SourceSpec[] = [
  {
    sourceName: "中国天气网（七日）",
    initialUrl: weatherSevenDayUrl,
    allowedUrls: new Set([weatherSevenDayUrl]),
  },
];

export class OfficialResearchExecutor {
  readonly #broker: LiveResearchBroker;
  readonly #fetch: OfficialFetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(options: OfficialResearchExecutorOptions) {
    this.#broker = options.broker;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(capability: ResearchCapability): Promise<VerifiedResearchResult> {
    const now = this.#now();
    const checkedAt = new Date(now).toISOString();
    const intent = this.#broker.redeemForExecutor(capability);
    if (intent === null) return noSafeResult(checkedAt);

    const sources = sourcesFor(intent.topic);
    if (sources.length === 0) return noSafeResult(checkedAt);

    const evidence: VerifiedResearchEvidence[] = [];
    try {
      for (const source of sources) {
        const fetched = await fetchOfficialDocument(
          source,
          this.#fetch,
          this.#timeoutMs,
        );
        if (fetched === null) return noSafeResult(checkedAt);

        const parsed = parseChinaWeatherSevenDay(
          fetched.body,
          intent.normalizedQuery,
        );
        const validated = parsed === null ? null : validateDocument(parsed, now);
        if (validated === null) return noSafeResult(checkedAt);

        evidence.push({
          sourceName: source.sourceName,
          url: fetched.finalUrl,
          title: validated.title,
          publishedAt: validated.publishedAt,
          eventDate: validated.eventDate,
          snippet: validated.snippet,
        });
      }
    } catch {
      return noSafeResult(checkedAt);
    }

    return {
      status: "VERIFIED",
      checkedAt,
      evidence,
    };
  }
}

function sourcesFor(
  topic: "weather" | "place" | "game" | "calendar",
): readonly SourceSpec[] {
  if (topic === "weather") return weatherSources;
  return [];
}

async function fetchOfficialDocument(
  source: SourceSpec,
  fetch: OfficialFetch,
  timeoutMs: number,
): Promise<FetchedDocument | null> {
  const controller = new AbortController();
  const responseCleanups = new Set<Promise<void>>();
  const trackResponseCleanup = (cleanup: Promise<void>): void => {
    responseCleanups.add(cleanup);
    void cleanup.finally(() => responseCleanups.delete(cleanup));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void Promise.allSettled([...responseCleanups]).then(() => {
        reject(new Error("OFFICIAL_RESEARCH_TIMEOUT"));
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchOfficialDocumentWithSignal(
        source,
        fetch,
        controller.signal,
        trackResponseCleanup,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchOfficialDocumentWithSignal(
  source: SourceSpec,
  fetch: OfficialFetch,
  signal: AbortSignal,
  trackResponseCleanup: (cleanup: Promise<void>) => void,
): Promise<FetchedDocument | null> {
  let currentUrl = source.initialUrl;
  const visited = new Set<string>();

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!isAllowedUrl(currentUrl, source.allowedUrls) || visited.has(currentUrl)) {
      return null;
    }
    visited.add(currentUrl);

    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        accept: "text/html",
      },
    });
    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      await cancelResponseBody(response, trackResponseCleanup);
      if (location === null || redirectCount === MAX_REDIRECTS) return null;
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }
    if (!response.ok) {
      await cancelResponseBody(response, trackResponseCleanup);
      return null;
    }

    if (!isHtmlDocument(response.headers.get("content-type"))) {
      await cancelResponseBody(response, trackResponseCleanup);
      return null;
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
    ) {
      await cancelResponseBody(response, trackResponseCleanup);
      return null;
    }

    const bytes = await readBoundedBody(
      response,
      MAX_BODY_BYTES,
      signal,
      trackResponseCleanup,
    );
    if (bytes === null) return null;
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    return { finalUrl: currentUrl, body };
  }
  return null;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  trackResponseCleanup: (cleanup: Promise<void>) => void,
): Promise<Uint8Array | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  let abortCancellation: Promise<void> = Promise.resolve();
  let abortStarted = false;
  const cancelOnAbort = (): void => {
    if (abortStarted) return;
    abortStarted = true;
    abortCancellation = reader.cancel().then(() => undefined, () => undefined);
    trackResponseCleanup(abortCancellation);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    await abortCancellation;
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function cancelResponseBody(
  response: Response,
  trackResponseCleanup: (cleanup: Promise<void>) => void,
): Promise<void> {
  if (response.body === null) return;
  const cleanup = response.body.cancel().then(
    () => undefined,
    () => undefined,
  );
  trackResponseCleanup(cleanup);
  await cleanup;
}

function parseChinaWeatherSevenDay(
  body: string,
  normalizedQuery: string,
): ParsedDocument | null {
  const updateDigits = extractChinaWeatherUpdate(body);
  const target = weatherTarget(normalizedQuery);
  if (updateDigits === undefined || target === null) return null;

  const publishedAt = chinaLocalHourToIso(updateDigits);
  if (publishedAt === null) return null;

  const matchingEntries: Array<{
    heading: string;
    day: number;
    condition: string;
    temperature: string;
  }> = [];
  for (const match of body.matchAll(
    /<li\b(?=[^>]*class=["'][^"']*\bsky\b[^"']*["'])[^>]*>([\s\S]*?)<\/li>/giu,
  )) {
    const entry = match[1];
    if (entry === undefined) continue;
    const headingMatch = /<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/iu.exec(entry);
    if (headingMatch?.[1] === undefined) continue;
    const heading = boundedText(decodeHtmlText(stripHtml(headingMatch[1])), 40);
    if (
      heading === null ||
      !isStrictWeatherHeading(heading) ||
      !weatherHeadingMatches(heading, target)
    ) continue;

    const dayMatch = /^(\d{1,2})日/u.exec(heading);
    const conditionRaw = findElementContentByClass(entry, "p", "wea");
    const temperatureRaw = findElementContentByClass(entry, "p", "tem");
    if (
      dayMatch?.[1] === undefined ||
      conditionRaw === null ||
      temperatureRaw === null
    ) {
      return null;
    }
    const condition = boundedText(decodeHtmlText(stripHtml(conditionRaw)), 80);
    const highTokens = [...temperatureRaw.matchAll(/<\/?span\b/giu)];
    const highMatches = [
      ...temperatureRaw.matchAll(/<span>([\s\S]*?)<\/span>/giu),
    ];
    const lowMatch = /<i(?:\s[^>]*)?>([\s\S]*?)<\/i>/iu.exec(temperatureRaw);
    const low = boundedText(decodeHtmlText(stripHtml(lowMatch?.[1] ?? "")), 20);
    const validatedCondition = condition === null ? null : validateWeatherCondition(condition);
    const validatedLow = low === null ? null : validateTemperature(low);
    if (validatedCondition === null || validatedLow === null) return null;
    let temperature: string;
    if (highTokens.length === 0) {
      temperature = `最低${validatedLow.text}`;
    } else {
      if (highTokens.length !== 2 || highMatches.length !== 1) return null;
      const highRaw = highMatches[0]?.[1];
      if (highRaw === undefined || /[<>]/u.test(highRaw)) return null;
      const high = boundedText(decodeHtmlText(highRaw), 20);
      const validatedHigh = high === null ? null : validateTemperature(high);
      if (validatedHigh === null || validatedHigh.value < validatedLow.value) return null;
      temperature = `${validatedHigh.text}/${validatedLow.text}`;
    }
    matchingEntries.push({
      heading,
      day: Number(dayMatch[1]),
      condition: validatedCondition,
      temperature,
    });
  }
  if (matchingEntries.length !== 1) return null;
  const forecast = matchingEntries[0];
  if (forecast === undefined) return null;

  const eventDate = chinaForecastDayToIso(updateDigits, forecast.day);
  const titleMatch = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/iu.exec(body);
  const title = boundedText(
    decodeHtmlText(stripHtml(titleMatch?.[1] ?? "")),
    120,
  );
  if (
    eventDate === null ||
    title === null ||
    !weatherPageTitles.has(title) ||
    !eventDateMatchesTarget(eventDate, target, updateDigits)
  ) {
    return null;
  }
  return {
    title,
    publishedAt,
    eventDate,
    snippet: `${forecast.heading}：${forecast.condition}，${forecast.temperature}`,
  };
}

function extractChinaWeatherUpdate(body: string): string | undefined {
  const markerOccurrences = [
    ...body.matchAll(/\bfc_24h_internal_update_time\b\s*=/gu),
    ...body.matchAll(/\bid\s*=\s*["']fc_24h_internal_update_time["']/giu),
  ].length;
  const candidates: string[] = [];
  for (const match of body.matchAll(
    /fc_24h_internal_update_time\s*=\s*(?:"(\d{10})"|'(\d{10})'|(\d{10})(?!\d))(?=\s*(?:[;,<]|$))/gu,
  )) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (candidate !== undefined) candidates.push(candidate);
  }
  for (const match of body.matchAll(
    /<input\b(?=[^>]*\bid=(["'])fc_24h_internal_update_time\1)(?=[^>]*\bvalue=(["'])(\d{10})\2)[^>]*>/giu,
  )) {
    if (match[3] !== undefined) candidates.push(match[3]);
  }
  return markerOccurrences === 1 && candidates.length === 1
    ? candidates[0]
    : undefined;
}

function validateDocument(document: ParsedDocument, now: number): ParsedDocument | null {
  const eventDate = validateDate(document.eventDate, {
    minimum: now - MAX_EVENT_PAST_AGE_MS,
    maximum: now + MAX_EVENT_FUTURE_MS,
  });
  const publishedAt = validateForecastCycle(document.publishedAt, eventDate, now);
  if (
    document.publishedAt === null ||
    document.eventDate === null ||
    publishedAt === null ||
    eventDate === null
  ) {
    return null;
  }
  return { ...document, publishedAt, eventDate };
}

function validateForecastCycle(
  value: string | null,
  eventDate: string | null,
  now: number,
): string | null {
  if (value === null || eventDate === null) return null;
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < now - MAX_FORECAST_CYCLE_PAST_AGE_MS ||
    timestamp > now + MAX_FORECAST_CYCLE_FUTURE_MS
  ) {
    return null;
  }
  const cycleDay = shanghaiCalendarDate(timestamp);
  const eventDay = shanghaiCalendarDate(Date.parse(eventDate));
  const precedingEventDay = eventDay === null ? null : precedingCalendarDate(eventDay);
  if (cycleDay === null || eventDay === null || precedingEventDay === null ||
      (cycleDay !== eventDay && cycleDay !== precedingEventDay)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function shanghaiCalendarDate(timestamp: number): string | null {
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + 8 * 60 * 60 * 1_000);
  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function precedingCalendarDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

function validateDate(
  value: string | null,
  bounds: { minimum: number; maximum: number },
): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < bounds.minimum ||
    timestamp > bounds.maximum
  ) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function findElementContentByClass(
  body: string,
  tagName: string,
  className: string,
): string | null {
  const pattern = new RegExp(
    `<${tagName}\\b(?=[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'])[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "iu",
  );
  return pattern.exec(body)?.[1] ?? null;
}

type WeatherTarget =
  | { label: "今天" | "明天" | "后天" }
  | { month: number; day: number };

function weatherTarget(normalizedQuery: string): WeatherTarget | null {
  if (normalizedQuery.includes("明晚") || normalizedQuery.includes("明天")) {
    return { label: "明天" };
  }
  if (normalizedQuery.includes("后天")) return { label: "后天" };
  if (normalizedQuery.includes("今晚") || normalizedQuery.includes("今天")) {
    return { label: "今天" };
  }
  const dateMatch = /(\d{1,2})月(\d{1,2})日/u.exec(normalizedQuery);
  if (dateMatch?.[1] !== undefined && dateMatch[2] !== undefined) {
    return { month: Number(dateMatch[1]), day: Number(dateMatch[2]) };
  }
  return normalizedQuery === "示例城市示例城区 实时天气与短时预报"
    ? { label: "今天" }
    : null;
}

function weatherHeadingMatches(heading: string, target: WeatherTarget): boolean {
  if ("day" in target) return heading.startsWith(`${target.day}日`);
  return (
    heading.includes(`（${target.label}）`) ||
    heading.includes(`(${target.label})`)
  );
}

function isStrictWeatherHeading(heading: string): boolean {
  return /^\d{1,2}日(?:（(?:今天|明天|后天|周[一二三四五六日天])）|\((?:今天|明天|后天|周[一二三四五六日天])\))$/u
    .test(heading);
}

function validateWeatherCondition(condition: string): string | null {
  const parts = condition.split("转");
  if (
    parts.length < 1 ||
    parts.length > 2 ||
    parts.some((part) => !weatherConditions.has(part))
  ) {
    return null;
  }
  return parts.join("转");
}

function validateTemperature(
  temperature: string,
): { text: string; value: number } | null {
  const match = /^(-?\d{1,2})(?:℃)?$/u.exec(temperature);
  const digits = match?.[1];
  if (digits === undefined) return null;
  const value = Number(digits);
  if (!Number.isInteger(value) || value < -60 || value > 60) return null;
  return { text: `${String(value)}℃`, value };
}

function eventDateMatchesTarget(
  eventDate: string,
  target: WeatherTarget,
  update: string,
): boolean {
  const chinaTime = new Date(Date.parse(eventDate) + 8 * 60 * 60 * 1_000);
  if (!("day" in target)) {
    const year = Number(update.slice(0, 4));
    const month = Number(update.slice(4, 6));
    const day = Number(update.slice(6, 8));
    if (!validCalendarParts(year, month, day)) return false;
    const offset = target.label === "今天" ? 0 : target.label === "明天" ? 1 : 2;
    const expected = new Date(Date.UTC(year, month - 1, day + offset));
    return (
      chinaTime.getUTCFullYear() === expected.getUTCFullYear() &&
      chinaTime.getUTCMonth() === expected.getUTCMonth() &&
      chinaTime.getUTCDate() === expected.getUTCDate()
    );
  }
  return (
    chinaTime.getUTCMonth() + 1 === target.month &&
    chinaTime.getUTCDate() === target.day
  );
}

function chinaLocalHourToIso(value: string): string | null {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  if (!validCalendarParts(year, month, day) || hour < 0 || hour > 23) {
    return null;
  }
  const timestamp = Date.parse(
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  );
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function chinaForecastDayToIso(update: string, forecastDay: number): string | null {
  let year = Number(update.slice(0, 4));
  let month = Number(update.slice(4, 6));
  const updateDay = Number(update.slice(6, 8));
  if (!validCalendarParts(year, month, updateDay)) return null;
  if (forecastDay < updateDay) {
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  if (!validCalendarParts(year, month, forecastDay)) return null;
  const localMidnightUtc = Date.UTC(year, month - 1, forecastDay) - 8 * 60 * 60 * 1_000;
  return new Date(localMidnightUtc).toISOString();
}

function validCalendarParts(year: number, month: number, day: number): boolean {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function boundedText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  if (containsForbiddenControlCharacter(value)) return null;
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    return null;
  }
  return normalized;
}

function containsForbiddenControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127)
    ) {
      return true;
    }
  }
  return false;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/gu, " ");
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'");
}

function isAllowedUrl(url: string, allowedUrls: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === "" &&
      allowedUrls.has(parsed.href)
    );
  } catch {
    return false;
  }
}

function isHtmlDocument(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html";
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function noSafeResult(checkedAt: string): VerifiedResearchResult {
  return { status: "NO_SAFE_RESEARCH_RESULT", checkedAt, evidence: [] };
}
