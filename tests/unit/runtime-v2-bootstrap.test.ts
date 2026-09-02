import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import * as bootstrapModule from "../../src/runtime-v2/bootstrap.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime-v2 clean bootstrap admission", () => {
  it("creates only an absent owned runtime-v2 root with mode 0700", async () => {
    const fixture = await tempFixture();
    const runtimeRoot = path.join(fixture, "runtime-v2");

    const receipt = await bootstrapModule.admitCleanRuntimeV2Root({
      sourceRoot: path.join(fixture, "source"),
      runtimeRoot,
    });

    const status = await lstat(runtimeRoot);
    expect(status.isDirectory()).toBe(true);
    expect(status.mode & 0o777).toBe(0o700);
    expect(await readdir(runtimeRoot)).toEqual([]);
    expect(receipt).toEqual({ status: "created", runtimeRoot });
  });

  it("accepts an empty owned 0700 directory without creating children", async () => {
    const fixture = await tempFixture();
    const runtimeRoot = path.join(fixture, "runtime-v2");
    await mkdir(runtimeRoot, { mode: 0o700 });

    const receipt = await bootstrapModule.admitCleanRuntimeV2Root({
      sourceRoot: path.join(fixture, "source"),
      runtimeRoot,
    });

    expect(receipt).toEqual({ status: "admitted", runtimeRoot });
    expect(await readdir(runtimeRoot)).toEqual([]);
  });

  it.each(["nonempty", "symlink", "nested-source"])(
    "fails closed for %s without bootstrap children",
    async (scenario) => {
      const fixture = await tempFixture();
      const sourceRoot = path.join(fixture, "source");
      let runtimeRoot = path.join(fixture, "runtime-v2");
      if (scenario === "nonempty") {
        await mkdir(runtimeRoot, { mode: 0o700 });
        await writeFile(path.join(runtimeRoot, "user-file"), "keep");
      } else if (scenario === "symlink") {
        await symlink(sourceRoot, runtimeRoot);
      } else {
        runtimeRoot = path.join(sourceRoot, "runtime-v2");
      }

      await expect(bootstrapModule.admitCleanRuntimeV2Root({ sourceRoot, runtimeRoot }))
        .rejects.toThrow();

      if (scenario === "nonempty") {
        expect(await readdir(runtimeRoot)).toEqual(["user-file"]);
        expect(await readFile(path.join(runtimeRoot, "user-file"), "utf8")).toBe("keep");
      } else if (scenario === "symlink") {
        expect((await lstat(runtimeRoot)).isSymbolicLink()).toBe(true);
      } else {
        await expect(lstat(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("does not expose or import legacy release mutation entry points", () => {
    expect(Reflect.ownKeys(bootstrapModule).filter((key): key is string => typeof key === "string"))
      .toEqual(["admitCleanRuntimeV2Root"]);
    expect(JSON.stringify(Object.keys(bootstrapModule))).not.toMatch(
      /Maintenance|Legacy|Release|Pointer|Journal/iu,
    );
  });

  it("keeps the old release CLI fenced from runtime-v2 with zero writes", async () => {
    const fixture = await tempFixture();
    const home = path.join(fixture, "home");
    const runtimeRoot = path.join(home, "Desktop", "聊天助手", "runtime-v2");
    const releaseCliUrl = pathToFileURL(path.join(process.cwd(), "scripts", "release-cli.mjs")).href;
    const loaded = await import(releaseCliUrl) as {
      runReleaseCli(options: {
        argv: string[];
        home: string;
        input: PassThrough;
        output: PassThrough;
      }): Promise<unknown>;
    };

    await expect(loaded.runReleaseCli({
      argv: ["recover", "--runtime-root", runtimeRoot],
      home,
      input: new PassThrough(),
      output: new PassThrough(),
    })).rejects.toThrow("DESTINATION_NOT_ALLOWED");
    await expect(lstat(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function tempFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-v2-bootstrap-"));
  roots.push(root);
  await mkdir(path.join(root, "source"), { mode: 0o700 });
  return root;
}
