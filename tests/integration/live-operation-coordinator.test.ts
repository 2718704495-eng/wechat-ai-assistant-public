import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireLiveOperationCoordinator,
  acquireLiveOperationChildAdmission,
  assertLiveOperationCoordinator,
} from "../../src/mcp/live-operation-coordinator.js";
import { compatibilityTombstoneContents } from "../../src/storage/kernel-lock.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live operation coordinator kernel lease", () => {
  it("accepts a filesystem alias but detects an alias identity swap", async () => {
    const root = await temporaryRoot();
    const replacement = await temporaryRoot();
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias, "dir");
    const owner = await acquireLiveOperationCoordinator({
      dataDir: alias,
      ownerKind: "mcp",
    });
    expect(() => assertLiveOperationCoordinator(owner, root)).not.toThrow();
    await unlink(alias);
    await symlink(replacement, alias, "dir");
    expect(() => assertLiveOperationCoordinator(owner, alias)).toThrow(
      "LIVE_OPERATION_OWNER_ROOT_IDENTITY_CHANGED",
    );
    await owner.close();
  });

  it("excludes a second owner, serializes callbacks, and preserves the compatibility tombstone", async () => {
    const root = await temporaryRoot();
    const owner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    await expect(acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "cli" }))
      .rejects.toThrow("LIVE_RUNTIME_BUSY");

    const order: string[] = [];
    await Promise.all([
      owner.runExclusive(() => {
        order.push("first");
        return Promise.resolve();
      }),
      owner.runExclusive(() => {
        order.push("second");
        return Promise.resolve();
      }),
    ]);
    expect(order).toEqual(["first", "second"]);
    await owner.close();

    await expect(readFile(path.join(root, "state", "live-operation.lock"), "utf8"))
      .resolves.toBe(compatibilityTombstoneContents());
    const successor = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "cli" });
    await successor.close();
  });

  it("treats an old live-operation marker as busy without changing it", async () => {
    const root = await temporaryRoot();
    const marker = path.join(root, "state", "live-operation.lock");
    await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
    await writeFile(marker, "old marker", { mode: 0o600 });

    await expect(acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" }))
      .rejects.toThrow("LIVE_RUNTIME_BUSY");
    await expect(readFile(marker, "utf8")).resolves.toBe("old marker");
  });

  it("mints one non-forgeable local child admission per real owner and namespace", async () => {
    const root = await temporaryRoot();
    const owner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    const first = acquireLiveOperationChildAdmission(owner, "inbound-delivery");
    const second = acquireLiveOperationChildAdmission(owner, "inbound-delivery");
    expect(second).toBe(first);

    const fake = {
      runExclusive: <T>(operation: () => Promise<T>) => operation(),
      close: () => Promise.resolve(),
    };
    expect(() => acquireLiveOperationChildAdmission(fake, "inbound-delivery"))
      .toThrow("LIVE_OPERATION_OWNER_INVALID");

    await owner.close();
    await expect(first.runExclusive(() => Promise.resolve("never")))
      .rejects.toThrow("LIVE_RUNTIME_CLOSED");
  });

  it("does not hold or queue through the parent while a child callback re-enters it", async () => {
    const root = await temporaryRoot();
    const owner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    const child = acquireLiveOperationChildAdmission(owner, "inbound-delivery");

    const result = await owner.runExclusive(() => child.runExclusive(() =>
      Promise.resolve("child-inside-owner")));

    expect(result).toBe("child-inside-owner");
    await owner.close();
  });

  it("drains a parent operation accepted before close while rejecting new requests", async () => {
    const root = await temporaryRoot();
    const owner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const operation = owner.runExclusive(async () => {
      entered?.();
      await gate;
      return "drained" as const;
    });
    await started;

    const closing = owner.close();
    await expect(owner.runExclusive(() => Promise.resolve("late")))
      .rejects.toThrow("LIVE_RUNTIME_CLOSED");
    release?.();

    await expect(operation).resolves.toBe("drained");
    await closing;
  });

  it("keeps the kernel lease until an admitted child exits and fences its post-snapshot side effect", async () => {
    const root = await temporaryRoot();
    const owner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    const child = acquireLiveOperationChildAdmission(owner, "inbound-delivery");
    let releaseSnapshot: (() => void) | undefined;
    let snapshotStarted: (() => void) | undefined;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    const effects: string[] = [];

    const childWork = child.runExclusive(async (fence) => {
      snapshotStarted?.();
      await snapshotGate;
      fence.assertCurrent();
      effects.push("handler");
    });
    await started;
    const closing = owner.close();

    await expect(acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "cli" }))
      .rejects.toThrow("LIVE_RUNTIME_BUSY");
    expect(() => acquireLiveOperationChildAdmission(owner, "inbound-delivery"))
      .toThrow("LIVE_RUNTIME_CLOSED");
    releaseSnapshot?.();
    await expect(childWork).rejects.toThrow("LIVE_RUNTIME_CLOSED");
    await closing;
    expect(effects).toEqual([]);

    const successor = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "cli" });
    await successor.close();
  });

  it("bounds child-to-parent reentry while close drains both queues without deadlock", async () => {
    const root = await temporaryRoot();
    const owner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    const child = acquireLiveOperationChildAdmission(owner, "inbound-delivery");
    let beginReentry: (() => void) | undefined;
    let childStarted: (() => void) | undefined;
    const reentryGate = new Promise<void>((resolve) => { beginReentry = resolve; });
    const started = new Promise<void>((resolve) => { childStarted = resolve; });

    const childWork = child.runExclusive(async () => {
      childStarted?.();
      await reentryGate;
      await owner.runExclusive(() => Promise.resolve());
    });
    await started;
    const closing = owner.close();
    beginReentry?.();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      Promise.allSettled([childWork, closing]).then(() => "completed" as const),
      new Promise<"deadlocked">((resolve) => {
        timeout = setTimeout(() => { resolve("deadlocked"); }, 500);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    expect(outcome).toBe("completed");
    await expect(childWork).rejects.toThrow("LIVE_RUNTIME_CLOSED");
  });

  it("fences child-originated parent reentry that was queued before close but not executed", async () => {
    const root = await temporaryRoot();
    const owner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    const child = acquireLiveOperationChildAdmission(owner, "inbound-delivery");
    let releaseParent: (() => void) | undefined;
    let releaseFirstReentry: (() => void) | undefined;
    let reentriesQueued: (() => void) | undefined;
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
    const firstReentryGate = new Promise<void>((resolve) => { releaseFirstReentry = resolve; });
    const queued = new Promise<void>((resolve) => { reentriesQueued = resolve; });
    const effects: string[] = [];
    const blockingParent = owner.runExclusive(() => parentGate);
    const childWork = child.runExclusive(async () => {
      const first = owner.runExclusive(() => firstReentryGate);
      const second = owner.runExclusive(() => {
        effects.push("stale-parent-reentry");
        return Promise.resolve();
      });
      reentriesQueued?.();
      await Promise.allSettled([first, second]);
    });
    await queued;

    const closing = owner.close();
    releaseParent?.();
    releaseFirstReentry?.();
    await Promise.allSettled([blockingParent, childWork, closing]);

    expect(effects).toEqual([]);
  });

  it("completes parent-to-child-to-parent reentry without queue-cycle deadlock", async () => {
    const root = await temporaryRoot();
    const owner = await acquireLiveOperationCoordinator({ dataDir: root, ownerKind: "mcp" });
    const child = acquireLiveOperationChildAdmission(owner, "inbound-delivery");
    let reentryQueued: (() => void) | undefined;
    let escapeDeadlock: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => { reentryQueued = resolve; });
    const escape = new Promise<void>((resolve) => { escapeDeadlock = resolve; });

    const outer = owner.runExclusive(() => child.runExclusive(async () => {
      const reentry = owner.runExclusive(() => Promise.resolve("reentered"));
      reentryQueued?.();
      return Promise.race([reentry, escape.then(() => "escaped" as const)]);
    }));
    await queued;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      outer,
      new Promise<"deadlocked">((resolve) => {
        timeout = setTimeout(() => { resolve("deadlocked"); }, 500);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    escapeDeadlock?.();
    await outer;
    await owner.close();

    expect(outcome).toBe("reentered");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-operation-kernel-"));
  roots.push(root);
  await initializeTestKernelLockCatalog(root);
  return root;
}
