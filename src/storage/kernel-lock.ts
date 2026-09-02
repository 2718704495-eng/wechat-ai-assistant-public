import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const gateDirectoryName = ".kernel-lock-v1";
const catalogFilename = "catalog.json";
const catalogDigestFilename = "catalog.sha256";
const compatibilityTombstone = "{\"purpose\":\"round7-compatibility-tombstone\",\"version\":1}\n";
const compatibilityLockNames = ["release-install.lock", "live-operation.lock"] as const;
const catalogPurposes = [
  "release-installer",
  "live-operation",
  "encrypted-store-global",
] as const;
type CatalogPurpose = typeof catalogPurposes[number];
const wouldBlockErrnos = new Set(
  [os.constants.errno.EAGAIN, os.constants.errno.EWOULDBLOCK]
    .filter((value): value is number => Number.isInteger(value)),
);

interface NativeStatus {
  readonly ok: boolean;
  readonly errno: number;
}

interface NativeIdentity extends NativeStatus {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly size: number;
}

interface NativeOpenIdentity extends NativeIdentity {
  readonly fd: number;
}

interface NativeDirectoryEmpty extends NativeStatus {
  readonly empty: boolean;
}

interface NativeDirectoryNames extends NativeStatus {
  readonly names: readonly string[];
}

interface NativeSymlinkIdentity extends NativeIdentity {
  readonly target: string;
}

interface KernelLockAddon {
  lockExclusiveNonblocking(fd: number): NativeStatus;
  unlock(fd: number): NativeStatus;
  inspect(fd: number): NativeIdentity;
  archiveNoReplace(
    oldDirectoryFd: number,
    oldName: string,
    archiveDirectoryFd: number,
    archiveName: string,
  ): NativeStatus;
  openDirectoryAtNoFollow(directoryFd: number, name: string): NativeOpenIdentity;
  openFileAtNoFollow(directoryFd: number, name: string): NativeOpenIdentity;
  openReadFileAtNoFollow(directoryFd: number, name: string): NativeOpenIdentity;
  readDirectoryNames(fd: number): NativeDirectoryNames;
  inspectEntryAtNoFollow(directoryFd: number, name: string): NativeIdentity;
  readLinkAtNoFollow(directoryFd: number, name: string): NativeSymlinkIdentity;
  closeFd(fd: number): NativeStatus;
  fsyncFd(fd: number): NativeStatus;
  mkdirAtNoReplace(directoryFd: number, name: string, mode: number): NativeStatus;
  createPrivateDirectoryAtNoReplace(
    directoryFd: number,
    name: string,
    mode: number,
  ): NativeOpenIdentity & { readonly name: string };
  createFileAtNoReplace(
    directoryFd: number,
    name: string,
    mode: number,
  ): NativeOpenIdentity & { readonly name: string };
  writeFileAtNoReplace(
    directoryFd: number,
    name: string,
    contents: Buffer,
    mode: number,
  ): NativeStatus;
  linkAtNoReplace(directoryFd: number, sourceName: string, targetName: string): NativeStatus;
  symlinkAtNoReplace(directoryFd: number, target: string, name: string): NativeStatus;
  chmodAtExpected(
    directoryFd: number,
    name: string,
    expectedDev: number,
    expectedIno: number,
    mode: number,
    directory: boolean,
  ): NativeStatus;
  directoryIsEmpty(fd: number): NativeDirectoryEmpty;
  removePrivateTreeAtExpected(
    parentDirectoryFd: number,
    name: string,
    expectedDev: number,
    expectedIno: number,
    expectedUid: number,
  ): NativeStatus;
}

interface DirectoryLease {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
}

interface FileIdentity {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly mode: number;
  readonly nlink: number;
}

export interface KernelLockLease {
  readonly gateIdentity: { dev: number; ino: number };
  readonly gatePath: string;
  readonly kernelLockReceipt: KernelLockReceipt;
  readonly purpose: string;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface KernelLockReceipt {
  readonly purpose: CatalogPurpose;
  readonly gateIdentity: { readonly dev: number; readonly ino: number };
  readonly catalogSha256: string;
  readonly acquisitionNonce: string;
}

export interface AcquireKernelLeaseOptions {
  readonly dataRoot: string;
  readonly purpose: string;
  readonly addonPath?: string;
  readonly expectedAddonSha256?: string;
}

export interface InitializeKernelLockCatalogOptions {
  readonly dataRoot: string;
  readonly hook?: (stage: string) => Promise<void> | void;
}

export async function acquireKernelLease(
  options: AcquireKernelLeaseOptions,
): Promise<KernelLockLease> {
  return acquireValidatedKernelLease(options, { releaseWal: "runtime" });
}

export async function acquireReleaseMaintenanceKernelLease(options: {
  readonly dataRoot: string;
  readonly expectedTransactionJournalSha256: string | null;
}): Promise<KernelLockLease> {
  if (typeof options?.dataRoot !== "string" || options.dataRoot.length === 0 ||
      (options.expectedTransactionJournalSha256 !== null &&
        !/^[a-f0-9]{64}$/u.test(options.expectedTransactionJournalSha256))) {
    throw new Error("KERNEL_LOCK_MAINTENANCE_OPTIONS_INVALID");
  }
  return acquireValidatedKernelLease(
    { dataRoot: options.dataRoot, purpose: "live-operation" },
    { releaseWal: { expectedSha256: options.expectedTransactionJournalSha256 } },
  );
}

async function acquireValidatedKernelLease(
  options: AcquireKernelLeaseOptions,
  mode: {
    readonly releaseWal: "runtime" | { readonly expectedSha256: string | null };
  },
): Promise<KernelLockLease> {
  assertAcquireOptions(options);
  const addon = await loadKernelLockAddon(options);
  const rootPath = path.resolve(options.dataRoot);
  const root = await openOwnedDirectory(rootPath, false);
  let state: DirectoryLease | null = null;
  let gateDirectory: DirectoryLease | null = null;
  let gateHandle: FileHandle | null = null;
  try {
    try {
      state = await openOwnedDirectory(path.join(rootPath, "state"), false);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error("KERNEL_LOCK_CATALOG_MISSING", { cause: error });
      }
      throw error;
    }
    const catalog = await validateKernelLockCatalog(state, addon);
    gateDirectory = await openOwnedDirectory(path.join(state.path, gateDirectoryName), false);
    const gate = await openCatalogGate(gateDirectory, options.purpose, addon);
    gateHandle = gate.handle;
    const locked = addon.lockExclusiveNonblocking(gateHandle.fd);
    if (!locked.ok) {
      if (wouldBlockErrnos.has(locked.errno)) throw new Error("KERNEL_LOCK_BUSY");
      throw new Error("KERNEL_LOCK_NATIVE_FAILURE");
    }
    const finalCatalog = await validateKernelLockCatalog(state, addon);
    if (finalCatalog.catalogSha256 !== catalog.catalogSha256) {
      throw new Error("KERNEL_LOCK_CATALOG_INVALID");
    }
    if (options.purpose === "live-operation") {
      if (mode.releaseWal === "runtime") await assertReleaseWalAllowsRuntime(rootPath);
      else await assertReleaseWalForMaintenance(rootPath, mode.releaseWal.expectedSha256);
    }
    return new PersistentKernelLockLease({
      addon,
      root,
      state,
      gateDirectory,
      gateHandle,
      gatePath: gate.gatePath,
      anchorPath: gate.anchorPath,
      gateIdentity: gate.identity,
      purpose: options.purpose,
      catalogSha256: catalog.catalogSha256,
    });
  } catch (error) {
    await gateHandle?.close().catch(() => undefined);
    await gateDirectory?.handle.close().catch(() => undefined);
    await state?.handle.close().catch(() => undefined);
    await root.handle.close().catch(() => undefined);
    throw error;
  }
}

export async function initializeKernelLockCatalogForInstaller(
  options: InitializeKernelLockCatalogOptions,
): Promise<{ status: "initialized" | "already-initialized"; catalogSha256: string }> {
  if (typeof options?.dataRoot !== "string" || options.dataRoot.length === 0 ||
      (options.hook !== undefined && typeof options.hook !== "function")) {
    throw new Error("KERNEL_LOCK_BOOTSTRAP_OPTIONS_INVALID");
  }
  const addon = await loadKernelLockAddon({
    dataRoot: options.dataRoot,
    purpose: "release-installer",
  });
  const rootPath = path.resolve(options.dataRoot);
  const root = await openOwnedDirectory(rootPath, false);
  let state: DirectoryLease | null = null;
  let bootstrapLocked = false;
  let outcome: {
    status: "initialized" | "already-initialized";
    catalogSha256: string;
  } | null = null;
  let failure: unknown;
  let failed = false;
  try {
    state = await openOwnedDirectory(path.join(rootPath, "state"), true);
    const stateLease = state;
    const bootstrap = addon.lockExclusiveNonblocking(stateLease.handle.fd);
    if (!bootstrap.ok) {
      if (wouldBlockErrnos.has(bootstrap.errno)) throw new Error("KERNEL_LOCK_BOOTSTRAP_BUSY");
      throw new Error("KERNEL_LOCK_NATIVE_FAILURE");
    }
    bootstrapLocked = true;
    await verifyDirectoryLease(stateLease);

    const classifications = await Promise.all(
      compatibilityLockNames.map((name) => classifyCompatibilityPath(path.join(stateLease.path, name))),
    );
    if (classifications.includes("foreign")) {
      throw new Error("KERNEL_BOOTSTRAP_LEGACY_PATH_OCCUPIED");
    }
    for (const [index, name] of compatibilityLockNames.entries()) {
      if (classifications[index] === "missing") {
        await installCompatibilityTombstone(stateLease, name);
      }
      if (await classifyCompatibilityPath(path.join(stateLease.path, name)) !== "tombstone") {
        throw new Error("KERNEL_BOOTSTRAP_LEGACY_PATH_OCCUPIED");
      }
      await options.hook?.(`tombstone-durable:${name}`);
    }

    const gateDirectory = await openOwnedDirectory(path.join(stateLease.path, gateDirectoryName), true);
    try {
      const manifestExists = await pathExists(path.join(gateDirectory.path, catalogFilename));
      const digestExists = await pathExists(path.join(gateDirectory.path, catalogDigestFilename));
      if (manifestExists !== digestExists) throw new Error("KERNEL_LOCK_CATALOG_INVALID");
      if (manifestExists) {
        const catalog = await validateKernelLockCatalog(stateLease, addon);
        outcome = { status: "already-initialized", catalogSha256: catalog.catalogSha256 };
      } else {
        for (const purpose of catalogPurposes) {
          await initializeCatalogGatePair(gateDirectory, purpose, addon, options.hook);
        }
        const catalog = await writeKernelLockCatalog(stateLease, gateDirectory, addon);
        outcome = { status: "initialized", catalogSha256: catalog.catalogSha256 };
      }
    } finally {
      await gateDirectory.handle.close().catch(() => undefined);
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (bootstrapLocked && state !== null) {
      try {
        const result = addon.unlock(state.handle.fd);
        if (!result.ok && !failed) {
          failed = true;
          failure = new Error("KERNEL_LOCK_NATIVE_FAILURE");
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = new Error("KERNEL_LOCK_NATIVE_FAILURE", { cause: error });
        }
      }
    }
    await state?.handle.close().catch(() => undefined);
    await root.handle.close().catch(() => undefined);
  }
  if (failed) throw failure;
  if (outcome === null) throw new Error("KERNEL_LOCK_CATALOG_INVALID");
  return outcome;
}

export function validateKernelLockAddonApi(addon: unknown): asserts addon is KernelLockAddon {
  if (typeof addon !== "object" || addon === null) {
    throw new Error("KERNEL_LOCK_ADDON_API_INVALID");
  }
  const candidate = addon as Record<PropertyKey, unknown>;
  const expected = [
    "lockExclusiveNonblocking",
    "unlock",
    "inspect",
    "archiveNoReplace",
    "openDirectoryAtNoFollow",
    "openFileAtNoFollow",
    "openReadFileAtNoFollow",
    "readDirectoryNames",
    "inspectEntryAtNoFollow",
    "readLinkAtNoFollow",
    "closeFd",
    "fsyncFd",
    "mkdirAtNoReplace",
    "createPrivateDirectoryAtNoReplace",
    "createFileAtNoReplace",
    "writeFileAtNoReplace",
    "linkAtNoReplace",
    "symlinkAtNoReplace",
    "chmodAtExpected",
    "directoryIsEmpty",
    "removePrivateTreeAtExpected",
  ];
  const keys = Reflect.ownKeys(candidate);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      expected.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        return descriptor === undefined || typeof descriptor.value !== "function" ||
          descriptor.enumerable || descriptor.writable || descriptor.configurable;
      })) {
    throw new Error("KERNEL_LOCK_ADDON_API_INVALID");
  }
}

export async function assertNoLegacyArtifacts(
  stateDirectory: string,
  purpose: string,
): Promise<void> {
  const artifacts = await legacyArtifacts(stateDirectory, purpose);
  if (artifacts.length > 0) throw new Error("KERNEL_LOCK_LEGACY_ARTIFACT_PRESENT");
}

export function compatibilityTombstoneContents(): string {
  return compatibilityTombstone;
}

/** @deprecated Round 7 callers use compatibilityTombstoneContents. */
export function legacyCutoverTombstoneContents(): string {
  return compatibilityTombstone;
}

export async function archiveFileNoReplace(options: {
  readonly sourcePath: string;
  readonly archiveDirectory: string;
  readonly archiveName: string;
}): Promise<void> {
  const sourceName = path.basename(options.sourcePath);
  if (path.basename(options.archiveName) !== options.archiveName ||
      sourceName.length === 0 || sourceName === "." || sourceName === ".." ||
      options.archiveName.length === 0 || options.sourcePath.length === 0) {
    throw new Error("KERNEL_LOCK_ARCHIVE_OPTIONS_INVALID");
  }
  const addon = await loadKernelLockAddon({
    dataRoot: path.dirname(options.sourcePath),
    purpose: "kernel-lock-archive",
  });
  const sourceDirectory = await openOwnedDirectory(path.dirname(options.sourcePath), false);
  let archiveDirectory: DirectoryLease | null = null;
  try {
    archiveDirectory = await openOwnedDirectory(options.archiveDirectory, true);
    const status = addon.archiveNoReplace(
      sourceDirectory.handle.fd,
      sourceName,
      archiveDirectory.handle.fd,
      options.archiveName,
    );
    if (!status.ok) {
      if (status.errno === os.constants.errno.EEXIST) {
        throw new Error("KERNEL_LOCK_ARCHIVE_EXISTS");
      }
      throw new Error("KERNEL_LOCK_ARCHIVE_FAILED");
    }
    await syncDirectory(sourceDirectory.handle);
    await syncDirectory(archiveDirectory.handle);
  } finally {
    await archiveDirectory?.handle.close().catch(() => undefined);
    await sourceDirectory.handle.close().catch(() => undefined);
  }
}

async function loadKernelLockAddon(options: AcquireKernelLeaseOptions): Promise<KernelLockAddon> {
  const resolved = await resolveAddon(options);
  let handle: FileHandle;
  try {
    handle = await open(resolved.addonPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("KERNEL_LOCK_ADDON_MISSING", { cause: error });
    }
    throw new Error("KERNEL_LOCK_ADDON_UNREADABLE", { cause: error });
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== currentUid()) {
      throw new Error("KERNEL_LOCK_ADDON_UNREADABLE");
    }
    const bytes = await handle.readFile();
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== resolved.expectedSha256) {
      throw new Error("KERNEL_LOCK_ADDON_HASH_INVALID");
    }
    assertExpectedArchitecture(bytes);
    const nativeModule: { exports: unknown } = { exports: {} };
    try {
      process.dlopen(nativeModule, `/dev/fd/${handle.fd}`);
    } catch (error) {
      throw new Error("KERNEL_LOCK_ADDON_LOAD_FAILED", { cause: error });
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid ||
        before.mode !== after.mode || before.size !== after.size) {
      throw new Error("KERNEL_LOCK_ADDON_IDENTITY_DRIFT");
    }
    validateKernelLockAddonApi(nativeModule.exports);
    return nativeModule.exports;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function resolveAddon(options: AcquireKernelLeaseOptions): Promise<{
  addonPath: string;
  expectedSha256: string;
}> {
  if (options.addonPath !== undefined) {
    const addonPath = path.resolve(options.addonPath);
    try {
      await lstat(addonPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error("KERNEL_LOCK_ADDON_MISSING", { cause: error });
      }
      throw error;
    }
    if (options.expectedAddonSha256 === undefined) {
      throw new Error("KERNEL_LOCK_ADDON_HASH_MISSING");
    }
    return { addonPath, expectedSha256: options.expectedAddonSha256 };
  }
  for (const directory of defaultAddonDirectories()) {
    const addonPath = path.join(directory, "kernel_lock.node");
    const manifestPath = path.join(directory, "kernel_lock.manifest.json");
    try {
      const manifest = parseAddonManifest(await readFile(manifestPath, "utf8"));
      if (manifest.platform !== process.platform || manifest.arch !== process.arch ||
          manifest.napi !== Number(process.versions.napi)) {
        throw new Error("KERNEL_LOCK_ADDON_MANIFEST_INVALID");
      }
      await lstat(addonPath);
      return { addonPath, expectedSha256: manifest.sha256 };
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      if (error instanceof SyntaxError) throw new Error("KERNEL_LOCK_ADDON_MANIFEST_INVALID", { cause: error });
      if (error instanceof Error && error.message === "KERNEL_LOCK_ADDON_MANIFEST_INVALID") throw error;
      throw error;
    }
  }
  throw new Error("KERNEL_LOCK_ADDON_MISSING");
}

function defaultAddonDirectories(): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const target = `${process.platform}-${process.arch}`;
  return [
    path.resolve(moduleDirectory, "../../native/kernel-lock/build", target),
    path.resolve(moduleDirectory, "../../../native/kernel-lock/build", target),
  ];
}

function parseAddonManifest(serialized: string): {
  platform: string;
  arch: string;
  napi: number;
  sha256: string;
} {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null ||
      !Object.hasOwn(value, "version") || (value as { version: unknown }).version !== 2 ||
      typeof (value as { platform?: unknown }).platform !== "string" ||
      typeof (value as { arch?: unknown }).arch !== "string" ||
      !Number.isInteger((value as { napi?: unknown }).napi) ||
      typeof (value as { sha256?: unknown }).sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test((value as { sha256: string }).sha256)) {
    throw new Error("KERNEL_LOCK_ADDON_MANIFEST_INVALID");
  }
  return value as { platform: string; arch: string; napi: number; sha256: string };
}

interface ValidatedKernelCatalog {
  readonly catalogSha256: string;
}

interface KernelCatalogEntry {
  readonly purpose: CatalogPurpose;
  readonly anchor: string;
  readonly gate: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly sha256: string;
}

interface KernelCatalog {
  readonly version: 1;
  readonly state: { readonly dev: string; readonly ino: string };
  readonly purposes: readonly KernelCatalogEntry[];
}

async function validateKernelLockCatalog(
  state: DirectoryLease,
  addon: KernelLockAddon,
): Promise<ValidatedKernelCatalog> {
  for (const name of compatibilityLockNames) {
    if (await classifyCompatibilityPath(path.join(state.path, name)) !== "tombstone") {
      throw new Error("KERNEL_LOCK_COMPATIBILITY_TOMBSTONE_INVALID");
    }
  }
  const directoryPath = path.join(state.path, gateDirectoryName);
  let directory: DirectoryLease;
  try {
    directory = await openOwnedDirectory(directoryPath, false);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("KERNEL_LOCK_CATALOG_MISSING", { cause: error });
    }
    throw error;
  }
  try {
    const manifestPath = path.join(directory.path, catalogFilename);
    const digestPath = path.join(directory.path, catalogDigestFilename);
    const [manifestBytes, digestBytes] = await Promise.all([
      readExactCatalogFile(manifestPath),
      readExactCatalogFile(digestPath),
    ]).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error("KERNEL_LOCK_CATALOG_MISSING", { cause: error });
      }
      throw error;
    });
    const catalogSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    if (digestBytes !== `${catalogSha256}  ${catalogFilename}\n`) {
      throw new Error("KERNEL_LOCK_CATALOG_INVALID");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBytes);
    } catch (error) {
      throw new Error("KERNEL_LOCK_CATALOG_INVALID", { cause: error });
    }
    const expected = await buildCatalog(state, directory, addon);
    if (manifestBytes !== serializeCatalog(expected) || !catalogMatches(parsed, expected)) {
      throw new Error("KERNEL_LOCK_CATALOG_INVALID");
    }
    const expectedNames = [
      catalogFilename,
      catalogDigestFilename,
      ...expected.purposes.flatMap((entry) => [entry.anchor, entry.gate]),
    ].sort();
    if ((await readdir(directory.path)).sort().join("\0") !== expectedNames.join("\0")) {
      throw new Error("KERNEL_LOCK_CATALOG_INVALID");
    }
    return { catalogSha256 };
  } catch (error) {
    if (error instanceof Error && [
      "KERNEL_LOCK_CATALOG_MISSING",
      "KERNEL_LOCK_CATALOG_INVALID",
      "KERNEL_LOCK_COMPATIBILITY_TOMBSTONE_INVALID",
    ].includes(error.message)) throw error;
    throw new Error("KERNEL_LOCK_CATALOG_INVALID", { cause: error });
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
}

async function writeKernelLockCatalog(
  state: DirectoryLease,
  directory: DirectoryLease,
  addon: KernelLockAddon,
): Promise<ValidatedKernelCatalog> {
  const catalog = await buildCatalog(state, directory, addon);
  const serialized = serializeCatalog(catalog);
  const catalogSha256 = createHash("sha256").update(serialized).digest("hex");
  await writeNewDurableFile(
    directory,
    catalogFilename,
    serialized,
  );
  await writeNewDurableFile(
    directory,
    catalogDigestFilename,
    `${catalogSha256}  ${catalogFilename}\n`,
  );
  await syncDirectory(directory.handle);
  return validateKernelLockCatalog(state, addon);
}

async function writeNewDurableFile(
  directory: DirectoryLease,
  filename: string,
  contents: string,
): Promise<void> {
  const temporaryName = `.${filename}.${randomUUID()}.tmp`;
  const temporaryPath = path.join(directory.path, temporaryName);
  const destinationPath = path.join(directory.path, filename);
  let handle: FileHandle | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (await pathExists(destinationPath)) throw new Error("KERNEL_LOCK_CATALOG_INVALID");
    await rename(temporaryPath, destinationPath);
    await syncDirectory(directory.handle);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function buildCatalog(
  state: DirectoryLease,
  directory: DirectoryLease,
  addon: KernelLockAddon,
): Promise<KernelCatalog> {
  const entries: KernelCatalogEntry[] = [];
  for (const purpose of catalogPurposes) {
    const digest = purposeDigest(purpose);
    const anchor = `${digest}.anchor`;
    const gate = `${digest}.gate`;
    const anchorIdentity = await lstat(path.join(directory.path, anchor));
    const gateIdentity = await lstat(path.join(directory.path, gate));
    assertExactGatePair(gateIdentity, anchorIdentity);
    const handle = await open(
      path.join(directory.path, gate),
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      const identity = addon.inspect(handle.fd);
      if (!identity.ok || identity.dev !== Number(gateIdentity.dev) ||
          identity.ino !== Number(gateIdentity.ino)) {
        throw new Error("KERNEL_LOCK_CATALOG_INVALID");
      }
    } finally {
      await handle.close();
    }
    entries.push({
      purpose,
      anchor,
      gate,
      dev: String(gateIdentity.dev),
      ino: String(gateIdentity.ino),
      uid: gateIdentity.uid,
      mode: gateIdentity.mode & 0o777,
      nlink: gateIdentity.nlink,
      sha256: createHash("sha256").update("").digest("hex"),
    });
  }
  return {
    version: 1,
    state: { dev: String(state.identity.dev), ino: String(state.identity.ino) },
    purposes: entries,
  };
}

function serializeCatalog(catalog: KernelCatalog): string {
  return `${JSON.stringify(catalog)}\n`;
}

function catalogMatches(actual: unknown, expected: KernelCatalog): boolean {
  return typeof actual === "object" && actual !== null && !Array.isArray(actual) &&
    JSON.stringify(actual) === JSON.stringify(expected);
}

async function readExactCatalogFile(filePath: string): Promise<string> {
  const initial = await lstat(filePath);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.uid !== currentUid() ||
      (initial.mode & 0o777) !== 0o600 || initial.nlink !== 1) {
    throw new Error("KERNEL_LOCK_CATALOG_INVALID");
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertSameIdentity(opened, initial, "KERNEL_LOCK_CATALOG_INVALID");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function installCompatibilityTombstone(
  state: DirectoryLease,
  name: typeof compatibilityLockNames[number],
): Promise<void> {
  const filePath = path.join(state.path, name);
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(compatibilityTombstone, "utf8");
    await handle.sync();
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST" &&
        await classifyCompatibilityPath(filePath) === "tombstone")) {
      throw new Error("KERNEL_BOOTSTRAP_LEGACY_PATH_OCCUPIED", { cause: error });
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await syncDirectory(state.handle);
}

async function classifyCompatibilityPath(
  filePath: string,
): Promise<"missing" | "tombstone" | "foreign"> {
  try {
    const identity = await lstat(filePath);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.uid !== currentUid() ||
        (identity.mode & 0o777) !== 0o600 || identity.nlink !== 1 ||
        identity.size !== Buffer.byteLength(compatibilityTombstone)) {
      return "foreign";
    }
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      assertSameIdentity(opened, identity, "KERNEL_BOOTSTRAP_LEGACY_PATH_OCCUPIED");
      return await handle.readFile("utf8") === compatibilityTombstone ? "tombstone" : "foreign";
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    if (error instanceof Error && error.message === "KERNEL_BOOTSTRAP_LEGACY_PATH_OCCUPIED") {
      return "foreign";
    }
    throw error;
  }
}

async function initializeCatalogGatePair(
  directory: DirectoryLease,
  purpose: CatalogPurpose,
  addon: KernelLockAddon,
  hook: InitializeKernelLockCatalogOptions["hook"],
): Promise<void> {
  const digest = purposeDigest(purpose);
  const anchorPath = path.join(directory.path, `${digest}.anchor`);
  const gatePath = path.join(directory.path, `${digest}.gate`);
  const anchorExists = await pathExists(anchorPath);
  const gateExists = await pathExists(gatePath);
  if (!anchorExists && gateExists) throw new Error("KERNEL_LOCK_CATALOG_INVALID");
  if (!anchorExists) {
    const anchor = await open(anchorPath, "wx", 0o600);
    try {
      await anchor.sync();
    } finally {
      await anchor.close();
    }
    await hook?.(`anchor-created:${digest}`);
  }
  if (!gateExists) {
    const anchor = await lstat(anchorPath);
    if (!anchor.isFile() || anchor.isSymbolicLink() || anchor.uid !== currentUid() ||
        (anchor.mode & 0o777) !== 0o600 || anchor.nlink !== 1 || anchor.size !== 0) {
      throw new Error("KERNEL_LOCK_CATALOG_INVALID");
    }
    await link(anchorPath, gatePath);
    await hook?.(`gate-linked:${digest}`);
  }
  await syncDirectory(directory.handle);
  await hook?.(`directory-fsync:${digest}`);
  const gate = await lstat(gatePath);
  const anchor = await lstat(anchorPath);
  assertExactGatePair(gate, anchor);
  const handle = await open(gatePath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const inspected = addon.inspect(handle.fd);
    if (!inspected.ok || inspected.dev !== Number(gate.dev) || inspected.ino !== Number(gate.ino)) {
      throw new Error("KERNEL_LOCK_CATALOG_INVALID");
    }
  } finally {
    await handle.close();
  }
}

async function assertReleaseWalAllowsRuntime(dataRoot: string): Promise<void> {
  if (await pathExists(path.join(dataRoot, "state", "release-transaction.json"))) {
    throw new Error("RELEASE_RUNTIME_QUARANTINED");
  }
}

async function assertReleaseWalForMaintenance(
  dataRoot: string,
  expectedSha256: string | null,
): Promise<void> {
  const journalPath = path.join(dataRoot, "state", "release-transaction.json");
  if (expectedSha256 === null) {
    if (await pathExists(journalPath)) throw new Error("RELEASE_TRANSACTION_PENDING");
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(journalPath);
  } catch (error) {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS", { cause: error });
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
  }
}

function purposeDigest(purpose: CatalogPurpose): string {
  return createHash("sha256").update(purpose, "utf8").digest("hex");
}

function assertExpectedArchitecture(bytes: Buffer): void {
  if (process.platform === "darwin") {
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
        bytes.readUInt32LE(4) !== expectedMachCpuType()) {
      throw new Error("KERNEL_LOCK_ADDON_ARCH_INVALID");
    }
    return;
  }
  if (process.platform === "linux") {
    if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        bytes[5] !== 1 || bytes.readUInt16LE(18) !== expectedElfMachine()) {
      throw new Error("KERNEL_LOCK_ADDON_ARCH_INVALID");
    }
    return;
  }
  throw new Error("KERNEL_LOCK_PLATFORM_UNSUPPORTED");
}

function expectedMachCpuType(): number {
  if (process.arch === "arm64") return 0x0100000c;
  if (process.arch === "x64") return 0x01000007;
  throw new Error("KERNEL_LOCK_ADDON_ARCH_INVALID");
}

function expectedElfMachine(): number {
  if (process.arch === "arm64") return 183;
  if (process.arch === "x64") return 62;
  throw new Error("KERNEL_LOCK_ADDON_ARCH_INVALID");
}

async function openOwnedDirectory(
  directoryPath: string,
  create: boolean,
  recursive = false,
): Promise<DirectoryLease> {
  if (create) {
    try {
      await mkdir(directoryPath, { mode: 0o700, recursive });
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }
  const initial = await lstat(directoryPath);
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== currentUid() ||
      (initial.mode & 0o777) !== 0o700) {
    throw new Error("KERNEL_LOCK_ROOT_IDENTITY_INVALID");
  }
  const handle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    assertDirectoryIdentity(opened, initial);
    return {
      path: directoryPath,
      handle,
      identity: identityOf(opened),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openCatalogGate(
  directory: DirectoryLease,
  purpose: CatalogPurpose,
  addon: KernelLockAddon,
): Promise<{
  gatePath: string;
  anchorPath: string;
  handle: FileHandle;
  identity: NativeIdentity;
}> {
  const digest = purposeDigest(purpose);
  const anchorPath = path.join(directory.path, `${digest}.anchor`);
  const gatePath = path.join(directory.path, `${digest}.gate`);
  const initialGate = await lstat(gatePath);
  const initialAnchor = await lstat(anchorPath);
  assertExactGatePair(initialGate, initialAnchor);
  const handle = await open(gatePath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertSameIdentity(opened, initialGate, "KERNEL_LOCK_GATE_IDENTITY_MISMATCH");
    assertExactGatePair(opened, initialAnchor);
    const identity = addon.inspect(handle.fd);
    if (!identity.ok || identity.dev !== Number(opened.dev) || identity.ino !== Number(opened.ino)) {
      throw new Error("KERNEL_LOCK_NATIVE_FAILURE");
    }
    return { gatePath, anchorPath, handle, identity };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

class PersistentKernelLockLease implements KernelLockLease {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  public readonly gateIdentity: { dev: number; ino: number };
  public readonly kernelLockReceipt: KernelLockReceipt;

  public constructor(
    private readonly options: {
      addon: KernelLockAddon;
      root: DirectoryLease;
      state: DirectoryLease;
      gateDirectory: DirectoryLease;
      gateHandle: FileHandle;
      gatePath: string;
      anchorPath: string;
      gateIdentity: NativeIdentity;
      purpose: CatalogPurpose;
      catalogSha256: string;
    },
  ) {
    this.gateIdentity = { dev: options.gateIdentity.dev, ino: options.gateIdentity.ino };
    this.kernelLockReceipt = Object.freeze({
      purpose: options.purpose,
      gateIdentity: Object.freeze({ ...this.gateIdentity }),
      catalogSha256: options.catalogSha256,
      acquisitionNonce: randomUUID(),
    });
  }

  public get gatePath(): string {
    return this.options.gatePath;
  }

  public get purpose(): string {
    return this.options.purpose;
  }

  public runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("KERNEL_LOCK_CLOSED"));
    const result = this.tail.then(
      async () => {
        await this.assertOwnership();
        const value = await operation();
        await this.assertOwnership();
        return value;
      },
      async () => {
        await this.assertOwnership();
        const value = await operation();
        await this.assertOwnership();
        return value;
      },
    );
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(
      () => this.release(),
      () => this.release(),
    );
    return this.closePromise;
  }

  private async assertOwnership(): Promise<void> {
    try {
      await verifyDirectoryLease(this.options.root);
      await verifyDirectoryLease(this.options.state);
      await verifyDirectoryLease(this.options.gateDirectory);
      const gate = await lstat(this.options.gatePath);
      const anchor = await lstat(this.options.anchorPath);
      assertExactGatePair(gate, anchor);
      assertSameIdentity(gate, this.options.gateIdentity, "KERNEL_LOCK_OWNERSHIP_LOST");
      const owned = await this.options.gateHandle.stat();
      assertSameIdentity(owned, this.options.gateIdentity, "KERNEL_LOCK_OWNERSHIP_LOST");
    } catch (error) {
      if (error instanceof Error && error.message === "KERNEL_LOCK_GATE_IDENTITY_MISMATCH") {
        throw new Error("KERNEL_LOCK_OWNERSHIP_LOST", { cause: error });
      }
      if (error instanceof Error && error.message.startsWith("KERNEL_LOCK_")) throw error;
      throw new Error("KERNEL_LOCK_OWNERSHIP_LOST", { cause: error });
    }
  }

  private async release(): Promise<void> {
    let identityFailure: Error | null = null;
    let unlockFailure: Error | null = null;
    let gateCloseFailure: Error | null = null;
    let directoryCloseFailure: Error | null = null;
    try {
      await this.assertOwnership();
    } catch (error) {
      identityFailure = error instanceof Error
        ? error
        : new Error("KERNEL_LOCK_OWNERSHIP_LOST", { cause: error });
    }
    try {
      const result = this.options.addon.unlock(this.options.gateHandle.fd);
      if (!result.ok) unlockFailure = new Error("KERNEL_LOCK_UNLOCK_FAILED");
    } catch (error) {
      unlockFailure = new Error("KERNEL_LOCK_UNLOCK_FAILED", { cause: error });
    }
    try {
      await this.options.gateHandle.close();
    } catch (error) {
      gateCloseFailure = new Error("KERNEL_LOCK_GATE_CLOSE_FAILED", { cause: error });
    }
    for (const handle of [
      this.options.gateDirectory.handle,
      this.options.state.handle,
      this.options.root.handle,
    ]) {
      try {
        await handle.close();
      } catch (error) {
        directoryCloseFailure ??= new Error("KERNEL_LOCK_DIRECTORY_CLOSE_FAILED", { cause: error });
      }
    }
    const failure = identityFailure ?? unlockFailure ?? gateCloseFailure ?? directoryCloseFailure;
    if (failure !== null) throw failure;
  }
}

async function verifyDirectoryLease(directory: DirectoryLease): Promise<void> {
  const current = await lstat(directory.path);
  assertDirectoryIdentity(current, directory.identity);
  const opened = await directory.handle.stat();
  assertDirectoryIdentity(opened, directory.identity);
}

function assertDirectoryIdentity(
  actual: { dev: bigint | number; ino: bigint | number; mode: number; uid: number; isDirectory(): boolean },
  expected: { dev: bigint | number; ino: bigint | number },
): void {
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
      actual.uid !== currentUid() || (actual.mode & 0o777) !== 0o700) {
    throw new Error("KERNEL_LOCK_ROOT_IDENTITY_INVALID");
  }
}

function assertExactGatePair(
  gate: { dev: bigint | number; ino: bigint | number; mode: number; uid: number; nlink: number; isFile(): boolean; isSymbolicLink(): boolean },
  anchor: { dev: bigint | number; ino: bigint | number; mode: number; uid: number; nlink: number; isFile(): boolean; isSymbolicLink(): boolean },
): void {
  if (!gate.isFile() || gate.isSymbolicLink() || !anchor.isFile() || anchor.isSymbolicLink() ||
      gate.dev !== anchor.dev || gate.ino !== anchor.ino ||
      gate.uid !== currentUid() || anchor.uid !== currentUid() ||
      (gate.mode & 0o777) !== 0o600 || (anchor.mode & 0o777) !== 0o600 ||
      gate.nlink !== 2 || anchor.nlink !== 2) {
    throw new Error("KERNEL_LOCK_GATE_IDENTITY_MISMATCH");
  }
}

function assertSameIdentity(
  actual: { dev: bigint | number; ino: bigint | number },
  expected: { dev: bigint | number; ino: bigint | number },
  code: string,
): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(code);
}

function identityOf(stat: { dev: bigint | number; ino: bigint | number; mode: number; nlink: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink };
}

async function legacyArtifacts(stateDirectory: string, purpose: string): Promise<string[]> {
  if (purpose === "live-operation" || purpose === "release-maintenance") {
    return await existingPaths([path.join(stateDirectory, "live-operation.lock")]);
  }
  if (purpose === "release-installer") {
    return await existingPaths([path.join(stateDirectory, "release-install.lock")]);
  }
  const match = /^encrypted-store-transaction:(.+)$/u.exec(purpose);
  if (match?.[1] === undefined) return [];
  const lockRelativePath = match[1];
  if (path.isAbsolute(lockRelativePath) || lockRelativePath.includes("..")) {
    throw new Error("KERNEL_LOCK_PURPOSE_INVALID");
  }
  const lockPath = path.join(path.dirname(stateDirectory), lockRelativePath);
  const claimPath = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.recovery.claim`);
  const candidates = await legacyCandidatePaths(path.dirname(lockPath), path.basename(claimPath, ".claim"));
  return [
    ...(await existingPaths([lockPath, claimPath])),
    ...candidates,
  ];
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const candidate of paths) {
    try {
      const identity = await lstat(candidate);
      if (identity.isFile() && !identity.isSymbolicLink() &&
          (await readFile(candidate, "utf8")) === compatibilityTombstone) {
        continue;
      }
      existing.push(candidate);
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
  return existing;
}

async function legacyCandidatePaths(directory: string, prefix: string): Promise<string[]> {
  try {
    const entries = await readdir(directory);
    return entries
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".candidate"))
      .map((name) => path.join(directory, name));
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(handle: FileHandle): Promise<void> {
  await handle.sync();
}

function currentUid(): number {
  if (typeof process.getuid !== "function") throw new Error("KERNEL_LOCK_UID_UNAVAILABLE");
  return process.getuid();
}

function assertAcquireOptions(
  options: AcquireKernelLeaseOptions,
): asserts options is AcquireKernelLeaseOptions & { readonly purpose: CatalogPurpose } {
  if (typeof options?.dataRoot !== "string" || options.dataRoot.length === 0 ||
      typeof options.purpose !== "string" ||
      !(catalogPurposes as readonly string[]).includes(options.purpose) ||
      (options.expectedAddonSha256 !== undefined &&
        !/^[a-f0-9]{64}$/u.test(options.expectedAddonSha256))) {
    throw new Error("KERNEL_LOCK_OPTIONS_INVALID");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
