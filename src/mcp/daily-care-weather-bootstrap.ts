import type { DailyCareSlot, DailyCareWeatherFacts } from "../daily-care/types.js";
import { researchTodayQixiaWeather } from "../daily-care/weather.js";
import { LiveResearchBroker } from "./live-research-broker.js";
import {
  OfficialResearchExecutor,
  type OfficialFetch,
} from "./official-research-executor.js";
import {
  createCodexWeatherProxyTransport,
  type WeatherProxyTransport,
  type WeatherProxyTransportDependencies,
} from "./weather-proxy-transport.js";

export interface DailyCareWeatherBootstrapOptions {
  officialFetch?: OfficialFetch;
  now?: () => Date;
  environment?: Record<string, string | undefined>;
  transportDependencies?: WeatherProxyTransportDependencies;
  createTransport?: () => WeatherProxyTransport;
}

export interface DailyCareWeatherResearch {
  research(slot: DailyCareSlot): Promise<DailyCareWeatherFacts>;
  close(): Promise<void>;
}

export function createDailyCareWeatherResearch(
  options: DailyCareWeatherBootstrapOptions = {},
): DailyCareWeatherResearch {
  const now = options.now;
  const createTransport = options.createTransport ?? (() => createCodexWeatherProxyTransport({
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.transportDependencies === undefined
      ? {}
      : { dependencies: options.transportDependencies }),
  }));
  let acceptingResearch = true;
  let closePromise: Promise<void> | null = null;
  const activeResearch = new Set<Promise<DailyCareWeatherFacts>>();

  const research = (slot: DailyCareSlot): Promise<DailyCareWeatherFacts> => {
    if (!acceptingResearch) return Promise.reject(new Error("DAILY_CARE_WEATHER_BOOTSTRAP_CLOSED"));
    if (slot.kind !== "morning") {
      return Promise.reject(new Error("DAILY_CARE_WEATHER_NOT_ALLOWED"));
    }
    const task = executeResearch({
      slot,
      now,
      officialFetch: options.officialFetch,
      createTransport,
    });
    activeResearch.add(task);
    void task.then(
      () => activeResearch.delete(task),
      () => activeResearch.delete(task),
    );
    return task;
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      acceptingResearch = false;
      await Promise.allSettled(activeResearch);
    })();
    return closePromise;
  };

  return Object.freeze({
    research,
    close,
  });
}

async function executeResearch(options: {
  slot: DailyCareSlot;
  now: (() => Date) | undefined;
  officialFetch: OfficialFetch | undefined;
  createTransport: () => WeatherProxyTransport;
}): Promise<DailyCareWeatherFacts> {
  const transport = options.officialFetch === undefined ? options.createTransport() : null;
  const broker = new LiveResearchBroker({
    ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }),
  });
  const executor = new OfficialResearchExecutor({
    broker,
    fetch: options.officialFetch ?? transport!.fetch,
    ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }),
  });
  let facts: DailyCareWeatherFacts | undefined;
  let primaryFailure: unknown;
  try {
    facts = await researchTodayQixiaWeather({
      broker,
      executor,
      slot: options.slot,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error: unknown) {
    primaryFailure = error;
  }
  let closeFailure: Error | undefined;
  try {
    await transport?.close();
  } catch {
    closeFailure = new Error("DAILY_CARE_WEATHER_TRANSPORT_CLOSE_FAILED");
  }
  if (primaryFailure === undefined && closeFailure === undefined && facts !== undefined) return facts;
  if (primaryFailure !== undefined && closeFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, closeFailure],
      "DAILY_CARE_WEATHER_RESEARCH_FAILED",
    );
  }
  if (closeFailure !== undefined) throw closeFailure;
  if (primaryFailure instanceof Error) throw primaryFailure;
  throw new Error("DAILY_CARE_WEATHER_RESEARCH_FAILED");
}
