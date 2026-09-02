import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

interface KernelLease {
  readonly gateIdentity: { dev: number; ino: number };
  readonly gatePath: string;
  close(): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

interface KernelLockModule {
  acquireKernelLease(options: {
    dataRoot: string;
    purpose: string;
    addonPath?: string;
    expectedAddonSha256?: string;
  }): Promise<KernelLease>;
  validateKernelLockAddonApi(addon: unknown): void;
}

class FixedKeyProvider implements KeyProvider {
  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(32, 3));
  }
}

const transactionPurpose = "encrypted-store-global";
const transactionLockPath = "state/daily-care-broadcasts.lock";

describe("Round 6 process-internal kernel lock", () => {
  let rootDir: string;
  const children = new Set<ChildProcess>();

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "kernel-lock-round6-"));
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  it("excludes a second process, releases the same inode after SIGKILL, and excludes independent same-process leases", async () => {
    const kernel = await kernelLockModule();
    await initializeTestKernelLockCatalog(rootDir);
    const owner = spawnOwner("owner");
    const ownerAcquired = await waitForJson(path.join(rootDir, "acquired-owner.json"));
    const ownerIdentity = ownerAcquired.gateIdentity as { dev: number; ino: number };

    await expect(kernel.acquireKernelLease({ dataRoot: rootDir, purpose: transactionPurpose }))
      .rejects.toThrow("KERNEL_LOCK_BUSY");

    expect(owner.kill("SIGKILL")).toBe(true);
    const killed = await waitForChild(owner);
    expect(killed).toMatchObject({ code: null, signal: "SIGKILL" });

    const recovered = await kernel.acquireKernelLease({ dataRoot: rootDir, purpose: transactionPurpose });
    expect(recovered.gateIdentity).toEqual(ownerIdentity);
    await expect(kernel.acquireKernelLease({ dataRoot: rootDir, purpose: transactionPurpose }))
      .rejects.toThrow("KERNEL_LOCK_BUSY");
    await recovered.close();
  }, 20_000);

  it("rejects a project-controlled gate replacement before either callback can become a second winner", async () => {
    const kernel = await kernelLockModule();
    await initializeTestKernelLockCatalog(rootDir);
    const first = await kernel.acquireKernelLease({ dataRoot: rootDir, purpose: transactionPurpose });
    const archivedGate = `${first.gatePath}.round6-replacement`;
    await rename(first.gatePath, archivedGate);
    await writeFile(first.gatePath, "", { flag: "wx", mode: 0o600 });

    let callbackEntered = false;
    await expect(first.runExclusive(() => {
      callbackEntered = true;
      return Promise.resolve();
    })).rejects.toThrow("KERNEL_LOCK_OWNERSHIP_LOST");
    expect(callbackEntered).toBe(false);
    await expect(kernel.acquireKernelLease({ dataRoot: rootDir, purpose: transactionPurpose }))
      .rejects.toThrow("KERNEL_LOCK_CATALOG_INVALID");
    await expect(first.close()).rejects.toThrow("KERNEL_LOCK_OWNERSHIP_LOST");
  });

  it.each([
    transactionLockPath,
    "state/.daily-care-broadcasts.lock.recovery.claim",
    "state/.daily-care-broadcasts.lock.recovery-nonce.candidate",
  ])("fails closed at runtime for legacy artifact %s without removing it", async (legacyPath) => {
    await initializeTestKernelLockCatalog(rootDir);
    const artifactPath = path.join(rootDir, legacyPath);
    await mkdir(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
    const serialized = legacyPath === transactionLockPath
      ? JSON.stringify({
        version: 1,
        nonce: randomUUID(),
        purpose: transactionPurpose,
        pid: 999_999,
        processStartedAt: "2001-01-01T00:00:00.000Z",
        bootIdentity: "darwin:1:1",
        acquiredAt: "2001-01-01T00:00:00.000Z",
      })
      : JSON.stringify({ legacy: randomUUID() });
    await writeFile(artifactPath, serialized, { flag: "wx", mode: 0o600 });
    const before = await lstat(artifactPath);
    const store = new EncryptedStore(rootDir, new FixedKeyProvider());
    let callbackEntered = false;

    await expect(store.runExclusiveTransaction(transactionLockPath, () => {
      callbackEntered = true;
      return Promise.resolve();
    })).rejects.toThrow("KERNEL_LOCK_LEGACY_ARTIFACT_PRESENT");

    expect(callbackEntered).toBe(false);
    expect(await readFile(artifactPath, "utf8")).toBe(serialized);
    expect(await lstat(artifactPath)).toMatchObject({ dev: before.dev, ino: before.ino });
  });

  it("fails missing and hash-invalid native addons before a lock-state directory is created", async () => {
    const kernel = await kernelLockModule();
    const missing = path.join(rootDir, "missing.node");
    await expect(kernel.acquireKernelLease({
      dataRoot: rootDir,
      purpose: transactionPurpose,
      addonPath: missing,
    })).rejects.toThrow("KERNEL_LOCK_ADDON_MISSING");
    await expect(access(path.join(rootDir, "state"))).rejects.toMatchObject({ code: "ENOENT" });

    const malformed = path.join(rootDir, "hash-invalid.node");
    await writeFile(malformed, "not an addon", { mode: 0o600 });
    await expect(kernel.acquireKernelLease({
      dataRoot: rootDir,
      purpose: transactionPurpose,
      addonPath: malformed,
      expectedAddonSha256: "0".repeat(64),
    })).rejects.toThrow("KERNEL_LOCK_ADDON_HASH_INVALID");
    await expect(access(path.join(rootDir, "state"))).rejects.toMatchObject({ code: "ENOENT" });

    const archInvalid = path.join(rootDir, "arch-invalid.node");
    const archInvalidBytes = Buffer.from("not an architecture-valid addon", "utf8");
    await writeFile(archInvalid, archInvalidBytes, { mode: 0o600 });
    await expect(kernel.acquireKernelLease({
      dataRoot: rootDir,
      purpose: transactionPurpose,
      addonPath: archInvalid,
      expectedAddonSha256: createHash("sha256").update(archInvalidBytes).digest("hex"),
    })).rejects.toThrow("KERNEL_LOCK_ADDON_ARCH_INVALID");
    await expect(access(path.join(rootDir, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for an unsafe trusted-root mode before creating state", async () => {
    const kernel = await kernelLockModule();
    await chmod(rootDir, 0o755);

    await expect(kernel.acquireKernelLease({
      dataRoot: rootDir,
      purpose: transactionPurpose,
    })).rejects.toThrow("KERNEL_LOCK_ROOT_IDENTITY_INVALID");
    await expect(access(path.join(rootDir, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a missing native API before state mutation", async () => {
    const kernel = await kernelLockModule();
    expect(() => kernel.validateKernelLockAddonApi({
      lockExclusiveNonblocking: () => ({ ok: true, errno: 0 }),
      unlock: () => ({ ok: true, errno: 0 }),
    })).toThrow("KERNEL_LOCK_ADDON_API_INVALID");
    await expect(access(path.join(rootDir, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  function spawnOwner(workerId: string): ChildProcess {
    const child = spawn(process.execPath, [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      path.resolve("tests/fixtures/kernel-lock-worker.test.ts"),
      "--pool=threads",
      "--maxWorkers=1",
      "--reporter=dot",
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        KERNEL_LOCK_WORKER: "1",
        KERNEL_LOCK_DATA_ROOT: rootDir,
        KERNEL_LOCK_PURPOSE: transactionPurpose,
        KERNEL_LOCK_ACQUIRED_PATH: path.join(rootDir, `acquired-${workerId}.json`),
        KERNEL_LOCK_RELEASE_PATH: path.join(rootDir, `release-${workerId}`),
        KERNEL_LOCK_RESULT_PATH: path.join(rootDir, `result-${workerId}.json`),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    return child;
  }
});

async function kernelLockModule(): Promise<KernelLockModule> {
  const moduleUrl = new URL("../../src/storage/kernel-lock.js", import.meta.url).href;
  return await import(moduleUrl) as KernelLockModule;
}

async function waitForJson(filePath: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`KERNEL_LOCK_TEST_SIGNAL_MISSING:${path.basename(filePath)}`);
}

async function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  const [code, signal] = await once(child, "exit") as [number | null, string | null];
  return { code, signal };
}
