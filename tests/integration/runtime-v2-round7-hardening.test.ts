import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateBroadcastCandidate } from "../../src/daily-care/message-policy.js";
import { createDailyCareProductionRuntime } from "../../src/mcp/daily-care-runtime.js";
import { createFixedHeartbeatSupervisor } from
  "../../src/mcp/fixed-heartbeat-supervisor.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { DailyCareBroadcastRepository } from
  "../../src/storage/daily-care-broadcast-repository.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

const cleanups: Array<() => Promise<void>> = [];
const temporaryRoots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("runtime-v2 Fix Round 7 hardening", () => {
  it("makes a new operation await durable close intent before rejecting it", async () => {
    let persistBarrier: (() => void) | undefined;
    const barrierPending = new Promise<void>((resolve) => { persistBarrier = resolve; });
    const repository = {
      assertClear: vi.fn().mockResolvedValue(undefined),
      beginTerminalBarrier: vi.fn(() => barrierPending),
      clearTerminalBarrier: vi.fn().mockResolvedValue(undefined),
      quarantine: vi.fn().mockResolvedValue(undefined),
    };
    const { supervisor, client } = await connectedSupervisor(repository, {
      close: vi.fn().mockResolvedValue(undefined),
    });
    cleanups.push(() => closeSupervisor(supervisor, client, persistBarrier));

    await client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    const closing = client.callTool({ name: "close", arguments: {} });
    void closing.catch(() => undefined);
    await vi.waitFor(() => expect(repository.beginTerminalBarrier).toHaveBeenCalledTimes(1));

    let operationSettled = false;
    const operation = client.callTool({ name: "verify-send", arguments: {} })
      .finally(() => { operationSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(operationSettled).toBe(false);

    persistBarrier?.();
    expect((await operation).isError).toBe(true);
    expect((await closing).isError).not.toBe(true);
  });

  it("keeps the terminal barrier through the real owner release and clears last", async () => {
    const events: string[] = [];
    const repository = {
      assertClear: vi.fn().mockResolvedValue(undefined),
      beginTerminalBarrier: vi.fn(() => {
        events.push("barrier-durable");
        return Promise.resolve();
      }),
      clearTerminalBarrier: vi.fn(() => {
        events.push("barrier-clear");
        return Promise.resolve();
      }),
      quarantine: vi.fn().mockResolvedValue(undefined),
    };
    const { supervisor, client } = await connectedSupervisor(repository, {
      close: vi.fn(() => {
        events.push("owner-release");
        return Promise.resolve();
      }),
    }, () => {
      events.push("outcome-durable");
      return Promise.resolve();
    });
    cleanups.push(() => closeSupervisor(supervisor, client));

    await client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    expect((await client.callTool({ name: "close", arguments: {} })).isError).not.toBe(true);
    expect(events).toEqual([
      "barrier-durable",
      "outcome-durable",
      "owner-release",
      "barrier-clear",
    ]);
  });

  it("does not reject a new operation or release the owner until barrier failure is known", async () => {
    let rejectBarrier: ((error: Error) => void) | undefined;
    const barrierPending = new Promise<void>((_resolve, reject) => { rejectBarrier = reject; });
    const closeOwner = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(undefined);
    const repository = {
      assertClear: vi.fn().mockResolvedValue(undefined),
      beginTerminalBarrier: vi.fn(() => barrierPending),
      clearTerminalBarrier: vi.fn().mockResolvedValue(undefined),
      quarantine: vi.fn().mockResolvedValue(undefined),
    };
    const { supervisor, client } = await connectedSupervisor(
      repository,
      { close: closeOwner },
      complete,
    );
    cleanups.push(() => closeSupervisor(supervisor, client, () => {
      rejectBarrier?.(new Error("BARRIER_DURABILITY_INJECTED"));
    }));
    await client.callTool({ name: "begin-scheduled-tick", arguments: {} });
    const closing = client.callTool({ name: "close", arguments: {} });
    void closing.catch(() => undefined);
    await vi.waitFor(() => expect(repository.beginTerminalBarrier).toHaveBeenCalledTimes(1));
    let operationSettled = false;
    const operation = client.callTool({ name: "verify-send", arguments: {} })
      .finally(() => { operationSettled = true; });
    await Promise.resolve();
    expect(operationSettled).toBe(false);

    rejectBarrier?.(new Error("BARRIER_DURABILITY_INJECTED"));
    expect((await operation).isError).toBe(true);
    expect((await closing).isError).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(closeOwner).not.toHaveBeenCalled();
  });

  it.each(["owner-close", "barrier-clear"] as const)(
    "does not make a successor UI-admissible after %s failure",
    async (failure) => {
      let barrierActive = false;
      let quarantined = false;
      const repository = {
        assertClear: vi.fn(() => barrierActive || quarantined
          ? Promise.reject(new Error("FIXED_HEARTBEAT_DURABLE_QUARANTINE"))
          : Promise.resolve()),
        beginTerminalBarrier: vi.fn(() => {
          barrierActive = true;
          return Promise.resolve();
        }),
        clearTerminalBarrier: vi.fn(() => {
          if (failure === "barrier-clear") {
            return Promise.reject(new Error("BARRIER_CLEAR_INJECTED"));
          }
          barrierActive = false;
          return Promise.resolve();
        }),
        quarantine: vi.fn(() => {
          quarantined = true;
          return Promise.resolve();
        }),
      };
      const { supervisor, client } = await connectedSupervisor(repository, {
        close: failure === "owner-close"
          ? vi.fn().mockRejectedValue(new Error("OWNER_CLOSE_INJECTED"))
          : vi.fn().mockResolvedValue(undefined),
      });
      cleanups.push(() => closeSupervisor(supervisor, client));
      await client.callTool({ name: "begin-scheduled-tick", arguments: {} });
      expect((await client.callTool({ name: "close", arguments: {} })).isError).toBe(true);

      const factory = vi.fn().mockRejectedValue(new Error("MUST_NOT_RUN"));
      const successor = createFixedHeartbeatSupervisor({
        selectScheduledLane: vi.fn().mockResolvedValue("p1"),
        beginScheduledTick: factory,
      }, {
        quarantineRepository: repository,
        releaseSha256: "7".repeat(64),
      });
      const successorClient = new Client({ name: "round7-successor", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        successor.server.connect(serverTransport),
        successorClient.connect(clientTransport),
      ]);
      cleanups.push(async () => {
        await successor.shutdown().catch(() => undefined);
        await Promise.allSettled([successorClient.close(), successor.server.close()]);
      });
      expect((await successorClient.callTool({
        name: "begin-scheduled-tick", arguments: {},
      })).isError).toBe(true);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it.each([
    "barrier-deferred",
    "barrier-fail",
    "owner-close-fail",
    "barrier-clear-fail",
  ] as const)(
    "keeps a real successor at UI zero during %s",
    async (failure) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `round7-${failure}-`));
      temporaryRoots.push(root);
      await initializeTestKernelLockCatalog(root);
      const marker = path.join(root, "owner");
      const allow = path.join(root, "allow-owner-exit");
      const owner = spawnRound7TerminalWorker({
        mode: "owner", root, marker, allow, failure,
      });
      await waitForPath(`${marker}.failure-stage`);
      await waitForPath(path.join(root, "state", "fixed-heartbeat-terminal-barrier.json"));

      const successorMarker = path.join(root, "successor");
      const successor = spawnRound7TerminalWorker({
        mode: "successor", root, marker: successorMarker, allow, failure,
      });
      await expectChildSuccess(successor);
      await expect(readFile(successorMarker, "utf8")).resolves.toBe("blocked\n");
      expect(await exists(`${successorMarker}.ui`)).toBe(false);

      await writeFile(allow, "continue\n", { flag: "wx", mode: 0o600 });
      await expectChildSuccess(owner);
    },
    30_000,
  );

  it("opens and binds candidate inputs before validation and never loads an addon by source pathname", async () => {
    const [installer, kernelLoader] = await Promise.all([
      readFile("scripts/runtime-v2-clean-install.mjs", "utf8"),
      readFile("src/storage/kernel-lock.ts", "utf8"),
    ]);
    expect(installer).toContain("openBoundCandidateInput");
    expect(installer.indexOf("openBoundCandidateInput"))
      .toBeLessThan(installer.indexOf("validatePayloadInFreshProcess"));
    expect(installer.indexOf("openBoundCandidateInput"))
      .toBeLessThan(installer.indexOf("loadInstallerAddon"));
    expect(installer).not.toContain("copyPayloadTree(candidateRoot");
    expect(installer).not.toContain("nativeRequire(");
    expect(installer).toContain("process.dlopen");
    expect(installer).toContain("`/dev/fd/${addonHandle.fd}`");
    expect(kernelLoader).not.toContain("nativeRequire(");
    expect(kernelLoader).toContain("process.dlopen");
    expect(kernelLoader).toContain("`/dev/fd/${handle.fd}`");
  });

  it("rejects concrete action-object advice but permits harmless idioms without weather", () => {
    const base =
      "早呀，今日份的关心也准时送到啦。上班前先吃点东西，喝点温水，别空着肚子忙起来。路上不用太赶，给自己留一点从容，愿你今天顺顺利利，也记得照顾好身体。☀️💛\n——示例用户";
    for (const fragment of ["背上小包", "带上充电宝", "拿好钥匙", "装好耳机", "放包纸巾", "备个水杯"]) {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: base.replace("上班前", `${fragment}，上班前`),
        weather: null,
        recentVerifiedTexts: [],
      }), fragment).toThrow("BROADCAST_FALLBACK_WEATHER_FORBIDDEN");
    }
    for (const fragment of ["把烦恼放一放", "放下心事", "带着好心情"]) {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: base.replace("路上不用太赶", fragment),
        weather: null,
        recentVerifiedTexts: [],
      }), fragment).not.toThrow();
    }
  });

  it("reads bounded same-day context only for night and binds its proof to the candidate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "round7-context-"));
    temporaryRoots.push(root);
    await initializeTestKernelLockCatalog(root);
    const repository = new DailyCareBroadcastRepository(
      new EncryptedStore(root, new FixedKeyProvider(randomBytes(32))),
      () => new Date("2026-08-26T14:05:00.000Z"),
    );
    const readContext = vi.fn().mockResolvedValue({
      localDate: "2026-08-26",
      availability: "available" as const,
      explicitSignals: ["stated-discomfort"] as const,
      safeExcerpts: ["今天胃有点不舒服"],
      proofHash: "c".repeat(64),
    });
    const runtime = createDailyCareProductionRuntime({
      repository,
      surface: inertSurface(),
      researchWeather: vi.fn(),
      isStopped: vi.fn().mockResolvedValue(false),
      release: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-08-26T14:05:00.000Z"),
      readSameDayCareContext: readContext,
    });

    await expect(runtime.beginCurrentSlot()).resolves.toMatchObject({
      kind: "night",
      sameDayCareContext: {
        localDate: "2026-08-26",
        availability: "available",
        proofHash: "c".repeat(64),
      },
    });
    expect(readContext).toHaveBeenCalledWith({
      conversationId: "example-contact",
      localDate: "2026-08-26",
    });
    const nightBody =
      "想认真和你说声晚安。知道你今天胃有点不舒服，希望这会儿能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙";
    await runtime.prepareBroadcast(nightBody);
    await expect(repository.getSlot("2026-08-26/night")).resolves.toMatchObject({
      careContextProofHash: "c".repeat(64),
    });
  });

  it("does not read same-day context on morning and degrades read failure to unavailable", async () => {
    const morning = await createContextRuntime("2026-08-25T22:35:00.000Z", vi.fn());
    await expect(morning.runtime.beginCurrentSlot()).resolves.not.toHaveProperty(
      "sameDayCareContext.availability", "available",
    );
    expect(morning.readContext).not.toHaveBeenCalled();

    const failedReader = vi.fn().mockRejectedValue(new Error("PRIVATE_CONTEXT_READ_FAILURE"));
    const night = await createContextRuntime("2026-08-26T14:05:00.000Z", failedReader);
    const begun = await night.runtime.beginCurrentSlot();
    expect(begun).toMatchObject({
      sameDayCareContext: {
        localDate: "2026-08-26",
        availability: "unavailable",
        explicitSignals: [],
        safeExcerpts: [],
      },
    });
    expect(begun.sameDayCareContext?.proofHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(failedReader).toHaveBeenCalledTimes(1);
  });
});

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

async function connectedSupervisor(
  repository: {
    assertClear(): Promise<void>;
    beginTerminalBarrier(input: never): Promise<void>;
    clearTerminalBarrier(input: never): Promise<void>;
    quarantine(input: never): Promise<void>;
  },
  runtime: { close(): Promise<void> },
  complete: () => Promise<void> = () => Promise.resolve(),
) {
  const supervisor = createFixedHeartbeatSupervisor({
    selectScheduledLane: vi.fn().mockResolvedValue("p1"),
    beginScheduledTick: vi.fn().mockResolvedValue({
      lane: "p1",
      cycleId: "77777777-7777-4777-8777-777777777777",
      runtime: { dependencies: passiveDependencies(), close: () => runtime.close() },
      complete,
    }),
  }, { quarantineRepository: repository, releaseSha256: "7".repeat(64) });
  const client = new Client({ name: "round7", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([supervisor.server.connect(serverTransport), client.connect(clientTransport)]);
  return { supervisor, client };
}

async function closeSupervisor(
  supervisor: ReturnType<typeof createFixedHeartbeatSupervisor>,
  client: Client,
  settle?: () => void,
): Promise<void> {
  settle?.();
  await supervisor.shutdown().catch(() => undefined);
  await Promise.allSettled([client.close(), supervisor.server.close()]);
}

function passiveDependencies() {
  return {
    readTargetDirectForSupervisor: vi.fn().mockResolvedValue({
      publicResult: { replyDecision: { action: "wait" } },
      controlProof: null,
      proof: null,
    }),
    verifySend: vi.fn().mockResolvedValue({ status: "verified" }),
  } as never;
}

function inertSurface() {
  let draft = "";
  return {
    locateConversation: vi.fn().mockImplementation(() => Promise.resolve({
      conversationId: "example-contact",
      identity: {
        conversationId: "example-contact",
        visibleName: "示例联系人",
        avatarFingerprint: "a".repeat(64),
        recentMessageFingerprint: "b".repeat(64),
        confidence: 0.99,
      },
      messages: [],
      draftText: draft,
      composerEvidence: draft === "" ? "proven-empty" : "meaningful-content",
      unreadIndicator: false,
      windowRevision: "round7",
    })),
    focusConversation: vi.fn(),
    replaceDraft: vi.fn().mockImplementation((_id: string, text: string) => { draft = text; }),
    clearDraft: vi.fn().mockImplementation(() => { draft = ""; }),
    submitDraft: vi.fn(),
  };
}

async function createContextRuntime(at: string, readContext: ReturnType<typeof vi.fn>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "round7-context-"));
  temporaryRoots.push(root);
  await initializeTestKernelLockCatalog(root);
  const repository = new DailyCareBroadcastRepository(
    new EncryptedStore(root, new FixedKeyProvider(randomBytes(32))),
    () => new Date(at),
  );
  return {
    readContext,
    runtime: createDailyCareProductionRuntime({
      repository,
      surface: inertSurface(),
      researchWeather: vi.fn(),
      isStopped: vi.fn().mockResolvedValue(false),
      release: vi.fn().mockResolvedValue(undefined),
      now: () => new Date(at),
      readSameDayCareContext: readContext,
    } as never),
  };
}

function spawnRound7TerminalWorker(input: {
  mode: "owner" | "successor";
  root: string;
  marker: string;
  allow: string;
  failure: "barrier-deferred" | "barrier-fail" | "owner-close-fail" | "barrier-clear-fail";
}): ChildProcess {
  const child = spawn(process.execPath, [
    path.resolve("node_modules/vitest/vitest.mjs"),
    "run",
    path.resolve("tests/fixtures/runtime-v2-round7-terminal-worker.test.ts"),
    "--pool=threads",
    "--maxWorkers=1",
    "--reporter=dot",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUNTIME_V2_ROUND7_WORKER: "1",
      RUNTIME_V2_ROUND7_MODE: input.mode,
      RUNTIME_V2_ROUND7_ROOT: input.root,
      RUNTIME_V2_ROUND7_MARKER: input.marker,
      RUNTIME_V2_ROUND7_ALLOW: input.allow,
      RUNTIME_V2_ROUND7_FAILURE: input.failure,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function expectChildSuccess(child: ChildProcess): Promise<void> {
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  children.delete(child);
  if (code !== 0 || signal !== null) {
    throw new Error(`ROUND7_WORKER_FAILED:${String(code)}:${String(signal)}`);
  }
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await exists(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`ROUND7_WORKER_SIGNAL_MISSING:${path.basename(filePath)}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
