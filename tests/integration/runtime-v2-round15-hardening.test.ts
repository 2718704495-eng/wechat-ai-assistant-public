import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
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
  readonly size?: number;
}

interface KernelAddon {
  openDirectoryAtNoFollow(parentFd: number, name: string): NativeReceipt;
  openReadFileAtNoFollow(parentFd: number, name: string): NativeReceipt;
  readDirectoryNames(fd: number): {
    readonly ok: boolean;
    readonly errno: number;
    readonly names?: readonly string[];
  };
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
  createEmptyPayloadContainer?: (input: {
    readonly parentFd: number;
    readonly name: string;
    readonly addon: KernelAddon;
  }) => Promise<{ readonly fd: number; readonly identity: NativeReceipt }>;
  populatePayloadContainerFromDirectory?: (input: {
    readonly container: { readonly fd: number; readonly identity: NativeReceipt };
    readonly candidate: NativeReceipt;
    readonly addon: KernelAddon;
  }) => Promise<{ readonly receipt: ContainerReceipt }>;
  writePayloadContainerFromDirectory(input: {
    readonly candidate: NativeReceipt;
    readonly parentFd: number;
    readonly name: string;
    readonly addon: KernelAddon;
  }): Promise<{ readonly fd: number; readonly receipt: ContainerReceipt }>;
  materializePayloadContainer(input: {
    readonly fd: number;
    readonly expectedReceipt: ContainerReceipt;
    readonly destination: NativeReceipt;
    readonly addon: KernelAddon;
    readonly assertBoundary: () => Promise<void>;
    readonly beforeMutation: () => Promise<void>;
    readonly beforeResourceClose: (stage: string, context: { path?: string }) => Promise<void>;
  }): Promise<unknown>;
}

interface CleanDistModule {
  cleanDist(input: {
    readonly sourceRoot: string;
    readonly beforeRemove?: () => Promise<void>;
  }): Promise<void>;
}

const projectRoot = process.cwd();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("runtime-v2 Fix Round 15 hardening", () => {
  it("does not report a successful directory EOF as a stale errno failure", () => {
    const addon = loadKernelAddon();
    const failures: number[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      const fd = openSync(projectRoot, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        const result = addon.readDirectoryNames(fd);
        if (!result.ok) failures.push(result.errno);
      } finally {
        closeSync(fd);
      }
    }
    expect(failures).toEqual([]);
  });

  it("rechecks sourceName through the stable parent before dist mutation", async () => {
    const cleaner = await loadCleanDistModule();
    const parent = await makeRoot("round15-source-parent-");
    const sourceRoot = path.join(parent, "source");
    const displaced = path.join(parent, "source-opened");
    await mkdir(path.join(sourceRoot, "dist"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(sourceRoot, "package.json"), "{\"name\":\"wechat-ai-assistant-public\"}\n");
    await writeFile(path.join(sourceRoot, "dist", "owned.js"), "owned\n");

    await expect(cleaner.cleanDist({
      sourceRoot,
      beforeRemove: async () => {
        await rename(sourceRoot, displaced);
        await mkdir(path.join(sourceRoot, "dist"), { recursive: true, mode: 0o700 });
        await writeFile(path.join(sourceRoot, "package.json"), "{\"name\":\"wechat-ai-assistant-public\"}\n");
        await writeFile(path.join(sourceRoot, "dist", "foreign.js"), "foreign\n");
      },
    })).rejects.toThrow("CLEAN_DIST_SOURCE_INVALID");

    await expect(readFile(path.join(displaced, "dist", "owned.js"), "utf8"))
      .resolves.toBe("owned\n");
    await expect(readFile(path.join(sourceRoot, "dist", "foreign.js"), "utf8"))
      .resolves.toBe("foreign\n");
  });

  it("aggregates materialized-file primary, hook, and Native close errors in order", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const candidateRoot = await makeCandidateFixture();
    const containerParent = await makeRoot("round15-container-");
    const containerParentFd = openSync(containerParent, constants.O_RDONLY | constants.O_DIRECTORY);
    const candidateParentFd = openSync(
      path.dirname(candidateRoot),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    const candidate = addon.openDirectoryAtNoFollow(candidateParentFd, path.basename(candidateRoot));
    const container = await module.writePayloadContainerFromDirectory({
      candidate,
      parentFd: containerParentFd,
      name: "payload.container",
      addon,
    });
    const destination = await makeRoot("round15-materialized-");
    const destinationFd = openSync(destination, constants.O_RDONLY | constants.O_DIRECTORY);
    let injectedFd = -1;
    let closeAttempted = false;
    const injectedAddon = Object.create(addon) as KernelAddon;
    Object.defineProperty(injectedAddon, "openReadFileAtNoFollow", {
      value: (parentFd: number, name: string) => {
        if (name !== "entry.js") return addon.openReadFileAtNoFollow(parentFd, name);
        const target = path.join(destination, "dist", name);
        chmodSync(target, 0o600);
        const writer = openSync(target, constants.O_WRONLY);
        try {
          writeSync(writer, Buffer.from("X"), 0, 1, 0);
        } finally {
          closeSync(writer);
        }
        const opened = addon.openReadFileAtNoFollow(parentFd, name);
        injectedFd = opened.fd;
        return opened;
      },
    });
    Object.defineProperty(injectedAddon, "closeFd", {
      value: (fd: number) => {
        const result = addon.closeFd(fd);
        if (fd === injectedFd) {
          closeAttempted = true;
          throw new Error("ROUND15_FILE_NATIVE_CLOSE_FAILED");
        }
        return result;
      },
    });
    let caught: unknown;
    try {
      await module.materializePayloadContainer({
        fd: container.fd,
        expectedReceipt: container.receipt,
        destination: nativeIdentity(destinationFd),
        addon: injectedAddon,
        assertBoundary: () => Promise.resolve(),
        beforeMutation: () => Promise.resolve(),
        beforeResourceClose: (stage, context) => {
          if (stage === "container-close-materialized-file" && context.path === "dist/entry.js") {
            throw new Error("ROUND15_FILE_CLOSE_HOOK_FAILED");
          }
          return Promise.resolve();
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      addon.closeFd(container.fd);
      addon.closeFd(candidate.fd);
      closeSync(destinationFd);
      closeSync(candidateParentFd);
      closeSync(containerParentFd);
    }
    expect(closeAttempted).toBe(true);
    expect(flattenErrorMessages(caught)).toEqual([
      "PAYLOAD_CONTAINER_MATERIALIZED_FILE_INVALID",
      "ROUND15_FILE_CLOSE_HOOK_FAILED",
      "ROUND15_FILE_NATIVE_CLOSE_FAILED",
    ]);
  });

  it("exposes a create-then-populate container contract so identity can be journaled first", async () => {
    const module = await loadContainerModule();
    expect(typeof module.createEmptyPayloadContainer).toBe("function");
    expect(typeof module.populatePayloadContainerFromDirectory).toBe("function");
  });
});

async function loadCleanDistModule(): Promise<CleanDistModule> {
  return await import(
    `${pathToFileURL(path.join(projectRoot, "scripts/clean-dist.mjs")).href}?r15=${randomUUID()}`
  ) as CleanDistModule;
}

async function loadContainerModule(): Promise<ContainerModule> {
  return await import(`${pathToFileURL(path.join(
    projectRoot,
    "scripts/runtime-v2-payload-container.mjs",
  )).href}?r15=${randomUUID()}`) as ContainerModule;
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
    size: value.size,
  };
}

async function makeCandidateFixture(): Promise<string> {
  const root = await makeRoot("round15-candidate-");
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function flattenErrorMessages(value: unknown): string[] {
  if (value instanceof AggregateError) return value.errors.flatMap(flattenErrorMessages);
  if (value instanceof Error) return [value.message];
  return [String(value)];
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
