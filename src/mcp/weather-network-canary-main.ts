import { fileURLToPath } from "node:url";

import { runWeatherNetworkCanary } from "./weather-network-canary.js";

export async function runWeatherNetworkCanaryMain(
  argv: readonly string[] = process.argv,
): Promise<void> {
  if (argv.length !== 2) throw new Error("WEATHER_NETWORK_CANARY_ARGUMENTS_INVALID");
  const receipt = await runWeatherNetworkCanary();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runWeatherNetworkCanaryMain().catch(() => {
    process.exitCode = 1;
    process.stderr.write("WEATHER_NETWORK_CANARY_FAILED\n");
  });
}
