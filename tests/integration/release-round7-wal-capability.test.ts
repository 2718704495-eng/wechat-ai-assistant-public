import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface DecisionRequest {
  op: "precheck" | "commit";
  txid: string;
  maintenanceNonce: string;
  requestId: string;
  observationId: string;
  requestedAt: string;
}

interface PayloadModule {
  createPayloadManifest(options: {
    payloadRoot: string;
    provenance: Record<string, unknown>;
  }): Promise<unknown>;
  validatePayloadManifest(options: { payloadRoot: string }): Promise<{ manifestSha256: string }>;
}

interface ManagerModule {
  installValidatedCandidate(options: {
    runtimeRoot: string;
    candidateRoot: string;
    automationId: "automation";
    now(): Date;
    validateRelease(root: string): Promise<{ manifestSha256: string }>;
    readDecision(request: DecisionRequest): Promise<string>;
  }): Promise<unknown>;
  migrateLegacyRound4LockArtifacts(options: {
    runtimeRoot: string;
    transactionJournalPath: string;
    maintenanceLease: { purpose: "release-maintenance" };
    inspectLegacyOwner(): Promise<"dead">;
  }): Promise<unknown>;
}

const projectRoot = process.cwd();
const fixedNow = () => new Date("2026-08-25T10:00:00.000Z");
const roots: string[] = [];

describe("Round 7 release WAL and mutation capability", () => {
  let runtimeRoot: string;
  let candidateRoot: string;
  let manager: ManagerModule;
  let payload: PayloadModule;

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "round7-wal-capability-"));
    roots.push(root);
    await chmod(root, 0o700);
    runtimeRoot = path.join(root, "runtime");
    await mkdir(runtimeRoot, { mode: 0o700 });
    [manager, payload] = await Promise.all([loadManager(), loadPayload()]);
    candidateRoot = await candidate("candidate");
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await makeTreeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "RELEASE_CLI_DECISION_TIMEOUT",
    "RELEASE_CLI_STDIN_CLOSED",
  ])("terminal-aborts and archives safe pre-pointer %s while both gates are held", async (reason) => {
    await expect(installWithCommitFailure(new Error(reason))).rejects.toThrow(reason);

    const journalPath = path.join(runtimeRoot, "state", "release-transaction.json");
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(runtimeRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(runtimeRoot, "bin.previous"))).rejects.toMatchObject({ code: "ENOENT" });
    const archiveDirectory = path.join(runtimeRoot, "state", "release-transaction-archive");
    const archiveNames = await readdir(archiveDirectory);
    expect(archiveNames).toHaveLength(1);
    const archived = JSON.parse(await readFile(path.join(archiveDirectory, archiveNames[0] as string), "utf8")) as {
      phase: string;
      abortReason: string;
    };
    expect(archived).toMatchObject({ phase: "terminal-abort", abortReason: reason });
  });

  it("keeps an unknown commit failure pending and quarantines runtime", async () => {
    await expect(installWithCommitFailure(new Error("UNKNOWN_COMMIT_FAILURE")))
      .rejects.toThrow("UNKNOWN_COMMIT_FAILURE");
    expect((await lstat(path.join(runtimeRoot, "state", "release-transaction.json"))).isFile())
      .toBe(true);
    await expect(access(path.join(runtimeRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps timeout pending when a pointer drifts during the decision window", async () => {
    await expect(installWithCommitFailure(
      new Error("RELEASE_CLI_DECISION_TIMEOUT"),
      async () => writeFile(path.join(runtimeRoot, "bin"), "foreign\n", { flag: "wx" }),
    )).rejects.toThrow("RELEASE_CLI_DECISION_TIMEOUT");

    expect((await lstat(path.join(runtimeRoot, "state", "release-transaction.json"))).isFile())
      .toBe(true);
    await expect(readFile(path.join(runtimeRoot, "bin"), "utf8")).resolves.toBe("foreign\n");
    const archiveNames = await readdir(
      path.join(runtimeRoot, "state", "release-transaction-archive"),
    ).catch(() => [] as string[]);
    expect(archiveNames).toHaveLength(0);
  });

  it("rejects a structurally forged maintenance lease before any migration write", async () => {
    const journalPath = path.join(runtimeRoot, "state", "round7-forged-migration.json");
    await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify({
      version: 1,
      txid: randomUUID(),
      maintenanceNonce: randomUUID(),
      phase: "maintenance",
      legacyMigration: { version: 1, status: "pending", artifacts: [], archived: [] },
    })}\n`;
    await writeFile(journalPath, serialized, { mode: 0o600 });

    await expect(manager.migrateLegacyRound4LockArtifacts({
      runtimeRoot,
      transactionJournalPath: journalPath,
      maintenanceLease: { purpose: "release-maintenance" },
      inspectLegacyOwner: () => Promise.resolve("dead"),
    })).rejects.toThrow("RELEASE_MUTATION_CAPABILITY_INVALID");

    await expect(readFile(journalPath, "utf8")).resolves.toBe(serialized);
    await expect(access(path.join(runtimeRoot, "state", "round6-legacy-lock-archive")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before a pointer write when the held live gate identity changes", async () => {
    let changed = false;
    await expect(runInstall(async (request) => {
      if (request.op === "precheck") return receipt(request);
      const gateDirectory = path.join(runtimeRoot, "state", ".kernel-lock-v1");
      const gateName = `${sha256("live-operation")}.gate`;
      const gatePath = path.join(gateDirectory, gateName);
      const displaced = `${gatePath}.displaced`;
      await rename(gatePath, displaced);
      await writeFile(gatePath, "", { flag: "wx", mode: 0o600 });
      changed = true;
      return receipt(request);
    })).rejects.toThrow("KERNEL_LOCK_OWNERSHIP_LOST");
    expect(changed).toBe(true);
    await expect(access(path.join(runtimeRoot, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(path.join(runtimeRoot, "state", "release-transaction.json"))).isFile())
      .toBe(true);
  });

  it("has no production pathname swap dependency", async () => {
    const [managerSource, runtimeSource, nativeSource] = await Promise.all([
      readFile(path.join(projectRoot, "scripts", "release-manager.mjs"), "utf8"),
      readFile(path.join(projectRoot, "scripts", "kernel-lock-runtime.mjs"), "utf8"),
      readFile(path.join(projectRoot, "native", "kernel-lock", "kernel_lock.c"), "utf8"),
    ]);
    expect(`${managerSource}\n${runtimeSource}\n${nativeSource}`).not.toMatch(/swapPaths|swapFilePaths/u);
  });

  it("attempts installer cleanup before maintenance cleanup on every release path", async () => {
    const managerSource = await readFile(
      path.join(projectRoot, "scripts", "release-manager.mjs"),
      "utf8",
    );
    const helperStart = managerSource.indexOf("async function releaseTransactionLeases(");
    const helperEnd = managerSource.indexOf("\n\nclass StagedMaintenanceLease", helperStart);
    const helper = helperStart >= 0 && helperEnd > helperStart
      ? managerSource.slice(helperStart, helperEnd)
      : undefined;
    expect(helper).toBeDefined();
    expect(helper?.indexOf("installerLease.release()"))
      .toBeLessThan(helper?.indexOf("maintenanceLease.release()") ?? -1);
    expect(helper).toContain("stagedMaintenanceLease.discard()");
    expect(managerSource.match(/releaseTransactionLeases\(\{/gu)).toHaveLength(4);
  });

  async function installWithCommitFailure(
    failure: Error,
    beforeFailure?: () => Promise<void>,
  ): Promise<unknown> {
    return runInstall(async (request) => {
      if (request.op === "precheck") return receipt(request);
      await beforeFailure?.();
      throw failure;
    });
  }

  function runInstall(readDecision: (request: DecisionRequest) => Promise<string>): Promise<unknown> {
    return manager.installValidatedCandidate({
      runtimeRoot,
      candidateRoot,
      automationId: "automation",
      now: fixedNow,
      validateRelease: (root) => payload.validatePayloadManifest({ payloadRoot: root }),
      readDecision,
    });
  }

  async function candidate(version: string): Promise<string> {
    const candidate = path.join(runtimeRoot, ".releases", `.staging-${version}`);
    await mkdir(candidate, { recursive: true });
    const versionPath = path.join(candidate, "version.txt");
    await writeFile(versionPath, `${version}\n`);
    await chmod(versionPath, 0o444);
    await payload.createPayloadManifest({ payloadRoot: candidate, provenance: { version } });
    await chmod(candidate, 0o555);
    return candidate;
  }
});

function receipt(request: DecisionRequest): string {
  return JSON.stringify({
    op: request.op,
    txid: request.txid,
    maintenanceNonce: request.maintenanceNonce,
    automationObservation: {
      automationId: "automation",
      targetCount: 1,
      status: "PAUSED",
      requestId: request.requestId,
      observationId: request.observationId,
      observedAt: request.requestedAt,
    },
  });
}

async function loadManager(): Promise<ManagerModule> {
  return await import(
    pathToFileURL(path.join(projectRoot, "scripts", "release-manager.mjs")).href
  ) as ManagerModule;
}

async function loadPayload(): Promise<PayloadModule> {
  return await import(
    pathToFileURL(path.join(projectRoot, "scripts", "release-payload.mjs")).href
  ) as PayloadModule;
}

async function makeTreeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await chmod(root, 0o700).catch(() => undefined);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await makeTreeWritable(path.join(root, entry.name));
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
