import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface KernelLease {
  release(): Promise<void>;
}

interface ReleaseManagerModule {
  acquireMaintenanceLease(options: {
    runtimeRoot: string;
    txid: string;
    maintenanceNonce: string;
  }): Promise<KernelLease>;
  migrateLegacyRound4LockArtifacts(options: {
    runtimeRoot: string;
    transactionJournalPath: string;
    maintenanceLease: KernelLease;
    inspectLegacyOwner(metadata: unknown): Promise<"alive" | "dead" | "unknown">;
    hook?(stage: string): Promise<void>;
  }): Promise<{ archived: string[]; status: "complete" }>;
}

describe("Round 6 release maintenance legacy-lock cutover", () => {
  let runtimeRoot: string;
  let journalPath: string;

  beforeEach(async () => {
    runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "release-round6-cutover-"));
    journalPath = path.join(runtimeRoot, "state", "round7-legacy-migration-test.json");
    await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  it("records an empty bounded inventory as a completed maintenance migration", async () => {
    await seedJournal([]);
    const lease = await maintenanceLease();
    try {
      await expect(manager().then((release) => release.migrateLegacyRound4LockArtifacts({
        runtimeRoot,
        transactionJournalPath: journalPath,
        maintenanceLease: lease,
        inspectLegacyOwner: () => Promise.resolve("dead"),
      }))).resolves.toEqual({ archived: [], status: "complete" });
    } finally {
      await lease.release();
    }
    expect((await readJournal()).legacyMigration?.status).toBe("complete");
  });

  it("archives only the journal-bounded legacy files after proving there is no live owner", async () => {
    const artifacts = [
      "state/daily-care-broadcasts.lock",
      "state/.daily-care-broadcasts.lock.recovery.claim",
      "state/.daily-care-broadcasts.lock.recovery-nonce.candidate",
    ];
    for (const artifact of artifacts) await writeLegacyArtifact(artifact);
    await seedJournal(artifacts);
    const lease = await maintenanceLease();
    try {
      const result = await (await manager()).migrateLegacyRound4LockArtifacts({
        runtimeRoot,
        transactionJournalPath: journalPath,
        maintenanceLease: lease,
        inspectLegacyOwner: () => Promise.resolve("dead"),
      });
      expect(result).toMatchObject({ status: "complete", archived: artifacts });
    } finally {
      await lease.release();
    }
    for (const artifact of artifacts) {
      await expect(access(path.join(runtimeRoot, artifact))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect((await readdir(path.join(runtimeRoot, "state", "round6-legacy-lock-archive"))).length)
      .toBe(artifacts.length);
  });

  it("retries a crash-resumable journal without overwriting an existing archive", async () => {
    const artifacts = [
      "state/daily-care-broadcasts.lock",
      "state/.daily-care-broadcasts.lock.recovery.claim",
    ];
    for (const artifact of artifacts) await writeLegacyArtifact(artifact);
    await seedJournal(artifacts);
    const lease = await maintenanceLease();
    try {
      await expect((await manager()).migrateLegacyRound4LockArtifacts({
        runtimeRoot,
        transactionJournalPath: journalPath,
        maintenanceLease: lease,
        inspectLegacyOwner: () => Promise.resolve("dead"),
        hook: (stage) => stage === "legacy-artifact-archived:0"
          ? Promise.reject(new Error("ROUND6_TEST_CRASH"))
          : Promise.resolve(),
      })).rejects.toThrow("ROUND6_TEST_CRASH");
      await expect((await manager()).migrateLegacyRound4LockArtifacts({
        runtimeRoot,
        transactionJournalPath: journalPath,
        maintenanceLease: lease,
        inspectLegacyOwner: () => Promise.resolve("dead"),
      })).resolves.toMatchObject({ status: "complete", archived: artifacts });
    } finally {
      await lease.release();
    }
  });

  it("fails closed for a source/archive ambiguity or a live old-protocol owner", async () => {
    const artifact = "state/daily-care-broadcasts.lock";
    await writeLegacyArtifact(artifact);
    await seedJournal([artifact]);
    const archiveDirectory = path.join(runtimeRoot, "state", "round6-legacy-lock-archive");
    await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(archiveDirectory, "0-daily-care-broadcasts.lock"), "different", {
      mode: 0o600,
    });
    const lease = await maintenanceLease();
    try {
      await expect((await manager()).migrateLegacyRound4LockArtifacts({
        runtimeRoot,
        transactionJournalPath: journalPath,
        maintenanceLease: lease,
        inspectLegacyOwner: () => Promise.resolve("dead"),
      })).rejects.toThrow("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
      await unlink(path.join(archiveDirectory, "0-daily-care-broadcasts.lock"));
      await expect((await manager()).migrateLegacyRound4LockArtifacts({
        runtimeRoot,
        transactionJournalPath: journalPath,
        maintenanceLease: lease,
        inspectLegacyOwner: () => Promise.resolve("alive"),
      })).rejects.toThrow("RELEASE_LEGACY_OWNER_LIVE");
    } finally {
      await lease.release();
    }
  });

  async function seedJournal(artifacts: string[]): Promise<void> {
    await writeFile(journalPath, JSON.stringify({
      version: 1,
      txid: randomUUID(),
      maintenanceNonce: randomUUID(),
      phase: "maintenance-staged",
      legacyMigration: {
        version: 1,
        status: "pending",
        artifacts,
        archived: [],
      },
    }), { mode: 0o600 });
  }

  async function writeLegacyArtifact(relativePath: string): Promise<void> {
    const artifactPath = path.join(runtimeRoot, relativePath);
    await mkdir(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
    await writeFile(artifactPath, JSON.stringify({
      version: 1,
      pid: 999_999,
      purpose: "legacy-round4",
    }), { flag: "wx", mode: 0o600 });
  }

  async function readJournal(): Promise<Record<string, { status: string }>> {
    return JSON.parse(await readFile(journalPath, "utf8")) as Record<string, { status: string }>;
  }

  async function maintenanceLease(): Promise<KernelLease> {
    return (await manager()).acquireMaintenanceLease({
      runtimeRoot,
      txid: randomUUID(),
      maintenanceNonce: randomUUID(),
    });
  }
});

async function manager(): Promise<ReleaseManagerModule> {
  const moduleUrl = new URL("../../scripts/release-manager.mjs", import.meta.url).href;
  return await import(moduleUrl) as ReleaseManagerModule;
}
