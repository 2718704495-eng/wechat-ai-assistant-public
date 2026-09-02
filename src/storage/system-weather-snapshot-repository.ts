import type { SystemWeatherSnapshot } from "../daily-care/system-weather.js";
import { systemWeatherSnapshotSchema } from "../daily-care/system-weather.js";
import type { EncryptedStore } from "./encrypted-store.js";

const SNAPSHOT_PATH = "state/system-weather-snapshot.enc";

export class SystemWeatherSnapshotRepository {
  public constructor(private readonly store: EncryptedStore) {}

  public async read(): Promise<SystemWeatherSnapshot> {
    const stored = await this.store.read(SNAPSHOT_PATH, systemWeatherSnapshotSchema);
    if (stored === null) throw new Error("SYSTEM_WEATHER_SNAPSHOT_MISSING");
    return stored;
  }

  public async save(value: unknown): Promise<void> {
    let snapshot: SystemWeatherSnapshot;
    try {
      snapshot = systemWeatherSnapshotSchema.parse(value);
    } catch {
      throw new Error("SYSTEM_WEATHER_SNAPSHOT_INVALID");
    }
    await this.store.write(SNAPSHOT_PATH, snapshot);
  }
}
