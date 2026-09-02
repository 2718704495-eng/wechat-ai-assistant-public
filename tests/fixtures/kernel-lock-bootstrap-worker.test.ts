import { rename, writeFile } from "node:fs/promises";

import { test } from "vitest";

interface KernelLockModule {
  initializeKernelLockCatalogForInstaller(options: {
    dataRoot: string;
    hook(stage: string): Promise<void>;
  }): Promise<unknown>;
}

const workerTest = process.env.KERNEL_LOCK_BOOTSTRAP_WORKER === "1" ? test : test.skip;

workerTest("stops at one real installer bootstrap crash boundary", async () => {
  const root = requiredEnv("KERNEL_LOCK_BOOTSTRAP_ROOT");
  const crashStage = requiredEnv("KERNEL_LOCK_BOOTSTRAP_STAGE");
  const readyPath = requiredEnv("KERNEL_LOCK_BOOTSTRAP_READY");
  const kernel = await import(new URL("../../src/storage/kernel-lock.js", import.meta.url).href) as
    KernelLockModule;

  await kernel.initializeKernelLockCatalogForInstaller({
    dataRoot: root,
    hook: async (stage) => {
      if (!stage.startsWith(`${crashStage}:`)) return;
      const temporary = `${readyPath}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ stage })}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, readyPath);
      await new Promise<void>(() => undefined);
    },
  });
}, 20_000);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`MISSING_${name}`);
  return value;
}
