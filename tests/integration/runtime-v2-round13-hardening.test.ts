import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface NativeStatus {
  readonly ok: boolean;
  readonly errno: number;
}

interface NativeReceipt extends NativeStatus {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly name?: string;
}

interface KernelAddon {
  createFileAtNoReplace(parentFd: number, name: string, mode: number): NativeReceipt;
  openDirectoryAtNoFollow(parentFd: number, name: string): NativeReceipt;
  closeFd(fd: number): NativeStatus;
  linkAtNoReplace(parentFd: number, source: string, target: string): NativeStatus;
  [key: string]: unknown;
}

interface CandidateHandle {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
}

interface ContainerReceipt {
  readonly containerSha256: string;
  readonly headerSha256: string;
  readonly payloadManifestSha256: string;
  readonly entryCount: number;
  readonly size: number;
  readonly identity: CandidateHandle & { readonly size: number };
}

interface ContainerHandle {
  readonly fd: number;
  readonly name: string;
  readonly receipt: ContainerReceipt;
  readonly identity: ContainerReceipt["identity"];
}

interface ContainerModule {
  writePayloadContainerFromDirectory(input: {
    candidate: CandidateHandle;
    parentFd: number;
    name: string;
    addon: KernelAddon;
    beforeResourceClose?: (stage: string, context: { phase?: string }) => Promise<void> | void;
  }): Promise<ContainerHandle>;
  writePayloadContainerFromDirectory(input: {
    candidateRoot: string;
    parentFd: number;
    name: string;
    addon: KernelAddon;
    beforeResourceClose?: (stage: string, context: { phase?: string }) => Promise<void> | void;
  }): Promise<ContainerHandle>;
  validatePayloadContainerFd(input: {
    fd: number;
    expectedIdentity?: ContainerReceipt["identity"];
  }): Promise<ContainerReceipt>;
  readPayloadContainerEntries(fd: number): {
    readonly entries: ReadonlyArray<{ readonly path: string }>;
  };
  materializePayloadContainer(input: {
    fd: number;
    expectedReceipt: ContainerReceipt;
    destination: CandidateHandle;
    addon: KernelAddon;
    assertBoundary: () => Promise<void>;
    beforeMutation: (stage: string, context: { path?: string }) => Promise<void>;
    beforeResourceClose: undefined;
  }): Promise<unknown>;
}

const projectRoot = process.cwd();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("runtime-v2 Fix Round 13 hardening", () => {
  it("scans and copies only the originally opened candidate fd after pathname replacement", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const candidateParent = await makeRoot("round13-candidate-parent-");
    const candidateRoot = await makeCandidateFixture(
      { files: { "original.txt": "owned\n" } },
      candidateParent,
    );
    // Darwin requires owner write permission on an opened directory inode for this rename fixture.
    await chmod(candidateRoot, 0o755);
    const candidateParentFd = openSync(candidateParent, constants.O_RDONLY | constants.O_DIRECTORY);
    const candidate = addon.openDirectoryAtNoFollow(candidateParentFd, path.basename(candidateRoot));
    expect(candidate.ok).toBe(true);
    const displaced = `${candidateRoot}.opened-tree`;
    await rename(candidateRoot, displaced);
    await mkdir(candidateRoot, { mode: 0o700 });
    await writeFile(path.join(candidateRoot, "foreign.txt"), "foreign\n", { mode: 0o600 });
    const output = await makeRoot("round13-fd-candidate-output-");
    const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    let container: ContainerHandle | undefined;
    try {
      container = await module.writePayloadContainerFromDirectory({
        candidate,
        parentFd: outputFd,
        name: "payload.container",
        addon,
      });
      const paths = module.readPayloadContainerEntries(container.fd).entries.map(({ path: entry }) => entry);
      expect(paths).toContain("original.txt");
      expect(paths).not.toContain("foreign.txt");
      expect(await readFile(path.join(candidateRoot, "foreign.txt"), "utf8")).toBe("foreign\n");
    } finally {
      if (container !== undefined) expect(addon.closeFd(container.fd).ok).toBe(true);
      expect(addon.closeFd(candidate.fd).ok).toBe(true);
      closeSync(candidateParentFd);
      closeSync(outputFd);
    }
  });

  it("retains the opened container named entry after a copy failure instead of unlinking it", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const candidateRoot = await makeCandidateFixture();
    const output = await makeRoot("round13-retained-container-");
    const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    let failure: unknown;
    try {
      await writeCandidateContainer(module, addon, candidateRoot, {
        parentFd: outputFd,
        name: "retained.container",
        beforeResourceClose: (_stage, context) => {
          if (context.phase === "copy") throw new Error("ROUND13_COPY_FAILED");
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(errorTreeContains(failure, "ROUND13_COPY_FAILED")).toBe(true);
    expect(await readdir(output)).toContain("retained.container");
    expect(Reflect.ownKeys(addon)).not.toContain("unlinkFileAtExpected");
    closeSync(outputFd);
  });

  it("accepts NFC Unicode paths and rejects Unicode full-casefold collisions", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const output = await makeRoot("round13-unicode-output-");
    const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    const unicode = await makeCandidateFixture({ files: { "天气.txt": "晴\n" } });
    const valid = await writeCandidateContainer(module, addon, unicode, {
      parentFd: outputFd, name: "unicode.container",
    });
    expect(module.readPayloadContainerEntries(valid.fd).entries.map(({ path: entry }) => entry))
      .toContain("天气.txt");
    expect(addon.closeFd(valid.fd).ok).toBe(true);

    // Case-insensitive APFS itself aliases these names, so exercise the parser with a
    // canonical adversarial header rather than pretending both can coexist in a directory.
    const collisionPath = path.join(output, "collision.container");
    await writeCollisionContainer(collisionPath, ["STRASSE", "Straße"]);
    const collision = await open(collisionPath, "r+");
    await expect(module.validatePayloadContainerFd({ fd: collision.fd }))
      .rejects.toThrow("PAYLOAD_CONTAINER_PATH_COLLISION");
    await collision.close();
    closeSync(outputFd);
  });

  it("rejects hard-linked symlinks before trusting their targets", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const candidateRoot = await makeCandidateFixture({
      symlinks: { "link-one": "package.json" },
    });
    await chmod(candidateRoot, 0o700);
    const rootFd = openSync(candidateRoot, constants.O_RDONLY | constants.O_DIRECTORY);
    expect(addon.linkAtNoReplace(rootFd, "link-one", "link-two").ok).toBe(true);
    await rewriteManifest(candidateRoot, {
      symlinks: { "link-one": "package.json", "link-two": "package.json" },
    });
    await chmod(candidateRoot, 0o555);
    const output = await makeRoot("round13-symlink-hardlink-");
    const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    await expect(writeCandidateContainer(module, addon, candidateRoot, {
      parentFd: outputFd, name: "payload.container",
    })).rejects.toThrow("PAYLOAD_CONTAINER_HARDLINK_INVALID");
    closeSync(rootFd);
    closeSync(outputFd);
  });

  it("aggregates operation and every Node/Native close error without swallowed catches", async () => {
    const [containerSource, installerSource] = await Promise.all([
      readFile("scripts/runtime-v2-payload-container.mjs", "utf8"),
      readFile("scripts/runtime-v2-clean-install.mjs", "utf8"),
    ]);
    expect(containerSource).not.toMatch(/catch\(\(\) => undefined\)|Promise\.allSettled/u);
    expect(installerSource).not.toMatch(/catch\(\(\) => undefined\)|Promise\.allSettled/u);
    expect(containerSource).toContain("AggregateError");
  });

  it("revalidates the complete container receipt after a hook and before the first mutation", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const candidateRoot = await makeCandidateFixture();
    const output = await makeRoot("round13-receipt-source-");
    const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    const container = await writeCandidateContainer(module, addon, candidateRoot, {
      parentFd: outputFd, name: "payload.container",
    });
    const destinationParent = await makeRoot("round13-receipt-destination-");
    const releaseRoot = path.join(destinationParent, "release");
    await mkdir(releaseRoot, { mode: 0o700 });
    const releaseFd = openSync(releaseRoot, constants.O_RDONLY | constants.O_DIRECTORY);
    const releaseStat = fstatSync(releaseFd);
    let tampered = false;
    try {
      await expect(module.materializePayloadContainer({
        fd: container.fd,
        expectedReceipt: container.receipt,
        destination: {
          fd: releaseFd,
          dev: Number(releaseStat.dev),
          ino: Number(releaseStat.ino),
          uid: releaseStat.uid,
          mode: releaseStat.mode,
          nlink: releaseStat.nlink,
        },
        addon,
        assertBoundary: () => Promise.resolve(),
        beforeResourceClose: undefined,
        beforeMutation: async () => {
          if (tampered) return;
          tampered = true;
          await appendFile(path.join(output, "payload.container"), Buffer.from([0]));
        },
      })).rejects.toThrow(/PAYLOAD_CONTAINER_/u);
      expect(tampered).toBe(true);
      expect(await readdir(releaseRoot)).toEqual([]);
    } finally {
      expect(addon.closeFd(container.fd).ok).toBe(true);
      closeSync(releaseFd);
      closeSync(outputFd);
    }
  });

  it("provides a hash-chained append-only phase machine and rejects jumps, tamper and truncation", async () => {
    const journal = await loadInstallJournalModule();
    expect(journal.INSTALL_PHASES).toEqual([
      "intent-recorded", "container-created", "population-started", "container-validated",
      "gates-held", "materialized",
      "release-validated", "ready-to-link", "current-published", "complete", "error",
    ]);
    const root = await makeRoot("round13-journal-");
    const handle = await open(path.join(root, "journal.jsonl"), "wx+", 0o600);
    try {
      let state = await journal.appendInstallPhase({
        fd: handle.fd, txid: "a".repeat(32), previous: null,
        phase: "intent-recorded", facts: { containerSha256: "b".repeat(64) },
      });
      state = await journal.appendInstallPhase({
        fd: handle.fd, txid: "a".repeat(32), previous: state,
        phase: "container-created", facts: { manifestSha256: "c".repeat(64) },
      });
      expect(journal.parseInstallJournal(await handle.readFile())).toEqual(state);
      await expect(journal.appendInstallPhase({
        fd: handle.fd, txid: "a".repeat(32), previous: state,
        phase: "release-validated", facts: {},
      })).rejects.toThrow("RUNTIME_V2_INSTALL_PHASE_INVALID");
      const bytes = await handle.readFile();
      const tampered = Buffer.from(bytes);
      const tamperedIndex = Math.max(0, tampered.length - 3);
      tampered[tamperedIndex] = (tampered[tamperedIndex] ?? 0) ^ 1;
      expect(() => journal.parseInstallJournal(tampered))
        .toThrow("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
      expect(() => journal.parseInstallJournal(bytes.subarray(0, bytes.length - 1)))
        .toThrow("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
    } finally {
      await handle.close();
    }
  });

  it("cleans only a bound real dist directory and rejects a symlink without touching its target", async () => {
    const cleaner = await loadCleanDistModule();
    const root = await makeRoot("round13-clean-dist-");
    await writeFile(path.join(root, "package.json"), "{\"name\":\"wechat-ai-assistant-public\"}\n");
    await mkdir(path.join(root, "dist"), { mode: 0o700 });
    await writeFile(path.join(root, "dist", "stale.js"), "stale\n");
    await cleaner.cleanDist({ sourceRoot: root });
    await expect(lstat(path.join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" });

    const foreign = await makeRoot("round13-clean-dist-foreign-");
    await writeFile(path.join(foreign, "keep"), "keep\n");
    await symlink(foreign, path.join(root, "dist"));
    await expect(cleaner.cleanDist({ sourceRoot: root }))
      .rejects.toThrow("CLEAN_DIST_IDENTITY_INVALID");
    expect(await readFile(path.join(foreign, "keep"), "utf8")).toBe("keep\n");
  });

  it("binds clean source inputs, source dist and candidate dist in release provenance", async () => {
    const [packageDocument, releaseSource] = await Promise.all([
      readFile("package.json", "utf8").then((value) => JSON.parse(value) as { scripts?: { build?: string } }),
      readFile("scripts/release-payload.mjs", "utf8"),
    ]);
    expect(packageDocument.scripts?.build).toMatch(
      /^node scripts\/build-kernel-lock-addon\.mjs && node scripts\/clean-dist\.mjs && /u,
    );
    expect(releaseSource).toContain('"scripts/clean-dist.mjs"');
    for (const field of [
      "sourceInputSha256", "sourceDistTreeSha256", "candidateInputSha256", "candidateDistTreeSha256",
    ]) {
      expect(releaseSource).toContain(field);
    }
  });
});

interface InstallJournalState {
  readonly txid: string;
  readonly sequence: number;
  readonly phase: string;
  readonly recordSha256: string;
}

interface InstallJournalModule {
  readonly INSTALL_PHASES: readonly string[];
  appendInstallPhase(input: {
    fd: number;
    txid: string;
    previous: InstallJournalState | null;
    phase: string;
    facts: Record<string, unknown>;
  }): Promise<InstallJournalState>;
  parseInstallJournal(bytes: Buffer): InstallJournalState;
}

interface CleanDistModule {
  cleanDist(input: { sourceRoot: string }): Promise<void>;
}

async function loadContainerModule(): Promise<ContainerModule> {
  return await import(`${pathToFileURL(path.join(
    projectRoot, "scripts/runtime-v2-payload-container.mjs",
  )).href}?round13=${randomUUID()}`) as ContainerModule;
}

async function loadInstallJournalModule(): Promise<InstallJournalModule> {
  return await import(`${pathToFileURL(path.join(
    projectRoot, "scripts/runtime-v2-install-journal.mjs",
  )).href}?round13=${randomUUID()}`) as InstallJournalModule;
}

async function loadCleanDistModule(): Promise<CleanDistModule> {
  return await import(`${pathToFileURL(path.join(
    projectRoot, "scripts/clean-dist.mjs",
  )).href}?round13=${randomUUID()}`) as CleanDistModule;
}

async function writeCandidateContainer(
  module: ContainerModule,
  addon: KernelAddon,
  candidateRoot: string,
  input: {
    parentFd: number;
    name: string;
    beforeResourceClose?: (stage: string, context: { phase?: string }) => Promise<void> | void;
  },
): Promise<ContainerHandle> {
  const parentFd = openSync(path.dirname(candidateRoot), constants.O_RDONLY | constants.O_DIRECTORY);
  const candidate = addon.openDirectoryAtNoFollow(parentFd, path.basename(candidateRoot));
  expect(candidate.ok).toBe(true);
  try {
    return await module.writePayloadContainerFromDirectory({ candidate, addon, ...input });
  } finally {
    expect(addon.closeFd(candidate.fd).ok).toBe(true);
    closeSync(parentFd);
  }
}

function loadKernelAddon(): KernelAddon {
  return createRequire(import.meta.url)(path.join(
    projectRoot, "native/kernel-lock/build", `${process.platform}-${process.arch}`, "kernel_lock.node",
  )) as KernelAddon;
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return realpath(root);
}

async function makeCandidateFixture(options: {
  files?: Record<string, string>;
  symlinks?: Record<string, string>;
} = {}, parent?: string): Promise<string> {
  const root = parent === undefined
    ? await makeRoot("round13-candidate-")
    : path.join(parent, `candidate-${randomUUID()}`);
  if (parent !== undefined) await mkdir(root, { mode: 0o700 });
  await mkdir(path.join(root, "dist", "bin"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(root, "package.json"), "{}\n", { mode: 0o444 });
  await writeFile(path.join(root, "dist", "bin", "entry.js"), "export {};\n", { mode: 0o444 });
  await symlink("dist/bin/entry.js", path.join(root, "entry-link"));
  for (const [name, contents] of Object.entries(options.files ?? {})) {
    await writeFile(path.join(root, name), contents, { mode: 0o444 });
  }
  for (const [name, target] of Object.entries(options.symlinks ?? {})) {
    await symlink(target, path.join(root, name));
  }
  await rewriteManifest(root, options);
  await chmod(path.join(root, "dist", "bin"), 0o555);
  await chmod(path.join(root, "dist"), 0o555);
  await chmod(root, 0o555);
  return root;
}

async function rewriteManifest(root: string, options: {
  files?: Record<string, string>;
  symlinks?: Record<string, string>;
}): Promise<void> {
  await chmod(root, 0o700);
  const fileValues = {
    "dist/bin/entry.js": "export {};\n",
    "package.json": "{}\n",
    ...(options.files ?? {}),
  };
  const symlinkValues = { "entry-link": "dist/bin/entry.js", ...(options.symlinks ?? {}) };
  const entries: Array<Record<string, unknown>> = [
    { path: "dist", type: "directory", size: 0, mode: 0o555 },
    { path: "dist/bin", type: "directory", size: 0, mode: 0o555 },
  ];
  for (const [entryPath, contents] of Object.entries(fileValues)) {
    entries.push({
      path: entryPath, type: "file", size: Buffer.byteLength(contents), mode: 0o444,
      sha256: sha256(contents),
    });
  }
  for (const [entryPath, target] of Object.entries(symlinkValues)) {
    const identity = await lstat(path.join(root, entryPath));
    entries.push({
      path: entryPath, type: "symlink", size: Buffer.byteLength(target),
      mode: identity.mode & 0o777, target,
    });
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(String(left.path)), Buffer.from(String(right.path))));
  const manifestBytes = Buffer.from(`${JSON.stringify({
    manifestVersion: 1,
    provenance: { runtimeContractVersion: 4 },
    entries,
  })}\n`);
  await chmod(path.join(root, "payload-manifest.json"), 0o600).catch(() => undefined);
  await chmod(path.join(root, "payload-manifest.sha256"), 0o600).catch(() => undefined);
  await writeFile(path.join(root, "payload-manifest.json"), manifestBytes, { mode: 0o444 });
  await writeFile(path.join(root, "payload-manifest.sha256"), `${sha256(manifestBytes)}\n`, {
    mode: 0o444,
  });
  await chmod(path.join(root, "payload-manifest.json"), 0o444);
  await chmod(path.join(root, "payload-manifest.sha256"), 0o444);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeCollisionContainer(containerPath: string, names: readonly string[]): Promise<void> {
  const emptyHash = sha256(Buffer.alloc(0));
  const header = {
    dataSize: 0,
    entries: names.map((name) => ({
      mode: 0o555,
      path: name,
      sha256: emptyHash,
      size: 0,
      type: "directory",
    })),
    entryCount: names.length,
    formatVersion: 1,
  };
  const headerBytes = Buffer.from(`${JSON.stringify(header)}\n`);
  const prefix = Buffer.alloc(52);
  prefix.write("WCAPC001", 0, "ascii");
  prefix.writeUInt32BE(headerBytes.length, 8);
  prefix.writeBigUInt64BE(0n, 12);
  Buffer.from(sha256(headerBytes), "hex").copy(prefix, 20);
  await writeFile(containerPath, Buffer.concat([prefix, headerBytes]), { mode: 0o600 });
}

function errorTreeContains(value: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (value === expected) return true;
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Error && value.message === expected) return true;
  if (value instanceof AggregateError &&
      value.errors.some((entry) => errorTreeContains(entry, expected, seen))) return true;
  return "cause" in value && errorTreeContains(value.cause, expected, seen);
}

async function makeTreeWritable(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => undefined);
  const children = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    if (child.isDirectory() && !child.isSymbolicLink()) {
      await makeTreeWritable(path.join(root, child.name));
    }
  }
}
