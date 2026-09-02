import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";
import {
  AbortIntentRepository,
  AuditRepository,
  type ControlBoundaryCheckpoint,
  MessageRepository,
  PendingSendRepository,
  RealtimeReplyRepository,
  StateRepository,
} from "../../src/storage/repositories.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}

  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

class FailOnceEncryptedStore extends EncryptedStore {
  private failControlWrite = false;

  public armControlWriteFailure(): void {
    this.failControlWrite = true;
  }

  public override write<T>(relativePath: string, value: T): Promise<void> {
    if (this.failControlWrite && relativePath === "state/control.enc") {
      this.failControlWrite = false;
      return Promise.reject(new Error("INJECTED_WRITE_FAILURE:state/control.enc"));
    }
    return super.write(relativePath, value);
  }
}

const firstMessage: ChatMessage = {
  id: "wechat-001",
  conversationId: "example-contact",
  direction: "incoming",
  kind: "text",
  text: "今天上白班",
  occurredAt: "2026-08-19T00:00:00.000Z",
  source: "wechat",
  confidence: 0.99,
};

describe("encrypted repositories", () => {
  let rootDir: string;
  let store: EncryptedStore;
  let encryptionKey: Buffer;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "chat-assistant-repository-"));
    await initializeTestKernelLockCatalog(rootDir);
    encryptionKey = randomBytes(32);
    store = new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey));
    await activateBoundary(new StateRepository(store));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("appends each message id once and returns only newly stored ids", async () => {
    const repository = new MessageRepository(store);

    await expect(repository.appendUnique([firstMessage, firstMessage])).resolves.toEqual([
      "wechat-001",
    ]);
    await expect(repository.appendUnique([firstMessage])).resolves.toEqual([]);
    await expect(repository.list()).resolves.toEqual([firstMessage]);
  });

  test("never exposes stored message text in the backing document", async () => {
    const repository = new MessageRepository(store);
    await repository.appendUnique([firstMessage]);

    const disk = await readFile(path.join(rootDir, "vault/messages.enc"), "utf8");
    expect(disk).not.toContain("今天上白班");
  });

  test("serializes concurrent appends without losing either message", async () => {
    const repository = new MessageRepository(store);
    const secondMessage: ChatMessage = {
      ...firstMessage,
      id: "wechat-002",
      text: "今天上夜班",
    };

    await Promise.all([
      repository.appendUnique([firstMessage]),
      repository.appendUnique([secondMessage]),
    ]);

    await expect(repository.list()).resolves.toEqual([firstMessage, secondMessage]);
  });

  test("replaces one source while preserving messages from other sources", async () => {
    const repository = new MessageRepository(store);
    const douyin: ChatMessage = { ...firstMessage, id: "douyin-001", source: "douyin" };
    const replacement: ChatMessage = { ...firstMessage, id: "wechat-rebuilt", text: "重建后" };
    await repository.appendUnique([firstMessage, douyin]);

    await repository.replaceSource("wechat", [replacement, replacement]);

    await expect(repository.list()).resolves.toEqual([douyin, replacement]);
  });

  test("blocks every outgoing claim while the assistant is stopped", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    await repository.setStopped("user-command");

    await expect(repository.claimOutgoing("reply-hash-1")).rejects.toThrow("SYSTEM_STOPPED");
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
    });
  });

  test("invalidates a persistent stop-gate proof across stop and resume", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    const beforeStop = await repository.getPersistentStopGate();

    await expect(repository.assertPersistentStopGate(beforeStop)).resolves.toBeUndefined();
    await repository.setStopped("user-command");
    await expect(repository.assertPersistentStopGate(beforeStop)).rejects.toThrow(
      "CONTROL_CHANGED",
    );

    await repository.resume();
    const afterResume = await repository.getPersistentStopGate();
    expect(afterResume.gateRevision).not.toBe(beforeStop.gateRevision);
    await expect(repository.assertPersistentStopGate(beforeStop)).rejects.toThrow(
      "CONTROL_CHANGED",
    );
    await expect(repository.assertPersistentStopGate(afterResume)).resolves.toBeUndefined();
  });

  test("does not claim outgoing content against a stale expected gate revision", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    const staleGate = await repository.getPersistentStopGate();
    await repository.setStopped("user-command");
    await repository.resume();

    await expect(repository.claimOutgoing("stale-gate-reply", staleGate))
      .rejects.toThrow("CONTROL_CHANGED");
    expect((await repository.getControlState()).outgoing).not.toHaveProperty(
      "stale-gate-reply",
    );
  });

  test("deduplicates verified content fingerprints across stop and resume", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));

    await expect(repository.claimOutgoing("reply-hash-1")).resolves.toBe(true);
    await repository.markOutgoingVerified("reply-hash-1");
    await repository.setStopped("manual-check");
    await repository.resume();

    await expect(repository.claimOutgoing("reply-hash-1")).resolves.toBe(false);
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: false,
      outgoing: {
        "reply-hash-1": { status: "verified" },
      },
    });
  });

  test("an uncertain send is terminal for itself without blocking later outgoing claims", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    await repository.claimOutgoing("reply-hash-unknown");
    await repository.markOutgoingUncertain("reply-hash-unknown");

    await expect(repository.claimOutgoing("reply-hash-unknown")).resolves.toBe(false);
    await expect(repository.claimOutgoing("reply-hash-2")).resolves.toBe(true);
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
      outgoing: {
        "reply-hash-unknown": { status: "uncertain" },
        "reply-hash-2": { status: "claimed" },
      },
    });
  });

  test("issues one encrypted protocol-v3 boundary and activates only its exact occurrence", async () => {
    await store.write("state/control.enc", {
      stopped: false,
      stopReason: null,
      updatedAt: null,
      controlCursor: null,
      outgoing: {},
      sendReconciliationApproval: null,
    });
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));

    const issued = await repository.issueControlBoundary();
    const repeated = await repository.issueControlBoundary();

    expect(repeated).toEqual(issued);
    expect(issued.markerText).toMatch(/^聊天助手控制边界 [a-f0-9]{64}$/u);
    expect(issued.boundaryMessageId).toBe(
      createHash("sha256")
        .update(`file-transfer\0outgoing\0${issued.markerText}`)
        .digest("hex"),
    );
    await expect(repository.getControlState()).resolves.toMatchObject({
      controlProtocolVersion: 3,
      stopped: true,
      stopReason: "CONTROL_BOUNDARY_REQUIRED",
      controlBoundary: {
        status: "awaiting-boundary",
        epoch: issued.epoch,
        boundaryMessageId: issued.boundaryMessageId,
        consumedCount: 0,
      },
    });

    await expect(repository.activateControlBoundary({
      expectedEpoch: issued.epoch,
      boundaryMessageId: issued.boundaryMessageId,
      markerOccurrenceCount: 2,
    })).rejects.toThrow("CONTROL_BOUNDARY_AMBIGUOUS");
    await expect(repository.activateControlBoundary({
      expectedEpoch: issued.epoch,
      boundaryMessageId: issued.boundaryMessageId,
      markerOccurrenceCount: 1,
    })).resolves.toMatchObject({
      status: "active",
      epoch: issued.epoch,
      boundaryMessageId: issued.boundaryMessageId,
      consumedCount: 0,
      markerOccurrenceCount: 1,
    });
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
      controlBoundary: { status: "active" },
    });
    expect(await readFile(path.join(rootDir, "state/control.enc"), "utf8"))
      .not.toContain(issued.markerText);
  });

  test("migrates a legacy cursor to awaiting-boundary without clearing user-command", async () => {
      await store.write("state/control.enc", {
        stopped: true,
        stopReason: "user-command",
        updatedAt: "2026-08-19T01:00:00.000Z",
        controlCursor: "legacy-content-only-cursor",
        outgoing: {},
        sendReconciliationApproval: null,
      });
      const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));

      const migrated = await repository.getControlState();

      expect(migrated).toMatchObject({
        controlProtocolVersion: 3,
        stopped: true,
        stopReason: "user-command",
        controlBoundary: { status: "awaiting-boundary", consumedCount: 0 },
      });
      expect(migrated).not.toHaveProperty("controlCursor");
  });

  test("migrates an active protocol-v2 boundary without inventing a stop", async () => {
    const current = await new StateRepository(store).getControlState();
    await store.write("state/control.enc", {
      controlProtocolVersion: 2,
      stopped: false,
      stopReason: null,
      updatedAt: current.updatedAt,
      controlBoundary: current.controlBoundary,
      outgoing: current.outgoing,
    });

    const migrated = await new StateRepository(store).getControlState();

    expect(migrated).toMatchObject({
      controlProtocolVersion: 3,
      stopped: false,
      stopReason: null,
      controlBoundary: current.controlBoundary,
    });
    expect(migrated.gateRevision).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("drops a protocol-v1 pending target trigger that has no gate revision", async () => {
    const checkpoint = await new StateRepository(store).getControlBoundaryCheckpoint();
    const baseline = {
      epoch: "1".repeat(64),
      orderedSequenceHash: "2".repeat(64),
      visibleMessageIds: ["legacy-trigger-message"],
      latestMessageId: "legacy-trigger-message",
      latestDirection: "incoming" as const,
      unreadIndicator: true,
    };
    await store.write("state/target-reply.enc", {
      version: 1,
      baseline,
      pendingTrigger: {
        triggerId: "3".repeat(64),
        baselineEpoch: baseline.epoch,
        orderedSequenceHash: baseline.orderedSequenceHash,
        triggerMessageId: "legacy-trigger-message",
        controlCheckpoint: checkpoint,
        createdAt: "2026-08-19T01:00:00.000Z",
      },
      lastOwnerNoticeKey: null,
    });

    const migrated = await new StateRepository(store).getTargetReplyState();

    expect(migrated).toEqual({
      version: 2,
      baseline,
      pendingTrigger: null,
      lastOwnerNoticeKey: null,
    });
    await expect(new StateRepository(store).getTargetReplyState()).resolves.toEqual(migrated);
  });

  test.each(["legacy", "current"] as const)(
    "removes a %s SEND_RESULT_UNCERTAIN global stop while preserving its terminal fingerprint",
    async (format) => {
      const fingerprint = "a".repeat(64);
      const approval = {
        candidateId: "b".repeat(64),
        fingerprint,
        confirmationCode: "c".repeat(16),
        approvedAt: null,
        controlMessageIdHash: null,
      };
      if (format === "legacy") {
        await store.write("state/control.enc", {
          stopped: true,
          stopReason: "SEND_RESULT_UNCERTAIN",
          updatedAt: "2026-08-19T01:00:00.000Z",
          controlCursor: "legacy-content-only-cursor",
          outgoing: {
            [fingerprint]: { status: "uncertain", updatedAt: "2026-08-19T01:00:00.000Z" },
          },
          sendReconciliationApproval: approval,
        });
      } else {
        const seed = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
        const current = await seed.getControlState();
        await store.write("state/control.enc", {
          ...current,
          stopped: true,
          stopReason: "SEND_RESULT_UNCERTAIN",
          outgoing: {
            [fingerprint]: { status: "uncertain", updatedAt: "2026-08-19T01:00:00.000Z" },
          },
          sendReconciliationApproval: approval,
        });
      }

      const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
      await expect(repository.getControlState()).resolves.toMatchObject({
        stopped: false,
        stopReason: null,
        outgoing: { [fingerprint]: { status: "uncertain" } },
      });
      expect(await repository.getControlState()).not.toHaveProperty(
        "sendReconciliationApproval",
      );
    },
  );

  test("grants exactly one encrypted owner-notice claim across retries and concurrency", async () => {
    const storeA = new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey));
    const storeB = new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey));
    const repositoryA = new StateRepository(storeA, () => new Date("2026-08-19T01:00:00.000Z"));
    const repositoryB = new StateRepository(storeB, () => new Date("2026-08-19T01:00:00.000Z"));
    const request = {
      triggerIdHash: "c".repeat(64),
      reasonCode: "SENSITIVE_MEDICAL_REQUEST",
    };

    const claims = await Promise.all([
      repositoryA.claimOwnerNotice(request),
      repositoryB.claimOwnerNotice(request),
      repositoryA.claimOwnerNotice(request),
    ]);

    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      triggerIdHash: request.triggerIdHash,
      reasonCode: request.reasonCode,
    });
    expect(winners[0]?.noticeId).toMatch(/^[a-f0-9]{64}$/u);
    const state = await repositoryA.getTargetReplyState();
    expect(state.lastOwnerNoticeKey).toBeNull();
    const claimFiles = await readdir(path.join(rootDir, "state/owner-notice-claims"));
    expect(claimFiles).toEqual([
      `${createHash("sha256")
        .update(`${request.triggerIdHash}\0${request.reasonCode}`)
        .digest("hex")}.claim`,
    ]);
    const claimPath = path.join(
      rootDir,
      "state/owner-notice-claims",
      claimFiles[0] ?? "missing",
    );
    expect(await readFile(claimPath)).toHaveLength(0);
    expect((await stat(claimPath)).mode & 0o777).toBe(0o600);
  });

  test("grants one owner-notice claim across independent Node processes", async () => {
    const workerRoot = await mkdtemp(path.join(os.tmpdir(), "owner-notice-processes-"));
    const keyHex = encryptionKey.toString("hex");
    const workerPath = path.resolve("tests/fixtures/owner-notice-claim-worker.test.ts");
    const vitestPath = path.resolve("node_modules/vitest/vitest.mjs");
    const triggerIdHash = "d".repeat(64);
    const reasonCode = "SENSITIVE_MEDICAL_REQUEST";
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
          OWNER_NOTICE_WORKER: "1",
          OWNER_NOTICE_ROOT: workerRoot,
          OWNER_NOTICE_KEY_HEX: keyHex,
          OWNER_NOTICE_TRIGGER_HASH: triggerIdHash,
          OWNER_NOTICE_REASON: reasonCode,
          OWNER_NOTICE_WORKER_ID: workerId,
          OWNER_NOTICE_RESULT_PATH: resultPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { child, completion: waitForChild(child), resultPath, workerId };
    });

    try {
      await Promise.all(children.map(({ workerId }) =>
        waitForPath(path.join(workerRoot, `ready-${workerId}`))
      ));
      await writeFile(path.join(workerRoot, "start-release"), "", { flag: "wx" });

      const completedWithoutReadBarrier = await waitForEither(
        children.map(({ resultPath }) => resultPath),
        children.map(({ workerId }) => path.join(workerRoot, `read-ready-${workerId}`)),
      );
      if (!completedWithoutReadBarrier) {
        await writeFile(path.join(workerRoot, "read-release"), "", { flag: "wx" });
      }

      const outputs = await Promise.all(children.map(({ completion }) => completion));
      for (const output of outputs) {
        expect(output.code, output.stderr || output.stdout).toBe(0);
      }
      const results = await Promise.all(children.map(async ({ resultPath }) =>
        JSON.parse(await readFile(resultPath, "utf8")) as { claimed: boolean }
      ));
      expect(results.filter(({ claimed }) => claimed)).toHaveLength(1);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null) child.kill();
      }
      await rm(workerRoot, { recursive: true, force: true });
    }
  }, 20_000);

  test("persists STOP before completing its trusted boundary checkpoint", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    const before = await repository.getControlBoundaryCheckpoint();
    const after = extendCheckpoint(before, "cursor-after-stop");

    await repository.beginUserStopControlBatch(before);
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
      controlBoundary: before,
    });

    await repository.completeUserStopControlBatch(before, after);
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
      controlBoundary: after,
    });
  });

  test("atomically resumes only a user stop while consuming the trusted batch", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    await repository.setStopped("user-command");
    const first = await repository.getControlBoundaryCheckpoint();
    const resumed = extendCheckpoint(first, "resume-control");

    await expect(repository.consumeNonStopControlBatch({
      expectedBoundary: first,
      nextBoundary: resumed,
      resumeMessageIds: ["resume-control"],
    })).resolves.toEqual({ command: "resume", messageId: "resume-control" });
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
      controlBoundary: resumed,
    });
  });

  test("does not partially resume or advance the cursor when the atomic save fails", async () => {
    const failingStore = new FailOnceEncryptedStore(
      rootDir,
      new FixedKeyProvider(encryptionKey),
    );
    const repository = new StateRepository(
      failingStore,
      () => new Date("2026-08-19T01:00:00.000Z"),
    );
    const issued = await repository.issueControlBoundary();
    await repository.activateControlBoundary({
      expectedEpoch: issued.epoch,
      boundaryMessageId: issued.boundaryMessageId,
      markerOccurrenceCount: 1,
    });
    await repository.setStopped("user-command");
    const before = await repository.getControlBoundaryCheckpoint();
    const after = extendCheckpoint(before, "resume-control");
    failingStore.armControlWriteFailure();

    await expect(repository.consumeNonStopControlBatch({
      expectedBoundary: before,
      nextBoundary: after,
      resumeMessageIds: ["resume-control"],
    })).rejects.toThrow("INJECTED_WRITE_FAILURE:state/control.enc");
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: true,
      stopReason: "user-command",
      controlBoundary: before,
    });
  });

  test("atomically consumes a trusted ordinary batch without changing stop state", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    const before = await repository.getControlBoundaryCheckpoint();
    const after = extendCheckpoint(before, "ordinary-control");

    await expect(repository.consumeNonStopControlBatch({
      expectedBoundary: before,
      nextBoundary: after,
      resumeMessageIds: [],
    })).resolves.toBeNull();
    await expect(repository.getControlState()).resolves.toMatchObject({
      stopped: false,
      stopReason: null,
      controlBoundary: after,
    });
  });

  test("releases only the matching outgoing fingerprint while it is still claimed", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    await repository.claimOutgoing("reply-hash-aborted");
    await repository.claimOutgoing("reply-hash-other");

    await repository.releaseOutgoingClaim("reply-hash-aborted");

    await expect(repository.getControlState()).resolves.toMatchObject({
      outgoing: {
        "reply-hash-other": { status: "claimed" },
      },
    });
    expect((await repository.getControlState()).outgoing).not.toHaveProperty(
      "reply-hash-aborted",
    );
    await expect(repository.claimOutgoing("reply-hash-aborted")).resolves.toBe(true);
  });

  test("does not release a verified outgoing fingerprint", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    await repository.claimOutgoing("reply-hash-verified");
    await repository.markOutgoingVerified("reply-hash-verified");

    await expect(
      repository.releaseOutgoingClaim("reply-hash-verified"),
    ).rejects.toThrow("OUTGOING_NOT_CLAIMED");
    await expect(repository.getControlState()).resolves.toMatchObject({
      outgoing: {
        "reply-hash-verified": { status: "verified" },
      },
    });
  });

  test("idempotently releases only an abort intent's claimed outgoing fingerprint", async () => {
    const repository = new StateRepository(store, () => new Date("2026-08-19T01:00:00.000Z"));
    await repository.claimOutgoing("reply-hash-aborted");

    await repository.releaseOutgoingClaimForAbort("reply-hash-aborted");
    await repository.releaseOutgoingClaimForAbort("reply-hash-aborted");

    expect((await repository.getControlState()).outgoing).toEqual({});
    await repository.claimOutgoing("reply-hash-verified");
    await repository.markOutgoingVerified("reply-hash-verified");
    await expect(
      repository.releaseOutgoingClaimForAbort("reply-hash-verified"),
    ).rejects.toThrow("OUTGOING_NOT_CLAIMED");
  });

  test("stores a uniquely identified abort intent only in encrypted form", async () => {
    const repository = new AbortIntentRepository(store);
    const intent = {
      intentId: "1".repeat(64),
      candidateId: "2".repeat(64),
      tokenHash: "3".repeat(64),
      conversationId: "example-contact" as const,
      fingerprint: "4".repeat(64),
      textHash: "5".repeat(64),
      auditId: "11111111-1111-5111-8111-111111111111",
    };

    await repository.put(intent);
    await expect(repository.get()).resolves.toEqual(intent);
    await expect(repository.put(intent)).resolves.toBeUndefined();
    await expect(
      repository.put({ ...intent, textHash: "6".repeat(64) }),
    ).rejects.toThrow("ABORT_INTENT_CONFLICT");
    const disk = await readFile(path.join(rootDir, "state/abort-intent.enc"), "utf8");
    expect(disk).not.toContain("example-contact");
    expect(disk).not.toContain("3".repeat(64));
  });

  test("idempotently clears only the matching pending token", async () => {
    const repository = new PendingSendRepository(store);
    await repository.put({
      conversationId: "file-transfer",
      text: "连接测试",
      tokenHash: "7".repeat(64),
      fingerprint: null,
      baselineMessageIds: [],
      createdAt: "2026-08-19T01:02:03.000Z",
      draftVerifiedAt: null,
    });

    await repository.clearMatchingIfPresent("7".repeat(64));
    await repository.clearMatchingIfPresent("7".repeat(64));

    await expect(repository.get()).resolves.toBeNull();
  });

  test("records append-only audit events with deterministic timestamps", async () => {
    const repository = new AuditRepository(
      store,
      () => new Date("2026-08-19T01:02:03.000Z"),
    );

    const id = await repository.record({
      type: "assistant-stopped",
      details: { reason: "user-command" },
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(repository.list()).resolves.toEqual([
      {
        id,
        type: "assistant-stopped",
        occurredAt: "2026-08-19T01:02:03.000Z",
        details: { reason: "user-command" },
      },
    ]);
  });

  test("appends a deterministic audit identity at most once", async () => {
    const repository = new AuditRepository(
      store,
      () => new Date("2026-08-19T01:02:03.000Z"),
    );
    const auditId = "22222222-2222-5222-8222-222222222222";
    const event = {
      type: "live-draft-aborted",
      details: {
        conversationId: "example-contact",
        textHash: "8".repeat(64),
      },
    };

    await expect(repository.recordOnce(auditId, event)).resolves.toBe(auditId);
    await expect(repository.recordOnce(auditId, event)).resolves.toBe(auditId);

    expect((await repository.list()).filter((record) => record.id === auditId))
      .toHaveLength(1);
    await expect(
      repository.recordOnce(auditId, { ...event, type: "conflicting-event" }),
    ).rejects.toThrow("AUDIT_ID_CONFLICT");
  });

  test("uses cross-instance CAS for contact/revision/binding/trigger realtime state", async () => {
    const repositoryA = new RealtimeReplyRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey)),
    );
    const repositoryB = new RealtimeReplyRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey)),
    );
    const target = {
      contactId: "contact-11111111111111111111111111111111" as const,
      displayName: "测试联系人",
      revision: 7,
      enrollment: {} as never,
      enrollmentFingerprint: "e".repeat(64),
      bindingHash: "b".repeat(64),
    };
    const key = {
      contactId: target.contactId,
      contactRevision: target.revision,
      bindingHash: target.bindingHash,
      triggerId: "a".repeat(64),
    };
    await repositoryA.claim({
      target,
      triggerId: key.triggerId,
      source: "native-ocr",
      sourceEpoch: "source-epoch",
      sessionId: "session-id",
      messages: [{
        contractVersion: 1,
        source: "native-ocr",
        sourceEpoch: "source-epoch",
        sessionId: "session-id",
        conversationId: target.contactId,
        messageId: "c".repeat(64),
        sequence: 1,
        occurredAt: "2026-08-31T00:00:00.000Z",
        direction: "incoming",
        kind: "text",
        text: "不应出现在磁盘明文里",
      }],
      now: new Date("2026-08-31T00:00:00.000Z"),
    });

    const winners = await Promise.all([
      repositoryA.compareAndSet({
        key, expectedStatus: "new", next: { status: "generating" },
        now: new Date("2026-08-31T00:00:01.000Z"),
      }),
      repositoryB.compareAndSet({
        key, expectedStatus: "new", next: { status: "generating" },
        now: new Date("2026-08-31T00:00:01.000Z"),
      }),
    ]);

    expect(winners.filter(Boolean)).toHaveLength(1);
    await expect(repositoryB.get(key)).resolves.toMatchObject({
      contactId: target.contactId,
      contactRevision: 7,
      bindingHash: target.bindingHash,
      triggerId: key.triggerId,
      status: "generating",
    });
    expect(await readFile(path.join(rootDir, "state/realtime-replies.enc"), "utf8"))
      .not.toContain("不应出现在磁盘明文里");
  });

  test("restart recovery excludes verified and cancelled realtime triggers", async () => {
    const repository = new RealtimeReplyRepository(store);
    const target = {
      contactId: "contact-22222222222222222222222222222222" as const,
      displayName: "恢复联系人",
      revision: 1,
      enrollment: {} as never,
      enrollmentFingerprint: "e".repeat(64),
      bindingHash: "b".repeat(64),
    };
    const create = async (triggerId: string, terminal?: "verified" | "cancelled") => {
      const messageId = createHash("sha256").update(`recover:${triggerId}`).digest("hex");
      const derivedTriggerId = createHash("sha256").update([
        "personal-account-trigger-v2",
        target.contactId,
        "1",
        target.bindingHash,
        "native-ocr",
        "epoch",
        "session",
        messageId,
      ].join("\0")).digest("hex");
      const key = {
        contactId: target.contactId,
        contactRevision: 1,
        bindingHash: target.bindingHash,
        triggerId: derivedTriggerId,
      };
      await repository.claim({
        target, triggerId: derivedTriggerId, source: "native-ocr", sourceEpoch: "epoch", sessionId: "session",
        messages: [{
          contractVersion: 1, source: "native-ocr", sourceEpoch: "epoch", sessionId: "session",
          conversationId: target.contactId, messageId, sequence: 1,
          occurredAt: "2026-08-31T00:00:00.000Z", direction: "incoming", kind: "text", text: "x",
        }],
        now: new Date("2026-08-31T00:00:00.000Z"),
      });
      if (terminal !== undefined) {
        if (terminal === "cancelled") {
          await repository.compareAndSet({
            key, expectedStatus: "new", next: { status: terminal, reason: "OWNER_REPLIED" },
            now: new Date("2026-08-31T00:00:01.000Z"),
          });
        } else {
          await repository.compareAndSet({
            key, expectedStatus: "new", next: { status: "generating" },
            now: new Date("2026-08-31T00:00:00.100Z"),
          });
          await repository.compareAndSet({
            key,
            expectedStatus: "generating",
            next: { status: "prepared", intent: realtimeIntent(target, derivedTriggerId, [messageId]) },
            now: new Date("2026-08-31T00:00:00.200Z"),
          });
          await repository.compareAndSet({
            key, expectedStatus: "prepared", next: { status: "submit-started" },
            now: new Date("2026-08-31T00:00:00.300Z"),
          });
          await repository.compareAndSet({
            key, expectedStatus: "submit-started", next: { status: "verified" },
            now: new Date("2026-08-31T00:00:01.000Z"),
          });
        }
      }
      return derivedTriggerId;
    };
    await create("2".repeat(64), "verified");
    await create("3".repeat(64), "cancelled");
    const pendingTriggerId = await create("1".repeat(64));

    const restarted = new RealtimeReplyRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey)),
    );
    await expect(restarted.listRecoverable()).resolves.toEqual([
      expect.objectContaining({ triggerId: pendingTriggerId, status: "new" }),
    ]);
  });

  test("persists a buffered burst before it can be claimed after restart", async () => {
    const target = {
      contactId: "contact-44444444444444444444444444444444" as const,
      displayName: "持久缓冲联系人",
      revision: 1,
      enrollment: {} as never,
      enrollmentFingerprint: "e".repeat(64),
      bindingHash: "4".repeat(64),
    };
    const first = realtimeMessage(target.contactId, 1, "第一句");
    const second = realtimeMessage(target.contactId, 2, "第二句");
    const repository = new RealtimeReplyRepository(store);

    await repository.appendBufferedMessage({
      target,
      message: first,
      deadline: new Date("2026-08-31T00:00:02.000Z"),
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    await repository.appendBufferedMessage({
      target,
      message: second,
      deadline: new Date("2026-08-31T00:00:03.000Z"),
      now: new Date("2026-08-31T00:00:01.000Z"),
    });

    const restarted = new RealtimeReplyRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey)),
    );
    await expect(restarted.listBufferedBatches()).resolves.toEqual([
      expect.objectContaining({
        contactId: target.contactId,
        messages: [first, second],
        deadlineAt: "2026-08-31T00:00:03.000Z",
      }),
    ]);
  });

  test("keeps one active trigger per contact across independent repository instances", async () => {
    const target = {
      contactId: "contact-55555555555555555555555555555555" as const,
      displayName: "单 active 联系人",
      revision: 1,
      enrollment: {} as never,
      enrollmentFingerprint: "e".repeat(64),
      bindingHash: "5".repeat(64),
    };
    const repositoryA = new RealtimeReplyRepository(store);
    const repositoryB = new RealtimeReplyRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey)),
    );
    const firstMessage = realtimeMessage(target.contactId, 1, "first");
    const firstTriggerId = createHash("sha256").update([
      "personal-account-trigger-v2",
      target.contactId,
      String(target.revision),
      target.bindingHash,
      "native-ocr",
      "epoch",
      "session",
      firstMessage.messageId,
    ].join("\0")).digest("hex");
    const first = await repositoryA.claim({
      target,
      triggerId: firstTriggerId,
      source: "native-ocr",
      sourceEpoch: "epoch",
      sessionId: "session",
      messages: [firstMessage],
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    const firstKey = {
      contactId: target.contactId,
      contactRevision: target.revision,
      bindingHash: target.bindingHash,
      triggerId: first.record.triggerId,
    };
    await repositoryA.compareAndSet({
      key: firstKey,
      expectedStatus: "new",
      next: { status: "generating" },
      now: new Date("2026-08-31T00:00:00.100Z"),
    });
    await repositoryA.compareAndSet({
      key: firstKey,
      expectedStatus: "generating",
      next: {
        status: "prepared",
        intent: realtimeIntent(
          target,
          first.record.triggerId,
          first.record.messages.map(({ messageId }) => messageId),
        ),
      },
      now: new Date("2026-08-31T00:00:00.200Z"),
    });
    await repositoryA.compareAndSet({
      key: firstKey,
      expectedStatus: "prepared",
      next: { status: "submit-started" },
      now: new Date("2026-08-31T00:00:00.300Z"),
    });
    await repositoryA.compareAndSet({
      key: firstKey,
      expectedStatus: "submit-started",
      next: { status: "submitted-uncertain" },
      now: new Date("2026-08-31T00:00:00.400Z"),
    });

    const competing = await repositoryB.claim({
      target,
      triggerId: "6".repeat(64),
      source: "native-ocr",
      sourceEpoch: "epoch",
      sessionId: "session",
      messages: [realtimeMessage(target.contactId, 2, "second")],
      now: new Date("2026-08-31T00:00:01.000Z"),
    });

    expect(competing.claimed).toBe(false);
    expect(competing.record.triggerId).toBe(first.record.triggerId);

    await repositoryB.appendBufferedMessage({
      target,
      message: realtimeMessage(target.contactId, 2, "queued"),
      deadline: new Date("2026-08-31T00:00:03.000Z"),
      now: new Date("2026-08-31T00:00:01.000Z"),
    });
    await expect(repositoryB.claimBufferedBatch(
      target.contactId,
      new Date("2026-08-31T00:00:03.000Z"),
    )).resolves.toMatchObject({ claimed: false, record: { triggerId: first.record.triggerId } });
    await repositoryA.compareAndSet({
      key: firstKey,
      expectedStatus: "submitted-uncertain",
      next: { status: "verified" },
      now: new Date("2026-08-31T00:00:04.000Z"),
    });
    await expect(repositoryB.claimBufferedBatch(
      target.contactId,
      new Date("2026-08-31T00:00:05.000Z"),
    )).resolves.toMatchObject({ claimed: true, record: { status: "new" } });
  });

  test("allows exactly one Promise.all cross-instance claim for the same contact", async () => {
    const target = {
      contactId: "contact-88888888888888888888888888888888" as const,
      displayName: "并发联系人",
      revision: 1,
      enrollment: {} as never,
      enrollmentFingerprint: "e".repeat(64),
      bindingHash: "8".repeat(64),
    };
    const repositoryA = new RealtimeReplyRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey)),
    );
    const repositoryB = new RealtimeReplyRepository(
      new EncryptedStore(rootDir, new FixedKeyProvider(encryptionKey)),
    );
    const messages = [
      realtimeMessage(target.contactId, 1, "并发一"),
      realtimeMessage(target.contactId, 2, "并发二"),
    ];
    const trigger = (messageId: string) => createHash("sha256").update([
      "personal-account-trigger-v2",
      target.contactId,
      "1",
      target.bindingHash,
      "native-ocr",
      "epoch",
      "session",
      messageId,
    ].join("\0")).digest("hex");

    const results = await Promise.all(messages.map((message, index) =>
      (index === 0 ? repositoryA : repositoryB).claim({
        target,
        triggerId: trigger(message.messageId),
        source: "native-ocr",
        sourceEpoch: "epoch",
        sessionId: "session",
        messages: [message],
        now: new Date("2026-08-31T00:00:00.000Z"),
      })));

    expect(results.filter(({ claimed }) => claimed)).toHaveLength(1);
    expect((await repositoryA.list()).filter(({ status }) =>
      !["verified", "cancelled", "failed"].includes(status))).toHaveLength(1);
  });

  test("rejects illegal terminal shortcuts and keeps failed terminal", async () => {
    const target = {
      contactId: "contact-66666666666666666666666666666666" as const,
      displayName: "严格状态联系人",
      revision: 1,
      enrollment: {} as never,
      enrollmentFingerprint: "e".repeat(64),
      bindingHash: "6".repeat(64),
    };
    const repository = new RealtimeReplyRepository(store);
    const claimed = await repository.claim({
      target,
      triggerId: "7".repeat(64),
      source: "native-ocr",
      sourceEpoch: "epoch",
      sessionId: "session",
      messages: [realtimeMessage(target.contactId, 1, "strict")],
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    const key = {
      contactId: target.contactId,
      contactRevision: target.revision,
      bindingHash: target.bindingHash,
      triggerId: claimed.record.triggerId,
    };

    await expect(repository.compareAndSet({
      key,
      expectedStatus: "new",
      next: { status: "verified" },
      now: new Date("2026-08-31T00:00:01.000Z"),
    })).rejects.toThrow("REALTIME_STATE_TRANSITION_INVALID");
    await expect(repository.compareAndSet({
      key,
      expectedStatus: "new",
      next: { status: "failed", reason: "SOURCE_BLOCKED" },
      now: new Date("2026-08-31T00:00:01.000Z"),
    })).resolves.toBe(true);
    await expect(repository.compareAndSet({
      key,
      expectedStatus: "failed",
      next: { status: "generating" },
      now: new Date("2026-08-31T00:00:02.000Z"),
    })).rejects.toThrow("REALTIME_STATE_TRANSITION_INVALID");
  });
});

function realtimeMessage(
  contactId: `contact-${string}`,
  sequence: number,
  text: string,
) {
  return {
    contractVersion: 1 as const,
    source: "native-ocr" as const,
    sourceEpoch: "epoch",
    sessionId: "session",
    conversationId: contactId,
    messageId: createHash("sha256").update(`${sequence}:${text}`).digest("hex"),
    sequence,
    occurredAt: new Date(sequence * 1_000).toISOString(),
    direction: "incoming" as const,
    kind: "text" as const,
    text,
  };
}

function realtimeIntent(
  target: {
    contactId: `contact-${string}`;
    revision: number;
    bindingHash: string;
  },
  triggerId: string,
  sourceMessageIds: readonly string[],
) {
  const replyText = "reply";
  return {
    contractVersion: 1 as const,
    status: "prepared" as const,
    triggerId,
    conversationId: target.contactId,
    contactId: target.contactId,
    contactRevision: target.revision,
    bindingHash: target.bindingHash,
    source: "native-ocr" as const,
    sourceEpoch: "epoch",
    sessionId: "session",
    replyText,
    sourceMessageIds: [...sourceMessageIds],
    deliveryKey: createHash("sha256").update([
      "personal-account-delivery-v2",
      triggerId,
      target.contactId,
      String(target.revision),
      target.bindingHash,
      replyText,
    ].join("\0")).digest("hex"),
  };
}

async function activateBoundary(repository: StateRepository): Promise<void> {
  const issued = await repository.issueControlBoundary();
  await repository.activateControlBoundary({
    expectedEpoch: issued.epoch,
    boundaryMessageId: issued.boundaryMessageId,
    markerOccurrenceCount: 1,
  });
}

function extendCheckpoint(
  checkpoint: ControlBoundaryCheckpoint,
  messageId: string,
): ControlBoundaryCheckpoint {
  return {
    ...checkpoint,
    consumedCount: checkpoint.consumedCount + 1,
    prefixChainHash: createHash("sha256")
      .update(checkpoint.prefixChainHash)
      .update("\0")
      .update(String(checkpoint.consumedCount))
      .update("\0")
      .update(messageId)
      .digest("hex"),
  };
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

async function waitForEither(
  completedPaths: string[],
  barrierPaths: string[],
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await allPathsExist(completedPaths)) return true;
    if (await allPathsExist(barrierPaths)) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("WAIT_TIMEOUT:worker-result-or-read-barrier");
}

async function allPathsExist(paths: string[]): Promise<boolean> {
  const exists = await Promise.all(paths.map(async (filePath) => {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }));
  return exists.every(Boolean);
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}
