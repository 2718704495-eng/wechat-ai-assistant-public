#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { acquireKernelLease } from "./kernel-lock-runtime.mjs";
import {
  validateInstalledRuntimeV2,
  validatePayloadManifest,
  validateReleasePayload,
} from "./release-payload.mjs";

const modulePath = fileURLToPath(import.meta.url);
const runtimeBasename = "runtime-v2";
const journalFilename = "release-transaction.json";
const archiveDirectoryName = "release-transaction-archive";

export async function upgradeRuntimeV2(options, hooks = {}) {
  assertOptions(options, hooks);
  const runtimeRoot = normalizedAbsolute(options.runtimeRoot, "RUNTIME_V2_UPGRADE_ROOT_INVALID");
  const candidateRoot = normalizedAbsolute(
    options.candidateRoot,
    "RUNTIME_V2_UPGRADE_CANDIDATE_INVALID",
  );
  if (path.basename(runtimeRoot) !== runtimeBasename || options.automationStatus !== "PAUSED") {
    throw new Error("RUNTIME_V2_UPGRADE_ADMISSION_INVALID");
  }
  if (pathsOverlap(runtimeRoot, candidateRoot)) {
    throw new Error("RUNTIME_V2_UPGRADE_PATH_OVERLAP");
  }

  const [runtimeIdentity, candidateIdentity] = await Promise.all([
    lstat(runtimeRoot),
    lstat(candidateRoot),
  ]).catch((error) => {
    throw new Error("RUNTIME_V2_UPGRADE_INPUT_INVALID", { cause: error });
  });
  if (!runtimeIdentity.isDirectory() || runtimeIdentity.isSymbolicLink() ||
      runtimeIdentity.uid !== process.getuid?.() || (runtimeIdentity.mode & 0o777) !== 0o700 ||
      !candidateIdentity.isDirectory() || candidateIdentity.isSymbolicLink()) {
    throw new Error("RUNTIME_V2_UPGRADE_INPUT_INVALID");
  }
  if (candidateIdentity.uid !== process.getuid?.()) {
    throw new Error("RUNTIME_V2_UPGRADE_INPUT_INVALID");
  }

  const before = await validateInstalledCurrentIntegrity(runtimeRoot);
  const candidate = await validateReleasePayload({ payloadRoot: candidateRoot });
  if (before.manifestSha256 === candidate.manifestSha256) {
    return Object.freeze({
      status: "already-current",
      manifestSha256: before.manifestSha256,
      previousManifestSha256: before.manifestSha256,
      currentTarget: await readlink(path.join(runtimeRoot, "current")),
      previousTarget: await readlink(path.join(runtimeRoot, "current")),
    });
  }

  let installerLease;
  let liveLease;
  let operationError;
  let result;
  try {
    installerLease = await acquireKernelLease({ dataRoot: runtimeRoot, purpose: "release-installer" });
    liveLease = await acquireKernelLease({ dataRoot: runtimeRoot, purpose: "live-operation" });
    result = await performUpgrade({
      runtimeRoot,
      candidateRoot,
      automationStatus: options.automationStatus,
      expectedBefore: before,
      expectedCandidate: candidate,
      hooks,
    });
  } catch (error) {
    operationError = error;
  }

  const closeErrors = [];
  for (const lease of [liveLease, installerLease]) {
    if (lease === undefined) continue;
    try {
      await lease.close();
    } catch (error) {
      closeErrors.push(asError(error));
    }
  }
  const finalError = combineErrors(operationError, ...closeErrors);
  if (finalError !== null) throw finalError;
  if (result === undefined) throw new Error("RUNTIME_V2_UPGRADE_RESULT_MISSING");
  return result;
}

async function performUpgrade(input) {
  const currentPath = path.join(input.runtimeRoot, "current");
  const releaseStore = path.join(input.runtimeRoot, ".releases");
  const stateDirectory = path.join(input.runtimeRoot, "state");
  const journalPath = path.join(stateDirectory, journalFilename);
  const transactionId = randomUUID();
  const previousTarget = await readlink(currentPath);
  const previousIdentity = await symlinkIdentity(currentPath);
  const previousRelease = await realpath(currentPath);
  if (previousRelease !== await realpath(input.expectedBefore.releaseRoot)) {
    throw new Error("RUNTIME_V2_UPGRADE_CURRENT_DRIFT");
  }
  const releaseName = `release-${input.expectedCandidate.manifestSha256.slice(0, 16)}-${transactionId}`;
  const currentTarget = `.releases/${releaseName}`;
  const releaseRoot = path.join(releaseStore, releaseName);
  const nextPointerName = `current.next-${transactionId}`;
  const nextPointerPath = path.join(input.runtimeRoot, nextPointerName);
  const stateIdentity = await directoryIdentity(stateDirectory);
  let journal = {
    version: 1,
    kind: "runtime-v2-upgrade",
    txid: transactionId,
    phase: "intent-recorded",
    automationStatus: input.automationStatus,
    previousTarget,
    previousManifestSha256: input.expectedBefore.manifestSha256,
    currentTarget,
    currentManifestSha256: input.expectedCandidate.manifestSha256,
    releaseName,
    state: stateIdentity,
  };
  let switched = false;
  await createJournal(journalPath, journal);
  try {
    await input.hooks.beforeCopy?.();
    await assertCurrentBound(currentPath, previousTarget, previousIdentity, previousRelease);
    await cp(input.candidateRoot, releaseRoot, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
      verbatimSymlinks: true,
    });
    await chmod(releaseRoot, 0o555);
    await syncDirectory(releaseStore);
    const staged = await validateReleasePayload({ payloadRoot: releaseRoot });
    if (staged.manifestSha256 !== input.expectedCandidate.manifestSha256) {
      throw new Error("RUNTIME_V2_UPGRADE_STAGED_INVALID");
    }
    journal = await replaceJournal(journalPath, { ...journal, phase: "release-validated" });

    await input.hooks.beforeCurrentSwitch?.({ currentPath, releaseRoot });
    await assertCurrentBound(currentPath, previousTarget, previousIdentity, previousRelease);
    const finalStaged = await validateReleasePayload({ payloadRoot: releaseRoot });
    if (finalStaged.manifestSha256 !== input.expectedCandidate.manifestSha256) {
      throw new Error("RUNTIME_V2_UPGRADE_STAGED_DRIFT");
    }
    await symlink(currentTarget, nextPointerPath);
    await syncDirectory(input.runtimeRoot);
    journal = await replaceJournal(journalPath, { ...journal, phase: "ready-to-switch" });
    await assertCurrentBound(currentPath, previousTarget, previousIdentity, previousRelease);
    await rename(nextPointerPath, currentPath);
    switched = true;
    await syncDirectory(input.runtimeRoot);
    journal = await replaceJournal(journalPath, { ...journal, phase: "current-switched" });

    await input.hooks.afterCurrentSwitch?.({ currentPath, releaseRoot });
    const installed = await validateInstalledRuntimeV2({ runtimeRoot: input.runtimeRoot });
    if (installed.manifestSha256 !== input.expectedCandidate.manifestSha256 ||
        await readlink(currentPath) !== currentTarget ||
        await realpath(currentPath) !== await realpath(releaseRoot)) {
      throw new Error("RUNTIME_V2_UPGRADE_INSTALLED_INVALID");
    }
    await assertStateIdentity(stateDirectory, stateIdentity);
    journal = await replaceJournal(journalPath, { ...journal, phase: "installed-validated" });
    const receiptName = `upgrade-receipt-${transactionId}.json`;
    await writeDurableNewFile(stateDirectory, receiptName, `${JSON.stringify({
      version: 1,
      txid: transactionId,
      status: "installed",
      previousTarget,
      previousManifestSha256: input.expectedBefore.manifestSha256,
      currentTarget,
      currentManifestSha256: installed.manifestSha256,
      state: stateIdentity,
    })}\n`);
    journal = await replaceJournal(journalPath, { ...journal, phase: "complete" });
    await archiveJournal(stateDirectory, journalPath, transactionId, "complete");
    return Object.freeze({
      status: "installed",
      manifestSha256: installed.manifestSha256,
      previousManifestSha256: input.expectedBefore.manifestSha256,
      currentTarget,
      previousTarget,
      receipt: `state/${receiptName}`,
    });
  } catch (error) {
    let rollbackError;
    if (switched) {
      try {
        const rollbackPointer = path.join(input.runtimeRoot, `current.rollback-${transactionId}`);
        await validateReleasePayload({ payloadRoot: previousRelease });
        await symlink(previousTarget, rollbackPointer);
        await syncDirectory(input.runtimeRoot);
        await rename(rollbackPointer, currentPath);
        await syncDirectory(input.runtimeRoot);
        const restored = await validateInstalledCurrentIntegrity(input.runtimeRoot);
        if (restored.manifestSha256 !== input.expectedBefore.manifestSha256) {
          throw new Error("RUNTIME_V2_UPGRADE_ROLLBACK_INVALID");
        }
        journal = await replaceJournal(journalPath, { ...journal, phase: "rolled-back" });
        await archiveJournal(stateDirectory, journalPath, transactionId, "rolled-back");
      } catch (caught) {
        rollbackError = caught;
      }
    } else {
      try {
        await assertCurrentBound(currentPath, previousTarget, previousIdentity, previousRelease);
        journal = await replaceJournal(journalPath, { ...journal, phase: "aborted-before-switch" });
        await archiveJournal(stateDirectory, journalPath, transactionId, "aborted-before-switch");
      } catch (caught) {
        rollbackError = caught;
      }
    }
    throw combineErrors(error, rollbackError) ?? asError(error);
  }
}

export async function validateInstalledCurrentIntegrity(runtimeRoot) {
  const currentPath = path.join(runtimeRoot, "current");
  const currentIdentity = await lstat(currentPath);
  if (!currentIdentity.isSymbolicLink() || currentIdentity.uid !== process.getuid?.() ||
      currentIdentity.nlink !== 1) {
    throw new Error("RUNTIME_V2_UPGRADE_CURRENT_INVALID");
  }
  const target = await readlink(currentPath);
  if (path.isAbsolute(target) || target.includes("\0") || target.includes("..") ||
      !target.startsWith(".releases/release-")) {
    throw new Error("RUNTIME_V2_UPGRADE_CURRENT_INVALID");
  }
  const [releaseRoot, releaseStore] = await Promise.all([
    realpath(currentPath),
    realpath(path.join(runtimeRoot, ".releases")),
  ]);
  const relative = path.relative(releaseStore, releaseRoot);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("RUNTIME_V2_UPGRADE_CURRENT_INVALID");
  }
  const validation = await validatePayloadManifest({ payloadRoot: releaseRoot });
  return Object.freeze({
    manifestSha256: validation.manifestSha256,
    releaseRoot,
  });
}

async function assertCurrentBound(currentPath, expectedTarget, expectedIdentity, expectedRelease) {
  const [identity, target, release] = await Promise.all([
    symlinkIdentity(currentPath),
    readlink(currentPath),
    realpath(currentPath),
  ]).catch((error) => {
    throw new Error("RUNTIME_V2_UPGRADE_CURRENT_DRIFT", { cause: error });
  });
  if (target !== expectedTarget || release !== expectedRelease ||
      identity.dev !== expectedIdentity.dev || identity.ino !== expectedIdentity.ino ||
      identity.uid !== expectedIdentity.uid || identity.mode !== expectedIdentity.mode ||
      identity.nlink !== expectedIdentity.nlink) {
    throw new Error("RUNTIME_V2_UPGRADE_CURRENT_DRIFT");
  }
}

async function symlinkIdentity(value) {
  const identity = await lstat(value, { bigint: true });
  if (!identity.isSymbolicLink() || identity.uid !== BigInt(process.getuid?.() ?? -1) ||
      identity.nlink !== 1n) {
    throw new Error("RUNTIME_V2_UPGRADE_CURRENT_INVALID");
  }
  return Object.freeze({
    dev: String(identity.dev),
    ino: String(identity.ino),
    uid: Number(identity.uid),
    mode: Number(identity.mode),
    nlink: Number(identity.nlink),
  });
}

async function directoryIdentity(value) {
  const identity = await lstat(value, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() ||
      identity.uid !== BigInt(process.getuid?.() ?? -1)) {
    throw new Error("RUNTIME_V2_UPGRADE_STATE_INVALID");
  }
  return Object.freeze({
    dev: String(identity.dev),
    ino: String(identity.ino),
    uid: Number(identity.uid),
    mode: Number(identity.mode),
  });
}

async function assertStateIdentity(stateDirectory, expected) {
  const actual = await directoryIdentity(stateDirectory);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino ||
      actual.uid !== expected.uid || actual.mode !== expected.mode) {
    throw new Error("RUNTIME_V2_UPGRADE_STATE_DRIFT");
  }
}

async function createJournal(journalPath, value) {
  await writeFile(journalPath, serialize(value), { flag: "wx", mode: 0o600 });
  const handle = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(journalPath));
}

async function replaceJournal(journalPath, value) {
  const temporary = `${journalPath}.next-${randomUUID()}`;
  await writeFile(temporary, serialize(value), { flag: "wx", mode: 0o600 });
  const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, journalPath);
  await syncDirectory(path.dirname(journalPath));
  return value;
}

async function archiveJournal(stateDirectory, journalPath, txid, suffix) {
  const archiveDirectory = path.join(stateDirectory, archiveDirectoryName);
  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  const archiveIdentity = await lstat(archiveDirectory);
  if (!archiveIdentity.isDirectory() || archiveIdentity.isSymbolicLink() ||
      archiveIdentity.uid !== process.getuid?.() || (archiveIdentity.mode & 0o777) !== 0o700) {
    throw new Error("RUNTIME_V2_UPGRADE_ARCHIVE_INVALID");
  }
  await rename(journalPath, path.join(archiveDirectory, `upgrade-${txid}-${suffix}.json`));
  await Promise.all([syncDirectory(stateDirectory), syncDirectory(archiveDirectory)]);
}

async function writeDurableNewFile(directory, name, contents) {
  const target = path.join(directory, name);
  await writeFile(target, contents, { flag: "wx", mode: 0o600 });
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serialize(value) {
  return `${JSON.stringify(value)}\n`;
}

function normalizedAbsolute(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value ||
      value.includes("\0")) {
    throw new Error(code);
  }
  return value;
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ||
    (!reverse.startsWith("..") && !path.isAbsolute(reverse));
}

function assertOptions(options, hooks) {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      Reflect.ownKeys(options).map(String).sort().join(",") !==
        "automationStatus,candidateRoot,runtimeRoot" ||
      hooks === null || typeof hooks !== "object" || Array.isArray(hooks) ||
      Reflect.ownKeys(hooks).some((key) =>
        !["afterCurrentSwitch", "beforeCopy", "beforeCurrentSwitch"].includes(String(key)) ||
        typeof hooks[key] !== "function")) {
    throw new Error("RUNTIME_V2_UPGRADE_ARGUMENT_INVALID");
  }
}

function combineErrors(...values) {
  const errors = values.filter((value) => value !== undefined && value !== null).map(asError);
  if (errors.length === 0) return null;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, "RUNTIME_V2_UPGRADE_FAILED");
}

function asError(value) {
  return value instanceof Error ? value : new Error("RUNTIME_V2_UPGRADE_FAILED");
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = await upgradeRuntimeV2({
      runtimeRoot: args["--runtime-root"],
      candidateRoot: args["--candidate"],
      automationStatus: args["--automation-status"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("RUNTIME_V2_UPGRADE_FAILED\n");
    process.exitCode = 1;
  }
}

function parseArguments(argv) {
  if (argv.length !== 6) throw new Error("RUNTIME_V2_UPGRADE_ARGUMENT_INVALID");
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--runtime-root", "--candidate", "--automation-status"].includes(key) ||
        typeof value !== "string" || Object.hasOwn(result, key)) {
      throw new Error("RUNTIME_V2_UPGRADE_ARGUMENT_INVALID");
    }
    result[key] = value;
  }
  return result;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === modulePath) {
  await main();
}
