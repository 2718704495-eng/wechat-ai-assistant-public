import type { DailyCareSlot } from "../daily-care/types.js";
import {
  createDailyCareWeatherResearch,
  type DailyCareWeatherResearch,
} from "./daily-care-weather-bootstrap.js";
import type { OfficialFetch } from "./official-research-executor.js";
import {
  createCodexWeatherProxyTransport,
  type WeatherProxyTransport,
} from "./weather-proxy-transport.js";

const WEATHER_URL = "https://www.weather.com.cn/weather/101190112.shtml";
const WEATHER_HOST = "www.weather.com.cn";
const WEATHER_PATH = "/weather/101190112.shtml";
const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface WeatherNetworkCanaryOptions {
  officialFetch?: OfficialFetch;
  now?: () => Date;
  createTransport?: () => WeatherProxyTransport;
}

export interface WeatherNetworkCanaryReceipt {
  readonly schemaVersion: 1;
  readonly status: "verified";
  readonly localDate: string;
  readonly sourceHost: typeof WEATHER_HOST;
  readonly sourcePath: typeof WEATHER_PATH;
  readonly requestCount: 1;
  readonly uiOperations: 0;
  readonly submitCount: 0;
  readonly factHash: string;
}

export async function runWeatherNetworkCanary(
  options: WeatherNetworkCanaryOptions = {},
): Promise<WeatherNetworkCanaryReceipt> {
  const capturedNow = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(capturedNow.getTime())) {
    throw new Error("WEATHER_NETWORK_CANARY_TIME_INVALID");
  }
  const localDate = SHANGHAI_DATE.format(capturedNow);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(localDate)) {
    throw new Error("WEATHER_NETWORK_CANARY_TIME_INVALID");
  }
  let requestCount = 0;
  let transport: WeatherProxyTransport | null = null;
  let research: DailyCareWeatherResearch | null = null;
  const slot: DailyCareSlot = Object.freeze({
    slotKey: `${localDate}/morning`,
    localDate,
    kind: "morning",
    targetMode: "production",
  });

  let receipt: WeatherNetworkCanaryReceipt | undefined;
  let failed = false;
  try {
    transport = options.officialFetch === undefined
      ? (options.createTransport ?? createCodexWeatherProxyTransport)()
      : null;
    const underlyingFetch: OfficialFetch = options.officialFetch ?? transport!.fetch;
    const restrictedFetch: OfficialFetch = (url, init) => {
      if (url !== WEATHER_URL || init.method !== "GET" || init.redirect !== "manual") {
        throw new Error("WEATHER_NETWORK_CANARY_REQUEST_REJECTED");
      }
      requestCount += 1;
      if (requestCount !== 1) {
        throw new Error("WEATHER_NETWORK_CANARY_REQUEST_REJECTED");
      }
      return underlyingFetch(url, init);
    };
    research = createDailyCareWeatherResearch({
      officialFetch: restrictedFetch,
      now: () => new Date(capturedNow.getTime()),
    });
    const facts = await research.research(slot);
    if (requestCount !== 1 || facts.sourceUrl !== WEATHER_URL || facts.localDate !== localDate) {
      throw new Error("WEATHER_NETWORK_CANARY_UNVERIFIED");
    }
    receipt = Object.freeze({
      schemaVersion: 1,
      status: "verified",
      localDate,
      sourceHost: WEATHER_HOST,
      sourcePath: WEATHER_PATH,
      requestCount: 1,
      uiOperations: 0,
      submitCount: 0,
      factHash: facts.factHash,
    });
  } catch {
    failed = true;
  } finally {
    try {
      await research?.close();
    } catch {
      failed = true;
    }
    try {
      await transport?.close();
    } catch {
      failed = true;
    }
  }
  if (failed || receipt === undefined) throw new Error("WEATHER_NETWORK_CANARY_UNVERIFIED");
  return receipt;
}
