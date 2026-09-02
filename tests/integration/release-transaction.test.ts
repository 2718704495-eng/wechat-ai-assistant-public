import crypto from "node:crypto";
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
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { acquireLiveOperationCoordinator } from "../../src/mcp/live-operation-coordinator.js";
import { legacyCutoverTombstoneContents } from "../../src/storage/kernel-lock.js";

type TransactionPhase = "previous-prepared" | "current-switched";

interface PayloadModule {
  createPayloadManifest(options: {
    payloadRoot: string;
    provenance: Record<string, unknown>;
  }): Promise<{ manifestSha256: string }>;
  validatePayloadManifest(options: {
    payloadRoot: string;
  }): Promise<{ manifestSha256: string }>;
}

interface TransactionOptions {
  runtimeRoot: string;
  decisionLines: string[];
  session: DecisionSession;
  automationId: "automation";
  now(): Date;
  validateRelease(releaseRoot: string): Promise<{ manifestSha256: string }>;
  hook?(phase: TransactionPhase): Promise<void> | void;
}

interface ReleaseManagerModule {
  installValidatedCandidate(
    options: TransactionOptions & { candidateRoot: string },
  ): Promise<unknown>;
  rollbackValidatedRelease(options: TransactionOptions): Promise<unknown>;
  recoverReleaseTransaction(options: {
    runtimeRoot: string;
    now(): Date;
    validateRelease(releaseRoot: string): Promise<{ manifestSha256: string }>;
    readDecision(request: RecoveryDecisionRequest): Promise<string>;
  }): Promise<unknown>;
}

interface RecoveryDecisionRequest {
  op: "precheck" | "commit";
  txid: string;
  maintenanceNonce: string;
  requestId: string;
  observationId: string;
  requestedAt: string;
}

const projectRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => makeTreeWritable(root)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release pointer transaction", () => {
  it("preserves an unvalidated legacy bin without promoting it to previous", async () => {
    const harness = await transactionHarness();
    const legacyBin = path.join(harness.runtimeRoot, "bin");
    await mkdir(legacyBin, { recursive: true });
    await writeFile(path.join(legacyBin, "legacy.txt"), "unvalidated legacy\n");
    const candidate = await harness.candidate("first");

    await harness.install(candidate);

    await expect(harness.currentVersion()).resolves.toBe("first");
    await expect(lstat(path.join(harness.runtimeRoot, "bin.previous")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const legacyNames = (await readdir(path.join(harness.runtimeRoot, ".releases")))
      .filter((name) => name.startsWith("legacy-"));
    expect(legacyNames).toHaveLength(1);
    await expect(readFile(
      path.join(harness.runtimeRoot, ".releases", legacyNames[0]!, "legacy.txt"),
      "utf8",
    )).resolves.toBe("unvalidated legacy\n");
  });

  it("promotes only the validated current release to previous", async () => {
    const harness = await transactionHarness();
    await harness.install(await harness.candidate("first"));
    await harness.install(await harness.candidate("second"));

    await expect(harness.currentVersion()).resolves.toBe("second");
    await expect(harness.previousVersion()).resolves.toBe("first");
  });

  it("rolls back by atomically exchanging two validated releases", async () => {
    const harness = await transactionHarness();
    await harness.install(await harness.candidate("first"));
    await harness.install(await harness.candidate("second"));

    await harness.rollback();

    await expect(harness.currentVersion()).resolves.toBe("first");
    await expect(harness.previousVersion()).resolves.toBe("second");
  });

  it("never accepts a manifest-valid staging directory as previous", async () => {
    const harness = await transactionHarness();
    await harness.install(await harness.candidate("first"));
    await harness.install(await harness.candidate("second"));
    const staging = await harness.candidate("mutable-staging");
    const previous = path.join(harness.runtimeRoot, "bin.previous");
    await unlink(previous);
    await symlink(path.relative(harness.runtimeRoot, staging), previous);

    await expect(harness.rollback()).rejects.toThrow("RELEASE_POINTER_TARGET_INVALID");
    await expect(harness.currentVersion()).resolves.toBe("second");
  });

  it("does not rotate pointers when the current manifest is installed again", async () => {
    const harness = await transactionHarness();
    const first = await harness.candidate("same");
    await harness.install(first);
    const currentTarget = await readlink(path.join(harness.runtimeRoot, "bin"));
    const releaseNames = await validatedReleaseNames(harness.runtimeRoot);

    await harness.install(await harness.candidate("same"));

    await expect(readlink(path.join(harness.runtimeRoot, "bin")))
      .resolves.toBe(currentTarget);
    await expect(lstat(path.join(harness.runtimeRoot, "bin.previous")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(validatedReleaseNames(harness.runtimeRoot)).resolves.toEqual(releaseNames);
  });

  it("leaves every pointer unchanged when an existing live owner is busy", async () => {
    const harness = await transactionHarness();
    await harness.install(await harness.candidate("first"));
    const beforeCurrent = await readlink(path.join(harness.runtimeRoot, "bin"));
    const owner = await acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "mcp",
    });

    try {
      await expect(harness.install(await harness.candidate("blocked")))
        .rejects.toThrow("RELEASE_RUNTIME_BUSY");
      await expect(readlink(path.join(harness.runtimeRoot, "bin")))
        .resolves.toBe(beforeCurrent);
      await expect(lstat(path.join(harness.runtimeRoot, "bin.previous")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await owner.close();
    }
  });

  it("keeps the permanent compatibility tombstone immutable across installs", async () => {
    const harness = await transactionHarness();
    await harness.install(await harness.candidate("first"));
    const legacyMarker = path.join(harness.runtimeRoot, "state", "live-operation.lock");
    await expect(readFile(legacyMarker, "utf8"))
      .resolves.toBe(legacyCutoverTombstoneContents());
    await expect(writeFile(legacyMarker, "old runtime recreated this", { flag: "wx" }))
      .rejects.toMatchObject({ code: "EEXIST" });

    await harness.install(await harness.candidate("second"));

    await expect(readFile(legacyMarker, "utf8"))
      .resolves.toBe(legacyCutoverTombstoneContents());
    const current = await acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    });
    await current.close();
  });

  it.each([
    {
      phase: "previous-prepared" as const,
      currentAfterRecovery: "second",
      previousAfterRecovery: "first",
    },
    {
      phase: "current-switched" as const,
      currentAfterRecovery: "third",
      previousAfterRecovery: "second",
    },
  ])("recovers a durable $phase interruption to one deterministic pointer state", async ({
    phase,
    currentAfterRecovery,
    previousAfterRecovery,
  }) => {
    const harness = await transactionHarness();
    await harness.install(await harness.candidate("first"));
    await harness.install(await harness.candidate("second"));
    const third = await harness.candidate("third");

    await expect(harness.install(third, (observedPhase) => {
      if (observedPhase === phase) throw new Error(`SIMULATED_${phase}`);
    })).rejects.toThrow(`SIMULATED_${phase}`);

    await harness.recover();

    await expect(harness.currentVersion()).resolves.toBe(currentAfterRecovery);
    await expect(harness.previousVersion()).resolves.toBe(previousAfterRecovery);
    await expect(lstat(path.join(harness.runtimeRoot, "state", "release-transaction.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(harness.runtimeRoot, "state", "live-operation.lock"), "utf8"))
      .resolves.toBe(legacyCutoverTombstoneContents());
  });
});

interface TransactionHarness {
  runtimeRoot: string;
  candidate(version: string): Promise<string>;
  install(candidateRoot: string, hook?: TransactionOptions["hook"]): Promise<void>;
  rollback(): Promise<void>;
  recover(): Promise<void>;
  currentVersion(): Promise<string>;
  previousVersion(): Promise<string>;
}

async function transactionHarness(): Promise<TransactionHarness> {
  const payload = await loadPayloadModule();
  const manager = await loadReleaseManagerModule();
  const root = await temporaryRoot("release transaction with spaces-");
  const runtimeRoot = path.join(root, "Desktop", "聊天助手");
  await mkdir(runtimeRoot, { recursive: true });
  await chmod(runtimeRoot, 0o700);
  let sequence = 0;
  const validateRelease = (releaseRoot: string) => payload.validatePayloadManifest({
    payloadRoot: releaseRoot,
  });
  const baseOptions = (): Omit<TransactionOptions, "decisionLines"> => ({
    runtimeRoot,
    automationId: "automation",
    now: () => new Date("2026-08-21T02:00:30.000Z"),
    validateRelease,
    session: decisionSession().session,
  });

  return {
    runtimeRoot,
    candidate: async (version) => {
      const candidateRoot = path.join(
        runtimeRoot,
        ".releases",
        `.staging-${version}-${String(sequence++)}`,
      );
      await mkdir(candidateRoot, { recursive: true });
      const versionPath = path.join(candidateRoot, "version.txt");
      await writeFile(versionPath, `${version}\n`);
      await chmod(versionPath, 0o444);
      await payload.createPayloadManifest({
        payloadRoot: candidateRoot,
        provenance: { fixture: "release-transaction", version },
      });
      await chmod(candidateRoot, 0o555);
      return candidateRoot;
    },
    install: async (candidateRoot, hook) => {
      const decision = decisionSession();
      await manager.installValidatedCandidate({
        ...baseOptions(),
        candidateRoot,
        session: decision.session,
        decisionLines: decision.lines,
        hook,
      });
    },
    rollback: async () => {
      const decision = decisionSession();
      await manager.rollbackValidatedRelease({
        ...baseOptions(),
        session: decision.session,
        decisionLines: decision.lines,
      });
    },
    recover: async () => {
      await manager.recoverReleaseTransaction({
        runtimeRoot,
        now: () => new Date("2026-08-21T02:01:00.000Z"),
        validateRelease,
        readDecision: (request) => Promise.resolve(recoveryReceipt(request)),
      });
    },
    currentVersion: () => pointerVersion(runtimeRoot, "bin"),
    previousVersion: () => pointerVersion(runtimeRoot, "bin.previous"),
  };
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

function recoveryReceipt(request: RecoveryDecisionRequest): string {
  return JSON.stringify({
    op: request.op,
    txid: request.txid,
    maintenanceNonce: request.maintenanceNonce,
    automationObservation: {
      requestId: request.requestId,
      observationId: request.observationId,
      automationId: "automation",
      targetCount: 1,
      status: "PAUSED",
      observedAt: request.requestedAt,
    },
  });
}

interface DecisionSession {
  txid: string;
  maintenanceNonce: string;
  precheckRequestId: string;
  precheckObservationId: string;
  precheckRequestedAt: string;
  commitRequestId: string;
  commitObservationId: string;
  commitRequestedAt: string;
}

function decisionSession(): { session: DecisionSession; lines: string[] } {
  const txid = crypto.randomUUID();
  const maintenanceNonce = crypto.randomUUID();
  const session = {
    txid,
    maintenanceNonce,
    precheckRequestId: crypto.randomUUID(),
    precheckObservationId: crypto.randomUUID(),
    precheckRequestedAt: "2026-08-21T02:00:00.000Z",
    commitRequestId: crypto.randomUUID(),
    commitObservationId: crypto.randomUUID(),
    commitRequestedAt: "2026-08-21T02:00:10.000Z",
  };
  return {
    session,
    lines: [
      decisionLine(
        "precheck",
        txid,
        maintenanceNonce,
        session.precheckRequestId,
        session.precheckObservationId,
        "2026-08-21T02:00:05.000Z",
      ),
      decisionLine(
        "commit",
        txid,
        maintenanceNonce,
        session.commitRequestId,
        session.commitObservationId,
        "2026-08-21T02:00:20.000Z",
      ),
    ],
  };
}

function decisionLine(
  op: "precheck" | "commit",
  txid: string,
  maintenanceNonce: string,
  requestId: string,
  observationId: string,
  observedAt: string,
): string {
  return JSON.stringify({
    op,
    txid,
    maintenanceNonce,
    automationObservation: {
      requestId,
      observationId,
      automationId: "automation",
      targetCount: 1,
      status: "PAUSED",
      observedAt,
    },
  });
}

async function pointerVersion(runtimeRoot: string, pointerName: string): Promise<string> {
  const pointer = path.join(runtimeRoot, pointerName);
  const target = await readlink(pointer);
  return (await readFile(
    path.join(path.resolve(path.dirname(pointer), target), "version.txt"),
    "utf8",
  ))
    .trim();
}

async function validatedReleaseNames(runtimeRoot: string): Promise<string[]> {
  const names = await readdir(path.join(runtimeRoot, ".releases"));
  return names.filter((name) => (
    !name.startsWith("legacy-") && !name.startsWith(".staging-")
  )).sort();
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
