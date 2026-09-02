import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import type { KeyProvider } from "../../src/security/keychain.js";
import { DailyCareBroadcastRepository } from "../../src/storage/daily-care-broadcast-repository.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

const workerTest = process.env.DAILY_CARE_CLAIM_WORKER === "1" ? test : test.skip;
const hydrateWorkerTest = process.env.DAILY_CARE_HYDRATE_WORKER === "1" ? test : test.skip;

workerTest("claims one daily-care slot in an independent process", async () => {
  const root = requiredEnv("DAILY_CARE_CLAIM_ROOT");
  const workerId = requiredEnv("DAILY_CARE_CLAIM_WORKER_ID");
  const repository = new DailyCareBroadcastRepository(new EncryptedStore(
    root,
    new FixedKeyProvider(Buffer.from(requiredEnv("DAILY_CARE_CLAIM_KEY_HEX"), "hex")),
  ));
  await writeFile(path.join(root, `ready-${workerId}`), "", { flag: "wx" });
  await waitForPath(path.join(root, "start"));
  let claimed = true;
  try {
    await repository.claimSlot({
      slot: {
        slotKey: `test/${"c".repeat(64)}`,
        localDate: "2026-08-23",
        kind: "morning",
        targetMode: "test",
      },
      targetConversationId: "file-transfer",
      targetModeHash: "d".repeat(64),
    });
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== "BROADCAST_SLOT_ALREADY_CLAIMED") throw error;
    claimed = false;
  }
  await writeFile(requiredEnv("DAILY_CARE_CLAIM_RESULT_PATH"), JSON.stringify({ claimed }), {
    flag: "wx",
  });
  expect(typeof claimed).toBe("boolean");
});

hydrateWorkerTest("hydrates one daily-care slot in an independent process", async () => {
  const root = requiredEnv("DAILY_CARE_CLAIM_ROOT");
  const workerId = requiredEnv("DAILY_CARE_CLAIM_WORKER_ID");
  const repository = new DailyCareBroadcastRepository(new EncryptedStore(
    root,
    new FixedKeyProvider(Buffer.from(requiredEnv("DAILY_CARE_CLAIM_KEY_HEX"), "hex")),
  ));
  await writeFile(path.join(root, `ready-${workerId}`), "", { flag: "wx" });
  await waitForPath(path.join(root, "start"));
  const record = await repository.claimOrHydrateSlot({
    slot: {
      slotKey: `test/${"c".repeat(64)}`,
      localDate: "2026-08-23",
      kind: "morning",
      targetMode: "test",
    },
    targetConversationId: "file-transfer",
    targetModeHash: "d".repeat(64),
  });
  await writeFile(requiredEnv("DAILY_CARE_CLAIM_RESULT_PATH"), JSON.stringify({
    sessionAttemptCount: record.sessionAttemptCount,
  }), { flag: "wx" });
  expect(record.status).toBe("pending");
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`MISSING_${name}`);
  return value;
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("WAIT_TIMEOUT");
}
