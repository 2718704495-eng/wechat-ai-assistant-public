import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../scripts/kernel-lock-runtime.mjs", () => ({
  acquireKernelLease: vi.fn(() => Promise.resolve({ close: () => Promise.resolve() })),
}));

vi.mock("../../scripts/release-payload.mjs", () => ({
  validatePayloadManifest: vi.fn(async ({ payloadRoot }: { payloadRoot: string }) => ({
    manifestSha256: (await readFile(path.join(payloadRoot, "fake-manifest.sha256"), "utf8")).trim(),
  })),
  validateReleasePayload: vi.fn(async ({ payloadRoot }: { payloadRoot: string }) => ({
    manifestSha256: (await readFile(path.join(payloadRoot, "fake-manifest.sha256"), "utf8")).trim(),
  })),
  validateInstalledRuntimeV2: vi.fn(async ({ runtimeRoot }: { runtimeRoot: string }) => {
    const releaseRoot = await realpath(path.join(runtimeRoot, "current"));
    return {
      releaseRoot,
      manifestSha256: (await readFile(
        path.join(releaseRoot, "fake-manifest.sha256"),
        "utf8",
      )).trim(),
    };
  }),
}));

const projectRoot = process.cwd();
const upgraderPath = path.join(projectRoot, "scripts", "runtime-v2-upgrade.mjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("runtime-v2 Round 28 in-place upgrade", () => {
  it("exposes one dedicated upgrader instead of applying the clean installer to existing state", async () => {
    const exists = await access(upgraderPath).then(() => true, () => false);
    let upgrade: unknown = null;
    if (exists) {
      const module = await import(pathToFileURL(upgraderPath).href) as Record<string, unknown>;
      upgrade = module["upgradeRuntimeV2"];
    }

    expect(exists).toBe(true);
    expect(typeof upgrade).toBe("function");
  });

  it("preserves state and the prior immutable release while atomically publishing a new current", async () => {
    const fixture = await makeFixture();
    const upgrader = await loadUpgrader();

    const result = await upgrader.upgradeRuntimeV2({
      runtimeRoot: fixture.runtimeRoot,
      candidateRoot: fixture.candidateRoot,
      automationStatus: "PAUSED",
    });

    expect(result).toMatchObject({
      status: "installed",
      previousManifestSha256: fixture.oldManifest,
      manifestSha256: fixture.newManifest,
      previousTarget: fixture.oldTarget,
    });
    expect(await readFile(fixture.stateMarker, "utf8")).toBe("preserve\n");
    await expect(access(fixture.oldRelease)).resolves.toBeUndefined();
    expect(await readlink(path.join(fixture.runtimeRoot, "current")))
      .toBe(result.currentTarget);
    expect((await readdir(path.join(fixture.runtimeRoot, "state")))
      .some((name) => name.startsWith("upgrade-receipt-"))).toBe(true);
    await expect(access(path.join(
      fixture.runtimeRoot,
      "state",
      "release-transaction.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses an existing bound private archive directory on later upgrades", async () => {
    const fixture = await makeFixture();
    await mkdir(path.join(
      fixture.runtimeRoot,
      "state",
      "release-transaction-archive",
    ), { mode: 0o700 });
    const upgrader = await loadUpgrader();

    await expect(upgrader.upgradeRuntimeV2({
      runtimeRoot: fixture.runtimeRoot,
      candidateRoot: fixture.candidateRoot,
      automationStatus: "PAUSED",
    })).resolves.toMatchObject({ status: "installed" });
  });

  it("restores the exact prior current after a post-switch validation failure", async () => {
    const fixture = await makeFixture();
    const upgrader = await loadUpgrader();

    await expect(upgrader.upgradeRuntimeV2({
      runtimeRoot: fixture.runtimeRoot,
      candidateRoot: fixture.candidateRoot,
      automationStatus: "PAUSED",
    }, {
      afterCurrentSwitch: () => {
        throw new Error("ROUND28_POST_SWITCH_FAILURE");
      },
    })).rejects.toThrow("ROUND28_POST_SWITCH_FAILURE");

    expect(await readlink(path.join(fixture.runtimeRoot, "current"))).toBe(fixture.oldTarget);
    expect(await realpath(path.join(fixture.runtimeRoot, "current"))).toBe(fixture.oldRelease);
    expect(await readFile(fixture.stateMarker, "utf8")).toBe("preserve\n");
  });

  it("does not replace a foreign current introduced before the switch", async () => {
    const fixture = await makeFixture();
    const upgrader = await loadUpgrader();
    const current = path.join(fixture.runtimeRoot, "current");
    const displaced = path.join(fixture.runtimeRoot, "current.displaced");
    const foreignTarget = ".releases/foreign";
    await mkdir(path.join(fixture.runtimeRoot, ".releases", "foreign"), { mode: 0o555 });

    await expect(upgrader.upgradeRuntimeV2({
      runtimeRoot: fixture.runtimeRoot,
      candidateRoot: fixture.candidateRoot,
      automationStatus: "PAUSED",
    }, {
      beforeCurrentSwitch: async () => {
        await rename(current, displaced);
        await symlink(foreignTarget, current);
      },
    })).rejects.toThrow("RUNTIME_V2_UPGRADE_FAILED");

    expect(await readlink(current)).toBe(foreignTarget);
    expect(await readlink(displaced)).toBe(fixture.oldTarget);
    await expect(access(fixture.oldRelease)).resolves.toBeUndefined();
    expect(await readFile(fixture.stateMarker, "utf8")).toBe("preserve\n");
  });
});

function loadUpgrader(): Promise<{
  upgradeRuntimeV2(options: {
    runtimeRoot: string;
    candidateRoot: string;
    automationStatus: "PAUSED";
  }, hooks?: {
    afterCurrentSwitch?(): void;
    beforeCurrentSwitch?(): Promise<void> | void;
  }): Promise<{
    status: string;
    manifestSha256: string;
    previousManifestSha256: string;
    previousTarget: string;
    currentTarget: string;
  }>;
}> {
  return import(pathToFileURL(upgraderPath).href) as never;
}

async function makeTreeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await makeTreeWritable(path.join(root, entry.name));
  }
  await chmod(root, 0o700).catch(() => undefined);
}

async function makeFixture(): Promise<{
  runtimeRoot: string;
  candidateRoot: string;
  oldRelease: string;
  oldTarget: string;
  oldManifest: string;
  newManifest: string;
  stateMarker: string;
}> {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "round28-upgrade-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime-v2");
  const releaseStore = path.join(runtimeRoot, ".releases");
  const oldRelease = path.join(releaseStore, "release-old");
  const candidateRoot = path.join(root, "candidate");
  const state = path.join(runtimeRoot, "state");
  const oldTarget = ".releases/release-old";
  const oldManifest = "1".repeat(64);
  const newManifest = "2".repeat(64);
  await mkdir(runtimeRoot, { mode: 0o700 });
  await mkdir(releaseStore, { mode: 0o700 });
  await Promise.all([
    mkdir(oldRelease, { mode: 0o700 }),
    mkdir(candidateRoot, { mode: 0o700 }),
    mkdir(state, { mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(path.join(oldRelease, "fake-manifest.sha256"), `${oldManifest}\n`, { mode: 0o444 }),
    writeFile(path.join(candidateRoot, "fake-manifest.sha256"), `${newManifest}\n`, { mode: 0o444 }),
    writeFile(path.join(candidateRoot, "payload.txt"), "candidate\n", { mode: 0o444 }),
    writeFile(path.join(state, "preserve.enc"), "preserve\n", { mode: 0o600 }),
  ]);
  await chmod(oldRelease, 0o555);
  await symlink(oldTarget, path.join(runtimeRoot, "current"));
  return {
    runtimeRoot,
    candidateRoot,
    oldRelease,
    oldTarget,
    oldManifest,
    newManifest,
    stateMarker: path.join(state, "preserve.enc"),
  };
}
