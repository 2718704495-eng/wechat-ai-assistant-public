import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { Dispatcher } from "undici";

import type { OfficialFetch } from "./official-research-executor.js";

const weatherUrl = "https://www.weather.com.cn/weather/101190112.shtml";
const proxyEnvironmentInvalid = "WEATHER_PROXY_ENV_INVALID";

export interface WeatherProxyDispatcher {
  close(): Promise<void>;
}

export interface WeatherProxyTransportDependencies {
  createProxyAgent(proxyUrl: string): WeatherProxyDispatcher;
  fetch(
    url: string,
    init: RequestInit & { redirect: "manual"; dispatcher: WeatherProxyDispatcher },
  ): Promise<Response>;
}

export interface WeatherProxyTransport {
  fetch: OfficialFetch;
  close(): Promise<void>;
}

export interface CreateCodexWeatherProxyTransportOptions {
  environment?: Record<string, string | undefined>;
  dependencies?: WeatherProxyTransportDependencies;
}

const defaultDependencies: WeatherProxyTransportDependencies = {
  createProxyAgent: (proxyUrl) => new ProxyAgent(proxyUrl),
  fetch: (url: string, init: RequestInit & { redirect: "manual"; dispatcher: WeatherProxyDispatcher }) =>
    undiciFetch(url, {
      ...init,
      dispatcher: init.dispatcher as Dispatcher,
    } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>,
};

export function createCodexWeatherProxyTransport(
  options: CreateCodexWeatherProxyTransportOptions = {},
): WeatherProxyTransport {
  const environment = options.environment ?? process.env;
  const proxyUrl = validateProxyEnvironment(environment);
  const dependencies = options.dependencies ?? defaultDependencies;
  let dispatcher: WeatherProxyDispatcher;
  try {
    dispatcher = dependencies.createProxyAgent(proxyUrl);
  } catch {
    throw new Error("WEATHER_PROXY_TRANSPORT_CREATE_FAILED");
  }
  let closePromise: Promise<void> | null = null;

  const close = (): Promise<void> => {
    closePromise ??= Promise.resolve(dispatcher.close()).catch(() => {
      throw new Error("WEATHER_PROXY_TRANSPORT_CLOSE_FAILED");
    });
    return closePromise;
  };

  return Object.freeze({
    fetch: async (
      url: string,
      init: RequestInit & { redirect: "manual" },
    ): Promise<Response> => {
      if (closePromise !== null) throw new Error("WEATHER_PROXY_TRANSPORT_CLOSED");
      if (
        url !== weatherUrl || init.method !== "GET" || init.redirect !== "manual" ||
        !(init.signal instanceof AbortSignal)
      ) {
        throw new Error("WEATHER_PROXY_TRANSPORT_REQUEST_INVALID");
      }
      return dependencies.fetch(url, { ...init, dispatcher });
    },
    close,
  });
}

function validateProxyEnvironment(environment: Record<string, string | undefined>): string {
  if (
    environment.CODEX_NETWORK_PROXY_ACTIVE !== "1" ||
    environment.CODEX_SANDBOX_NETWORK_DISABLED !== undefined
  ) {
    throw new Error(proxyEnvironmentInvalid);
  }
  const http = parseLoopbackProxyUrl(environment.HTTP_PROXY);
  const https = parseLoopbackProxyUrl(environment.HTTPS_PROXY);
  if (http === null || https === null || http.origin !== https.origin) {
    throw new Error(proxyEnvironmentInvalid);
  }
  return http.href;
}

function parseLoopbackProxyUrl(
  value: string | undefined,
): { href: string; origin: string } | null {
  if (value === undefined) return null;
  try {
    const explicitAuthority = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/u.exec(value);
    const explicitPort = Number(explicitAuthority?.[2]);
    if (explicitAuthority?.[1] === undefined || !Number.isInteger(explicitPort) || explicitPort > 65_535) {
      return null;
    }
    const parsed = new URL(value);
    if (
      parsed.protocol !== "http:" ||
      (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") ||
      parsed.username.length > 0 || parsed.password.length > 0 ||
      parsed.pathname !== "/" || parsed.search.length > 0 || parsed.hash.length > 0
    ) {
      return null;
    }
    return {
      href: value,
      origin: `${explicitAuthority[1]}:${String(explicitPort)}`,
    };
  } catch {
    return null;
  }
}
