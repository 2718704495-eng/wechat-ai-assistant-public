import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { isComfortStationWakeRequest } from "../../src/mcp/live-runtime.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { ComfortStationDeliveryRepository } from
  "../../src/storage/comfort-station-delivery-repository.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

describe("comfort-station explicit wake delivery", () => {
  let root: string;
  let store: EncryptedStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "comfort-station-delivery-"));
    await initializeTestKernelLockCatalog(root);
    store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
  });

  afterEach(async () => {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  });

  test("accepts only the explicit allowlisted wake phrases", () => {
    for (const text of [
      "示例用户",
      " 示例用户。 ",
      "示例用户！",
      "示例用户?",
      "示例用户？",
    ]) {
      expect(isComfortStationWakeRequest(text), text).toBe(true);
    }
    for (const text of [
      "打开安心小站",
      "请打开安心小站。",
      "不要叫示例用户",
      "她说示例用户",
      "示例用户，胃不舒服怎么办",
      "示例用户在吗",
      "示例用户 示例用户",
      "不要打开安心小站",
      "她说打开安心小站",
      "打开安心小站再聊聊",
      "打开安心小站 打开安心小站",
      "在吗",
      "安心小站",
      "帮帮我",
    ]) {
      expect(isComfortStationWakeRequest(text), text).toBe(false);
    }
  });

  test("atomically allows one durable intent and makes uncertain terminal across instances", async () => {
    const input = {
      deliveryKey: "a1".repeat(32),
      triggerMessageIdHash: "b2".repeat(32),
      cardSha256: "c3".repeat(32),
      createdAt: "2026-08-30T03:30:00.000Z",
    };
    const attempts = await Promise.all(Array.from({ length: 8 }, () =>
      new ComfortStationDeliveryRepository(store).claim(input)
    ));
    expect(attempts.filter(({ claimed }) => claimed)).toHaveLength(1);
    expect(attempts.filter(({ claimed }) => !claimed)).toHaveLength(7);

    const repository = new ComfortStationDeliveryRepository(store);
    await repository.markUncertain(input.deliveryKey, "2026-08-30T03:30:01.000Z");
    await expect(repository.claim(input)).resolves.toMatchObject({
      claimed: false,
      record: { status: "uncertain", cardSha256: input.cardSha256 },
    });
    await expect(repository.markVerified(
      input.deliveryKey,
      "2026-08-30T03:30:02.000Z",
    )).rejects.toThrow("COMFORT_STATION_DELIVERY_STATE_INVALID");
  });
});

async function makeTreeWritable(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await chmod(directory, 0o700);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeTreeWritable(target);
    } else if (!entry.isSymbolicLink()) {
      await chmod(target, 0o600);
    }
  }
}
