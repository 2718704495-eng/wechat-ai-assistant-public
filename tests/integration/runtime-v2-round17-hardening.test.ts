import {
  mkdir,
  mkdtemp,
  readFile,
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
    await rm(root, { recursive: true, force: true });
  }
});

describe("runtime-v2 Fix Round 17 root-anchored clean", () => {
  it.each([
    { label: "whole grandparent", replacementIndex: 2 },
    { label: "higher intermediate ancestor", replacementIndex: 1 },
  ])("keeps original and foreign dist after $label replacement", async ({ replacementIndex }) => {
    const cleaner = await loadCleanDistModule();
    const base = await makeCanonicalRoot("round17-ancestor-replacement-");
    const components = ["ancestor", "middle", "grandparent", "parent", "source"];
    const sourceRoot = path.join(base, ...components);
    await createSource(sourceRoot, "owned.js", "owned\n");
    const replaced = path.join(base, ...components.slice(0, replacementIndex + 1));
    const displaced = `${replaced}-opened`;
    const suffix = components.slice(replacementIndex + 1);

    await expect(cleaner.cleanDist({
      sourceRoot,
      beforeRemove: async () => {
        await rename(replaced, displaced);
        await createSource(path.join(replaced, ...suffix), "foreign.js", "foreign\n");
      },
    })).rejects.toThrow("CLEAN_DIST_SOURCE_INVALID");

    await expect(readFile(path.join(displaced, ...suffix, "dist", "owned.js"), "utf8"))
      .resolves.toBe("owned\n");
    await expect(readFile(path.join(sourceRoot, "dist", "foreign.js"), "utf8"))
      .resolves.toBe("foreign\n");
  });

  it("rejects a symlink in an ancestor above the old grandparent", async () => {
    const cleaner = await loadCleanDistModule();
    const base = await makeCanonicalRoot("round17-symlink-component-");
    const realAncestor = path.join(base, "real-ancestor");
    const alias = path.join(base, "alias");
    const sourceRoot = path.join(alias, "middle", "grandparent", "parent", "source");
    await createSource(
      path.join(realAncestor, "middle", "grandparent", "parent", "source"),
      "owned.js",
      "owned\n",
    );
    await symlink(realAncestor, alias);

    await expect(cleaner.cleanDist({ sourceRoot })).rejects.toThrow("CLEAN_DIST_SOURCE_INVALID");
    await expect(readFile(
      path.join(realAncestor, "middle", "grandparent", "parent", "source", "dist", "owned.js"),
      "utf8",
    )).resolves.toBe("owned\n");
  });

  it("rejects a non-NFC absolute path component without deleting dist", async () => {
    const cleaner = await loadCleanDistModule();
    const base = await makeCanonicalRoot("round17-nfc-component-");
    const decomposed = "cafe\u0301";
    expect(decomposed.normalize("NFC")).not.toBe(decomposed);
    const sourceRoot = path.join(base, decomposed, "middle", "grandparent", "parent", "source");
    await createSource(sourceRoot, "owned.js", "owned\n");

    await expect(cleaner.cleanDist({ sourceRoot })).rejects.toThrow("CLEAN_DIST_SOURCE_INVALID");
    await expect(readFile(path.join(sourceRoot, "dist", "owned.js"), "utf8"))
      .resolves.toBe("owned\n");
  });

  it("removes only dist when every absolute component remains bound", async () => {
    const cleaner = await loadCleanDistModule();
    const base = await makeCanonicalRoot("round17-positive-clean-");
    const sourceRoot = path.join(base, "ancestor", "middle", "grandparent", "parent", "source");
    await createSource(sourceRoot, "owned.js", "owned\n");

    await expect(cleaner.cleanDist({ sourceRoot })).resolves.toBeUndefined();
    await expect(readFile(path.join(sourceRoot, "package.json"), "utf8"))
      .resolves.toContain("wechat-ai-assistant-public");
    await expect(readFile(path.join(sourceRoot, "dist", "owned.js"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createSource(sourceRoot: string, filename: string, contents: string): Promise<void> {
  await mkdir(path.join(sourceRoot, "dist"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(sourceRoot, "package.json"), "{\"name\":\"wechat-ai-assistant-public\"}\n");
  await writeFile(path.join(sourceRoot, "dist", filename), contents);
}

async function loadCleanDistModule(): Promise<CleanDistModule> {
  const loaded: unknown = await import(
    pathToFileURL(path.join(projectRoot, "scripts", "clean-dist.mjs")).href
  );
  return loaded as CleanDistModule;
}

async function makeCanonicalRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return realpath(root);
}
