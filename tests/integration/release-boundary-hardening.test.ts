import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface ReleaseCliModule {
  runReleaseCli(options: {
    argv: string[];
    home?: string;
    input?: Readable;
    output?: Writable;
  }): Promise<unknown>;
}

interface ReleasePayloadModule {
  createPayloadManifest(options: {
    payloadRoot: string;
    provenance: Record<string, unknown>;
  }): Promise<unknown>;
  validatePayloadManifest(options: { payloadRoot: string }): Promise<unknown>;
}

const projectRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release CLI boundary hardening", () => {
  it("rejects a missing HOME before writing beneath the process cwd", async () => {
    const root = await temporaryRoot("release missing HOME-");
    const cwd = path.join(root, "cwd");
    await mkdir(cwd);
    const runtimeRoot = path.join(await realpath(cwd), "Desktop", "聊天助手");

    const result = await runCliWithoutHome({
      cwd,
      argv: [
        "install",
        "--runtime-root",
        runtimeRoot,
        "--candidate",
        path.join(root, "missing candidate"),
      ],
    });

    await expect(lstat(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result).toEqual({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "RELEASE_HOME_REQUIRED\n",
    });
  });

  it("rejects an install candidate outside the controlled staging directory", async () => {
    const cli = await loadReleaseCliModule();
    const payload = await loadReleasePayloadModule();
    const root = await temporaryRoot("release outside staging-");
    const home = path.join(root, "home");
    const runtimeRoot = path.join(home, "Desktop", "聊天助手");
    const candidateRoot = path.join(root, "outside candidate");
    await mkdir(candidateRoot);
    await writeFile(path.join(candidateRoot, "entry.js"), "export {};\n");
    await payload.createPayloadManifest({ payloadRoot: candidateRoot, provenance: {} });

    const input = new PassThrough();
    const output = new PassThrough();
    const error = await cli.runReleaseCli({
      argv: [
        "install",
        "--runtime-root",
        runtimeRoot,
        "--candidate",
        candidateRoot,
      ],
      home,
      input,
      output,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect((await lstat(candidateRoot)).isDirectory()).toBe(true);
    await expect(lstat(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.read()).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("RELEASE_CANDIDATE_OUTSIDE_STAGING");
  });
});

describe("release payload mode policy", () => {
  it("rejects a writable payload root even when every manifest entry matches", async () => {
    const payload = await loadReleasePayloadModule();
    const root = await temporaryRoot("release writable root-");
    await writeFile(path.join(root, "entry.js"), "export {};\n");
    await payload.createPayloadManifest({ payloadRoot: root, provenance: {} });

    await expect(payload.validatePayloadManifest({ payloadRoot: root }))
      .rejects.toThrow("RELEASE_PAYLOAD_MODE_POLICY_INVALID");
  });

  it("rejects a writable payload directory recorded by the manifest", async () => {
    const payload = await loadReleasePayloadModule();
    const root = await temporaryRoot("release writable directory-");
    const directory = path.join(root, "dist");
    await mkdir(directory, { mode: 0o755 });
    await writeFile(path.join(directory, "entry.js"), "export {};\n");
    await payload.createPayloadManifest({ payloadRoot: root, provenance: {} });
    await chmod(root, 0o555);

    try {
      await expect(payload.validatePayloadManifest({ payloadRoot: root }))
        .rejects.toThrow("RELEASE_PAYLOAD_MODE_POLICY_INVALID");
    } finally {
      await chmod(root, 0o700);
    }
  });
});

async function runCliWithoutHome(options: {
  cwd: string;
  argv: string[];
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const cliUrl = pathToFileURL(path.join(projectRoot, "scripts", "release-cli.mjs")).href;
  const source = [
    `import { runReleaseCli } from ${JSON.stringify(cliUrl)};`,
    `try { await runReleaseCli({ argv: ${JSON.stringify(options.argv)} }); }`,
    "catch (error) {",
    "  process.stderr.write((error instanceof Error ? error.message : String(error)) + \"\\n\");",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: options.cwd,
    env: {
      LANG: "en_US.UTF-8",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.stdout === null || child.stderr === null) throw new Error("CHILD_PIPE_REQUIRED");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  return {
    code,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function loadReleaseCliModule(): Promise<ReleaseCliModule> {
  const url = pathToFileURL(path.join(projectRoot, "scripts", "release-cli.mjs")).href;
  const loaded: unknown = await import(url);
  return loaded as ReleaseCliModule;
}

async function loadReleasePayloadModule(): Promise<ReleasePayloadModule> {
  const url = pathToFileURL(path.join(projectRoot, "scripts", "release-payload.mjs")).href;
  const loaded: unknown = await import(url);
  return loaded as ReleasePayloadModule;
}
