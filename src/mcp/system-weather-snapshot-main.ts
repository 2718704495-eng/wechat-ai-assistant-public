import path from "node:path";
import { fileURLToPath } from "node:url";

import { MacOSKeychainKeyProvider } from "../security/keychain.js";
import { EncryptedStore } from "../storage/encrypted-store.js";
import { SystemWeatherSnapshotRepository } from
  "../storage/system-weather-snapshot-repository.js";
import {
  produceSystemWeatherSnapshot,
  runAppleSystemWeatherScript,
} from "./system-weather-snapshot-producer.js";

export async function runSystemWeatherSnapshotMain(
  argv: readonly string[] = process.argv,
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (argv.length !== 2) throw new Error("SYSTEM_WEATHER_SNAPSHOT_ARGUMENTS_INVALID");
  const dataDir = environment.CHAT_ASSISTANT_DATA_DIR;
  const home = environment.HOME;
  if (dataDir === undefined || !path.isAbsolute(dataDir) ||
      home === undefined || !path.isAbsolute(home)) {
    throw new Error("SYSTEM_WEATHER_SNAPSHOT_ENVIRONMENT_INVALID");
  }
  const releaseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const scriptPath = path.join(releaseRoot, "bin", "system-weather-snapshot.swift");
  const repository = new SystemWeatherSnapshotRepository(
    new EncryptedStore(dataDir, new MacOSKeychainKeyProvider()),
  );
  await produceSystemWeatherSnapshot({
    scriptPath,
    dependencies: {
      runSwift: (candidate) => runAppleSystemWeatherScript({ scriptPath: candidate, home }),
      saveSnapshot: (snapshot) => repository.save(snapshot),
    },
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runSystemWeatherSnapshotMain().catch(() => {
    process.exitCode = 1;
    process.stderr.write("SYSTEM_WEATHER_SNAPSHOT_FAILED\n");
  });
}
