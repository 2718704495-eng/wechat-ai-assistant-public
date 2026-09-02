import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
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

interface NativeFileReceipt extends NativeStatus {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly name: string;
  readonly size: number;
}

interface KernelAddon {
  createFileAtNoReplace(parentFd: number, name: string, mode: number): NativeFileReceipt;
  closeFd(fd: number): NativeStatus;
  inspect(fd: number): NativeFileReceipt;
  inspectEntryAtNoFollow(parentFd: number, name: string): NativeFileReceipt;
  readDirectoryNames(fd: number): NativeStatus & { readonly names: readonly string[] };
  mkdirAtNoReplace(parentFd: number, name: string, mode: number): NativeStatus;
  openDirectoryAtNoFollow(parentFd: number, name: string): NativeFileReceipt;
  openReadFileAtNoFollow(parentFd: number, name: string): NativeFileReceipt;
  writeFileAtNoReplace(parentFd: number, name: string, bytes: Buffer, mode: number): NativeStatus;
  symlinkAtNoReplace(parentFd: number, target: string, name: string): NativeStatus;
  readLinkAtNoFollow(parentFd: number, name: string): NativeFileReceipt & { target: string };
  fsyncFd(fd: number): NativeStatus;
  chmodAtExpected(
    parentFd: number,
    name: string,
    dev: number,
    ino: number,
    mode: number,
    directory: boolean,
  ): NativeStatus;
}

interface ContainerReceipt {
  readonly formatVersion: 1;
  readonly containerSha256: string;
  readonly headerSha256: string;
  readonly payloadManifestSha256: string;
  readonly runtimeContractVersion: 4;
  readonly entryCount: number;
  readonly size: number;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly uid: number;
    readonly mode: number;
    readonly nlink: number;
    readonly size: number;
  };
}

interface ContainerHandle {
  readonly fd: number;
  readonly name: string;
  readonly receipt: ContainerReceipt;
  readonly identity: ContainerReceipt["identity"];
}

interface ContainerModule {
  readonly PAYLOAD_CONTAINER_MAGIC: "WCAPC001";
  readonly PAYLOAD_CONTAINER_FORMAT_VERSION: 1;
  readonly PAYLOAD_CONTAINER_LIMITS: {
    readonly maximumEntries: 200_000;
    readonly maximumPathBytes: 4_096;
    readonly maximumSymlinkTargetBytes: 4_096;
    readonly maximumFileBytes: number;
    readonly maximumHeaderBytes: number;
    readonly maximumDataBytes: number;
    readonly maximumContainerBytes: number;
  };
  writePayloadContainerFromDirectory(input: {
    candidate: NativeFileReceipt;
    parentFd: number;
    name: string;
    addon: KernelAddon;
  }): Promise<ContainerHandle>;
  validatePayloadContainerFd(input: {
    fd: number;
    expectedIdentity?: ContainerReceipt["identity"];
  }): Promise<ContainerReceipt>;
  materializePayloadContainer(input: {
    fd: number;
    expectedReceipt: ContainerReceipt;
    destination: ContainerReceipt["identity"] & { fd: number };
    addon: KernelAddon;
    assertBoundary: () => Promise<void>;
    beforeMutation: undefined | ((stage: string, context: unknown) => Promise<void>);
    beforeResourceClose: undefined | ((stage: string, context: unknown) => Promise<void>);
  }): Promise<{
    readonly containerSha256: string;
    readonly entryCount: number;
    readonly payloadManifestSha256: string;
  }>;
}

const roots: string[] = [];
const projectRoot = process.cwd();

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("runtime-v2 Fix Round 12 fd-backed payload container", () => {
  it("uses an atomic regular-file fd as the first owned identity and never unlinks a replacement", async () => {
    const module = await loadContainerModule();
    expect(module.PAYLOAD_CONTAINER_MAGIC).toBe("WCAPC001");
    const addon = loadKernelAddon();
    const root = await makeRoot("round12-atomic-owner-");
    const parentFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    const name = `payload-${randomUUID()}.container`;
    try {
      const created = addon.createFileAtNoReplace(parentFd, name, 0o600);
      expect(created).toMatchObject({ ok: true, name });
      expect(created.mode & constants.S_IFMT).toBe(constants.S_IFREG);
      expect(created.nlink).toBe(1);
      const original = path.join(root, name);
      const displaced = `${original}.owned-displaced`;
      await rename(original, displaced);
      await writeFile(original, "foreign\n", { mode: 0o600 });
      const foreign = await lstat(original);
      expect(Reflect.ownKeys(addon)).not.toContain("unlinkFileAtExpected");
      await expect(lstat(original)).resolves.toMatchObject({ dev: foreign.dev, ino: foreign.ino });
      expect(await readFile(original, "utf8")).toBe("foreign\n");
      expect(addon.closeFd(created.fd).ok).toBe(true);
    } finally {
      closeSync(parentFd);
    }
  });

  it("writes byte-identical deterministic containers and validates from the same opened fd", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const fixture = await makeCandidateFixture();
    const output = await makeRoot("round12-deterministic-");
    const parentFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    const handles: ContainerHandle[] = [];
    try {
      handles.push(await writeCandidateContainer(module, addon, fixture, {
        parentFd,
        name: "first.container",
      }));
      handles.push(await writeCandidateContainer(module, addon, fixture, {
        parentFd,
        name: "second.container",
      }));
      const first = handles[0];
      const second = handles[1];
      if (first === undefined || second === undefined) throw new Error("ROUND12_HANDLE_MISSING");
      expect(readFileSync(first.fd)).toEqual(readFileSync(second.fd));
      expect(first.receipt.containerSha256).toBe(second.receipt.containerSha256);
      expect(await module.validatePayloadContainerFd({
        fd: first.fd,
        expectedIdentity: first.identity,
      })).toEqual(first.receipt);
      expect(first.receipt).toMatchObject({
        formatVersion: 1,
        runtimeContractVersion: 4,
        entryCount: 7,
      });
    } finally {
      for (const handle of handles) expect(addon.closeFd(handle.fd).ok).toBe(true);
      closeSync(parentFd);
    }
  });

  it.each([
    ["path traversal", [{ path: "../escape", type: "file", mode: 0o444, size: 0, sha256: sha256("") }]],
    ["duplicate", [directory("a"), directory("a")]],
    ["case-fold collision", [directory("Folder"), directory("folder")]],
    ["missing parent", [file("missing/a", "")]],
    ["symlink escape", [symlinkEntry("outside", "../escape")]],
    ["symlink cycle", [symlinkEntry("a", "b"), symlinkEntry("b", "a")]],
    ["special file", [{ path: "device", type: "fifo", mode: 0o444, size: 0, sha256: sha256("") }]],
    ["illegal mode", [{ ...directory("dir"), mode: 0o777 }]],
  ])("rejects unsafe parser metadata: %s", async (_label, entries) => {
    const module = await loadContainerModule();
    const raw = encodeRawContainer(entries, Buffer.alloc(0));
    await expect(validateRaw(module, raw)).rejects.toThrow(/PAYLOAD_CONTAINER_/u);
  });

  it("rejects hardlinks and special files while copying the read-only candidate", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const output = await makeRoot("round12-invalid-source-");
    const parentFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const hardlinkRoot = await makeCandidateFixture();
      await chmod(hardlinkRoot, 0o755);
      await link(path.join(hardlinkRoot, "package.json"), path.join(hardlinkRoot, "hardlink"));
      await chmod(hardlinkRoot, 0o555);
      await expect(writeCandidateContainer(module, addon, hardlinkRoot, {
        parentFd, name: "hardlink.container",
      })).rejects.toThrow("PAYLOAD_CONTAINER_HARDLINK_INVALID");
      if (process.platform !== "win32") {
        const fifoRoot = await makeCandidateFixture();
        await chmod(fifoRoot, 0o755);
        const fifo = path.join(fifoRoot, "fifo");
        await new Promise<void>((resolve, reject) => {
          const child = spawn("/usr/bin/mkfifo", [fifo], { stdio: "ignore" });
          child.once("error", reject);
          child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("MKFIFO_FAILED")));
        });
        await chmod(fifoRoot, 0o555);
        await expect(writeCandidateContainer(module, addon, fifoRoot, {
          parentFd, name: "fifo.container",
        })).rejects.toThrow("PAYLOAD_CONTAINER_SPECIAL_FILE");
      }
    } finally {
      closeSync(parentFd);
    }
  });

  it("rejects an entry that is not bound by the payload manifest before runtime mutation", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const fixture = await makeCandidateFixture();
    await chmod(fixture, 0o755);
    await writeFile(path.join(fixture, "unmanifested"), "tamper\n", { mode: 0o444 });
    await chmod(fixture, 0o555);
    const output = await makeRoot("round12-manifest-mismatch-");
    const parentFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await expect(writeCandidateContainer(module, addon, fixture, {
        parentFd,
        name: "payload.container",
      })).rejects.toThrow("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_MISMATCH");
      expect((await lstat(path.join(output, "payload.container"))).size).toBeGreaterThan(0);
    } finally {
      closeSync(parentFd);
    }
  });

  it.each(["tamper", "truncate", "trailing", "header-hash", "noncanonical"] as const)(
    "rejects %s container bytes",
    async (kind) => {
      const module = await loadContainerModule();
      const data = Buffer.from("payload", "utf8");
      const entries = [file("payload.txt", data.toString("utf8"))];
      let raw = encodeRawContainer(entries, data);
      if (kind === "tamper") raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
      if (kind === "truncate") raw = raw.subarray(0, raw.length - 1);
      if (kind === "trailing") raw = Buffer.concat([raw, Buffer.from([0])]);
      if (kind === "header-hash") raw[20] = (raw[20] ?? 0) ^ 0xff;
      if (kind === "noncanonical") raw = encodeRawContainer(entries, data, { pretty: true });
      await expect(validateRaw(module, raw)).rejects.toThrow(/PAYLOAD_CONTAINER_/u);
    },
  );

  it.each([
    ["entry limit", { entryCount: 200_001n }],
    ["header limit", { headerLength: 32n * 1024n * 1024n + 1n }],
    ["data limit", { dataLength: 1024n * 1024n * 1024n + 1n }],
  ])("rejects declared %s before allocating", async (_label, override) => {
    const module = await loadContainerModule();
    const raw = encodeRawContainer([], Buffer.alloc(0), override);
    await expect(validateRaw(module, raw)).rejects.toThrow("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
  });

  it("keeps validation bound to the original fd when the pathname is replaced", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const fixture = await makeCandidateFixture();
    const output = await makeRoot("round12-replacement-");
    const parentFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    const handle = await writeCandidateContainer(module, addon, fixture, {
      parentFd, name: "payload.container",
    });
    try {
      const containerPath = path.join(output, handle.name);
      await rename(containerPath, `${containerPath}.owned-displaced`);
      await writeFile(containerPath, "foreign\n", { mode: 0o600 });
      await expect(module.validatePayloadContainerFd({
        fd: handle.fd,
        expectedIdentity: handle.identity,
      })).resolves.toEqual(handle.receipt);
      expect(await readFile(containerPath, "utf8")).toBe("foreign\n");
    } finally {
      expect(addon.closeFd(handle.fd).ok).toBe(true);
      closeSync(parentFd);
    }
  });

  it("materializes only from the validated fd using no-replace directory-relative mutations", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const fixture = await makeCandidateFixture();
    const output = await makeRoot("round12-materialize-source-");
    const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    const destinationParent = await makeRoot("round12-materialize-destination-");
    const releasePath = path.join(destinationParent, "release");
    await mkdir(releasePath, { mode: 0o700 });
    const destinationFd = openSync(releasePath, constants.O_RDONLY | constants.O_DIRECTORY);
    const destinationIdentity = fstatSync(destinationFd);
    const handle = await writeCandidateContainer(module, addon, fixture, {
      parentFd: outputFd, name: "payload.container",
    });
    try {
      const result = await module.materializePayloadContainer({
        fd: handle.fd,
        expectedReceipt: handle.receipt,
        destination: {
          fd: destinationFd,
          dev: Number(destinationIdentity.dev),
          ino: Number(destinationIdentity.ino),
          uid: destinationIdentity.uid,
          mode: destinationIdentity.mode,
          nlink: destinationIdentity.nlink,
          size: destinationIdentity.size,
        },
        addon,
        assertBoundary: () => Promise.resolve(),
        beforeMutation: undefined,
        beforeResourceClose: undefined,
      });
      expect(result).toEqual({
        containerSha256: handle.receipt.containerSha256,
        entryCount: 7,
        payloadManifestSha256: handle.receipt.payloadManifestSha256,
      });
      expect(await readFile(path.join(releasePath, "dist/bin/entry.js"), "utf8"))
        .toBe("export {};\n");
      expect(await readlink(path.join(releasePath, "entry-link"))).toBe("dist/bin/entry.js");
      expect((await lstat(path.join(releasePath, "dist"))).mode & 0o777).toBe(0o555);
    } finally {
      expect(addon.closeFd(handle.fd).ok).toBe(true);
      closeSync(destinationFd);
      closeSync(outputFd);
    }
  });

  it("retains a foreign replacement and stops before the next materialization mutation", async () => {
    const module = await loadContainerModule();
    const addon = loadKernelAddon();
    const fixture = await makeCandidateFixture();
    const output = await makeRoot("round12-materialize-race-source-");
    const outputFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY);
    const destinationParent = await makeRoot("round12-materialize-race-destination-");
    const releasePath = path.join(destinationParent, "release");
    const displacedPath = path.join(destinationParent, "owned-displaced");
    await mkdir(releasePath, { mode: 0o700 });
    const destinationFd = openSync(releasePath, constants.O_RDONLY | constants.O_DIRECTORY);
    const destinationIdentity = fstatSync(destinationFd);
    const handle = await writeCandidateContainer(module, addon, fixture, {
      parentFd: outputFd, name: "payload.container",
    });
    let replaced = false;
    const assertBoundary = async () => {
      const observed = await lstat(releasePath);
      if (Number(observed.dev) !== Number(destinationIdentity.dev) ||
          Number(observed.ino) !== Number(destinationIdentity.ino)) {
        throw new Error("PAYLOAD_CONTAINER_DESTINATION_DRIFT");
      }
    };
    try {
      await expect(module.materializePayloadContainer({
        fd: handle.fd,
        expectedReceipt: handle.receipt,
        destination: {
          fd: destinationFd,
          dev: Number(destinationIdentity.dev),
          ino: Number(destinationIdentity.ino),
          uid: destinationIdentity.uid,
          mode: destinationIdentity.mode,
          nlink: destinationIdentity.nlink,
          size: destinationIdentity.size,
        },
        addon,
        assertBoundary,
        beforeResourceClose: undefined,
        beforeMutation: async () => {
          if (replaced) return;
          replaced = true;
          await rename(releasePath, displacedPath);
          await mkdir(releasePath, { mode: 0o700 });
          await writeFile(path.join(releasePath, "foreign"), "keep\n", { mode: 0o600 });
        },
      })).rejects.toThrow("PAYLOAD_CONTAINER_DESTINATION_DRIFT");
      expect(await readFile(path.join(releasePath, "foreign"), "utf8")).toBe("keep\n");
      expect((await readdir(releasePath)).sort()).toEqual(["foreign"]);
    } finally {
      expect(addon.closeFd(handle.fd).ok).toBe(true);
      closeSync(destinationFd);
      closeSync(outputFd);
    }
  });

  it("removes the legacy directory snapshot production path and keeps current last", async () => {
    const source = await readFile("scripts/runtime-v2-clean-install.mjs", "utf8");
    expect(source).not.toContain("createCandidateSnapshot(");
    expect(source).not.toContain("candidateSnapshotMoved");
    const intent = source.indexOf('phase: "intent-recorded"');
    const create = source.indexOf("payloadContainer = await createEmptyPayloadContainer");
    const created = source.indexOf('phase: "container-created"');
    const populate = source.indexOf("populatePayloadContainerFromDirectory", created);
    expect(intent).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(intent);
    expect(created).toBeGreaterThan(create);
    expect(populate).toBeGreaterThan(created);
    expect(source).toContain("validatePayloadContainerFd");
    expect(source).toContain("acquireMaterializationGates");
    expect(source.indexOf("materializePayloadContainer"))
      .toBeLessThan(source.indexOf("symlinkAtNoReplace(runtime.fd, currentTarget, \"current\")"));
  });
});

async function loadContainerModule(): Promise<ContainerModule> {
  const url = pathToFileURL(path.join(projectRoot, "scripts/runtime-v2-payload-container.mjs")).href;
  return await import(`${url}?round12=${randomUUID()}`) as ContainerModule;
}

function loadKernelAddon(): KernelAddon {
  return createRequire(import.meta.url)(path.join(
    projectRoot,
    "native/kernel-lock/build",
    `${process.platform}-${process.arch}`,
    "kernel_lock.node",
  )) as KernelAddon;
}

async function writeCandidateContainer(
  module: ContainerModule,
  addon: KernelAddon,
  candidateRoot: string,
  input: { readonly parentFd: number; readonly name: string },
): Promise<ContainerHandle> {
  const candidateParentFd = openSync(
    path.dirname(candidateRoot),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  const candidate = addon.openDirectoryAtNoFollow(
    candidateParentFd,
    path.basename(candidateRoot),
  );
  expect(candidate.ok).toBe(true);
  try {
    return await module.writePayloadContainerFromDirectory({ candidate, addon, ...input });
  } finally {
    expect(addon.closeFd(candidate.fd).ok).toBe(true);
    closeSync(candidateParentFd);
  }
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeCandidateFixture(): Promise<string> {
  const root = await makeRoot("round12-candidate-");
  await mkdir(path.join(root, "dist", "bin"), { recursive: true, mode: 0o755 });
  const packageBytes = Buffer.from("{}\n");
  const entryBytes = Buffer.from("export {};\n");
  await writeFile(path.join(root, "package.json"), packageBytes, { mode: 0o444 });
  await writeFile(path.join(root, "dist", "bin", "entry.js"), entryBytes, { mode: 0o444 });
  await symlink("dist/bin/entry.js", path.join(root, "entry-link"));
  await writeFile(path.join(root, "payload-manifest.json"), JSON.stringify({
    manifestVersion: 1,
    provenance: { runtimeContractVersion: 4 },
    entries: [
      { path: "dist", type: "directory", size: 0, mode: 0o555 },
      { path: "dist/bin", type: "directory", size: 0, mode: 0o555 },
      {
        path: "dist/bin/entry.js", type: "file", size: entryBytes.length,
        mode: 0o444, sha256: sha256(entryBytes),
      },
      {
        path: "entry-link", type: "symlink", size: Buffer.byteLength("dist/bin/entry.js"),
        mode: (await lstat(path.join(root, "entry-link"))).mode & 0o777,
        target: "dist/bin/entry.js",
      },
      {
        path: "package.json", type: "file", size: packageBytes.length,
        mode: 0o444, sha256: sha256(packageBytes),
      },
    ],
  }) + "\n", { mode: 0o444 });
  const manifest = await readFile(path.join(root, "payload-manifest.json"));
  await writeFile(path.join(root, "payload-manifest.sha256"), `${sha256(manifest)}\n`, { mode: 0o444 });
  await chmod(path.join(root, "dist", "bin"), 0o555);
  await chmod(path.join(root, "dist"), 0o555);
  await chmod(root, 0o555);
  return root;
}

type RawEntry = Record<string, unknown>;

function directory(entryPath: string): RawEntry {
  return { path: entryPath, type: "directory", mode: 0o555, size: 0, sha256: sha256("") };
}

function file(entryPath: string, contents: string): RawEntry {
  return {
    path: entryPath,
    type: "file",
    mode: 0o444,
    size: Buffer.byteLength(contents),
    sha256: sha256(contents),
    offset: 0,
  };
}

function symlinkEntry(entryPath: string, target: string): RawEntry {
  return {
    path: entryPath,
    type: "symlink",
    mode: 0o777,
    size: Buffer.byteLength(target),
    sha256: sha256(target),
    target,
  };
}

function encodeRawContainer(
  entries: RawEntry[],
  data: Buffer,
  override: { pretty?: boolean; headerLength?: bigint; dataLength?: bigint; entryCount?: bigint } = {},
): Buffer {
  const headerValue = {
    formatVersion: 1,
    entryCount: override.entryCount === undefined ? entries.length : Number(override.entryCount),
    dataSize: data.length,
    entries,
  };
  const header = Buffer.from(
    override.pretty === true
      ? `${JSON.stringify(headerValue, null, 2)}\n`
      : `${JSON.stringify(sortJson(headerValue))}\n`,
    "utf8",
  );
  const prefix = Buffer.alloc(52);
  prefix.write("WCAPC001", 0, "ascii");
  const declaredHeader = override.headerLength ?? BigInt(header.length);
  if (declaredHeader <= 0xffff_ffffn) prefix.writeUInt32BE(Number(declaredHeader), 8);
  else prefix.writeUInt32BE(0xffff_ffff, 8);
  prefix.writeBigUInt64BE(override.dataLength ?? BigInt(data.length), 12);
  createHash("sha256").update(header).digest().copy(prefix, 20);
  if (override.entryCount !== undefined) {
    return Buffer.concat([prefix, header, data]);
  }
  return Buffer.concat([prefix, header, data]);
}

async function validateRaw(module: ContainerModule, bytes: Buffer): Promise<ContainerReceipt> {
  const root = await makeRoot("round12-raw-");
  const filename = path.join(root, "payload.container");
  const handle = await open(filename, "wx+", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    return await module.validatePayloadContainerFd({ fd: handle.fd });
  } finally {
    await handle.close();
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))).map(([key, child]) => [key, sortJson(child)]));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
