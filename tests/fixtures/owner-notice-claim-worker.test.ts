import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";
import type { z } from "zod";

import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { StateRepository } from "../../src/storage/repositories.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}

  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

class ReadBarrierEncryptedStore extends EncryptedStore {
  public constructor(
    rootDir: string,
    keyProvider: KeyProvider,
    private readonly workerId: string,
  ) {
    super(rootDir, keyProvider);
  }

  public override async read<T>(relativePath: string, schema: z.ZodType<T>): Promise<T | null> {
    const value = await super.read(relativePath, schema);
    if (relativePath === "state/target-reply.enc") {
      await writeFile(path.join(requiredEnv("OWNER_NOTICE_ROOT"), `read-ready-${this.workerId}`), "", {
        flag: "wx",
      });
      await waitForPath(path.join(requiredEnv("OWNER_NOTICE_ROOT"), "read-release"));
    }
    return value;
  }
}

const workerTest = process.env.OWNER_NOTICE_WORKER === "1" ? test : test.skip;

workerTest("claims an owner notice in one independent process", async () => {
  const rootDir = requiredEnv("OWNER_NOTICE_ROOT");
  const workerId = requiredEnv("OWNER_NOTICE_WORKER_ID");
  const store = new ReadBarrierEncryptedStore(
    rootDir,
    new FixedKeyProvider(Buffer.from(requiredEnv("OWNER_NOTICE_KEY_HEX"), "hex")),
    workerId,
  );
  const repository = new StateRepository(store);
  await writeFile(path.join(rootDir, `ready-${workerId}`), "", { flag: "wx" });
  await waitForPath(path.join(rootDir, "start-release"));

  const claim = await repository.claimOwnerNotice({
    triggerIdHash: requiredEnv("OWNER_NOTICE_TRIGGER_HASH"),
    reasonCode: requiredEnv("OWNER_NOTICE_REASON"),
  });
  await writeFile(
    requiredEnv("OWNER_NOTICE_RESULT_PATH"),
    JSON.stringify({ claimed: claim !== null }),
    { flag: "wx" },
  );

  expect(claim === null || /^[a-f0-9]{64}$/u.test(claim.noticeId)).toBe(true);
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
  throw new Error(`WAIT_TIMEOUT:${path.basename(filePath)}`);
}
