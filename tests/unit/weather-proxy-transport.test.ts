import { describe, expect, it, vi } from "vitest";

import {
  createCodexWeatherProxyTransport,
  type WeatherProxyTransportDependencies,
} from "../../src/mcp/weather-proxy-transport.js";
import {
  createDailyCareWeatherResearch,
} from "../../src/mcp/daily-care-weather-bootstrap.js";
import type { DailyCareSlot } from "../../src/daily-care/types.js";
import type { WeatherProxyTransport } from "../../src/mcp/weather-proxy-transport.js";

const WEATHER_URL = "https://www.weather.com.cn/weather/101190112.shtml";

describe("Codex weather proxy transport", () => {
  it("accepts only an active same-origin clean loopback HTTP(S) proxy pair", () => {
    const harness = createHarness();
    const transport = createCodexWeatherProxyTransport({
      environment: activeEnvironment(),
      dependencies: harness.dependencies,
    });

    expect(harness.createProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:38123/");
    expect(typeof transport.close).toBe("function");
    expect(typeof transport.fetch).toBe("function");
  });

  it("preserves an explicitly supplied valid default HTTP port", () => {
    const harness = createHarness();
    createCodexWeatherProxyTransport({
      environment: activeEnvironment({
        HTTP_PROXY: "http://127.0.0.1:80/",
        HTTPS_PROXY: "http://127.0.0.1:80/",
      }),
      dependencies: harness.dependencies,
    });

    expect(harness.createProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:80/");
  });

  it("accepts a Codex loopback proxy URL without a literal trailing slash", () => {
    const harness = createHarness();
    createCodexWeatherProxyTransport({
      environment: activeEnvironment({
        HTTP_PROXY: "http://127.0.0.1:38123",
        HTTPS_PROXY: "http://127.0.0.1:38123",
      }),
      dependencies: harness.dependencies,
    });

    expect(harness.createProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:38123");
  });

  it.each([
    ["missing marker", { CODEX_NETWORK_PROXY_ACTIVE: undefined }],
    ["wrong marker", { CODEX_NETWORK_PROXY_ACTIVE: "true" }],
    ["network disabled", { CODEX_SANDBOX_NETWORK_DISABLED: "1" }],
    ["missing HTTPS proxy", { HTTPS_PROXY: undefined }],
    ["different origins", { HTTPS_PROXY: "http://127.0.0.1:38124/" }],
    ["non-http scheme", { HTTPS_PROXY: "https://127.0.0.1:38123/", HTTP_PROXY: "https://127.0.0.1:38123/" }],
    ["hostname alias", { HTTPS_PROXY: "http://localhost:38123/", HTTP_PROXY: "http://localhost:38123/" }],
    ["no explicit port", { HTTPS_PROXY: "http://127.0.0.1/", HTTP_PROXY: "http://127.0.0.1/" }],
    ["credential", { HTTPS_PROXY: "http://secret:credential@127.0.0.1:38123/", HTTP_PROXY: "http://secret:credential@127.0.0.1:38123/" }],
    ["non-root path", { HTTPS_PROXY: "http://127.0.0.1:38123/proxy", HTTP_PROXY: "http://127.0.0.1:38123/proxy" }],
    ["query", { HTTPS_PROXY: "http://127.0.0.1:38123/?private=1", HTTP_PROXY: "http://127.0.0.1:38123/?private=1" }],
    ["fragment", { HTTPS_PROXY: "http://127.0.0.1:38123/#private", HTTP_PROXY: "http://127.0.0.1:38123/#private" }],
  ])("rejects %s before constructing a dispatcher", (_name, overrides) => {
    const harness = createHarness();

    expect(() => createCodexWeatherProxyTransport({
      environment: activeEnvironment(overrides),
      dependencies: harness.dependencies,
    })).toThrow("WEATHER_PROXY_ENV_INVALID");
    expect(harness.createProxyAgent).not.toHaveBeenCalled();
  });

  it("never exposes proxy credentials through the public environment failure", () => {
    const sentinel = "SENTINEL_PROXY_CREDENTIAL";
    const harness = createHarness();
    let failure: unknown;
    try {
      createCodexWeatherProxyTransport({
        environment: activeEnvironment({
          HTTPS_PROXY: `http://${sentinel}@127.0.0.1:38123/`,
          HTTP_PROXY: `http://${sentinel}@127.0.0.1:38123/`,
        }),
        dependencies: harness.dependencies,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(String(failure)).toBe("Error: WEATHER_PROXY_ENV_INVALID");
    expect(JSON.stringify(failure)).not.toContain(sentinel);
  });

  it("maps dispatcher construction failures to a stable public error", () => {
    const sentinel = "PRIVATE_PROXY_FACTORY_DETAIL";
    const harness = createHarness();
    harness.createProxyAgent.mockImplementation(() => {
      throw new Error(sentinel);
    });

    let failure: unknown;
    try {
      createCodexWeatherProxyTransport({
        environment: activeEnvironment(),
        dependencies: harness.dependencies,
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(String(failure)).toBe("Error: WEATHER_PROXY_TRANSPORT_CREATE_FAILED");
    expect(String(failure)).not.toContain(sentinel);
  });

  it("dispatches only the fixed GET/manual weather request and closes idempotently", async () => {
    const harness = createHarness();
    const transport = createCodexWeatherProxyTransport({
      environment: activeEnvironment(),
      dependencies: harness.dependencies,
    });
    const controller = new AbortController();

    await expect(transport.fetch(WEATHER_URL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "text/html" },
    })).resolves.toBeInstanceOf(Response);
    await expect(Promise.all([transport.close(), transport.close()])).resolves.toEqual([undefined, undefined]);

    expect(harness.fetch).toHaveBeenCalledWith(
      WEATHER_URL,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        dispatcher: harness.dispatcher,
      }),
    );
    expect(harness.dispatcher.close).toHaveBeenCalledTimes(1);
    await expect(transport.fetch(WEATHER_URL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    })).rejects.toThrow("WEATHER_PROXY_TRANSPORT_CLOSED");
  });

  it.each([
    "http://www.weather.com.cn/weather/101190112.shtml",
    "https://www.weather.com.cn/weather/101190112.shtml?drift=1",
    "https://www.weather.com.cn/weather/101190111.shtml",
  ])("rejects request drift before dispatch: %s", async (url) => {
    const harness = createHarness();
    const transport = createCodexWeatherProxyTransport({
      environment: activeEnvironment(),
      dependencies: harness.dependencies,
    });
    const controller = new AbortController();

    await expect(transport.fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    })).rejects.toThrow("WEATHER_PROXY_TRANSPORT_REQUEST_INVALID");
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a forged signal-shaped object", Object.freeze({ aborted: false })],
  ])("rejects %s before dispatch", async (_name, signal) => {
    const harness = createHarness();
    const transport = createCodexWeatherProxyTransport({
      environment: activeEnvironment(),
      dependencies: harness.dependencies,
    });

    await expect(transport.fetch(WEATHER_URL, {
      method: "GET",
      redirect: "manual",
      signal: signal as AbortSignal,
    })).rejects.toThrow("WEATHER_PROXY_TRANSPORT_REQUEST_INVALID");
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["method", { method: "POST", redirect: "manual", signal: new AbortController().signal }],
    ["redirect", { method: "GET", redirect: "follow", signal: new AbortController().signal }],
    ["signal", { method: "GET", redirect: "manual" }],
  ])("rejects %s drift before dispatch", async (_name, init) => {
    const harness = createHarness();
    const transport = createCodexWeatherProxyTransport({
      environment: activeEnvironment(),
      dependencies: harness.dependencies,
    });

    await expect(transport.fetch(
      WEATHER_URL,
      init as RequestInit & { redirect: "manual" },
    )).rejects.toThrow("WEATHER_PROXY_TRANSPORT_REQUEST_INVALID");
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it("closes each research dispatcher, closes the long-lived bootstrap idempotently, and aggregates failures", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const transport: WeatherProxyTransport = {
      fetch: vi.fn(() => Promise.resolve(weatherResponse())),
      close,
    };
    const research = createDailyCareWeatherResearch({
      now: () => new Date("2026-08-22T22:35:00.000Z"),
      createTransport: () => transport,
    });

    await expect(research.research(morningSlot())).resolves.toMatchObject({
      localDate: "2026-08-23",
      sourceUrl: WEATHER_URL,
    });
    await expect(Promise.all([research.close(), research.close()])).resolves.toEqual([undefined, undefined]);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(research.research(morningSlot())).rejects.toThrow("DAILY_CARE_WEATHER_BOOTSTRAP_CLOSED");

    const failingResearch = createDailyCareWeatherResearch({
      createTransport: () => ({
        fetch: vi.fn(() => Promise.reject(new Error("PRIMARY_FIXTURE_FAILURE"))),
        close: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("CLOSE_FIXTURE_FAILURE")),
      }),
    });
    const failure = await failingResearch.research(morningSlot()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String)).toEqual([
      "Error: DAILY_CARE_WEATHER_EVIDENCE_INVALID",
      "Error: DAILY_CARE_WEATHER_TRANSPORT_CLOSE_FAILED",
    ]);
  });
});

function activeEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    CODEX_NETWORK_PROXY_ACTIVE: "1",
    HTTP_PROXY: "http://127.0.0.1:38123/",
    HTTPS_PROXY: "http://127.0.0.1:38123/",
    ...overrides,
  };
}

function createHarness(): {
  dependencies: WeatherProxyTransportDependencies;
  dispatcher: { close: ReturnType<typeof vi.fn> };
  createProxyAgent: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
} {
  const dispatcher = { close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
  const createProxyAgent = vi.fn(() => dispatcher);
  const fetch = vi.fn(() => Promise.resolve(new Response("ok", {
    headers: { "content-type": "text/html" },
  })));
  return {
    dependencies: { createProxyAgent, fetch },
    dispatcher,
    createProxyAgent,
    fetch,
  };
}

function morningSlot(): DailyCareSlot {
  return {
    slotKey: "2026-08-23/morning",
    localDate: "2026-08-23",
    kind: "morning",
    targetMode: "production",
  };
}

function weatherResponse(): Response {
  const html = [
    "<!doctype html><html><head>",
    "<title>示例城区天气预报,示例城区7天天气预报</title>",
    "<script>var fc_24h_internal_update_time = \"2026082306\";</script>",
    "</head><body><ul class=\"t clearfix\">",
    "<li class=\"sky skyid lv2 on\"><h1>23日（今天）</h1><p class=\"wea\">多云</p><p class=\"tem\"><span>32</span>/<i>25℃</i></p></li>",
    "</ul></body></html>",
  ].join("");
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
