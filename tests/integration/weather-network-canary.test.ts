import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runWeatherNetworkCanary } from "../../src/mcp/weather-network-canary.js";
import { runWeatherNetworkCanaryMain } from "../../src/mcp/weather-network-canary-main.js";
import type { OfficialFetch } from "../../src/mcp/official-research-executor.js";
import type { WeatherProxyTransport } from "../../src/mcp/weather-proxy-transport.js";

const fixedUrl = "https://www.weather.com.cn/weather/101190112.shtml";
const now = () => new Date("2026-08-22T22:35:00.000Z");

describe("formal production weather network canary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the production research bootstrap exactly once and returns a bounded no-UI receipt", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const officialFetch: OfficialFetch = (url, init) => {
      requests.push({ url, init });
      return Promise.resolve(new Response(weatherHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("UNEXPECTED_GLOBAL_FETCH"))));

    const receipt = await runWeatherNetworkCanary({ officialFetch, now });
    expect(receipt).toEqual({
      schemaVersion: 1,
      status: "verified",
      localDate: "2026-08-23",
      sourceHost: "www.weather.com.cn",
      sourcePath: "/weather/101190112.shtml",
      requestCount: 1,
      uiOperations: 0,
      submitCount: 0,
      factHash: receipt.factHash,
    });
    expect(receipt.factHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: fixedUrl,
      init: { method: "GET", redirect: "manual" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses and closes the restricted proxy transport on the production default path", async () => {
    const proxyFetch = vi.fn<OfficialFetch>(() => Promise.resolve(
      new Response(weatherHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ));
    const proxyClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const transport: WeatherProxyTransport = { fetch: proxyFetch, close: proxyClose };
    const createTransport = vi.fn(() => transport);
    const globalFetch = vi.fn(() => Promise.reject(new Error("UNEXPECTED_GLOBAL_FETCH")));
    vi.stubGlobal("fetch", globalFetch);

    await expect(runWeatherNetworkCanary({ createTransport, now }))
      .resolves.toMatchObject({ status: "verified", requestCount: 1 });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(proxyClose).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("fails closed without constructing UI or send dependencies", async () => {
    const officialFetch = vi.fn<OfficialFetch>(() => Promise.resolve(
      new Response("<html><title>broken</title></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ));

    await expect(runWeatherNetworkCanary({ officialFetch, now }))
      .rejects.toThrow("WEATHER_NETWORK_CANARY_UNVERIFIED");
    expect(officialFetch).toHaveBeenCalledTimes(1);

    const source = await readFile(
      path.join(process.cwd(), "src", "mcp", "weather-network-canary.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /NativeBridge|NativeWechatSurface|WeChatSurface|acquireLiveOperationCoordinator|assertSendGate/u,
    );
  });

  it("maps transport factory failures to the bounded public canary error", async () => {
    const sentinel = "PRIVATE_FACTORY_SENTINEL";
    const createTransport = vi.fn((): WeatherProxyTransport => {
      throw new Error(sentinel);
    });
    const globalFetch = vi.fn(() => Promise.reject(new Error("UNEXPECTED_GLOBAL_FETCH")));
    vi.stubGlobal("fetch", globalFetch);

    const failure = await runWeatherNetworkCanary({ createTransport, now })
      .catch((error: unknown) => error);
    expect(String(failure)).toBe("Error: WEATHER_NETWORK_CANARY_UNVERIFIED");
    expect(String(failure)).not.toContain(sentinel);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("rejects argv input before any network operation", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("UNEXPECTED_FETCH")));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(runWeatherNetworkCanaryMain(["node", "canary", "extra"]))
      .rejects.toThrow("WEATHER_NETWORK_CANARY_ARGUMENTS_INVALID");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects wrapper argv before executing the Node entry point", async () => {
    const wrapperPath = path.join(
      process.cwd(),
      "runtime-bin",
      "weather-network-canary",
    );
    const wrapper = await readFile(wrapperPath, "utf8");
    expect(wrapper).toMatch(
      /set -eu\n\nif \[ "\$#" -ne 0 \]; then\n {2}printf '%s\\n' 'WEATHER_NETWORK_CANARY_FAILED' >&2\n {2}exit 1\nfi\n\nscript_dir=/u,
    );

    const child = spawn(wrapperPath, ["extra"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const [code, signal] = await once(child, "exit") as [
      number | null,
      NodeJS.Signals | null,
    ];
    expect({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }).toEqual({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "WEATHER_NETWORK_CANARY_FAILED\n",
    });
  });
});

function weatherHtml(): string {
  return `<!doctype html><html><head>
    <title>示例城区天气预报,示例城区7天天气预报</title>
    <script>var fc_24h_internal_update_time = "2026082306";</script>
  </head><body><ul class="t clearfix">
    <li class="sky skyid lv2 on"><h1>23日（今天）</h1><p class="wea">多云</p><p class="tem"><span>32</span>/<i>25℃</i></p></li>
  </ul></body></html>`;
}
