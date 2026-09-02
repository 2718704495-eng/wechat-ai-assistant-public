import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { acquireLiveOperationCoordinator } from "../../src/mcp/live-operation-coordinator.js";
import { compatibilityTombstoneContents } from "../../src/storage/kernel-lock.js";

type TransactionPhase =
  | "previous-prepared"
  | "current-switched"
  | "forensic-admitted"
  | "journal-archived";
type OwnerIdentity = "alive-exact" | "dead" | "pid-reused" | "unknown";

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

interface DecisionBundle {
  session: DecisionSession;
  lines: [string, string];
}

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
  recoverReleaseTransaction(options: {
    runtimeRoot: string;
    now(): Date;
    validateRelease(releaseRoot: string): Promise<{ manifestSha256: string }>;
    readDecision?(request: RecoveryDecisionRequest): Promise<string>;
    inspectOwnerIdentity?(owner: {
      pid: number;
      processStartedAt: string;
    }): Promise<OwnerIdentity>;
    hook?(phase: TransactionPhase): Promise<void> | void;
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

interface SafetyHarness {
  manager: ReleaseManagerModule;
  payload: PayloadModule;
  root: string;
  runtimeRoot: string;
  validateRelease(releaseRoot: string): Promise<{ manifestSha256: string }>;
  candidate(version: string): Promise<string>;
  install(
    candidateRoot: string,
    decision?: DecisionBundle,
    hook?: TransactionOptions["hook"],
  ): Promise<unknown>;
  currentVersion(): Promise<string>;
}

const projectRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => makeTreeWritable(root)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release automation receipts", () => {
  it.each([
    { name: "bare precheck", mutate: (bundle: DecisionBundle) => { bundle.lines[0] = "precheck"; } },
    { name: "extra commit field", mutate: (bundle: DecisionBundle) => mutateReceipt(bundle, 1, (value) => ({ ...value, extra: true })) },
    { name: "wrong txid", mutate: (bundle: DecisionBundle) => mutateReceipt(bundle, 1, (value) => ({ ...value, txid: crypto.randomUUID() })) },
    { name: "wrong nonce", mutate: (bundle: DecisionBundle) => mutateReceipt(bundle, 1, (value) => ({ ...value, maintenanceNonce: crypto.randomUUID() })) },
    { name: "wrong request", mutate: (bundle: DecisionBundle) => mutateObservation(bundle, 1, { requestId: crypto.randomUUID() }) },
    { name: "wrong observation", mutate: (bundle: DecisionBundle) => mutateObservation(bundle, 1, { observationId: crypto.randomUUID() }) },
    { name: "wrong automation", mutate: (bundle: DecisionBundle) => mutateObservation(bundle, 1, { automationId: "another" }) },
    { name: "multiple targets", mutate: (bundle: DecisionBundle) => mutateObservation(bundle, 1, { targetCount: 2 }) },
    { name: "ACTIVE automation", mutate: (bundle: DecisionBundle) => mutateObservation(bundle, 1, { status: "ACTIVE" }) },
    { name: "expired receipt", mutate: (bundle: DecisionBundle) => mutateObservation(bundle, 1, { observedAt: "2026-08-21T01:58:00.000Z" }) },
    {
      name: "same observation replayed across phases",
      mutate: (bundle: DecisionBundle) => mutateObservation(bundle, 1, {
        observationId: bundle.session.precheckObservationId,
      }),
    },
    {
      name: "receipt from another session",
      mutate: (bundle: DecisionBundle) => {
        bundle.lines[1] = decisionBundle().lines[1];
      },
    },
  ])("rejects $name before changing a release pointer", async ({ mutate }) => {
    const harness = await safetyHarness();
    const candidate = await harness.candidate("blocked");
    const decision = decisionBundle();
    mutate(decision);

    await expect(harness.install(candidate, decision))
      .rejects.toThrow("RELEASE_COMMIT_DECISION_INVALID");

    await expect(lstat(path.join(harness.runtimeRoot, "bin")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(harness.runtimeRoot, "state", "live-operation.lock"), "utf8"))
      .resolves.toBe(compatibilityTombstoneContents());
  });

  it("rejects a consumed pair of receipts when replayed in a later operation", async () => {
    const harness = await safetyHarness();
    const decision = decisionBundle();
    await harness.install(await harness.candidate("first"), decision);

    await expect(harness.install(await harness.candidate("replay"), decision))
      .rejects.toThrow("RELEASE_COMMIT_DECISION_REPLAYED");
    await expect(harness.currentVersion()).resolves.toBe("first");
  });

  it("persists receipt consumption across a fresh manager module instance", async () => {
    const harness = await safetyHarness();
    const decision = decisionBundle();
    await harness.install(await harness.candidate("first"), decision);
    const freshManager = await loadReleaseManagerModule(crypto.randomUUID());

    await expect(freshManager.installValidatedCandidate({
      runtimeRoot: harness.runtimeRoot,
      candidateRoot: await harness.candidate("must-not-install"),
      automationId: "automation",
      now: fixedNow,
      validateRelease: (releaseRoot) => harness.validateRelease(releaseRoot),
      session: decision.session,
      decisionLines: decision.lines,
    })).rejects.toThrow("RELEASE_COMMIT_DECISION_REPLAYED");

    await expect(harness.currentVersion()).resolves.toBe("first");
  });
});

describe("release installer exclusion and durable journal", () => {
  it("holds a dedicated persistent installer gate across pointer mutation", async () => {
    const harness = await safetyHarness();
    await harness.install(await harness.candidate("first"));
    const entered = deferred<void>();
    const release = deferred<void>();
    const installing = harness.install(
      await harness.candidate("second"),
      decisionBundle(),
      async (phase) => {
        if (phase !== "previous-prepared") return;
        entered.resolve(undefined);
        await release.promise;
      },
    );
    try {
      await expect(settlesWithin(Promise.race([entered.promise, installing])))
        .resolves.toBe("SETTLED");
      const gateEntries = await readdir(path.join(
        harness.runtimeRoot,
        "state",
        ".kernel-lock-v1",
      ));
      expect(gateEntries.filter((name) => name.endsWith(".gate"))).toHaveLength(3);

      const third = await harness.candidate("third");
      await expect(harness.install(third)).rejects.toThrow("RELEASE_INSTALLER_BUSY");
      await expect(harness.currentVersion()).resolves.toBe("first");
    } finally {
      release.resolve(undefined);
      await installing.catch(() => undefined);
    }
    await expect(installing).resolves.toBeDefined();
    await expect(harness.currentVersion()).resolves.toBe("second");
    await expect(readFile(path.join(harness.runtimeRoot, "state", "release-install.lock"), "utf8"))
      .resolves.toBe(compatibilityTombstoneContents());
  });

  it("persists exact maintenance and two-observation identity in the journal", async () => {
    const harness = await safetyHarness();
    const decision = decisionBundle();
    let journalChecked = false;

    await harness.install(await harness.candidate("journal"), decision, async (phase) => {
      if (phase !== "previous-prepared") return;
      const journal: unknown = JSON.parse(await readFile(
        path.join(harness.runtimeRoot, "state", "release-transaction.json"),
        "utf8",
      ));
      const journalRecord = parseObject(journal);
      const maintenance = parseObject(journalRecord.maintenanceLease);
      const lockPath = path.join(harness.runtimeRoot, ...String(maintenance.path).split("/"));
      const lockIdentity = await lstat(lockPath);
      expect(journalRecord.txid).toBe(decision.session.txid);
      expect(journalRecord.maintenanceNonce).toBe(decision.session.maintenanceNonce);
      expect(maintenance.path).toMatch(/^state\/\.kernel-lock-v1\/[a-f0-9]{64}\.gate$/u);
      expect(maintenance.device).toBe(String(lockIdentity.dev));
      expect(maintenance.inode).toBe(String(lockIdentity.ino));
      expect(maintenance.nonce).toBe(decision.session.maintenanceNonce);
      expect(maintenance.pid).toEqual(expect.any(Number));
      expect(maintenance.processStartedAt).toEqual(expect.any(String));
      expect(parseObject(journalRecord.automationObservations).precheck)
        .toEqual(receiptObservation(decision.lines[0]));
      expect(parseObject(journalRecord.automationObservations).commit)
        .toEqual(receiptObservation(decision.lines[1]));
      journalChecked = true;
    });

    expect(journalChecked).toBe(true);
  });

  it("archives the completed journal while maintenance still excludes live owners", async () => {
    const harness = await safetyHarness();
    const decision = decisionBundle();
    let archivedWhileBusy = false;

    await harness.install(await harness.candidate("archive"), decision, async (phase) => {
      if (phase !== "journal-archived") return;
      await expect(lstat(path.join(harness.runtimeRoot, "state", "release-transaction.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(acquireLiveOperationCoordinator({
        dataDir: harness.runtimeRoot,
        ownerKind: "cli",
      })).rejects.toThrow("LIVE_RUNTIME_BUSY");
      archivedWhileBusy = true;
    });

    expect(archivedWhileBusy).toBe(true);
    const archiveDirectory = path.join(
      harness.runtimeRoot,
      "state",
      "release-transaction-archive",
    );
    expect((await readdir(archiveDirectory)).some((name) => name.includes(decision.session.txid)))
      .toBe(true);
    await expect(readFile(path.join(harness.runtimeRoot, "state", "live-operation.lock"), "utf8"))
      .resolves.toBe(compatibilityTombstoneContents());
  });
});

describe("release kernel recovery", () => {
  it("requires a fresh PAUSED observation before and after acquiring recovery maintenance", async () => {
    const harness = await safetyHarness();
    await harness.install(await harness.candidate("first"));
    await expect(harness.install(
      await harness.candidate("interrupted"),
      decisionBundle(),
      (phase) => {
        if (phase === "previous-prepared") throw new Error("SIMULATED_INTERRUPTION");
      },
    )).rejects.toThrow("SIMULATED_INTERRUPTION");
    await expect(harness.manager.recoverReleaseTransaction({
      runtimeRoot: harness.runtimeRoot,
      now: fixedNow,
      validateRelease: (releaseRoot) => harness.validateRelease(releaseRoot),
    })).rejects.toThrow("RELEASE_TRANSACTION_INVALID");

    const phases: string[] = [];
    await harness.manager.recoverReleaseTransaction({
      runtimeRoot: harness.runtimeRoot,
      now: fixedNow,
      validateRelease: (releaseRoot) => harness.validateRelease(releaseRoot),
      readDecision: async (request) => {
        phases.push(request.op);
        if (request.op === "precheck") {
          await expect(acquireLiveOperationCoordinator({
            dataDir: harness.runtimeRoot,
            ownerKind: "cli",
          })).rejects.toThrow("RELEASE_RUNTIME_QUARANTINED");
        } else {
          await expect(acquireLiveOperationCoordinator({
            dataDir: harness.runtimeRoot,
            ownerKind: "cli",
          })).rejects.toThrow("LIVE_RUNTIME_BUSY");
          await expect(harness.currentVersion()).resolves.toBe("first");
        }
        return recoveryReceipt(request);
      },
    });
    expect(phases).toEqual(["precheck", "commit"]);
    await expect(harness.currentVersion()).resolves.toBe("first");
  });

  it("recovers a SIGKILLed installer using the persistent live and installer gates", async () => {
    const harness = await safetyHarness();
    await crashTransaction(harness, "previous-prepared");
    const phases: string[] = [];
    await harness.manager.recoverReleaseTransaction({
      runtimeRoot: harness.runtimeRoot,
      now: fixedNow,
      validateRelease: (releaseRoot) => harness.validateRelease(releaseRoot),
      readDecision: async (request) => {
        phases.push(request.op);
        if (request.op === "commit") {
          await expect(acquireLiveOperationCoordinator({
            dataDir: harness.runtimeRoot,
            ownerKind: "mcp",
          })).rejects.toThrow("LIVE_RUNTIME_BUSY");
        }
        return recoveryReceipt(request);
      },
    });
    expect(phases).toEqual(["precheck", "commit"]);
    await expect(harness.currentVersion()).resolves.toBe("first");
  });

  it("leaves no owner artifact after a SIGKILL following journal archival", async () => {
    const harness = await safetyHarness();
    await crashTransaction(harness, "journal-archived");
    await expect(lstat(path.join(harness.runtimeRoot, "state", "release-transaction.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    const live = await acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    });
    await live.close();
    await expect(harness.manager.recoverReleaseTransaction({
      runtimeRoot: harness.runtimeRoot,
      now: fixedNow,
      validateRelease: (releaseRoot) => harness.validateRelease(releaseRoot),
      readDecision: recoveryDecisionReader(),
    })).rejects.toThrow("RELEASE_TRANSACTION_NOT_FOUND");
  });
});

function fixedNow(): Date {
  return new Date("2026-08-21T02:00:30.000Z");
}

function recoveryDecisionReader(): (request: RecoveryDecisionRequest) => Promise<string> {
  return (request) => Promise.resolve(recoveryReceipt(request));
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

async function safetyHarness(): Promise<SafetyHarness> {
  const payload = await loadPayloadModule();
  const manager = await loadReleaseManagerModule();
  const root = await temporaryRoot("release safety with spaces-");
  const runtimeRoot = path.join(root, "Desktop", "聊天助手");
  await mkdir(runtimeRoot, { recursive: true });
  await chmod(runtimeRoot, 0o700);
  let sequence = 0;
  const validateRelease = (releaseRoot: string) => payload.validatePayloadManifest({
    payloadRoot: releaseRoot,
  });
  return {
    manager,
    payload,
    root,
    runtimeRoot,
    validateRelease,
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
        provenance: { fixture: "release-packaging-safety", version },
      });
      await chmod(candidateRoot, 0o555);
      return candidateRoot;
    },
    install: (candidateRoot, decision = decisionBundle(), hook) => manager
      .installValidatedCandidate({
        runtimeRoot,
        candidateRoot,
        automationId: "automation",
        now: fixedNow,
        validateRelease,
        session: decision.session,
        decisionLines: decision.lines,
        hook,
      }),
    currentVersion: () => pointerVersion(runtimeRoot, "bin"),
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

function decisionBundle(): DecisionBundle {
  const session: DecisionSession = {
    txid: crypto.randomUUID(),
    maintenanceNonce: crypto.randomUUID(),
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
        session,
        session.precheckRequestId,
        session.precheckObservationId,
        "2026-08-21T02:00:05.000Z",
      ),
      decisionLine(
        "commit",
        session,
        session.commitRequestId,
        session.commitObservationId,
        "2026-08-21T02:00:20.000Z",
      ),
    ],
  };
}

function decisionLine(
  op: "precheck" | "commit",
  session: DecisionSession,
  requestId: string,
  observationId: string,
  observedAt: string,
): string {
  return JSON.stringify({
    op,
    txid: session.txid,
    maintenanceNonce: session.maintenanceNonce,
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

function mutateReceipt(
  bundle: DecisionBundle,
  index: 0 | 1,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>,
): void {
  bundle.lines[index] = JSON.stringify(mutate(parseObject(bundle.lines[index])));
}

function mutateObservation(
  bundle: DecisionBundle,
  index: 0 | 1,
  fields: Record<string, unknown>,
): void {
  mutateReceipt(bundle, index, (value) => ({
    ...value,
    automationObservation: {
      ...parseObject(value.automationObservation),
      ...fields,
    },
  }));
}

function receiptObservation(serialized: string): Record<string, unknown> {
  return parseObject(parseObject(serialized).automationObservation);
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("EXPECTED_TEST_OBJECT");
  }
  return parsed as Record<string, unknown>;
}

async function crashTransaction(
  harness: SafetyHarness,
  crashPhase: "previous-prepared" | "current-switched" | "journal-archived",
): Promise<{ decision: DecisionBundle; lockPath: string }> {
  await harness.install(await harness.candidate("first"));
  const candidateRoot = await harness.candidate("crash");
  const decision = decisionBundle();
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, "tests", "fixtures", "release-transaction-crash.mjs")],
    {
      cwd: harness.root,
      env: {
        HOME: path.join(harness.root, "child home"),
        LANG: "en_US.UTF-8",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(JSON.stringify({
    runtimeRoot: harness.runtimeRoot,
    candidateRoot,
    decisionLines: decision.lines,
    session: decision.session,
    automationId: "automation",
    now: fixedNow().toISOString(),
    crashPhase,
  }));
  const line = await readChildLine(child);
  expect(JSON.parse(line)).toEqual({ phase: crashPhase });
  child.kill("SIGKILL");
  await once(child, "exit");
  return {
    decision,
    lockPath: path.join(harness.runtimeRoot, "state", "live-operation.lock"),
  };
}

async function readChildLine(child: ReturnType<typeof spawn>): Promise<string> {
  if (child.stdout === null || child.stderr === null) throw new Error("CHILD_PIPE_REQUIRED");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  try {
    const result = await Promise.race([
      iterator.next(),
      once(child, "exit").then(() => ({ done: true, value: undefined })),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("CRASH_CHILD_TIMEOUT")), 2_000);
      }),
    ]);
    if (result.done || typeof result.value !== "string") {
      throw new Error(`CRASH_CHILD_EXITED:${Buffer.concat(stderrChunks).toString("utf8")}`);
    }
    return result.value;
  } finally {
    lines.close();
  }
}

async function pointerVersion(runtimeRoot: string, pointerName: string): Promise<string> {
  const pointer = path.join(runtimeRoot, pointerName);
  const target = await readlink(pointer);
  return (await readFile(
    path.join(path.resolve(path.dirname(pointer), target), "version.txt"),
    "utf8",
  )).trim();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise(value);
    },
  };
}

async function settlesWithin(promise: Promise<unknown>): Promise<"SETTLED"> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("TEST_DEADLINE_EXCEEDED")), 1_000);
  });
  try {
    await Promise.race([promise, deadline]);
    return "SETTLED";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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

async function loadReleaseManagerModule(cacheBust?: string): Promise<ReleaseManagerModule> {
  const base = pathToFileURL(path.join(projectRoot, "scripts", "release-manager.mjs")).href;
  const url = cacheBust === undefined ? base : `${base}?instance=${cacheBust}`;
  const loaded: unknown = await import(url);
  return loaded as ReleaseManagerModule;
}
