import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateBroadcastCandidate } from "../../src/daily-care/message-policy.js";
import { FileOperationQuarantineRepository } from
  "../../src/runtime-v2/operation-quarantine.js";
import { SingleDispatcherAdmission } from
  "../../src/runtime-v2/single-dispatcher-admission.js";
import {
  FileSingleSchedulerStateRepository,
  InMemorySingleSchedulerStateRepository,
  SingleScheduler,
} from "../../src/runtime-v2/single-scheduler.js";
import {
  FileAcceptanceRepository,
  SupervisedAcceptanceService,
  type AcceptanceDriver,
  type ReleaseBinding,
} from "../../src/runtime-v2/supervised-acceptance.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

const projectRoot = process.cwd();
const temporaryRoots: string[] = [];
const children = new Set<ChildProcess>();
const binding: ReleaseBinding = {
  payloadManifestSha256: "a".repeat(64),
  nativeSha256: "b".repeat(64),
  effectiveConfigSha256: "c".repeat(64),
};

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("runtime-v2 Fix Round 5 hardening", () => {
  it("recovers acceptance submit-started after SIGKILL through an OS lease and never unlinks a replacement pathname lock", async () => {
    const runtimeRoot = await makeRuntimeRoot("round5 acceptance-");
    const marker = path.join(runtimeRoot, "acceptance-acquired");
    const owner = spawnWorker("acceptance", runtimeRoot, marker);
    await waitForPath(marker);
    const legacyLock = path.join(runtimeRoot, "state", "supervised-acceptance.lock");
    if (await exists(legacyLock)) await rename(legacyLock, `${legacyLock}.displaced`);
    await writeFile(legacyLock, "foreign replacement\n", { flag: "wx", mode: 0o600 });
    const replacement = await lstat(legacyLock);
    owner.kill("SIGKILL");
    await expectChildKilled(owner);

    const successor = acceptanceDriver(true);
    const receipt = await new SupervisedAcceptanceService({
      repository: new FileAcceptanceRepository(runtimeRoot),
      admission: new SingleDispatcherAdmission({
        acquireOwner: () => Promise.resolve(successor),
      }),
    }).runA(binding);

    expect(receipt.status).toBe("verified");
    expect(successor.submitOnce).not.toHaveBeenCalled();
    expect(successor.replaceComposerWithFixedMessage).not.toHaveBeenCalled();
    expect(successor.readOutgoingFixedMessageAfterBaseline).toHaveBeenCalledTimes(1);
    expect(await lstat(legacyLock)).toMatchObject({ dev: replacement.dev, ino: replacement.ino });
    expect(await readFile(legacyLock, "utf8")).toBe("foreign replacement\n");
  }, 20_000);

  it("recovers a scheduler transaction after SIGKILL without unlinking a replacement pathname lock", async () => {
    const runtimeRoot = await makeRuntimeRoot("round5 scheduler-");
    const marker = path.join(runtimeRoot, "scheduler-acquired");
    const owner = spawnWorker("scheduler", runtimeRoot, marker);
    await waitForPath(marker);
    const legacyLock = path.join(runtimeRoot, "state", "single-scheduler.lock");
    if (await exists(legacyLock)) await rename(legacyLock, `${legacyLock}.displaced`);
    await writeFile(legacyLock, "foreign replacement\n", { flag: "wx", mode: 0o600 });
    const replacement = await lstat(legacyLock);
    owner.kill("SIGKILL");
    await expectChildKilled(owner);

    const repository = new FileSingleSchedulerStateRepository(runtimeRoot);
    await expect(repository.transact((state) => Promise.resolve({ state, result: "recovered" })))
      .resolves.toBe("recovered");
    expect(await lstat(legacyLock)).toMatchObject({ dev: replacement.dev, ino: replacement.ino });
  }, 20_000);

  it("returns an exactly-once durable completion token and opens independent P0/P1 circuits", async () => {
    const state = new InMemorySingleSchedulerStateRepository();
    const scheduler = new SingleScheduler({
      state,
      inspectP0Slot: () => Promise.resolve({ status: "pending" }),
      circuitFailureThreshold: 3,
      circuitDurationMs: 30 * 60 * 1000,
    });
    for (const instant of ["2026-08-25T22:30:00Z", "2026-08-25T22:40:00Z", "2026-08-25T22:50:00Z"]) {
      const decision = await scheduler.beginScheduledTick(new Date(instant), {
        createPassive: () => Promise.resolve({}),
        createDailyCare: () => Promise.resolve({}),
      }) as unknown as { lane: "p0" | "p1"; complete(input: { success: boolean }): Promise<void> };
      expect(decision.lane).toBe("p0");
      await decision.complete({ success: false });
      await decision.complete({ success: false });
    }
    const afterP0 = await state.load();
    expect(afterP0.p0Failures).toBe(3);
    expect(afterP0.p1Failures).toBe(0);

    for (const instant of ["2026-08-26T01:00:00Z", "2026-08-26T01:10:00Z", "2026-08-26T01:20:00Z"]) {
      const decision = await scheduler.beginScheduledTick(new Date(instant), {
        createPassive: () => Promise.resolve({}),
        createDailyCare: () => Promise.resolve({}),
      }) as unknown as { complete(input: { success: boolean }): Promise<void> };
      await decision.complete({ success: false });
    }
    const afterP1 = await state.load();
    expect(afterP1.p0Failures).toBe(3);
    expect(afterP1.p1Failures).toBe(3);
    await expect(scheduler.beginScheduledTick(new Date("2026-08-26T01:30:00Z"), {
      createPassive: () => Promise.resolve({}),
      createDailyCare: () => Promise.resolve({}),
    })).rejects.toThrow("SINGLE_SCHEDULER_CIRCUIT_OPEN");

    const recovered = await scheduler.beginScheduledTick(new Date("2026-08-26T02:00:00Z"), {
      createPassive: () => Promise.resolve({}),
      createDailyCare: () => Promise.resolve({}),
    }) as unknown as { complete(input: { success: boolean }): Promise<void> };
    await recovered.complete({ success: true });
    expect((await state.load()).p1Failures).toBe(0);
  });

  it("persists a release- and cycle-bound quarantine record", async () => {
    const runtimeRoot = await makeRuntimeRoot("round5 quarantine-");
    const repository = new FileOperationQuarantineRepository(runtimeRoot);
    await repository.quarantine({
      lane: "p1",
      reason: "UI_OPERATION_UNSETTLED",
      cycleId: "11111111-1111-4111-8111-111111111111",
      releaseSha256: "d".repeat(64),
      draftPending: true,
      submitUncertain: false,
      outcomeCause: "OPERATION_TIMEOUT",
    } as never);
    expect(JSON.parse(await readFile(
      path.join(runtimeRoot, "state", "fixed-heartbeat-quarantine.json"),
      "utf8",
    ))).toMatchObject({
      version: 2,
      lane: "p1",
      cycleId: "11111111-1111-4111-8111-111111111111",
      releaseSha256: "d".repeat(64),
      draftPending: true,
      submitUncertain: false,
      outcomeCause: "OPERATION_TIMEOUT",
    });
  });

  it("initializes and verifies the kernel catalog and strict payload before publishing current", async () => {
    const source = await readFile(path.join(projectRoot, "scripts", "runtime-v2-clean-install.mjs"), "utf8");
    const initializeCatalog = source.indexOf("await initializeCatalogAt");
    const finalValidation = source.indexOf("const finalValidation");
    const publishCurrent = source.indexOf("addon.symlinkAtNoReplace");
    expect(initializeCatalog).toBeGreaterThanOrEqual(0);
    expect(finalValidation).toBeGreaterThan(initializeCatalog);
    expect(publishCurrent).toBeGreaterThan(finalValidation);
  });

  it("requires an installed-current validator for config command, wrapper realpath and manifest hash", async () => {
    const release = await import(new URL("../../scripts/release-payload.mjs", import.meta.url).href) as {
      validateInstalledRuntimeV2?: unknown;
    };
    expect(typeof release.validateInstalledRuntimeV2).toBe("function");
  });

  it("accepts warm pure-care fallbacks but rejects every concrete clothing or carried-item claim", () => {
    const accepted = [
      "早呀，今日份的关心也准时送到啦。上班前先吃点东西，喝点温水，别空着肚子忙起来。路上不用太赶，给自己留一点从容，愿你今天顺顺利利，也记得照顾好身体。☀️💛\n——示例用户",
      "早上好，今天也想提醒你，上班别太赶，忙起来记得按时吃饭、喝水，累了就停一停。自己的感受也值得认真照顾，愿这一天平稳顺心。☀️💛\n——示例用户",
    ];
    for (const text of accepted) {
      expect(() => validateBroadcastCandidate({
        kind: "morning", text, weather: null, recentVerifiedTexts: [],
      })).not.toThrow();
    }
    for (const claim of ["穿件短袖再出门", "拿件外套", "带把雨伞", "包里放好防晒霜", "戴上帽子"]) {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: accepted[0]!.replace("上班前", `${claim}，上班前`),
        weather: null,
        recentVerifiedTexts: [],
      })).toThrow("BROADCAST_FALLBACK_WEATHER_FORBIDDEN");
    }
  });
});

async function makeRuntimeRoot(prefix: string): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(parent);
  const runtimeRoot = path.join(parent, "runtime-v2");
  await mkdir(runtimeRoot, { mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await initializeTestKernelLockCatalog(runtimeRoot);
  return runtimeRoot;
}

function spawnWorker(mode: "acceptance" | "scheduler", runtimeRoot: string, marker: string): ChildProcess {
  const child = spawn(process.execPath, [
    path.resolve("node_modules/vitest/vitest.mjs"),
    "run",
    path.resolve("tests/fixtures/runtime-v2-round5-state-worker.test.ts"),
    "--pool=threads",
    "--maxWorkers=1",
    "--reporter=dot",
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RUNTIME_V2_ROUND5_WORKER: "1",
      RUNTIME_V2_ROUND5_MODE: mode,
      RUNTIME_V2_ROUND5_ROOT: runtimeRoot,
      RUNTIME_V2_ROUND5_ACQUIRED: marker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function expectChildKilled(child: ChildProcess): Promise<void> {
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  children.delete(child);
  expect({ code, signal }).toEqual({ code: null, signal: "SIGKILL" });
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await exists(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`ROUND5_WORKER_SIGNAL_MISSING:${path.basename(filePath)}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function acceptanceDriver(outgoingVerified: boolean): AcceptanceDriver & {
  submitOnce: ReturnType<typeof vi.fn>;
  replaceComposerWithFixedMessage: ReturnType<typeof vi.fn>;
  readOutgoingFixedMessageAfterBaseline: ReturnType<typeof vi.fn>;
} {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    locateFixedTarget: vi.fn().mockResolvedValue({
      unique: true,
      outgoingBaseline: {
        fixedOutgoingCount: 0,
        anchor: { messageId: "a".repeat(64), occurrenceOrdinal: 1 },
      },
    }),
    readLatestDirection: vi.fn().mockResolvedValue("incoming"),
    readComposer: vi.fn().mockResolvedValue(""),
    replaceComposerWithFixedMessage: vi.fn().mockResolvedValue(undefined),
    clearComposer: vi.fn().mockResolvedValue(undefined),
    submitOnce: vi.fn().mockResolvedValue(undefined),
    readOutgoingFixedMessageAfterBaseline: vi.fn().mockResolvedValue(outgoingVerified),
    close: vi.fn().mockResolvedValue({ gateReleased: true }),
  };
}
