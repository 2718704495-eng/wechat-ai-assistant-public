import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

interface KernelLease {
  readonly gateIdentity: { dev: number; ino: number };
  close(): Promise<void>;
}

interface KernelLockModule {
  acquireKernelLease(options: {
    dataRoot: string;
    purpose: string;
  }): Promise<KernelLease>;
}

const workerTest = process.env.KERNEL_LOCK_WORKER === "1" ? test : test.skip;

workerTest("holds one process-local kernel gate until the parent releases it", async () => {
  const dataRoot = requiredEnv("KERNEL_LOCK_DATA_ROOT");
  const purpose = requiredEnv("KERNEL_LOCK_PURPOSE");
  const acquiredPath = requiredEnv("KERNEL_LOCK_ACQUIRED_PATH");
  const releasePath = requiredEnv("KERNEL_LOCK_RELEASE_PATH");
  const resultPath = requiredEnv("KERNEL_LOCK_RESULT_PATH");
  const moduleUrl = new URL("../../src/storage/kernel-lock.js", import.meta.url).href;
  const kernel = await import(moduleUrl) as KernelLockModule;
  const lease = await kernel.acquireKernelLease({ dataRoot, purpose });
  try {
    await writeFile(
      acquiredPath,
      JSON.stringify({ gateIdentity: lease.gateIdentity }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await waitForPath(releasePath);
    await writeFile(resultPath, JSON.stringify({ status: "released" }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    await lease.close();
  }

  expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ status: "released" });
}, 20_000);

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
  throw new Error(`KERNEL_LOCK_WORKER_SIGNAL_MISSING:${path.basename(filePath)}`);
}
