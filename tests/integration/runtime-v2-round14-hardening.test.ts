import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import {
  appendFile,
  chmod,
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

interface NativeReceipt {
  readonly ok: boolean;
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly name?: string;
}

interface KernelAddon {
  openDirectoryAtNoFollow(parentFd: number, name: string): NativeReceipt;
  closeFd(fd: number): { readonly ok: boolean };
  [key: string]: unknown;
}

interface ContainerReceipt {
  readonly containerSha256: string;
  readonly headerSha256: string;
  readonly payloadManifestSha256: string;
  readonly entryCount: number;
  readonly size: number;
  readonly identity: NativeReceipt & { readonly size: number };
}

interface ContainerModule {
  writePayloadContainerFromDirectory(input: {
    readonly candidate: NativeReceipt;
    readonly parentFd: number;
    readonly name: string;
    readonly addon: KernelAddon;
  }): Promise<{ readonly fd: number; readonly receipt: ContainerReceipt }>;
  validatePayloadContainerFd(input: { readonly fd: number }): Promise<ContainerReceipt>;
  materializePayloadContainer(input: {
    readonly fd: number;
    readonly expectedReceipt: ContainerReceipt;
    readonly destination: NativeReceipt;
    readonly addon: KernelAddon;
    readonly assertBoundary: () => Promise<void>;
    readonly beforeMutation: () => Promise<void>;
    readonly beforeResourceClose: undefined;
    readonly beforeAuthorizationStage?: (stage: string) => Promise<void>;
  }): Promise<unknown>;
}

interface CleanDistModule {
  cleanDist(input: {
    readonly sourceRoot: string;
    readonly beforeRemove?: () => Promise<void>;
  }): Promise<void>;
}

interface JournalState {
  readonly txid: string;
  readonly sequence: number;
  readonly phase: string;
  readonly recordSha256: string;
}

interface JournalModule {
  readonly INSTALL_PHASES: readonly string[];
  appendInstallPhase(input: {
    readonly fd: number;
    readonly txid: string;
    readonly previous: JournalState | null;
    readonly phase: string;
    readonly facts: Record<string, unknown>;
  }): Promise<JournalState>;
}

interface InstallerIdentityModule {
  decodeDurableContainerIdentityFact(value: Record<string, unknown>): {
    readonly dev: number;
    readonly ino: number;
    readonly uid: number;
    readonly mode: number;
    readonly nlink: number;
    readonly size: number;
  };
  assertStableParentIdentityFact(
    observed: {
      readonly dev: number | bigint;
      readonly ino: number | bigint;
      readonly uid: number;
      readonly mode: number;
      readonly nlink: number;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    },
    fact: Record<string, unknown>,
  ): void;
}

const projectRoot = process.cwd();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("runtime-v2 Fix Round 14 hardening", () => {
  it("uses a bound source-root fd for clean-dist and retains a replacement named entry", async () => {
    const cleaner = await loadCleanDistModule();
    const parent = await makeRoot("round14-clean-parent-");
    const sourceRoot = path.join(parent, "source");
    const dist = path.join(sourceRoot, "dist");
    const openedTree = path.join(sourceRoot, "dist-opened");
    await mkdir(dist, { recursive: true, mode: 0o700 });
    await writeFile(path.join(sourceRoot, "package.json"), "{\"name\":\"wechat-ai-assistant-public\"}\n");
    await writeFile(path.join(dist, "owned.js"), "owned\n");
    let replaced = false;

    await expect(cleaner.cleanDist({
      sourceRoot,
      beforeRemove: async () => {
        replaced = true;
        await rename(dist, openedTree);
        await mkdir(dist, { mode: 0o700 });
        await writeFile(path.join(dist, "foreign.js"), "foreign\n");
      },
    })).rejects.toThrow("CLEAN_DIST_IDENTITY_INVALID");

    expect(replaced).toBe(true);
    expect(await readFile(path.join(dist, "foreign.js"), "utf8")).toBe("foreign\n");
    expect(await readFile(path.join(openedTree, "owned.js"), "utf8")).toBe("owned\n");
    const source = await readFile("scripts/clean-dist.mjs", "utf8");
    expect(source).not.toMatch(/\brm\s*\([^)]*recursive\s*:\s*true/su);
    expect(source).toContain("removePrivateTreeAtExpected");
  });

  it("uses pinned complete Unicode full case-fold including Greek multi-code-point mappings", async () => {
    const module = await loadContainerModule();
    const root = await makeRoot("round14-casefold-");
    const containerPath = path.join(root, "greek.container");
    await writeCollisionContainer(containerPath, ["ᾈ", "ἀι"]);
    const handle = await open(containerPath, "r");
    try {
      await expect(module.validatePayloadContainerFd({ fd: handle.fd }))
        .rejects.toThrow("PAYLOAD_CONTAINER_PATH_COLLISION");
    } finally {
      await handle.close();
    }
    const [containerSource, tableSource] = await Promise.all([
      readFile("scripts/runtime-v2-payload-container.mjs", "utf8"),
      readFile("scripts/unicode-full-casefold.mjs", "utf8"),
    ]);
    expect(containerSource).toContain("unicodeFullCaseFold");
    expect(containerSource).not.toContain("toLocaleLowerCase");
    expect(tableSource).toMatch(/UNICODE_CASEFOLD_VERSION\s*=\s*"[0-9]+\.[0-9]+\.[0-9]+"/u);
    expect(tableSource).toContain("UNICODE_CASEFOLD_TABLE_SHA256");
  });

  it("preserves the operation error and a failing Native close from an invalid opened receipt", async () => {
    const module = await loadContainerModule();
    const realAddon = loadKernelAddon();
    const candidateRoot = await makeCandidateFixture();
    const output = await makeRoot("round14-close-source-");
    const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    const candidateParentFd = openSync(
      path.dirname(candidateRoot),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    const candidate = realAddon.openDirectoryAtNoFollow(candidateParentFd, path.basename(candidateRoot));
    const container = await module.writePayloadContainerFromDirectory({
      candidate,
      parentFd: outputFd,
      name: "payload.container",
      addon: realAddon,
    });
    const destination = await makeRoot("round14-close-destination-");
    const destinationFd = openSync(destination, constants.O_RDONLY | constants.O_DIRECTORY);
    const destinationIdentity = nativeIdentity(destinationFd);
    let invalidFd = -1;
    let closeAttempted = false;
    const injectedAddon = Object.create(realAddon) as KernelAddon;
    Object.defineProperty(injectedAddon, "openDirectoryAtNoFollow", { value: (
      parentFd: number,
      name: string,
    ) => {
      const opened = realAddon.openDirectoryAtNoFollow(parentFd, name);
      invalidFd = opened.fd;
      return { ...opened, uid: -1 };
    } });
    Object.defineProperty(injectedAddon, "closeFd", { value: (fd: number) => {
      const result = realAddon.closeFd(fd);
      if (fd === invalidFd) {
        closeAttempted = true;
        throw new Error("ROUND14_NATIVE_CLOSE_FAILED");
      }
      return result;
    } });
    let caught: unknown;
    try {
      await module.materializePayloadContainer({
        fd: container.fd,
        expectedReceipt: container.receipt,
        destination: destinationIdentity,
        addon: injectedAddon,
        assertBoundary: () => Promise.resolve(),
        beforeMutation: () => Promise.resolve(),
        beforeResourceClose: undefined,
      });
    } catch (error) {
      caught = error;
    } finally {
      realAddon.closeFd(container.fd);
      realAddon.closeFd(candidate.fd);
      closeSync(destinationFd);
      closeSync(candidateParentFd);
      closeSync(outputFd);
    }
    expect(closeAttempted, describeErrorTree(caught)).toBe(true);
    expect(errorTreeContains(caught, "PAYLOAD_CONTAINER_DESTINATION_DRIFT")).toBe(true);
    expect(errorTreeContains(caught, "ROUND14_NATIVE_CLOSE_FAILED")).toBe(true);
  });

  it.each(["after-pre-stamp", "after-full-validation"])(
    "rejects container drift at the %s authorization boundary before any release mutation",
    async (failureStage) => {
      const module = await loadContainerModule();
      const addon = loadKernelAddon();
      const candidateRoot = await makeCandidateFixture();
      const output = await makeRoot(`round14-auth-${failureStage}-`);
      const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
      const candidateParentFd = openSync(
        path.dirname(candidateRoot),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      const candidate = addon.openDirectoryAtNoFollow(candidateParentFd, path.basename(candidateRoot));
      const container = await module.writePayloadContainerFromDirectory({
        candidate,
        parentFd: outputFd,
        name: "payload.container",
        addon,
      });
      const destination = await makeRoot(`round14-auth-destination-${failureStage}-`);
      const destinationFd = openSync(destination, constants.O_RDONLY | constants.O_DIRECTORY);
      let injected = false;
      try {
        await expect(module.materializePayloadContainer({
          fd: container.fd,
          expectedReceipt: container.receipt,
          destination: nativeIdentity(destinationFd),
          addon,
          assertBoundary: () => Promise.resolve(),
          beforeMutation: () => Promise.resolve(),
          beforeResourceClose: undefined,
          beforeAuthorizationStage: async (stage) => {
            if (stage !== failureStage || injected) return;
            injected = true;
            await appendFile(path.join(output, "payload.container"), Buffer.from([0]));
          },
        })).rejects.toThrow(/PAYLOAD_CONTAINER_(?:RECEIPT|IDENTITY|SIZE|AUTHORIZATION)/u);
        expect(injected).toBe(true);
        expect(await readdir(destination)).toEqual([]);
      } finally {
        addon.closeFd(container.fd);
        addon.closeFd(candidate.fd);
        closeSync(destinationFd);
        closeSync(candidateParentFd);
        closeSync(outputFd);
      }
    },
  );

  it("starts the durable phase chain with intent and carries retained identity through terminal records", async () => {
    const journal = await loadJournalModule();
    expect(journal.INSTALL_PHASES).toEqual([
      "intent-recorded", "container-created", "population-started", "container-validated",
      "gates-held", "materialized",
      "release-validated", "ready-to-link", "current-published", "complete", "error",
    ]);
    const root = await makeRoot("round14-intent-");
    const handle = await open(path.join(root, "journal.jsonl"), "wx+", 0o600);
    try {
      const state = await journal.appendInstallPhase({
        fd: handle.fd,
        txid: "a".repeat(32),
        previous: null,
        phase: "intent-recorded",
        facts: {
          containerIdentity: null,
          containerName: "runtime-v2-payload-a.container",
          containerParent: { dev: "1", ino: "2", uid: process.getuid?.() ?? -1 },
          retained: false,
        },
      });
      expect(state.phase).toBe("intent-recorded");
    } finally {
      await handle.close();
    }
    const installerSource = await readFile("scripts/runtime-v2-clean-install.mjs", "utf8");
    const containerCreate = installerSource.indexOf(
      "payloadContainer = await createEmptyPayloadContainer",
    );
    const containerCreated = installerSource.indexOf('phase: "container-created"');
    const containerPopulate = installerSource.indexOf(
      "payloadContainer = await populatePayloadContainerFromDirectory",
    );
    expect(installerSource.indexOf('phase: "intent-recorded"')).toBeGreaterThan(-1);
    expect(installerSource.indexOf('phase: "intent-recorded"'))
      .toBeLessThan(containerCreate);
    expect(containerCreated).toBeGreaterThan(containerCreate);
    expect(containerPopulate).toBeGreaterThan(containerCreated);
    expect(installerSource).toContain("verifyExistingInstallJournalState");
    expect(installerSource).toMatch(/current-published[\s\S]+validateInstalledRuntimeV2/u);
    expect(installerSource).toContain("terminalFromPhase");
  });

  it("performs a full container receipt validation after ready-to-link and before current", async () => {
    const source = await readFile("scripts/runtime-v2-clean-install.mjs", "utf8");
    const ready = source.indexOf('phase: "ready-to-link"');
    const finalReceipt = source.indexOf("before-current-container-validation", ready);
    const current = source.indexOf('symlinkAtNoReplace(runtime.fd, currentTarget, "current")', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(finalReceipt).toBeGreaterThan(ready);
    expect(current).toBeGreaterThan(finalReceipt);
    expect(source.slice(finalReceipt, current)).toContain("validatePayloadContainerFd");
  });

  it("rehydrates durable string dev/ino into the numeric identity required by fd validation", async () => {
    const installer = await loadInstallerIdentityModule();
    expect(typeof installer.decodeDurableContainerIdentityFact).toBe("function");
    expect(installer.decodeDurableContainerIdentityFact({
      dev: "16777234",
      ino: "37967617",
      uid: process.getuid?.() ?? -1,
      mode: constants.S_IFREG | 0o600,
      nlink: 1,
      size: 19_703_621,
    })).toEqual({
      dev: 16_777_234,
      ino: 37_967_617,
      uid: process.getuid?.() ?? -1,
      mode: constants.S_IFREG | 0o600,
      nlink: 1,
      size: 19_703_621,
    });
  });

  it("allows stable parent nlink drift but rejects dev ino uid type or mode drift", async () => {
    const installer = await loadInstallerIdentityModule();
    expect(typeof installer.assertStableParentIdentityFact).toBe("function");
    const uid = process.getuid?.() ?? -1;
    const fact = {
      dev: "7", ino: "11", uid, mode: constants.S_IFDIR | 0o700, nlink: 2,
    };
    const observed = {
      dev: 7, ino: 11, uid, mode: constants.S_IFDIR | 0o700, nlink: 9,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    };
    expect(() => installer.assertStableParentIdentityFact(observed, fact)).not.toThrow();
    for (const drift of [
      { ...observed, dev: 8 },
      { ...observed, ino: 12 },
      { ...observed, uid: uid + 1 },
      { ...observed, mode: constants.S_IFDIR | 0o755 },
      { ...observed, isDirectory: () => false },
      { ...observed, isSymbolicLink: () => true },
    ]) {
      expect(() => installer.assertStableParentIdentityFact(drift, fact))
        .toThrow("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
    }
  });
});

async function loadCleanDistModule(): Promise<CleanDistModule> {
  return await import(
    `${pathToFileURL(path.join(projectRoot, "scripts/clean-dist.mjs")).href}?r14=${randomUUID()}`
  ) as CleanDistModule;
}

async function loadContainerModule(): Promise<ContainerModule> {
  return await import(`${pathToFileURL(path.join(
    projectRoot,
    "scripts/runtime-v2-payload-container.mjs",
  )).href}?r14=${randomUUID()}`) as ContainerModule;
}

async function loadJournalModule(): Promise<JournalModule> {
  return await import(`${pathToFileURL(path.join(
    projectRoot,
    "scripts/runtime-v2-install-journal.mjs",
  )).href}?r14=${randomUUID()}`) as JournalModule;
}

async function loadInstallerIdentityModule(): Promise<InstallerIdentityModule> {
  return await import(`${pathToFileURL(path.join(
    projectRoot,
    "scripts/runtime-v2-clean-install.mjs",
  )).href}?r14-identity=${randomUUID()}`) as InstallerIdentityModule;
}

function loadKernelAddon(): KernelAddon {
  return createRequire(import.meta.url)(path.join(
    projectRoot,
    "native/kernel-lock/build",
    `${process.platform}-${process.arch}`,
    "kernel_lock.node",
  )) as KernelAddon;
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return realpath(root);
}

function nativeIdentity(fd: number): NativeReceipt {
  const value = fstatSync(fd);
  return {
    ok: true,
    fd,
    dev: Number(value.dev),
    ino: Number(value.ino),
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
  };
}

async function makeCandidateFixture(): Promise<string> {
  const root = await makeRoot("round14-candidate-");
  await mkdir(path.join(root, "dist"), { mode: 0o755 });
  await writeFile(path.join(root, "dist", "entry.js"), "export {};\n", { mode: 0o444 });
  await writeFile(path.join(root, "package.json"), "{}\n", { mode: 0o444 });
  await symlink("dist/entry.js", path.join(root, "entry-link"));
  const entries: Array<Record<string, unknown>> = [
    { path: "dist", type: "directory", size: 0, mode: 0o555 },
    {
      path: "dist/entry.js", type: "file", size: 11, mode: 0o444,
      sha256: sha256("export {};\n"),
    },
    { path: "entry-link", type: "symlink", size: 13, mode: 0o755, target: "dist/entry.js" },
    { path: "package.json", type: "file", size: 3, mode: 0o444, sha256: sha256("{}\n") },
  ];
  const manifest = Buffer.from(`${JSON.stringify({
    manifestVersion: 1,
    provenance: { runtimeContractVersion: 4 },
    entries,
  })}\n`);
  await writeFile(path.join(root, "payload-manifest.json"), manifest, { mode: 0o444 });
  await writeFile(path.join(root, "payload-manifest.sha256"), `${sha256(manifest)}\n`, {
    mode: 0o444,
  });
  await chmod(path.join(root, "dist"), 0o555);
  await chmod(root, 0o555);
  return root;
}

async function writeCollisionContainer(containerPath: string, names: readonly string[]): Promise<void> {
  const emptyHash = sha256(Buffer.alloc(0));
  const sortedNames = [...names].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  const header = {
    dataSize: 0,
    entries: sortedNames.map((name) => ({
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

function describeErrorTree(value: unknown): string {
  if (value instanceof AggregateError) {
    return `${value.message}: ${value.errors.map(describeErrorTree).join(" | ")}`;
  }
  if (value instanceof Error) return value.message;
  return String(value);
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
