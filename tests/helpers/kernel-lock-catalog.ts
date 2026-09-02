import { chmod, lstat } from "node:fs/promises";

import { initializeKernelLockCatalogForInstaller } from "../../src/storage/kernel-lock.js";

/**
 * Test-only equivalent of the installer bootstrap. Production runtimes must
 * never call this helper or create/repair their own catalog.
 */
export async function initializeTestKernelLockCatalog(dataRoot: string): Promise<void> {
  const root = await lstat(dataRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("TEST_KERNEL_LOCK_ROOT_INVALID");
  }
  if ((root.mode & 0o777) !== 0o700) await chmod(dataRoot, 0o700);
  await initializeKernelLockCatalogForInstaller({ dataRoot });
}
