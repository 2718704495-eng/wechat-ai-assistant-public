import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DailyCareSlot } from "../../src/daily-care/types.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { DailyCareBroadcastRepository } from "../../src/storage/daily-care-broadcast-repository.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

const morningSlot: DailyCareSlot = {
  slotKey: `test/${"a".repeat(64)}`,
  localDate: "2026-08-23",
  kind: "morning",
  targetMode: "test",
};

describe("DailyCareBroadcastRepository", () => {
  let rootDir: string;
  let key: Buffer;
  let repository: DailyCareBroadcastRepository;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "daily-care-repository-"));
    await initializeTestKernelLockCatalog(rootDir);
    key = randomBytes(32);
    repository = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
      () => new Date("2026-08-23T10:00:00.000Z"),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("moves one claimed slot through a fail-closed submit lifecycle", async () => {
    const targetModeHash = createHash("sha256").update("test:file-transfer").digest("hex");
    await expect(repository.claimSlot({
      slot: morningSlot,
      targetConversationId: "file-transfer",
      targetModeHash,
    })).resolves.toMatchObject({ status: "pending", phase: "claimed", targetModeHash });

    await repository.saveCandidate(morningSlot.slotKey, {
      text: "encrypted candidate",
      normalizedHash: "b".repeat(64),
      weatherFactHash: "c".repeat(64),
    });
    await repository.markDraftVerified(morningSlot.slotKey);
    await repository.markSubmitStarted(morningSlot.slotKey);
    await expect(repository.getSlot(morningSlot.slotKey)).resolves.toMatchObject({
      status: "submitted-uncertain",
      phase: "submit-started",
    });
    await repository.markVerified(morningSlot.slotKey);
    await expect(repository.getSlot(morningSlot.slotKey)).resolves.toMatchObject({
      status: "verified",
      phase: "terminal",
    });
    await expect(repository.markSubmitStarted(morningSlot.slotKey)).rejects.toThrow(
      "BROADCAST_SLOT_TERMINAL",
    );
  });

  it("rejects duplicate claims, candidate conflicts, and illegal transitions", async () => {
    const input = {
      slot: morningSlot,
      targetConversationId: "file-transfer" as const,
      targetModeHash: "d".repeat(64),
    };
    await repository.claimSlot(input);
    await expect(repository.claimSlot(input)).rejects.toThrow("BROADCAST_SLOT_ALREADY_CLAIMED");
    await expect(repository.markDraftVerified(morningSlot.slotKey)).rejects.toThrow(
      "BROADCAST_SLOT_PHASE_INVALID",
    );
    await repository.saveCandidate(morningSlot.slotKey, {
      text: "first candidate",
      normalizedHash: "e".repeat(64),
      weatherFactHash: "f".repeat(64),
    });
    await expect(repository.saveCandidate(morningSlot.slotKey, {
      text: "different candidate",
      normalizedHash: "1".repeat(64),
      weatherFactHash: "f".repeat(64),
    })).rejects.toThrow("BROADCAST_CANDIDATE_CONFLICT");
  });

  it("keeps candidates and target identifiers out of the backing documents and marker names", async () => {
    await repository.claimSlot({
      slot: morningSlot,
      targetConversationId: "file-transfer",
      targetModeHash: "2".repeat(64),
    });
    await repository.saveCandidate(morningSlot.slotKey, {
      text: "绝不能出现在磁盘明文里的候选",
      normalizedHash: "3".repeat(64),
      weatherFactHash: null,
    });
    const encrypted = await readFile(path.join(rootDir, "state/daily-care-broadcasts.enc"), "utf8");
    expect(encrypted).not.toContain("绝不能出现在磁盘明文里的候选");
    expect(encrypted).not.toContain("file-transfer");
    const claims = await readdir(path.join(rootDir, "state/daily-care-claims"));
    expect(claims).toEqual([
      `${createHash("sha256").update(morningSlot.slotKey).digest("hex")}.claim`,
    ]);
    expect((await stat(path.join(rootDir, "state/daily-care-claims", claims[0] ?? "missing"))).mode & 0o777)
      .toBe(0o600);
  });

  it("returns only recent verified texts of the requested kind", async () => {
    await finishSlot(repository, morningSlot, "morning text");
    await finishSlot(repository, {
      ...morningSlot,
      slotKey: `test/${"b".repeat(64)}`,
      kind: "night",
    }, "night text");
    await expect(repository.listRecentVerifiedTexts("morning", 14)).resolves.toEqual([
      "morning text",
    ]);
    await expect(repository.listRecentVerifiedTexts("night", 14)).resolves.toEqual([
      "night text",
    ]);
  });

  it("atomically counts two concurrent hydrates from independent repository instances", async () => {
    const input = {
      slot: morningSlot,
      targetConversationId: "file-transfer" as const,
      targetModeHash: "7".repeat(64),
    };
    await repository.claimSlot(input);
    const first = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
    );
    const second = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
    );

    const hydrated = await Promise.all([
      first.claimOrHydrateSlot(input),
      second.claimOrHydrateSlot(input),
    ]);

    expect(hydrated.map(({ sessionAttemptCount }) => sessionAttemptCount).sort()).toEqual([1, 2]);
    await expect(repository.getSlot(morningSlot.slotKey)).resolves.toMatchObject({
      status: "pending",
      phase: "claimed",
      sessionAttemptCount: 2,
    });
  });

  it("counts every successful hydrate of each recoverable durable phase", async () => {
    const input = {
      slot: morningSlot,
      targetConversationId: "file-transfer" as const,
      targetModeHash: "6".repeat(64),
    };
    await repository.claimSlot(input);

    const claimed = await repository.claimOrHydrateSlot(input);
    expect(claimed).toMatchObject({ phase: "claimed", sessionAttemptCount: 1 });
    repository.releaseSessionSlot(morningSlot.slotKey);

    await repository.saveCandidate(morningSlot.slotKey, {
      text: "recoverable candidate",
      normalizedHash: "5".repeat(64),
      weatherFactHash: "4".repeat(64),
    });
    const preparedRepository = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
    );
    const prepared = await preparedRepository.claimOrHydrateSlot(input);
    expect(prepared).toMatchObject({ phase: "candidate-prepared", sessionAttemptCount: 2 });
    preparedRepository.releaseSessionSlot(morningSlot.slotKey);

    await repository.markDraftVerified(morningSlot.slotKey);
    const verifiedRepository = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
    );
    const verified = await verifiedRepository.claimOrHydrateSlot(input);
    expect(verified).toMatchObject({ phase: "draft-verified", sessionAttemptCount: 3 });
  });

  it("terminalizes the fourth hydrate after three recoverable attempts", async () => {
    const input = {
      slot: morningSlot,
      targetConversationId: "file-transfer" as const,
      targetModeHash: "3".repeat(64),
    };
    await repository.claimSlot(input);
    await repository.saveCandidate(morningSlot.slotKey, {
      text: "recoverable candidate",
      normalizedHash: "2".repeat(64),
      weatherFactHash: "1".repeat(64),
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const instance = new DailyCareBroadcastRepository(
        new EncryptedStore(rootDir, new FixedKeyProvider(key)),
      );
      await expect(instance.claimOrHydrateSlot(input)).resolves.toMatchObject({
        phase: "candidate-prepared",
        sessionAttemptCount: attempt,
      });
      instance.releaseSessionSlot(morningSlot.slotKey);
    }

    const fourth = new DailyCareBroadcastRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(key)),
    );
    await expect(fourth.claimOrHydrateSlot(input)).resolves.toMatchObject({
      status: "skipped",
      phase: "terminal",
      skipReason: "retry-limit-exhausted",
      sessionAttemptCount: 3,
    });
  });

  it("grants exactly one claim to two independent Node processes", async () => {
    const workerRoot = await mkdtemp(path.join(os.tmpdir(), "daily-care-process-"));
    await initializeTestKernelLockCatalog(workerRoot);
    const workerPath = path.resolve("tests/fixtures/daily-care-claim-worker.test.ts");
    const vitestPath = path.resolve("node_modules/vitest/vitest.mjs");
    const children = ["a", "b"].map((workerId) => {
      const resultPath = path.join(workerRoot, `result-${workerId}.json`);
      const child = spawn(process.execPath, [
        vitestPath,
        "run",
        workerPath,
        "--pool=forks",
        "--maxWorkers=1",
        "--reporter=dot",
      ], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          DAILY_CARE_CLAIM_WORKER: "1",
          DAILY_CARE_CLAIM_ROOT: workerRoot,
          DAILY_CARE_CLAIM_KEY_HEX: key.toString("hex"),
          DAILY_CARE_CLAIM_WORKER_ID: workerId,
          DAILY_CARE_CLAIM_RESULT_PATH: resultPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { child, resultPath, readyPath: path.join(workerRoot, `ready-${workerId}`) };
    });
    try {
      await Promise.all(children.map(({ readyPath }) => waitForPath(readyPath)));
      await writeFile(path.join(workerRoot, "start"), "", { flag: "wx" });
      const outputs = await Promise.all(children.map(({ child }) => waitForChild(child)));
      for (const output of outputs) expect(output.code, output.stderr || output.stdout).toBe(0);
      const results = await Promise.all(children.map(async ({ resultPath }) =>
        JSON.parse(await readFile(resultPath, "utf8")) as { claimed: boolean }
      ));
      expect(results.filter(({ claimed }) => claimed)).toHaveLength(1);
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill();
      await rm(workerRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("atomically counts successful hydrates from two independent Node processes", async () => {
    const workerRoot = await mkdtemp(path.join(os.tmpdir(), "daily-care-hydrate-process-"));
    await initializeTestKernelLockCatalog(workerRoot);
    const workerPath = path.resolve("tests/fixtures/daily-care-claim-worker.test.ts");
    const vitestPath = path.resolve("node_modules/vitest/vitest.mjs");
    const seeded = new DailyCareBroadcastRepository(new EncryptedStore(
      workerRoot,
      new FixedKeyProvider(key),
    ));
    await seeded.claimSlot({
      slot: {
        slotKey: `test/${"c".repeat(64)}`,
        localDate: "2026-08-23",
        kind: "morning",
        targetMode: "test",
      },
      targetConversationId: "file-transfer",
      targetModeHash: "d".repeat(64),
    });
    const children = ["a", "b"].map((workerId) => {
      const resultPath = path.join(workerRoot, `result-${workerId}.json`);
      const child = spawn(process.execPath, [
        vitestPath,
        "run",
        workerPath,
        "--pool=forks",
        "--maxWorkers=1",
        "--reporter=dot",
      ], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          DAILY_CARE_HYDRATE_WORKER: "1",
          DAILY_CARE_CLAIM_ROOT: workerRoot,
          DAILY_CARE_CLAIM_KEY_HEX: key.toString("hex"),
          DAILY_CARE_CLAIM_WORKER_ID: workerId,
          DAILY_CARE_CLAIM_RESULT_PATH: resultPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { child, resultPath, readyPath: path.join(workerRoot, `ready-${workerId}`) };
    });
    try {
      await Promise.all(children.map(({ readyPath }) => waitForPath(readyPath)));
      await writeFile(path.join(workerRoot, "start"), "", { flag: "wx" });
      const outputs = await Promise.all(children.map(({ child }) => waitForChild(child)));
      for (const output of outputs) expect(output.code, output.stderr || output.stdout).toBe(0);
      const results = await Promise.all(children.map(async ({ resultPath }) =>
        JSON.parse(await readFile(resultPath, "utf8")) as { sessionAttemptCount: number }
      ));
      expect(results.map(({ sessionAttemptCount }) => sessionAttemptCount).sort()).toEqual([1, 2]);
      await expect(seeded.getSlot(`test/${"c".repeat(64)}`)).resolves.toMatchObject({
        sessionAttemptCount: 2,
      });
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill();
      await rm(workerRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

async function finishSlot(
  repository: DailyCareBroadcastRepository,
  slot: DailyCareSlot,
  text: string,
): Promise<void> {
  await repository.claimSlot({
    slot,
    targetConversationId: "file-transfer",
    targetModeHash: "9".repeat(64),
  });
  await repository.saveCandidate(slot.slotKey, {
    text,
    normalizedHash: createHash("sha256").update(text).digest("hex"),
    weatherFactHash: slot.kind === "morning" ? "8".repeat(64) : null,
  });
  await repository.markDraftVerified(slot.slotKey);
  await repository.markSubmitStarted(slot.slotKey);
  await repository.markVerified(slot.slotKey);
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`WAIT_TIMEOUT:${path.basename(filePath)}`);
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("exit", (code) => { resolve({ code, stdout, stderr }); });
  });
}
