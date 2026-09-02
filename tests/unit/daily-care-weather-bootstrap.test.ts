import { describe, expect, it, vi } from "vitest";

import type { DailyCareSlot } from "../../src/daily-care/types.js";
import { createDailyCareWeatherResearch } from "../../src/mcp/daily-care-weather-bootstrap.js";
import type { OfficialFetch } from "../../src/mcp/official-research-executor.js";
import type { WeatherProxyTransport } from "../../src/mcp/weather-proxy-transport.js";
import type { WeatherProxyTransportDependencies } from "../../src/mcp/weather-proxy-transport.js";

const NOW = new Date("2026-08-23T00:05:00.000Z");
const MORNING_SLOT: DailyCareSlot = Object.freeze({
  slotKey: "2026-08-23/morning",
  localDate: "2026-08-23",
  kind: "morning",
  targetMode: "production",
});
const NIGHT_SLOT: DailyCareSlot = Object.freeze({
  slotKey: "2026-08-23/night",
  localDate: "2026-08-23",
  kind: "night",
  targetMode: "production",
});

describe("daily-care weather proxy lifecycle", () => {
  it("binds its explicit production environment to the default transport factory", async () => {
    const dispatcher = { close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
    const createProxyAgent = vi.fn(() => dispatcher);
    const dependencies: WeatherProxyTransportDependencies = {
      createProxyAgent,
      fetch: vi.fn(() => Promise.resolve(validWeatherResponse())),
    };
    const environment = {
      CODEX_NETWORK_PROXY_ACTIVE: "1",
      HTTP_PROXY: "http://127.0.0.1:38123/",
      HTTPS_PROXY: "http://127.0.0.1:38123/",
    };
    const research = createDailyCareWeatherResearch({
      now: () => new Date(NOW),
      environment,
      transportDependencies: dependencies,
    });

    await expect(research.research(MORNING_SLOT)).resolves.toMatchObject({
      localDate: "2026-08-23",
      sourceUrl: "https://www.weather.com.cn/weather/101190112.shtml",
    });
    expect(createProxyAgent).toHaveBeenCalledWith("http://127.0.0.1:38123/");
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
    await research.close();
  });

  it("rejects a night slot before creating any transport resource", async () => {
    const fetch = vi.fn<OfficialFetch>();
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const createTransport = vi.fn((): WeatherProxyTransport => ({ fetch, close }));
    const research = createDailyCareWeatherResearch({ createTransport });

    await expect(research.research(NIGHT_SLOT))
      .rejects.toThrow("DAILY_CARE_WEATHER_NOT_ALLOWED");
    expect(createTransport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await research.close();
  });

  it.each([
    ["HTTP failure", { status: 503, contentType: "text/html" }],
    ["non-HTML response", { status: 200, contentType: "image/png" }],
  ])("cancels an unread %s body before closing its dispatcher", async (_name, input) => {
    const events: string[] = [];
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        events.push("body-cancelled");
      },
    }), {
      status: input.status,
      headers: { "content-type": input.contentType },
    });
    const research = createDailyCareWeatherResearch({
      now: () => new Date(NOW),
      createTransport: () => transportFor(response, events),
    });

    await expect(research.research(MORNING_SLOT))
      .rejects.toThrow("DAILY_CARE_WEATHER_EVIDENCE_INVALID");
    expect(events).toEqual(["body-cancelled", "dispatcher-closed"]);
    await research.close();
  });

  it("waits for an abort-driven body cancellation before closing its dispatcher", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let finishCancellation: (() => void) | undefined;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        events.push("body-cancel-started");
        return new Promise<void>((resolve) => {
          finishCancellation = () => {
            events.push("body-cancel-finished");
            resolve();
          };
        });
      },
    }), { headers: { "content-type": "text/html" } });
    const research = createDailyCareWeatherResearch({
      now: () => new Date(NOW),
      createTransport: () => transportFor(response, events),
    });

    try {
      const result = research.research(MORNING_SLOT);
      await vi.advanceTimersByTimeAsync(8_001);
      expect(events).toContain("body-cancel-started");
      expect(events).not.toContain("dispatcher-closed");
      finishCancellation?.();
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).rejects.toThrow("DAILY_CARE_WEATHER_EVIDENCE_INVALID");
      expect(events).toEqual([
        "body-cancel-started",
        "body-cancel-finished",
        "dispatcher-closed",
      ]);
      await research.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps primary and close failures in stable order without dependency details", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({}), {
      status: 503,
      headers: { "content-type": "text/html" },
    });
    const fetch: OfficialFetch = () => Promise.resolve(response);
    const research = createDailyCareWeatherResearch({
      now: () => new Date(NOW),
      createTransport: () => ({
        fetch,
        close: () => Promise.reject(new Error("PRIVATE_PROXY_CLOSE_DETAIL")),
      }),
    });

    const failure = await research.research(MORNING_SLOT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: "DAILY_CARE_WEATHER_RESEARCH_FAILED" });
    expect((failure as AggregateError).errors.map(String)).toEqual([
      "Error: DAILY_CARE_WEATHER_EVIDENCE_INVALID",
      "Error: DAILY_CARE_WEATHER_TRANSPORT_CLOSE_FAILED",
    ]);
    expect(String(failure)).not.toContain("PRIVATE_PROXY_CLOSE_DETAIL");
    await research.close();
  });
});

function transportFor(response: Response, events: string[]): WeatherProxyTransport {
  return {
    fetch: () => Promise.resolve(response),
    close: () => {
      events.push("dispatcher-closed");
      return Promise.resolve();
    },
  };
}

function validWeatherResponse(): Response {
  return new Response(`<!doctype html><html><head>
    <title>示例城区天气预报,示例城区7天天气预报</title>
    <script>var fc_24h_internal_update_time = "2026082308";</script>
  </head><body><ul class="t clearfix">
    <li class="sky skyid lv2 on"><h1>23日（今天）</h1>
      <p class="wea">多云</p><p class="tem"><span>32</span>/<i>25℃</i></p>
    </li>
  </ul></body></html>`, { headers: { "content-type": "text/html" } });
}
