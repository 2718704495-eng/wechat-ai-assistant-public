import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface KernelLockReceipt {
  readonly purpose: string;
  readonly gateIdentity: { readonly dev: number; readonly ino: number };
  readonly catalogSha256: string;
  readonly acquisitionNonce: string;
}

interface KernelLease {
  readonly gateIdentity: { dev: number; ino: number };
  readonly gatePath: string;
  readonly kernelLockReceipt: KernelLockReceipt;
  close(): Promise<void>;
}

interface KernelLockModule {
  initializeKernelLockCatalogForInstaller(options: {
    dataRoot: string;
    hook?(stage: string): Promise<void> | void;
  }): Promise<{ status: "initialized" | "already-initialized"; catalogSha256: string }>;
  acquireKernelLease(options: { dataRoot: string; purpose: string }): Promise<KernelLease>;
  validateKernelLockAddonApi(addon: unknown): void;
  compatibilityTombstoneContents(): string;
}

const projectRoot = process.cwd();
const purposes = ["release-installer", "live-operation", "encrypted-store-global"];
const children = new Set<ChildProcess>();

describe("Round 7 bootstrap tombstones and installer-only catalog", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "kernel-lock-round7-"));
    await chmod(root, 0o700);
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    children.clear();
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  });

  it("installs two opaque tombstones and a fixed three-purpose catalog exactly once", async () => {
    const kernel = await moduleUnderTest();
    const initialized = await kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root });
    expect(initialized.status).toBe("initialized");
    expect(initialized.catalogSha256).toMatch(/^[a-f0-9]{64}$/u);

    const state = path.join(root, "state");
    for (const name of ["release-install.lock", "live-operation.lock"]) {
      const filePath = path.join(state, name);
      const identity = await lstat(filePath);
      expect(identity.isFile()).toBe(true);
      expect(identity.mode & 0o777).toBe(0o600);
      expect(await readFile(filePath, "utf8")).toBe(kernel.compatibilityTombstoneContents());
    }
    const catalogDirectory = path.join(state, ".kernel-lock-v1");
    expect((await readdir(catalogDirectory)).sort()).toEqual([
      "catalog.json",
      "catalog.sha256",
      ...purposes.flatMap((purpose) => {
        const digest = createHash("sha256").update(purpose).digest("hex");
        return [`${digest}.anchor`, `${digest}.gate`];
      }),
    ].sort());

    await expect(kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root }))
      .resolves.toMatchObject({ status: "already-initialized" });
  });

  it.each([
    ["regular", async (target: string) => writeFile(target, "legacy owner", { mode: 0o600 })],
    ["malformed", async (target: string) => writeFile(target, "{}\n", { mode: 0o600 })],
    ["directory", async (target: string) => mkdir(target, { mode: 0o700 })],
    ["symlink", async (target: string) => symlink("elsewhere", target)],
  ] as const)("fails closed for a pre-existing %s base path with zero protocol writes", async (_kind, seed) => {
    const kernel = await moduleUnderTest();
    const state = path.join(root, "state");
    await mkdir(state, { mode: 0o700 });
    const occupied = path.join(state, "live-operation.lock");
    await seed(occupied);
    const before = await lstat(occupied);

    await expect(kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root }))
      .rejects.toThrow("KERNEL_BOOTSTRAP_LEGACY_PATH_OCCUPIED");

    expect(await lstat(occupied)).toMatchObject({ dev: before.dev, ino: before.ino });
    await expect(access(path.join(state, "release-install.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(state, ".kernel-lock-v1"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(state, "release-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an exact first tombstone when second-path occupation races, then resumes", async () => {
    const kernel = await moduleUnderTest();
    let injected = false;
    await expect(kernel.initializeKernelLockCatalogForInstaller({
      dataRoot: root,
      hook: async (stage) => {
        if (stage !== "tombstone-durable:release-install.lock" || injected) return;
        injected = true;
        await writeFile(path.join(root, "state", "live-operation.lock"), "old owner", {
          flag: "wx",
          mode: 0o600,
        });
      },
    })).rejects.toThrow("KERNEL_BOOTSTRAP_LEGACY_PATH_OCCUPIED");

    const firstPath = path.join(root, "state", "release-install.lock");
    const first = await lstat(firstPath);
    expect(await readFile(firstPath, "utf8")).toBe(kernel.compatibilityTombstoneContents());
    await rm(path.join(root, "state", "live-operation.lock"));
    await kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root });
    expect(await lstat(firstPath)).toMatchObject({ dev: first.dev, ino: first.ino });
  });

  it.each(["anchor-created", "gate-linked", "directory-fsync"])(
    "converges without replacing the anchor after a real SIGKILL at %s",
    async (crashStage) => {
      const kernel = await moduleUnderTest();
      const readyPath = path.join(root, `ready-${crashStage}.json`);
      const child = spawn(process.execPath, [
        path.resolve("node_modules/vitest/vitest.mjs"),
        "run",
        path.resolve("tests/fixtures/kernel-lock-bootstrap-worker.test.ts"),
        "--pool=threads",
        "--maxWorkers=1",
        "--reporter=dot",
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          KERNEL_LOCK_BOOTSTRAP_WORKER: "1",
          KERNEL_LOCK_BOOTSTRAP_ROOT: root,
          KERNEL_LOCK_BOOTSTRAP_STAGE: crashStage,
          KERNEL_LOCK_BOOTSTRAP_READY: readyPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      await waitForPath(readyPath);
      const observed = JSON.parse(await readFile(readyPath, "utf8")) as { stage: string };
      const digest = observed.stage.split(":")[1];
      if (digest === undefined) throw new Error("ROUND7_CRASH_STAGE_NOT_REACHED");
      const anchorPath = path.join(root, "state", ".kernel-lock-v1", `${digest}.anchor`);
      const before = await lstat(anchorPath);
      expect(child.kill("SIGKILL")).toBe(true);
      const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
      children.delete(child);
      expect({ code, signal }).toEqual({ code: null, signal: "SIGKILL" });

      await expect(kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root }))
        .resolves.toMatchObject({ status: "initialized" });
      expect(await lstat(anchorPath)).toMatchObject({ dev: before.dev, ino: before.ino });
    },
  );

  it("makes runtime refuse a missing or partial catalog and a pending release WAL", async () => {
    const kernel = await moduleUnderTest();
    await expect(kernel.acquireKernelLease({ dataRoot: root, purpose: "live-operation" }))
      .rejects.toThrow("KERNEL_LOCK_CATALOG_MISSING");
    await kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root });
    const catalog = path.join(root, "state", ".kernel-lock-v1", "catalog.json");
    const original = await readFile(catalog, "utf8");
    await writeFile(catalog, `${original} `);
    await expect(kernel.acquireKernelLease({ dataRoot: root, purpose: "live-operation" }))
      .rejects.toThrow("KERNEL_LOCK_CATALOG_INVALID");
    await writeFile(catalog, original);
    await writeFile(path.join(root, "state", "release-transaction.json"), JSON.stringify({
      version: 7,
      phase: "awaiting-commit",
    }), { mode: 0o600 });
    await expect(kernel.acquireKernelLease({ dataRoot: root, purpose: "live-operation" }))
      .rejects.toThrow("RELEASE_RUNTIME_QUARANTINED");
  });

  it("serializes on the live gate before making the final WAL admission decision", async () => {
    const kernel = await moduleUnderTest();
    await kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root });
    const owner = await kernel.acquireKernelLease({ dataRoot: root, purpose: "live-operation" });
    await writeFile(path.join(root, "state", "release-transaction.json"), JSON.stringify({
      version: 7,
      phase: "awaiting-commit",
    }), { mode: 0o600 });
    await expect(kernel.acquireKernelLease({ dataRoot: root, purpose: "live-operation" }))
      .rejects.toThrow("KERNEL_LOCK_BUSY");
    await owner.close();
    await expect(kernel.acquireKernelLease({ dataRoot: root, purpose: "live-operation" }))
      .rejects.toThrow("RELEASE_RUNTIME_QUARANTINED");
  });

  it("requires exact non-enumerable native keys and exposes an immutable lock receipt", async () => {
    const kernel = await moduleUnderTest();
    const addonPath = path.join(
      projectRoot,
      "native",
      "kernel-lock",
      "build",
      `${process.platform}-${process.arch}`,
      "kernel_lock.node",
    );
    const addon = createRequire(import.meta.url)(addonPath) as object;
    expect(Reflect.ownKeys(addon)).toEqual([
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
    ]);
    for (const key of Reflect.ownKeys(addon)) {
      expect(Object.getOwnPropertyDescriptor(addon, key)).toMatchObject({
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
    kernel.validateKernelLockAddonApi(addon);

    const extra = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(addon)) {
      Object.defineProperty(extra, key, Object.getOwnPropertyDescriptor(addon, key) as PropertyDescriptor);
    }
    Object.defineProperty(extra, Symbol("hidden"), { value: () => undefined });
    expect(() => kernel.validateKernelLockAddonApi(extra)).toThrow("KERNEL_LOCK_ADDON_API_INVALID");

    await kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root });
    const lease = await kernel.acquireKernelLease({ dataRoot: root, purpose: "live-operation" });
    expect(Object.isFrozen(lease.kernelLockReceipt)).toBe(true);
    expect(lease.kernelLockReceipt.purpose).toBe("live-operation");
    expect(lease.kernelLockReceipt.gateIdentity).toEqual(lease.gateIdentity);
    expect(lease.kernelLockReceipt.catalogSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(lease.kernelLockReceipt.acquisitionNonce).toMatch(/^[0-9a-f-]{36}$/u);
    await lease.close();
  });

  it("reports final identity loss from close instead of silently unlocking a replaced path", async () => {
    const kernel = await moduleUnderTest();
    await kernel.initializeKernelLockCatalogForInstaller({ dataRoot: root });
    const lease = await kernel.acquireKernelLease({ dataRoot: root, purpose: "live-operation" });
    const displaced = `${lease.gatePath}.displaced`;
    await rename(lease.gatePath, displaced);
    await writeFile(lease.gatePath, "", { flag: "wx", mode: 0o600 });

    await expect(lease.close()).rejects.toThrow("KERNEL_LOCK_OWNERSHIP_LOST");
  });
});

async function moduleUnderTest(): Promise<KernelLockModule> {
  return await import(new URL("../../src/storage/kernel-lock.js", import.meta.url).href) as KernelLockModule;
}

async function makeTreeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await chmod(root, 0o700).catch(() => undefined);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await makeTreeWritable(path.join(root, entry.name));
  }
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
  throw new Error(`ROUND7_BOOTSTRAP_WORKER_TIMEOUT:${path.basename(filePath)}`);
}
