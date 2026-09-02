import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateBroadcastCandidate } from "../../src/daily-care/message-policy.js";
import { createFixedHeartbeatSupervisor } from
  "../../src/mcp/fixed-heartbeat-supervisor.js";
import { FileOperationQuarantineRepository } from
  "../../src/runtime-v2/operation-quarantine.js";

const temporaryRoots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("runtime-v2 Fix Round 8 hardening", () => {
  it("rolls back a failed barrier intent without poisoning the active cycle", async () => {
    let rejectBarrier: ((error: Error) => void) | undefined;
    const barrierAttempt = new Promise<void>((_resolve, reject) => { rejectBarrier = reject; });
    const complete = vi.fn().mockResolvedValue(undefined);
    const ownerClose = vi.fn().mockResolvedValue(undefined);
    const repository = {
      assertClear: vi.fn().mockResolvedValue(undefined),
      beginTerminalBarrier: vi.fn()
        .mockImplementationOnce(() => barrierAttempt)
        .mockResolvedValueOnce(undefined),
      clearTerminalBarrier: vi.fn().mockResolvedValue(undefined),
      quarantine: vi.fn().mockResolvedValue(undefined),
    };
    const { supervisor, client } = await connectedSupervisor(repository, ownerClose, complete);
    try {
      await client.callTool({ name: "begin-scheduled-tick", arguments: {} });
      const closing = client.callTool({ name: "close", arguments: {} });
      void closing.catch(() => undefined);
      await vi.waitFor(() => expect(repository.beginTerminalBarrier).toHaveBeenCalledTimes(1));

      let operationSettled = false;
      const waitingOperation = client.callTool({
        name: "prepare-latest-reply",
        arguments: { text: "测试候选" },
      })
        .finally(() => { operationSettled = true; });
      await Promise.resolve();
      expect(operationSettled).toBe(false);

      rejectBarrier?.(new Error("ROUND8_BARRIER_WRITE_FAILED"));
      expect((await closing).isError).toBe(true);
      expect((await waitingOperation).isError).not.toBe(true);
      expect(complete).not.toHaveBeenCalled();
      expect(ownerClose).not.toHaveBeenCalled();

      expect((await client.callTool({ name: "abort-draft", arguments: {} })).isError)
        .not.toBe(true);
      expect((await client.callTool({ name: "close", arguments: {} })).isError).not.toBe(true);
      expect(repository.beginTerminalBarrier).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(ownerClose).toHaveBeenCalledTimes(1);
    } finally {
      await supervisor.shutdown().catch(() => undefined);
      await Promise.allSettled([client.close(), supervisor.server.close()]);
    }
  });

  it("keeps a durable clear receipt after unlink succeeds but directory fsync fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "round8-clear-receipt-"));
    temporaryRoots.push(root);
    const barrier = {
      lane: "p1" as const,
      cycleId: "88888888-8888-4888-8888-888888888888",
      releaseSha256: "8".repeat(64),
      draftPending: false,
      submitUncertain: false,
    };
    let failed = false;
    const InjectableFileRepository = FileOperationQuarantineRepository as unknown as new (
      dataRoot: string,
      options: { syncDirectory(directory: string, stage: string): Promise<void> },
    ) => FileOperationQuarantineRepository;
    const owner = new InjectableFileRepository(root, {
      syncDirectory: (_directory: string, stage: string) => {
        if (stage === "barrier-unlinked" && !failed) {
          failed = true;
          return Promise.reject(new Error("ROUND8_DIRECTORY_FSYNC_FAILED"));
        }
        return Promise.resolve();
      },
    });
    await owner.beginTerminalBarrier(barrier);
    await expect(owner.clearTerminalBarrier(barrier)).rejects.toThrow(
      "ROUND8_DIRECTORY_FSYNC_FAILED",
    );
    await expect(access(path.join(
      root, "state", "fixed-heartbeat-terminal-barrier-clear-pending.json",
    ))).resolves.toBeUndefined();

    const marker = path.join(root, "successor");
    const child = spawnRound8Successor(root, marker);
    await expectChildSuccess(child);
    await expect(readFile(marker, "utf8")).resolves.toBe("blocked\n");
    await expect(access(`${marker}.ui`)).rejects.toMatchObject({ code: "ENOENT" });

    const recovery = new FileOperationQuarantineRepository(root);
    await expect(recovery.clearTerminalBarrier(barrier)).resolves.toBeUndefined();
    await expect(recovery.assertClear()).resolves.toBeUndefined();
  }, 30_000);

  it("detects long, inverted and punctuated weather-null action-object advice", () => {
    const base =
      "早呀，今日份的关心也准时送到啦。上班前先吃点东西，喝点温水，别空着肚子忙起来。路上不用太赶，给自己留一点从容，愿你今天顺顺利利，也记得照顾好身体。☀️💛\n——示例用户";
    for (const fragment of [
      "出门前记得带上那个平时放在桌边备用的小小充电宝",
      "雨伞，出门的时候最好还是随手带一下",
      "那件早晚方便保暖的薄外套——出门前可以先穿上",
      "钥匙……临走前别忘了顺手拿好",
    ]) {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: base.replace("路上不用太赶", fragment),
        weather: null,
        recentVerifiedTexts: [],
      }), fragment).toThrow("BROADCAST_FALLBACK_WEATHER_FORBIDDEN");
    }
    for (const fragment of ["把烦恼放一放", "带着好心情"]) {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: base.replace("路上不用太赶", fragment),
        weather: null,
        recentVerifiedTexts: [],
      }), fragment).not.toThrow();
    }
  });

  it("binds every night personal fact to a matching same-day signal", () => {
    const discomfort =
      "想认真和你说声晚安。知道你今天胃有点不舒服，希望这会儿能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙\n——示例用户";
    const general =
      "想认真和你说声晚安。无论今天过得怎样，都希望你这会儿能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙\n——示例用户";
    const unavailable = {
      localDate: "2026-08-26",
      availability: "unavailable" as const,
      explicitSignals: [],
      safeExcerpts: [],
      proofHash: "8".repeat(64),
    };
    const discomfortContext = {
      localDate: "2026-08-26",
      availability: "available" as const,
      explicitSignals: ["stated-discomfort" as const],
      safeExcerpts: ["今天胃有点不舒服"],
      proofHash: "9".repeat(64),
    };
    const fatigueOnly = {
      ...discomfortContext,
      explicitSignals: ["expressed-fatigue" as const],
      safeExcerpts: ["今天有点累"],
    };
    expect(() => validateBroadcastCandidate({
      kind: "night", text: discomfort, weather: null, recentVerifiedTexts: [],
      sameDayCareContext: unavailable,
    } as never)).toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateBroadcastCandidate({
      kind: "night", text: discomfort, weather: null, recentVerifiedTexts: [],
      sameDayCareContext: fatigueOnly,
    } as never)).toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateBroadcastCandidate({
      kind: "night", text: discomfort, weather: null, recentVerifiedTexts: [],
      sameDayCareContext: discomfortContext,
    } as never)).not.toThrow();
    expect(() => validateBroadcastCandidate({
      kind: "night", text: general, weather: null, recentVerifiedTexts: [],
      sameDayCareContext: unavailable,
    } as never)).not.toThrow();
  });
});

async function connectedSupervisor(
  repository: {
    assertClear(): Promise<void>;
    beginTerminalBarrier(input: never): Promise<void>;
    clearTerminalBarrier(input: never): Promise<void>;
    quarantine(input: never): Promise<void>;
  },
  ownerClose: () => Promise<void>,
  complete: () => Promise<void>,
) {
  const supervisor = createFixedHeartbeatSupervisor({
    selectScheduledLane: vi.fn().mockResolvedValue("p1"),
    beginScheduledTick: vi.fn().mockResolvedValue({
      lane: "p1",
      cycleId: "88888888-8888-4888-8888-888888888888",
      complete,
      runtime: {
        dependencies: {
          readTargetDirectForSupervisor: vi.fn().mockResolvedValue({
            publicResult: { replyDecision: { action: "wait" } },
            controlProof: {},
            proof: {},
          }),
          prepareLatestReplyForSupervisor: vi.fn().mockResolvedValue({ candidateToken: "token" }),
          abortPreparedDraftForSupervisor: vi.fn().mockResolvedValue({
            conversationId: "example-contact",
          }),
          verifySend: vi.fn().mockResolvedValue({ status: "verified" }),
        } as never,
        close: ownerClose,
      },
    }),
  }, { quarantineRepository: repository, releaseSha256: "8".repeat(64) });
  const client = new Client({ name: "round8", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([supervisor.server.connect(serverTransport), client.connect(clientTransport)]);
  return { supervisor, client };
}

function spawnRound8Successor(root: string, marker: string): ChildProcess {
  const child = spawn(process.execPath, [
    path.resolve("node_modules/vitest/vitest.mjs"),
    "run",
    path.resolve("tests/fixtures/runtime-v2-round8-quarantine-worker.test.ts"),
    "--pool=threads",
    "--maxWorkers=1",
    "--reporter=dot",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUNTIME_V2_ROUND8_WORKER: "1",
      RUNTIME_V2_ROUND8_ROOT: root,
      RUNTIME_V2_ROUND8_MARKER: marker,
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
    throw new Error(`ROUND8_WORKER_FAILED:${String(code)}:${String(signal)}`);
  }
}
