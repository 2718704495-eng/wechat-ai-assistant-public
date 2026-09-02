"use strict";
/* global __dirname, process */

const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { constants } = require("node:fs");
const {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
} = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const workerPath = path.join(__dirname, "flock-worker.cjs");
const wouldBlockErrnos = new Set(
  [os.constants.errno.EAGAIN, os.constants.errno.EWOULDBLOCK]
    .filter((value) => Number.isInteger(value)),
);

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink };
}

function assertLocked(status, code) {
  requireCondition(status && status.ok === true && status.errno === 0, code);
}

function assertWouldBlock(status, code) {
  requireCondition(
    status && status.ok === false && wouldBlockErrnos.has(status.errno),
    code,
  );
}

async function createRegularGate(directory, name) {
  const gatePath = path.join(directory, name);
  const created = await open(gatePath, "wx", 0o600);
  await created.close();
  return gatePath;
}

function startWorker(addonPath, targetPath, kind = "regular") {
  const child = spawn(process.execPath, [workerPath, addonPath, targetPath, kind], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let buffered = "";
  let attemptSettled = false;
  let resolveAttempt;
  let rejectAttempt;
  const attempt = new Promise((resolve, reject) => {
    resolveAttempt = resolve;
    rejectAttempt = reject;
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout.push(chunk);
    buffered += chunk;
    while (true) {
      const delimiter = buffered.indexOf("\n");
      if (delimiter < 0) return;
      const line = buffered.slice(0, delimiter);
      buffered = buffered.slice(delimiter + 1);
      if (line.length === 0) continue;
      try {
        const message = JSON.parse(line);
        if (!attemptSettled && message.type === "attempt") {
          attemptSettled = true;
          resolveAttempt(message);
        }
      } catch (error) {
        if (!attemptSettled) {
          attemptSettled = true;
          rejectAttempt(new Error(`ROUND6_WORKER_STDOUT_INVALID:${String(error)}`));
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  child.once("error", (error) => {
    if (!attemptSettled) {
      attemptSettled = true;
      rejectAttempt(error);
    }
  });
  exited.then((exit) => {
    if (!attemptSettled) {
      attemptSettled = true;
      rejectAttempt(new Error(
        `ROUND6_WORKER_EXITED_WITHOUT_ATTEMPT:${JSON.stringify({ exit, stdout, stderr })}`,
      ));
    }
  }).catch(() => undefined);

  return {
    child,
    attempt,
    exited,
    output: () => ({ stdout: stdout.join(""), stderr: stderr.join("") }),
  };
}

async function releaseWorker(worker, code) {
  worker.child.stdin.end("release\n");
  const exit = await worker.exited;
  requireCondition(exit.code === 0 && exit.signal === null, `${code}:${JSON.stringify({
    exit,
    ...worker.output(),
  })}`);
  return { exit, ...worker.output() };
}

async function expectWorkerExit(worker, expectedCode, expectedSignal, code) {
  const exit = await worker.exited;
  requireCondition(
    exit.code === expectedCode && exit.signal === expectedSignal,
    `${code}:${JSON.stringify({ exit, ...worker.output() })}`,
  );
  return { exit, ...worker.output() };
}

async function probeRegularGate(addon, root) {
  const gatePath = await createRegularGate(root, "regular-gate");
  const handle = await open(gatePath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const identity = addon.inspect(handle.fd);
    const locked = addon.lockExclusiveNonblocking(handle.fd);
    const unlocked = addon.unlock(handle.fd);
    assertLocked(locked, "ROUND6_REGULAR_GATE_LOCK_FAILED");
    assertLocked(unlocked, "ROUND6_REGULAR_GATE_UNLOCK_FAILED");
    return { identity, locked, unlocked };
  } finally {
    await handle.close();
  }
}

async function probeCrossProcess(addonPath, root) {
  const gatePath = await createRegularGate(root, "cross-process-gate");
  const owner = startWorker(addonPath, gatePath);
  const ownerAttempt = await owner.attempt;
  assertLocked(ownerAttempt.lock, "ROUND6_CROSS_PROCESS_OWNER_LOCK_FAILED");

  const contender = startWorker(addonPath, gatePath);
  const contenderAttempt = await contender.attempt;
  assertWouldBlock(contenderAttempt.lock, "ROUND6_CROSS_PROCESS_NOT_EWOULDBLOCK");
  const contenderOutput = await expectWorkerExit(contender, 0, null, "ROUND6_CROSS_PROCESS_CONTENDER_EXIT");
  const ownerOutput = await releaseWorker(owner, "ROUND6_CROSS_PROCESS_OWNER_RELEASE");

  return { ownerAttempt, contenderAttempt, ownerOutput, contenderOutput };
}

async function probeSigkillRecovery(addonPath, root) {
  const gatePath = await createRegularGate(root, "sigkill-gate");
  const owner = startWorker(addonPath, gatePath);
  const ownerAttempt = await owner.attempt;
  assertLocked(ownerAttempt.lock, "ROUND6_SIGKILL_OWNER_LOCK_FAILED");

  requireCondition(owner.child.kill("SIGKILL"), "ROUND6_SIGKILL_DELIVERY_FAILED");
  const ownerOutput = await expectWorkerExit(owner, null, "SIGKILL", "ROUND6_SIGKILL_OWNER_EXIT");
  const afterOwnerDeath = identityOf(await lstat(gatePath));
  requireCondition(
    sameIdentity(ownerAttempt.identity, afterOwnerDeath),
    "ROUND6_SIGKILL_PATH_IDENTITY_CHANGED_BEFORE_WAITER",
  );

  const waiter = startWorker(addonPath, gatePath);
  const waiterAttempt = await waiter.attempt;
  assertLocked(waiterAttempt.lock, "ROUND6_SIGKILL_WAITER_LOCK_FAILED");
  requireCondition(
    sameIdentity(ownerAttempt.identity, waiterAttempt.identity),
    "ROUND6_SIGKILL_WAITER_LOCKED_DIFFERENT_INODE",
  );
  const waiterOutput = await releaseWorker(waiter, "ROUND6_SIGKILL_WAITER_RELEASE");

  return { ownerAttempt, ownerOutput, afterOwnerDeath, waiterAttempt, waiterOutput };
}

async function probeSameProcess(addon, addonPath, root) {
  const gatePath = await createRegularGate(root, "same-process-gate");
  const first = await open(gatePath, constants.O_RDWR | constants.O_NOFOLLOW);
  const second = await open(gatePath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const firstLock = addon.lockExclusiveNonblocking(first.fd);
    assertLocked(firstLock, "ROUND6_SAME_PROCESS_FIRST_LOCK_FAILED");
    const secondInitialAttempt = addon.lockExclusiveNonblocking(second.fd);
    assertWouldBlock(secondInitialAttempt, "ROUND6_SAME_PROCESS_NOT_EWOULDBLOCK");
    const firstUnlock = addon.unlock(first.fd);
    assertLocked(firstUnlock, "ROUND6_SAME_PROCESS_FIRST_UNLOCK_FAILED");
    const secondAfterRelease = addon.lockExclusiveNonblocking(second.fd);
    assertLocked(secondAfterRelease, "ROUND6_SAME_PROCESS_SECOND_LOCK_AFTER_RELEASE_FAILED");
    const secondUnlock = addon.unlock(second.fd);
    assertLocked(secondUnlock, "ROUND6_SAME_PROCESS_SECOND_UNLOCK_FAILED");
    return {
      firstIdentity: addon.inspect(first.fd),
      secondIdentity: addon.inspect(second.fd),
      firstLock,
      secondInitialAttempt,
      firstUnlock,
      secondAfterRelease,
      secondUnlock,
    };
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

async function probeDirectoryFd(addon, root) {
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const identity = addon.inspect(handle.fd);
    const locked = addon.lockExclusiveNonblocking(handle.fd);
    const unlocked = addon.unlock(handle.fd);
    assertLocked(locked, "ROUND6_DIRECTORY_FD_LOCK_FAILED");
    assertLocked(unlocked, "ROUND6_DIRECTORY_FD_UNLOCK_FAILED");
    return { identity, locked, unlocked };
  } finally {
    await handle.close();
  }
}

async function probeProjectControlledReplacement(addonPath, root) {
  const controlledRoot = path.join(root, "controlled-root");
  await mkdir(controlledRoot, { mode: 0o700 });
  const parentBefore = identityOf(await lstat(controlledRoot));
  const gatePath = await createRegularGate(controlledRoot, "gate");
  const owner = startWorker(addonPath, gatePath);
  const ownerAttempt = await owner.attempt;
  assertLocked(ownerAttempt.lock, "ROUND6_REPLACEMENT_OWNER_LOCK_FAILED");
  const originalGate = identityOf(await lstat(gatePath));
  const archivedGatePath = path.join(controlledRoot, "gate.pre-replacement");
  await rename(gatePath, archivedGatePath);
  await createRegularGate(controlledRoot, "gate");
  const replacementGate = identityOf(await lstat(gatePath));
  const parentAfter = identityOf(await lstat(controlledRoot));
  requireCondition(
    sameIdentity(parentBefore, parentAfter),
    "ROUND6_REPLACEMENT_PARENT_IDENTITY_CHANGED",
  );
  requireCondition(
    !sameIdentity(originalGate, replacementGate),
    "ROUND6_REPLACEMENT_GATE_IDENTITY_NOT_CHANGED",
  );

  const replacementOwner = startWorker(addonPath, gatePath);
  const replacementAttempt = await replacementOwner.attempt;
  assertLocked(replacementAttempt.lock, "ROUND6_REPLACEMENT_NEW_GATE_LOCK_FAILED");
  const replacementOutput = await releaseWorker(
    replacementOwner,
    "ROUND6_REPLACEMENT_NEW_GATE_RELEASE",
  );
  const originalOutput = await releaseWorker(owner, "ROUND6_REPLACEMENT_ORIGINAL_GATE_RELEASE");

  return {
    parentBefore,
    parentAfter,
    originalGate,
    replacementGate,
    ownerAttempt,
    replacementAttempt,
    dualWinnerObserved: true,
    originalOutput,
    replacementOutput,
  };
}

function quantile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

async function probePerformance(addon, root) {
  const gatePath = await createRegularGate(root, "performance-gate");
  const expected = identityOf(await lstat(gatePath));
  const samplesMilliseconds = [];
  for (let index = 0; index < 30; index += 1) {
    const startedAt = process.hrtime.bigint();
    const handle = await open(gatePath, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      requireCondition(
        sameIdentity(addon.inspect(handle.fd), expected),
        "ROUND6_PERFORMANCE_GATE_IDENTITY_CHANGED",
      );
      const locked = addon.lockExclusiveNonblocking(handle.fd);
      assertLocked(locked, "ROUND6_PERFORMANCE_LOCK_FAILED");
      const unlocked = addon.unlock(handle.fd);
      assertLocked(unlocked, "ROUND6_PERFORMANCE_UNLOCK_FAILED");
    } finally {
      await handle.close();
    }
    samplesMilliseconds.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
  }
  return {
    sampleCount: samplesMilliseconds.length,
    samplesMilliseconds,
    p50Milliseconds: quantile(samplesMilliseconds, 0.5),
    p95Milliseconds: quantile(samplesMilliseconds, 0.95),
  };
}

async function main() {
  const [addonPath] = process.argv.slice(2);
  if (typeof addonPath !== "string") throw new Error("ROUND6_DIAGNOSTIC_ARGUMENTS_INVALID");
  const addon = require(addonPath);
  const root = await mkdtemp(path.join(os.tmpdir(), "round6-flock-probe-"));
  try {
    const report = {
      addonPath,
      platform: process.platform,
      arch: process.arch,
      wouldBlockErrnos: [...wouldBlockErrnos],
      regularGate: await probeRegularGate(addon, root),
      crossProcess: await probeCrossProcess(addonPath, root),
      sigkillRecovery: await probeSigkillRecovery(addonPath, root),
      sameProcessIndependentFds: await probeSameProcess(addon, addonPath, root),
      directoryFd: await probeDirectoryFd(addon, root),
      projectControlledReplacement: await probeProjectControlledReplacement(addonPath, root),
      performance: await probePerformance(addon, root),
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    stage: "diagnostic-failed",
    code: error && typeof error === "object" ? error.code ?? null : null,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  })}\n`);
  process.exitCode = 1;
});
