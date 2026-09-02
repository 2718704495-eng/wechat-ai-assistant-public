import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(scriptDirectory, "../dist/src/storage/kernel-lock.js"),
  path.resolve(scriptDirectory, "../src/storage/kernel-lock.js"),
];

let modulePath = null;
for (const candidate of candidates) {
  try {
    await access(candidate);
    modulePath = candidate;
    break;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
if (modulePath === null) throw new Error("KERNEL_LOCK_RUNTIME_MODULE_MISSING");

export const {
  acquireKernelLease,
  acquireReleaseMaintenanceKernelLease,
  archiveFileNoReplace,
  compatibilityTombstoneContents,
  initializeKernelLockCatalogForInstaller,
  legacyCutoverTombstoneContents,
} = await import(pathToFileURL(modulePath).href);
