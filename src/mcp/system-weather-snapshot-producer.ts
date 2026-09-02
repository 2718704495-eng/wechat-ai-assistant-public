import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  systemWeatherSnapshotSchema,
  type SystemWeatherSnapshot,
} from "../daily-care/system-weather.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 4 * 1024;
const TIMEOUT_MS = 15_000;

export interface SystemWeatherSnapshotProducerDependencies {
  runSwift(scriptPath: string): Promise<{ stdout: string }>;
  saveSnapshot(snapshot: SystemWeatherSnapshot): Promise<void>;
}

export async function produceSystemWeatherSnapshot(input: {
  scriptPath: string;
  dependencies: SystemWeatherSnapshotProducerDependencies;
}): Promise<{ stored: true; eventDate: string }> {
  if (input.scriptPath.length === 0) throw new Error("SYSTEM_WEATHER_SCRIPT_INVALID");
  let stdout: string;
  try {
    ({ stdout } = await input.dependencies.runSwift(input.scriptPath));
  } catch {
    throw new Error("SYSTEM_WEATHER_SNAPSHOT_FAILED");
  }
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES ||
      !stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n")) {
    throw new Error("SYSTEM_WEATHER_SNAPSHOT_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("SYSTEM_WEATHER_SNAPSHOT_INVALID");
  }
  let snapshot: SystemWeatherSnapshot;
  try {
    snapshot = systemWeatherSnapshotSchema.parse(parsed);
  } catch {
    throw new Error("SYSTEM_WEATHER_SNAPSHOT_INVALID");
  }
  try {
    await input.dependencies.saveSnapshot(snapshot);
  } catch {
    throw new Error("SYSTEM_WEATHER_SNAPSHOT_STORE_FAILED");
  }
  return { stored: true, eventDate: snapshot.eventDate };
}

export function runAppleSystemWeatherScript(options: {
  scriptPath: string;
  home: string;
}): Promise<{ stdout: string }> {
  return execFileAsync("/usr/bin/swift", [options.scriptPath], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: {
      HOME: options.home,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
    },
  }).then(({ stdout }) => ({ stdout }));
}
