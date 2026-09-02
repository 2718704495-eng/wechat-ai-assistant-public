import { access, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(32, 7));
  }
}

const lockRelativePath = "state/daily-care-broadcasts.lock";

describe("EncryptedStore kernel-backed transaction", () => {
  let rootDir: string;
  let store: EncryptedStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "encrypted-store-kernel-"));
    await initializeTestKernelLockCatalog(rootDir);
    store = new EncryptedStore(rootDir, new FixedKeyProvider());
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("keeps a permanent regular gate while releasing the advisory lock after success and failure", async () => {
    await expect(store.runExclusiveTransaction(lockRelativePath, () => Promise.resolve("first")))
      .resolves.toBe("first");
    const gateDirectory = path.join(rootDir, "state", ".kernel-lock-v1");
    const initialEntries = await readdir(gateDirectory);
    expect(initialEntries).toHaveLength(8);
    const gateName = initialEntries.find((name) => name ===
      "8cb3f57a0604c5e68e2c1efd32fd7bf8c22b27e7896cfff9d2840f91c77ea6ff.gate");
    if (gateName === undefined) throw new Error("KERNEL_GATE_NOT_CREATED");
    const initialGate = await lstat(path.join(gateDirectory, gateName));

    await expect(store.runExclusiveTransaction(
      lockRelativePath,
      () => Promise.reject(new Error("EXPECTED_OPERATION_FAILURE")),
    )).rejects.toThrow("EXPECTED_OPERATION_FAILURE");
    await expect(store.runExclusiveTransaction(lockRelativePath, () => Promise.resolve("second")))
      .resolves.toBe("second");

    expect(await lstat(path.join(gateDirectory, gateName))).toMatchObject({
      dev: initialGate.dev,
      ino: initialGate.ino,
    });
    await expect(access(path.join(rootDir, lockRelativePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes a second store behind an active callback", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = store.runExclusiveTransaction(lockRelativePath, async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first-end");
    });
    while (releaseFirst === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const secondStore = new EncryptedStore(rootDir, new FixedKeyProvider());
    const second = secondStore.runExclusiveTransaction(lockRelativePath, () => {
      order.push("second");
      return Promise.resolve();
    });
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
