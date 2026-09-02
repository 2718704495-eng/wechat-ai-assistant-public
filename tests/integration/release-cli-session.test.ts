import crypto from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { acquireLiveOperationCoordinator } from "../../src/mcp/live-operation-coordinator.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

interface AutomationRequest {
  type: "automation-observation-request";
  phase: "precheck" | "commit";
  txid: string;
  maintenanceNonce: string;
  automationId: "automation";
  requestId: string;
  observationId: string;
  requestedAt: string;
}

interface SessionOperationContext {
  readDecision(request: AutomationRequest): Promise<string>;
}

interface CliSessionModule {
  runReleaseCliSession<T>(options: {
    input: Readable;
    output: Writable;
    decisionTimeoutMs?: number;
    operation(context: SessionOperationContext): Promise<T>;
  }): Promise<T>;
}

interface MaintenanceLease {
  release(): Promise<void>;
}

interface ManagerModule {
  acquireMaintenanceLease(options: {
    runtimeRoot: string;
    txid: string;
    maintenanceNonce: string;
  }): Promise<MaintenanceLease>;
}

interface SessionHarness {
  input: PassThrough;
  output: PassThrough;
  runtimeRoot: string;
  binPath: string;
  precheck: AutomationRequest;
  commitRequest(): AutomationRequest;
  run(options?: { decisionTimeoutMs?: number }): Promise<string>;
  nextRequest(): Promise<AutomationRequest>;
}

const projectRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release CLI decision sequencing", () => {
  it("requests precheck before locking and commit only after the persistent maintenance gate is held", async () => {
    const harness = await sessionHarness();
    let completed = false;
    const running = harness.run().finally(() => {
      completed = true;
    });

    const precheck = await harness.nextRequest();
    expect(precheck).toEqual(harness.precheck);
    const beforeMaintenance = await acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    });
    await beforeMaintenance.close();
    expect(completed).toBe(false);

    harness.input.write(`${receiptFor(precheck)}\n`);
    const commit = await harness.nextRequest();
    expect(commit).toEqual(harness.commitRequest());
    await expect(acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    })).rejects.toThrow("LIVE_RUNTIME_BUSY");
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("before\n");
    expect(completed).toBe(false);

    harness.input.write(`${receiptFor(commit)}\n`);
    await expect(running).resolves.toBe("committed");
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("after\n");
    const afterMaintenance = await acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    });
    await afterMaintenance.close();
  });

  it("fails closed on EOF before the precheck receipt", async () => {
    const harness = await sessionHarness();
    const running = harness.run();
    await harness.nextRequest();

    harness.input.end();

    await expect(running).rejects.toThrow("RELEASE_CLI_STDIN_CLOSED");
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("before\n");
    const live = await acquireLiveOperationCoordinator({ dataDir: harness.runtimeRoot, ownerKind: "cli" });
    await live.close();
  });

  it("fails closed on a bounded precheck decision timeout", async () => {
    const harness = await sessionHarness();
    const running = harness.run({ decisionTimeoutMs: 20 });
    await harness.nextRequest();

    await expect(Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("TEST_DECISION_TIMEOUT")), 250);
      }),
    ])).rejects.toThrow("RELEASE_CLI_DECISION_TIMEOUT");
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("before\n");
    const live = await acquireLiveOperationCoordinator({ dataDir: harness.runtimeRoot, ownerKind: "cli" });
    await live.close();
  });

  it("releases ordinary maintenance on a bounded commit decision timeout", async () => {
    const harness = await sessionHarness();
    const running = harness.run({ decisionTimeoutMs: 20 });
    const precheck = await harness.nextRequest();
    harness.input.write(`${receiptFor(precheck)}\n`);
    await harness.nextRequest();
    await expect(acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    })).rejects.toThrow("LIVE_RUNTIME_BUSY");

    await expect(Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("TEST_DECISION_TIMEOUT")), 250);
      }),
    ])).rejects.toThrow("RELEASE_CLI_DECISION_TIMEOUT");
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("before\n");
    const live = await acquireLiveOperationCoordinator({ dataDir: harness.runtimeRoot, ownerKind: "cli" });
    await live.close();
  });

  it("releases maintenance and preserves bin on EOF before the commit receipt", async () => {
    const harness = await sessionHarness();
    const running = harness.run();
    const precheck = await harness.nextRequest();
    harness.input.write(`${receiptFor(precheck)}\n`);
    await harness.nextRequest();
    await expect(acquireLiveOperationCoordinator({
      dataDir: harness.runtimeRoot,
      ownerKind: "cli",
    })).rejects.toThrow("LIVE_RUNTIME_BUSY");

    harness.input.end();

    await expect(running).rejects.toThrow("RELEASE_CLI_STDIN_CLOSED");
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("before\n");
    const live = await acquireLiveOperationCoordinator({ dataDir: harness.runtimeRoot, ownerKind: "cli" });
    await live.close();
  });

  it("rejects an extra line instead of carrying it into the commit decision", async () => {
    const harness = await sessionHarness();
    const running = harness.run();
    const precheck = await harness.nextRequest();

    harness.input.write(`${receiptFor(precheck)}\n{"extra":true}\n`);

    await expect(running).rejects.toThrow();
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("before\n");
    const live = await acquireLiveOperationCoordinator({ dataDir: harness.runtimeRoot, ownerKind: "cli" });
    await live.close();
  });

  it("rejects two receipts sent as one early batch", async () => {
    const harness = await sessionHarness();
    const running = harness.run();
    const precheck = await harness.nextRequest();
    const parsedReceipt: unknown = JSON.parse(receiptFor(precheck));
    const earlyCommit = {
      ...parseObject(parsedReceipt),
      op: "commit",
    };

    harness.input.write(
      `${receiptFor(precheck)}\n${JSON.stringify(earlyCommit)}\n`,
    );

    await expect(running).rejects.toThrow();
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("before\n");
    const live = await acquireLiveOperationCoordinator({ dataDir: harness.runtimeRoot, ownerKind: "cli" });
    await live.close();
  });

  it("rejects trailing input delivered after the final receipt", async () => {
    const harness = await sessionHarness();
    const running = harness.run();
    const precheck = await harness.nextRequest();
    harness.input.write(`${receiptFor(precheck)}\n`);
    const commit = await harness.nextRequest();

    harness.input.write(`${receiptFor(commit)}\n`);
    setImmediate(() => harness.input.write("{\"extra\":true}\n"));

    await expect(running).rejects.toThrow("RELEASE_CLI_UNSOLICITED_INPUT");
    await expect(readFile(harness.binPath, "utf8")).resolves.toBe("before\n");
    const live = await acquireLiveOperationCoordinator({ dataDir: harness.runtimeRoot, ownerKind: "cli" });
    await live.close();
  });
});

async function sessionHarness(): Promise<SessionHarness> {
  const [session, manager] = await Promise.all([
    loadCliSessionModule(),
    loadManagerModule(),
  ]);
  const root = await temporaryRoot("release CLI session with spaces-");
  const runtimeRoot = path.join(root, "Desktop", "聊天助手");
  await mkdir(runtimeRoot, { recursive: true });
  await chmod(runtimeRoot, 0o700);
  await initializeTestKernelLockCatalog(runtimeRoot);
  const binPath = path.join(runtimeRoot, "bin");
  await writeFile(binPath, "before\n");
  const input = new PassThrough();
  const output = new PassThrough();
  const txid = crypto.randomUUID();
  const maintenanceNonce = crypto.randomUUID();
  const precheck = request("precheck", txid, maintenanceNonce);
  let commit: AutomationRequest | null = null;
  let bufferedOutput = "";

  return {
    input,
    output,
    runtimeRoot,
    binPath,
    precheck,
    commitRequest: () => {
      if (commit === null) throw new Error("COMMIT_REQUEST_NOT_CREATED");
      return commit;
    },
    run: (options = {}) => session.runReleaseCliSession({
      input,
      output,
      ...options,
      operation: async (context) => {
        const precheckReceipt = await context.readDecision(precheck);
        expect(precheckReceipt).toBe(receiptFor(precheck));
        const lease = await manager.acquireMaintenanceLease({
          runtimeRoot,
          txid,
          maintenanceNonce,
        });
        try {
          commit = request("commit", txid, maintenanceNonce);
          const commitReceipt = await context.readDecision(commit);
          expect(commitReceipt).toBe(receiptFor(commit));
          await writeFile(binPath, "after\n");
          return "committed";
        } finally {
          await lease.release();
        }
      },
    }),
    nextRequest: async () => {
      const deadline = Date.now() + 1_000;
      while (true) {
        const chunk: unknown = output.read();
        if (Buffer.isBuffer(chunk)) bufferedOutput += chunk.toString("utf8");
        else if (typeof chunk === "string") bufferedOutput += chunk;
        const newline = bufferedOutput.indexOf("\n");
        if (newline >= 0) {
          const line = bufferedOutput.slice(0, newline);
          bufferedOutput = bufferedOutput.slice(newline + 1);
          return assertAutomationRequest(JSON.parse(line));
        }
        if (Date.now() >= deadline) throw new Error("CLI_REQUEST_DEADLINE_EXCEEDED");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

function request(
  phase: "precheck" | "commit",
  txid: string,
  maintenanceNonce: string,
): AutomationRequest {
  return {
    type: "automation-observation-request",
    phase,
    txid,
    maintenanceNonce,
    automationId: "automation",
    requestId: crypto.randomUUID(),
    observationId: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
  };
}

function receiptFor(request_: AutomationRequest): string {
  return JSON.stringify({
    op: request_.phase,
    txid: request_.txid,
    maintenanceNonce: request_.maintenanceNonce,
    automationObservation: {
      requestId: request_.requestId,
      observationId: request_.observationId,
      automationId: request_.automationId,
      targetCount: 1,
      status: "PAUSED",
      observedAt: request_.requestedAt,
    },
  });
}

function assertAutomationRequest(value: unknown): AutomationRequest {
  const record = parseObject(value);
  expect(Object.keys(record).sort()).toEqual([
    "automationId",
    "maintenanceNonce",
    "observationId",
    "phase",
    "requestId",
    "requestedAt",
    "txid",
    "type",
  ]);
  expect(record).toMatchObject({
    type: "automation-observation-request",
    automationId: "automation",
  });
  return record as unknown as AutomationRequest;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("EXPECTED_TEST_OBJECT");
  }
  return value as Record<string, unknown>;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function loadCliSessionModule(): Promise<CliSessionModule> {
  const url = pathToFileURL(path.join(projectRoot, "scripts", "release-cli-session.mjs")).href;
  const loaded: unknown = await import(url);
  return loaded as CliSessionModule;
}

async function loadManagerModule(): Promise<ManagerModule> {
  const url = pathToFileURL(path.join(projectRoot, "scripts", "release-manager.mjs")).href;
  const loaded: unknown = await import(url);
  return loaded as ManagerModule;
}
