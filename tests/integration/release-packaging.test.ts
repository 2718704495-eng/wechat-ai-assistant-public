import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { acquireLiveOperationCoordinator } from "../../src/mcp/live-operation-coordinator.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

interface PayloadModule {
  createPayloadManifest(options: {
    payloadRoot: string;
    provenance: Record<string, unknown>;
  }): Promise<{ manifestSha256: string }>;
  validatePayloadManifest(options: { payloadRoot: string }): Promise<unknown>;
}

interface CommitDecisionGate {
  accept(serialized: string): {
    txid: string;
    maintenanceNonce: string;
    automationObservation: {
      requestId: string;
      observationId: string;
      automationId: "automation";
      targetCount: 1;
      status: "PAUSED";
      observedAt: string;
    };
  };
}

interface MaintenanceLease {
  gatePath: string;
  identity: { device: string; inode: string; nonce: string; txid: string };
  release(): Promise<void>;
}

interface ReleaseManagerModule {
  acquireMaintenanceLease(options: {
    runtimeRoot: string;
    txid: string;
    maintenanceNonce: string;
  }): Promise<MaintenanceLease>;
  createCommitDecisionGate(options: {
    txid: string;
    maintenanceNonce: string;
    automationRequestId: string;
    requestedAt: string;
    now(): Date;
    maximumAgeMs: number;
  }): CommitDecisionGate;
  resolveValidatedPreviousRelease(options: {
    runtimeRoot: string;
    validateRelease(releaseRoot: string): Promise<void>;
  }): Promise<string>;
}

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => makeTreeWritable(root)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release payload manifest", () => {
  it("records and verifies the complete deterministic payload set", async () => {
    const payload = await loadPayloadModule();
    const root = await temporaryRoot("release payload with spaces-");
    await mkdir(path.join(root, "dist", "src"), { recursive: true });
    const packagePath = path.join(root, "package.json");
    await writeFile(packagePath, '{"name":"fixture"}\n');
    await chmod(packagePath, 0o444);
    await writeFile(path.join(root, "dist", "src", "entry.js"), "export {};\n");
    await chmod(path.join(root, "dist", "src", "entry.js"), 0o555);
    await symlink("src/entry.js", path.join(root, "dist", "entry-link.js"));
    await chmod(path.join(root, "dist", "src"), 0o555);
    await chmod(path.join(root, "dist"), 0o555);

    const first = await payload.createPayloadManifest({
      payloadRoot: root,
      provenance: { nativeConfiguration: "release", architecture: "arm64" },
    });
    const firstBytes = await readFile(path.join(root, "payload-manifest.json"), "utf8");
    const firstSidecar = await readFile(path.join(root, "payload-manifest.sha256"), "utf8");
    await chmod(root, 0o555);

    await expect(payload.validatePayloadManifest({ payloadRoot: root })).resolves.toBeDefined();
    await chmod(root, 0o755);
    const second = await payload.createPayloadManifest({
      payloadRoot: root,
      provenance: { nativeConfiguration: "release", architecture: "arm64" },
    });
    await chmod(root, 0o555);
    await expect(readFile(path.join(root, "payload-manifest.json"), "utf8"))
      .resolves.toBe(firstBytes);
    await expect(readFile(path.join(root, "payload-manifest.sha256"), "utf8"))
      .resolves.toBe(firstSidecar);
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(firstSidecar).toBe(`${first.manifestSha256}\n`);
  });

  it("fails closed for missing, extra, tampered, and escaping payload entries", async () => {
    const payload = await loadPayloadModule();

    const tampered = await manifestFixture(payload);
    await chmod(path.join(tampered, "dist", "entry.js"), 0o644);
    await writeFile(path.join(tampered, "dist", "entry.js"), "tampered\n");
    await chmod(path.join(tampered, "dist", "entry.js"), 0o444);
    await expect(payload.validatePayloadManifest({ payloadRoot: tampered }))
      .rejects.toThrow("RELEASE_PAYLOAD_HASH_MISMATCH");

    const extra = await manifestFixture(payload);
    await chmod(extra, 0o755);
    await writeFile(path.join(extra, "unexpected.txt"), "unexpected");
    await chmod(path.join(extra, "unexpected.txt"), 0o444);
    await chmod(extra, 0o555);
    await expect(payload.validatePayloadManifest({ payloadRoot: extra }))
      .rejects.toThrow("RELEASE_PAYLOAD_SET_MISMATCH");

    const missing = await manifestFixture(payload);
    await chmod(path.join(missing, "dist"), 0o755);
    await rm(path.join(missing, "dist", "entry.js"));
    await chmod(path.join(missing, "dist"), 0o555);
    await expect(payload.validatePayloadManifest({ payloadRoot: missing }))
      .rejects.toThrow("RELEASE_PAYLOAD_SET_MISMATCH");

    const outside = await temporaryRoot("release-outside-");
    const escaping = await temporaryRoot("release-escaping-");
    await writeFile(path.join(outside, "secret"), "outside");
    await symlink(path.join(outside, "secret"), path.join(escaping, "escape"));
    await expect(payload.createPayloadManifest({
      payloadRoot: escaping,
      provenance: {},
    })).rejects.toThrow("RELEASE_PAYLOAD_SYMLINK_OUTSIDE_ROOT");
  });

  it("rejects special files instead of following them", async () => {
    const payload = await loadPayloadModule();
    const root = await temporaryRoot("release-special-");
    await execFileAsync("/usr/bin/mkfifo", [path.join(root, "pipe")]);

    await expect(payload.createPayloadManifest({ payloadRoot: root, provenance: {} }))
      .rejects.toThrow("RELEASE_PAYLOAD_SPECIAL_FILE");
  });
});

describe("release commit decision", () => {
  it("accepts one fresh exact PAUSED observation bound to the active session", async () => {
    const manager = await loadReleaseManagerModule();
    const expected = decisionExpectation();
    const gate = manager.createCommitDecisionGate(expected);
    const serialized = JSON.stringify(validDecision(expected));

    expect(gate.accept(serialized)).toMatchObject({
      txid: expected.txid,
      maintenanceNonce: expected.maintenanceNonce,
      automationObservation: {
        requestId: expected.automationRequestId,
        automationId: "automation",
        targetCount: 1,
        status: "PAUSED",
      },
    });
    expect(() => gate.accept(serialized)).toThrow("RELEASE_COMMIT_DECISION_REPLAYED");
  });

  it.each([
    { name: "bare commit", mutate: () => "commit" },
    { name: "extra field", mutate: (value: object) => JSON.stringify({ ...value, extra: true }) },
    { name: "wrong txid", mutate: (value: Decision) => JSON.stringify({ ...value, txid: crypto.randomUUID() }) },
    { name: "wrong nonce", mutate: (value: Decision) => JSON.stringify({ ...value, maintenanceNonce: crypto.randomUUID() }) },
    { name: "wrong request", mutate: (value: Decision) => JSON.stringify({ ...value, automationObservation: { ...value.automationObservation, requestId: crypto.randomUUID() } }) },
    { name: "not unique", mutate: (value: Decision) => JSON.stringify({ ...value, automationObservation: { ...value.automationObservation, targetCount: 2 } }) },
    { name: "active", mutate: (value: Decision) => JSON.stringify({ ...value, automationObservation: { ...value.automationObservation, status: "ACTIVE" } }) },
    { name: "stale", mutate: (value: Decision) => JSON.stringify({ ...value, automationObservation: { ...value.automationObservation, observedAt: "2026-08-20T23:58:00.000Z" } }) },
  ])("rejects $name without authorizing commit", async ({ mutate }) => {
    const manager = await loadReleaseManagerModule();
    const expected = decisionExpectation();
    const gate = manager.createCommitDecisionGate(expected);
    const value = validDecision(expected);

    expect(() => gate.accept(mutate(value))).toThrow("RELEASE_COMMIT_DECISION_INVALID");
  });
});

describe("release maintenance lease", () => {
  it("makes every live owner busy while the persistent live-operation gate is held", async () => {
    const manager = await loadReleaseManagerModule();
    const runtimeRoot = await temporaryRoot("release-runtime-");
    const lease = await manager.acquireMaintenanceLease({
      runtimeRoot,
      txid: crypto.randomUUID(),
      maintenanceNonce: crypto.randomUUID(),
    });
    const gateBeforeRelease = await lstat(lease.gatePath);
    expect(gateBeforeRelease.isFile()).toBe(true);

    await expect(acquireLiveOperationCoordinator({ dataDir: runtimeRoot, ownerKind: "cli" }))
      .rejects.toThrow("LIVE_RUNTIME_BUSY");
    await expect(acquireLiveOperationCoordinator({ dataDir: runtimeRoot, ownerKind: "mcp" }))
      .rejects.toThrow("LIVE_RUNTIME_BUSY");

    await lease.release();
    const gateAfterRelease = await lstat(lease.gatePath);
    expect(gateAfterRelease.ino).toBe(gateBeforeRelease.ino);
    const next = await acquireLiveOperationCoordinator({ dataDir: runtimeRoot, ownerKind: "cli" });
    await next.close();
  });

  it("does not mutate the persistent gate namespace when a live owner is busy", async () => {
    const manager = await loadReleaseManagerModule();
    const runtimeRoot = await temporaryRoot("release-runtime-busy-");
    await initializeTestKernelLockCatalog(runtimeRoot);
    const owner = await acquireLiveOperationCoordinator({ dataDir: runtimeRoot, ownerKind: "mcp" });
    const gateDirectory = path.join(runtimeRoot, "state", ".kernel-lock-v1");
    const before = await readdir(gateDirectory);
    await expect(readFile(path.join(runtimeRoot, "state", "live-operation.lock"), "utf8"))
      .resolves.toContain("round7-compatibility-tombstone");

    await expect(manager.acquireMaintenanceLease({
      runtimeRoot,
      txid: crypto.randomUUID(),
      maintenanceNonce: crypto.randomUUID(),
    })).rejects.toThrow("RELEASE_RUNTIME_BUSY");

    await expect(readdir(gateDirectory)).resolves.toEqual(before);
    await owner.close();

    const maintenance = await manager.acquireMaintenanceLease({
      runtimeRoot,
      txid: crypto.randomUUID(),
      maintenanceNonce: crypto.randomUUID(),
    });
    await maintenance.release();
  });
});

describe("release rollback eligibility", () => {
  it("fails closed without a fully validated previous release", async () => {
    const manager = await loadReleaseManagerModule();
    const runtimeRoot = await temporaryRoot("release-no-previous-");
    await mkdir(path.join(runtimeRoot, ".releases"), { recursive: true });

    await expect(manager.resolveValidatedPreviousRelease({
      runtimeRoot,
      validateRelease: () => Promise.resolve(),
    })).rejects.toThrow("NO_VALIDATED_PREVIOUS_RELEASE");

    await expect(lstat(path.join(runtimeRoot, "bin.previous")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a previous pointer outside the controlled release store", async () => {
    const manager = await loadReleaseManagerModule();
    const runtimeRoot = await temporaryRoot("release-outside-previous-");
    const outside = await temporaryRoot("release-outside-target-");
    await symlink(outside, path.join(runtimeRoot, "bin.previous"));
    const before = await readlink(path.join(runtimeRoot, "bin.previous"));

    await expect(manager.resolveValidatedPreviousRelease({
      runtimeRoot,
      validateRelease: () => Promise.resolve(),
    })).rejects.toThrow("NO_VALIDATED_PREVIOUS_RELEASE");

    await expect(readlink(path.join(runtimeRoot, "bin.previous"))).resolves.toBe(before);
  });
});

interface DecisionExpectation {
  txid: string;
  maintenanceNonce: string;
  automationRequestId: string;
  requestedAt: string;
  now(): Date;
  maximumAgeMs: number;
}

interface Decision {
  op: "commit";
  txid: string;
  maintenanceNonce: string;
  automationObservation: {
    requestId: string;
    observationId: string;
    automationId: "automation";
    targetCount: number;
    status: string;
    observedAt: string;
  };
}

function decisionExpectation(): DecisionExpectation {
  return {
    txid: "11111111-1111-4111-8111-111111111111",
    maintenanceNonce: "22222222-2222-4222-8222-222222222222",
    automationRequestId: "33333333-3333-4333-8333-333333333333",
    requestedAt: "2026-08-21T00:00:00.000Z",
    now: () => new Date("2026-08-21T00:00:30.000Z"),
    maximumAgeMs: 60_000,
  };
}

function validDecision(expected: DecisionExpectation): Decision {
  return {
    op: "commit",
    txid: expected.txid,
    maintenanceNonce: expected.maintenanceNonce,
    automationObservation: {
      requestId: expected.automationRequestId,
      observationId: "44444444-4444-4444-8444-444444444444",
      automationId: "automation",
      targetCount: 1,
      status: "PAUSED",
      observedAt: "2026-08-21T00:00:20.000Z",
    },
  };
}

async function manifestFixture(payload: PayloadModule): Promise<string> {
  const root = await temporaryRoot("release-manifest-");
  await mkdir(path.join(root, "dist"), { recursive: true });
  const entryPath = path.join(root, "dist", "entry.js");
  await writeFile(entryPath, "export {};\n");
  await chmod(entryPath, 0o444);
  await chmod(path.join(root, "dist"), 0o555);
  await payload.createPayloadManifest({ payloadRoot: root, provenance: {} });
  await chmod(root, 0o555);
  return root;
}

async function makeTreeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    const child = path.join(root, entry.name);
    await chmod(child, 0o700);
    await makeTreeWritable(child);
  }));
  await chmod(root, 0o700).catch(() => undefined);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function loadPayloadModule(): Promise<PayloadModule> {
  const url = pathToFileURL(path.join(projectRoot, "scripts", "release-payload.mjs")).href;
  const loaded: unknown = await import(url);
  return loaded as PayloadModule;
}

async function loadReleaseManagerModule(): Promise<ReleaseManagerModule> {
  const url = pathToFileURL(path.join(projectRoot, "scripts", "release-manager.mjs")).href;
  const loaded: unknown = await import(url);
  return loaded as ReleaseManagerModule;
}
