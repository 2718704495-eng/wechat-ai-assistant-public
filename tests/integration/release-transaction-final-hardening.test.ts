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
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { acquireLiveOperationCoordinator } from "../../src/mcp/live-operation-coordinator.js";

type TransactionPhase =
  | "maintenance-staged"
  | "candidate-root-thawed"
  | "candidate-renamed"
  | "previous-prepared"
  | "current-switched"
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

interface RecoveryDecisionRequest {
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
  }): Promise<{ manifestSha256: string }>;
  validatePayloadManifest(options: {
    payloadRoot: string;
  }): Promise<{ manifestSha256: string }>;
}

interface TransactionOptions {
  runtimeRoot: string;
  candidateRoot: string;
  decisionLines: string[];
  session: DecisionSession;
  automationId: "automation";
  now(): Date;
  validateRelease(releaseRoot: string): Promise<{ manifestSha256: string }>;
  hook?(phase: TransactionPhase): Promise<void> | void;
}

interface ReleaseManagerModule {
  installValidatedCandidate(options: TransactionOptions): Promise<unknown>;
  rollbackValidatedRelease(options: {
    runtimeRoot: string;
    automationId: "automation";
    now(): Date;
    validateRelease(releaseRoot: string): Promise<{ manifestSha256: string }>;
    readDecision(request: RecoveryDecisionRequest): Promise<string>;
  }): Promise<unknown>;
  recoverReleaseTransaction(options: {
    runtimeRoot: string;
    now(): Date;
    validateRelease(releaseRoot: string): Promise<{ manifestSha256: string }>;
    readDecision(request: RecoveryDecisionRequest): Promise<string>;
    inspectOwnerIdentity?(owner: {
      pid: number;
      processStartedAt: string;
    }): Promise<OwnerIdentity>;
  }): Promise<unknown>;
}

interface Harness {
  manager: ReleaseManagerModule;
  payload: PayloadModule;
  root: string;
  runtimeRoot: string;
  candidate(version: string): Promise<string>;
  install(
    candidateRoot: string,
    hook?: TransactionOptions["hook"],
    decision?: DecisionBundle,
  ): Promise<unknown>;
  validateRelease(releaseRoot: string): Promise<{ manifestSha256: string }>;
  currentVersion(): Promise<string>;
}

const projectRoot = process.cwd();
const fixedTime = "2026-08-21T02:00:30.000Z";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((root) => makeTreeWritable(root)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release transaction final crash hardening", () => {
  it("recovers a crash before maintenance without creating a staged marker", async () => {
    const harness = await createHarness();
    await crashInstall(harness, "maintenance-staged");
    const stateDirectory = path.join(harness.runtimeRoot, "state");
    const stagedNames = (await readdir(stateDirectory))
      .filter((name) => name.endsWith(".staged"));
    expect(stagedNames).toHaveLength(0);
    await expect(acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    })).rejects.toThrow("RELEASE_RUNTIME_QUARANTINED");

    await expect(recover(harness)).resolves.toMatchObject({ recovered: true });

    await expect(harness.currentVersion()).resolves.toBe("first");
  });

  it("durably records rollback maintenance ownership before commit approval", async () => {
    const harness = await createHarness();
    await harness.install(await harness.candidate("first"));
    await harness.install(await harness.candidate("second"));
    const beforeCurrent = await readlink(path.join(harness.runtimeRoot, "bin"));
    const beforePrevious = await readlink(path.join(harness.runtimeRoot, "bin.previous"));
    let signalCommitRequested: (() => void) | undefined;
    const commitRequested = new Promise<void>((resolve) => {
      signalCommitRequested = resolve;
    });
    let rejectCommit: ((error: Error) => void) | undefined;
    const blockedCommit = new Promise<string>((_resolve, reject) => {
      rejectCommit = reject;
    });
    const operation = harness.manager.rollbackValidatedRelease({
      runtimeRoot: harness.runtimeRoot,
      automationId: "automation",
      now: fixedNow,
      validateRelease: (releaseRoot) => harness.validateRelease(releaseRoot),
      readDecision: (request) => {
        if (request.op === "precheck") {
          return Promise.resolve(recoveryReceipt(request));
        }
        signalCommitRequested?.();
        return blockedCommit;
      },
    });

    await commitRequested;
    const journal = parseObject(await readFile(
      path.join(harness.runtimeRoot, "state", "release-transaction.json"),
      "utf8",
    ));
    const maintenance = objectValue(journal.maintenanceLease);
    const maintenancePath = path.join(
      harness.runtimeRoot,
      ...String(maintenance.path).split("/"),
    );
    const marker = await lstat(maintenancePath);
    expect(journal).toMatchObject({ operation: "rollback", phase: "awaiting-commit" });
    expect(maintenance).toMatchObject({
      device: String(marker.dev),
      inode: String(marker.ino),
    });
    await expect(readlink(path.join(harness.runtimeRoot, "bin"))).resolves.toBe(beforeCurrent);
    await expect(readlink(path.join(harness.runtimeRoot, "bin.previous")))
      .resolves.toBe(beforePrevious);

    rejectCommit?.(new Error("TEST_ABORT_ROLLBACK"));
    await expect(operation).rejects.toThrow("TEST_ABORT_ROLLBACK");
  });

  it.each([
    "candidate-root-thawed",
    "candidate-renamed",
  ] as const)("refreezes and validates the candidate after %s SIGKILL", async (crashPhase) => {
    const harness = await createHarness();
    await crashInstall(harness, crashPhase);
    const journal = parseObject(await readFile(
      path.join(harness.runtimeRoot, "state", "release-transaction.json"),
      "utf8",
    ));
    const stagingRoot = path.resolve(
      harness.runtimeRoot,
      String(journal.candidateStagingTarget),
    );
    const candidate = objectValue(journal.candidate);
    const releaseRoot = path.resolve(harness.runtimeRoot, String(candidate.target));
    const observedRoot = crashPhase === "candidate-root-thawed" ? stagingRoot : releaseRoot;
    expect((await lstat(observedRoot)).mode & 0o777).toBe(0o755);

    await expect(recover(harness)).resolves.toMatchObject({ recovered: true });

    expect((await lstat(observedRoot)).mode & 0o777).toBe(0o555);
    await expect(harness.validateRelease(observedRoot)).resolves.toMatchObject({
      manifestSha256: candidate.manifestSha256,
    });
    await expect(harness.currentVersion()).resolves.toBe("first");
  });

  it("rejects candidate-moving recovery when both or neither exact path exists", async () => {
    const both = await createHarness();
    await crashInstall(both, "candidate-root-thawed");
    const bothJournal = parseObject(await readFile(
      path.join(both.runtimeRoot, "state", "release-transaction.json"),
      "utf8",
    ));
    const bothCandidate = objectValue(bothJournal.candidate);
    const unexpectedRelease = path.resolve(both.runtimeRoot, String(bothCandidate.target));
    await mkdir(unexpectedRelease);
    await chmod(unexpectedRelease, 0o555);
    await expect(recover(both)).rejects.toThrow("RELEASE_CANDIDATE_MOVE_AMBIGUOUS");
    await expect(both.currentVersion()).resolves.toBe("first");

    const neither = await createHarness();
    await crashInstall(neither, "candidate-root-thawed");
    const neitherJournal = parseObject(await readFile(
      path.join(neither.runtimeRoot, "state", "release-transaction.json"),
      "utf8",
    ));
    const stagingRoot = path.resolve(
      neither.runtimeRoot,
      String(neitherJournal.candidateStagingTarget),
    );
    const quarantineRoot = path.join(neither.runtimeRoot, ".releases", ".quarantine");
    await rename(stagingRoot, quarantineRoot);
    await expect(recover(neither)).rejects.toThrow("RELEASE_CANDIDATE_MOVE_AMBIGUOUS");
    await expect(neither.currentVersion()).resolves.toBe("first");
  });

  it("durably records maintenance ownership before waiting for commit approval", async () => {
    const harness = await createHarness();
    await harness.install(await harness.candidate("first"));
    const candidateRoot = await harness.candidate("blocked-before-journal");
    const beforeCurrent = await readlink(path.join(harness.runtimeRoot, "bin"));
    const child = spawnCommitWaiter(harness, candidateRoot);

    try {
      await expect(readChildLine(child)).resolves.toBe("commit-requested");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }

    expect((await lstat(
      path.join(harness.runtimeRoot, "state", "release-transaction.json"),
    )).isFile()).toBe(true);
    expect((await lstat(candidateRoot)).isDirectory()).toBe(true);
    await expect(readlink(path.join(harness.runtimeRoot, "bin"))).resolves.toBe(beforeCurrent);

    await expect(recover(harness)).resolves.toMatchObject({ recovered: true });
    await expect(harness.currentVersion()).resolves.toBe("first");
    const liveAfterRecovery = await acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    });
    await liveAfterRecovery.close();
  });

  it("releases kernel ownership when a process is SIGKILLed after journal archival", async () => {
    const harness = await createHarness();
    const crashed = await crashInstall(harness, "journal-archived");
    const liveAfterArchive = await acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    });
    await liveAfterArchive.close();
    await expect(recover(harness)).rejects.toThrow("RELEASE_TRANSACTION_NOT_FOUND");
    await expect(harness.currentVersion()).resolves.toBe("crash");
    expect((await readdir(path.join(
      harness.runtimeRoot,
      "state",
      "release-transaction-archive",
    ))).some((name) => name.startsWith(crashed.txid))).toBe(true);
  });

  it("rejects pointer drift that is not legal for the journal phase", async () => {
    const harness = await createHarness();
    await crashInstall(harness, "previous-prepared");
    const externalRoot = await harness.candidate("external-drift");
    const externalReleaseName = `${"a".repeat(16)}-${crypto.randomUUID()}`;
    const externalRelease = path.join(
      harness.runtimeRoot,
      ".releases",
      externalReleaseName,
    );
    await chmod(externalRoot, 0o755);
    await rename(externalRoot, externalRelease);
    await chmod(externalRelease, 0o555);
    const currentPath = path.join(harness.runtimeRoot, "bin");
    const externalTarget = path.posix.join(".releases", externalReleaseName);
    await unlink(currentPath);
    await symlink(externalTarget, currentPath);

    await expect(recover(harness)).rejects.toThrow("RELEASE_POINTER_STATE_AMBIGUOUS");

    await expect(readlink(currentPath)).resolves.toBe(externalTarget);
    await expect(harness.currentVersion()).resolves.toBe("external-drift");
    await expect(acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    })).rejects.toThrow("RELEASE_RUNTIME_QUARANTINED");
  });

  it("refuses to archive a journal that differs outside txid and nonce", async () => {
    const harness = await createHarness();
    await harness.install(await harness.candidate("first"));
    const candidate = await harness.candidate("tampered-journal");
    const decision = decisionBundle();
    const journalPath = path.join(
      harness.runtimeRoot,
      "state",
      "release-transaction.json",
    );

    await expect(harness.install(candidate, async (phase) => {
      if (phase !== "current-switched") return;
      const journal = parseObject(await readFile(journalPath, "utf8"));
      journal.phase = "previous-prepared";
      await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");
    }, decision)).rejects.toThrow("RELEASE_MUTATION_CAPABILITY_INVALID");

    expect((await lstat(journalPath)).isFile()).toBe(true);
    const archiveDirectory = path.join(
      harness.runtimeRoot,
      "state",
      "release-transaction-archive",
    );
    const archiveNames = await readdir(archiveDirectory).catch(() => [] as string[]);
    expect(archiveNames).not.toContain(`${decision.session.txid}-install.json`);
  });
});

async function createHarness(): Promise<Harness> {
  const manager = await loadReleaseManagerModule();
  const payload = await loadPayloadModule();
  const root = await temporaryRoot("release final hardening with spaces-");
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
        provenance: { fixture: "release-transaction-final-hardening", version },
      });
      await chmod(candidateRoot, 0o555);
      return candidateRoot;
    },
    install: (candidateRoot, hook, decision = decisionBundle()) => {
      return manager.installValidatedCandidate({
        runtimeRoot,
        candidateRoot,
        automationId: "automation",
        now: fixedNow,
        validateRelease,
        session: decision.session,
        decisionLines: decision.lines,
        hook,
      });
    },
    validateRelease,
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

function spawnCommitWaiter(harness: Harness, candidateRoot: string): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", commitWaiterSource], {
    cwd: harness.root,
    env: isolatedEnvironment(harness.root),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({
    projectRoot,
    runtimeRoot: harness.runtimeRoot,
    candidateRoot,
    now: fixedTime,
  }));
  return child;
}

const commitWaiterSource = String.raw`
import path from "node:path";
import { pathToFileURL } from "node:url";
let serialized = "";
for await (const chunk of process.stdin) serialized += chunk;
const options = JSON.parse(serialized);
const manager = await import(pathToFileURL(path.join(options.projectRoot, "scripts", "release-manager.mjs")).href);
const payload = await import(pathToFileURL(path.join(options.projectRoot, "scripts", "release-payload.mjs")).href);
const receipt = (request) => JSON.stringify({
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
await manager.installValidatedCandidate({
  runtimeRoot: options.runtimeRoot,
  candidateRoot: options.candidateRoot,
  automationId: "automation",
  now: () => new Date(options.now),
  validateRelease: (releaseRoot) => payload.validatePayloadManifest({ payloadRoot: releaseRoot }),
  readDecision: async (request) => {
    if (request.op === "precheck") return receipt(request);
    process.stdout.write("commit-requested\n");
    await new Promise(() => undefined);
  },
});
`;

async function crashInstall(
  harness: Harness,
  crashPhase: TransactionPhase,
): Promise<DecisionSession> {
  if (await pointerMissing(harness.runtimeRoot)) {
    await harness.install(await harness.candidate("first"));
  }
  const candidateRoot = await harness.candidate("crash");
  const decision = decisionBundle();
  const child = spawn(
    process.execPath,
    [path.join(projectRoot, "tests", "fixtures", "release-transaction-crash.mjs")],
    {
      cwd: harness.root,
      env: isolatedEnvironment(harness.root),
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
    now: fixedTime,
    crashPhase,
  }));
  await expect(readChildLine(child)).resolves.toBe(JSON.stringify({ phase: crashPhase }));
  child.kill("SIGKILL");
  await once(child, "exit");
  return decision.session;
}

async function recover(harness: Harness): Promise<unknown> {
  return harness.manager.recoverReleaseTransaction({
    runtimeRoot: harness.runtimeRoot,
    now: fixedNow,
    validateRelease: (releaseRoot) => harness.validateRelease(releaseRoot),
    inspectOwnerIdentity: () => Promise.resolve("dead"),
    readDecision: (request) => Promise.resolve(recoveryReceipt(request)),
  });
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
      decisionLine("precheck", session, "2026-08-21T02:00:05.000Z"),
      decisionLine("commit", session, "2026-08-21T02:00:20.000Z"),
    ],
  };
}

function decisionLine(
  op: "precheck" | "commit",
  session: DecisionSession,
  observedAt: string,
): string {
  const capitalized = op === "precheck" ? "precheck" : "commit";
  return JSON.stringify({
    op,
    txid: session.txid,
    maintenanceNonce: session.maintenanceNonce,
    automationObservation: {
      requestId: session[`${capitalized}RequestId`],
      observationId: session[`${capitalized}ObservationId`],
      automationId: "automation",
      targetCount: 1,
      status: "PAUSED",
      observedAt,
    },
  });
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

async function pointerMissing(runtimeRoot: string): Promise<boolean> {
  try {
    await lstat(path.join(runtimeRoot, "bin"));
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
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

function parseObject(serialized: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(serialized);
  return objectValue(parsed);
}

function objectValue(parsed: unknown): Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("EXPECTED_TEST_OBJECT");
  }
  return parsed as Record<string, unknown>;
}

function fixedNow(): Date {
  return new Date(fixedTime);
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    HOME: path.join(root, "child HOME"),
    LANG: "en_US.UTF-8",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
