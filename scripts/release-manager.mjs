import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  acquireKernelLease,
  acquireReleaseMaintenanceKernelLease,
  archiveFileNoReplace,
  initializeKernelLockCatalogForInstaller,
} from "./kernel-lock-runtime.mjs";

const maximumTransactionJournalBytes = 32_768;
const transactionDecisionMaximumAgeMs = 60_000;
const transactionJournalFilename = "release-transaction.json";
const transactionArchiveDirectoryName = "release-transaction-archive";
const manifestSha256Pattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const processStartedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const consumedTransactionDecisions = new Set();
const retainedKernelLeases = new Set();
const genuineMaintenanceLeases = new WeakSet();
const genuineInstallerLeases = new WeakSet();
const genuineMutationCapabilities = new WeakSet();
const execFileAsync = promisify(execFile);

export function createCommitDecisionGate(options) {
  assertCommitGateOptions(options);
  let accepted = false;

  return {
    accept(serialized) {
      if (accepted) throw new Error("RELEASE_COMMIT_DECISION_REPLAYED");

      const decision = parseCommitDecision(serialized);
      const observedAt = Date.parse(decision.automationObservation.observedAt);
      const requestedAt = Date.parse(options.requestedAt);
      const now = options.now().getTime();
      const matchesSession =
        decision.txid === options.txid &&
        decision.maintenanceNonce === options.maintenanceNonce &&
        decision.automationObservation.requestId === options.automationRequestId;
      const isFresh =
        observedAt >= requestedAt &&
        observedAt <= now &&
        now - observedAt <= options.maximumAgeMs;

      if (!matchesSession || !isFresh) {
        throw new Error("RELEASE_COMMIT_DECISION_INVALID");
      }

      accepted = true;
      return decision;
    },
  };
}

export async function acquireMaintenanceLease(options) {
  await initializeKernelLockCatalogForInstaller({ dataRoot: path.resolve(options.runtimeRoot) });
  const staged = await stageMaintenanceLease(options);
  try {
    return await staged.publish();
  } catch (error) {
    await staged.discard();
    throw error;
  }
}

export async function migrateLegacyRound4LockArtifacts(options) {
  if (typeof options?.runtimeRoot !== "string" || options.runtimeRoot.length === 0 ||
      typeof options?.transactionJournalPath !== "string" ||
      typeof options?.inspectLegacyOwner !== "function" ||
      options.maintenanceLease?.purpose !== "release-maintenance" ||
      !genuineMaintenanceLeases.has(options.maintenanceLease)) {
    if (options?.maintenanceLease?.purpose === "release-maintenance") {
      throw new Error("RELEASE_MUTATION_CAPABILITY_INVALID");
    }
    throw new Error("RELEASE_LEGACY_MIGRATION_INVALID");
  }
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const journalPath = path.resolve(options.transactionJournalPath);
  if (!isStrictDescendant(runtimeRoot, journalPath)) {
    throw new Error("RELEASE_LEGACY_MIGRATION_INVALID");
  }
  const journal = parseRound6LegacyMigrationJournal(await readFile(journalPath, "utf8"));
  const stateDirectory = path.join(runtimeRoot, "state");
  const archiveDirectory = path.join(stateDirectory, "round6-legacy-lock-archive");
  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  const archived = new Set(journal.legacyMigration.archived);
  const archiveRecords = Array.isArray(journal.legacyMigration.archiveRecords)
    ? journal.legacyMigration.archiveRecords
    : [];

  for (const [index, relativePath] of journal.legacyMigration.artifacts.entries()) {
    const sourcePath = path.resolve(runtimeRoot, relativePath);
    const destinationName = `${index}-${path.basename(relativePath)}`;
    const destinationPath = path.join(archiveDirectory, destinationName);
    const [source, destination] = await Promise.all([
      readRegularFileIdentityOrNull(sourcePath),
      readRegularFileIdentityOrNull(destinationPath),
    ]);
    if (source !== null && destination !== null) {
      throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
    }
    if (source === null && destination === null) {
      throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
    }
    if (source === null) {
      const record = archiveRecords.find((candidate) => candidate.source === relativePath);
      if (!archived.has(relativePath) || record === undefined ||
          record.destination !== destinationName || record.device !== String(destination.dev) ||
          record.inode !== String(destination.ino)) {
        throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
      }
      continue;
    }
    if (archived.has(relativePath)) throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
    let metadata;
    try {
      metadata = JSON.parse(await readFile(sourcePath, "utf8"));
    } catch (error) {
      throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS", { cause: error });
    }
    const owner = await options.inspectLegacyOwner(metadata);
    if (owner === "alive") throw new Error("RELEASE_LEGACY_OWNER_LIVE");
    if (owner !== "dead") throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
    await archiveFileNoReplace({
      sourcePath,
      archiveDirectory,
      archiveName: destinationName,
    });
    const archivedIdentity = await readRegularFileIdentityOrNull(destinationPath);
    if (archivedIdentity === null || archivedIdentity.dev !== source.dev ||
        archivedIdentity.ino !== source.ino) {
      throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
    }
    archived.add(relativePath);
    archiveRecords.push({
      source: relativePath,
      destination: destinationName,
      device: String(source.dev),
      inode: String(source.ino),
    });
    journal.legacyMigration.archived = [...archived];
    journal.legacyMigration.archiveRecords = archiveRecords;
    journal.legacyMigration.status = "in-progress";
    await writeRound6LegacyMigrationJournal(journalPath, journal);
    await options.hook?.(`legacy-artifact-archived:${index}`);
  }
  journal.legacyMigration.status = "complete";
  await writeRound6LegacyMigrationJournal(journalPath, journal);
  return { archived: journal.legacyMigration.artifacts, status: "complete" };
}

async function migrateLegacyArtifactsForMaintenance(options) {
  const stateDirectory = path.join(options.runtimeRoot, "state");
  const journalPath = path.join(
    stateDirectory,
    `round6-legacy-migration-${options.txid}.json`,
  );
  try {
    await lstat(journalPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    const journal = {
      version: 1,
      txid: options.txid,
      maintenanceNonce: options.maintenanceNonce,
      phase: "maintenance",
      legacyMigration: {
        version: 1,
        status: "pending",
        artifacts: await inventoryBoundedLegacyArtifacts(stateDirectory),
        archived: [],
      },
    };
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const handle = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(stateDirectory);
  }
  try {
    return await migrateLegacyRound4LockArtifacts({
      runtimeRoot: options.runtimeRoot,
      transactionJournalPath: journalPath,
      maintenanceLease: options.maintenanceLease,
      inspectLegacyOwner: async (metadata) => {
        if (!isLegacyOwnerMetadata(metadata)) return "unknown";
        const owner = await inspectProcessOwnerIdentity(metadata);
        return owner === "alive-exact" ? "alive" : owner === "dead" ? "dead" : "unknown";
      },
      hook: options.hook,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "RELEASE_LEGACY_OWNER_LIVE") {
      throw new Error("RELEASE_RUNTIME_BUSY", { cause: error });
    }
    throw error;
  }
}

async function inventoryBoundedLegacyArtifacts(stateDirectory) {
  const entries = await readdir(stateDirectory, { withFileTypes: true });
  const artifacts = entries
    .filter((entry) => entry.isFile() && isBoundedLegacyArtifactPath(`state/${entry.name}`))
    .map((entry) => `state/${entry.name}`)
    .sort();
  if (artifacts.length > 64) throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
  return artifacts;
}

function isLegacyOwnerMetadata(metadata) {
  return typeof metadata === "object" && metadata !== null &&
    Number.isSafeInteger(metadata.pid) && metadata.pid > 0 &&
    typeof metadata.processStartedAt === "string" && isIsoDateTime(metadata.processStartedAt);
}

function parseRound6LegacyMigrationJournal(serialized) {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      value.version !== 1 || typeof value.txid !== "string" ||
      typeof value.maintenanceNonce !== "string" || typeof value.phase !== "string" ||
      typeof value.legacyMigration !== "object" || value.legacyMigration === null ||
      Array.isArray(value.legacyMigration) || value.legacyMigration.version !== 1 ||
      !["pending", "in-progress", "complete"].includes(value.legacyMigration.status) ||
      !Array.isArray(value.legacyMigration.artifacts) ||
      !Array.isArray(value.legacyMigration.archived)) {
    throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
  }
  assertUuid(value.txid);
  assertUuid(value.maintenanceNonce);
  const artifacts = value.legacyMigration.artifacts;
  const archived = value.legacyMigration.archived;
  if (new Set(artifacts).size !== artifacts.length || new Set(archived).size !== archived.length ||
      !artifacts.every(isBoundedLegacyArtifactPath) ||
      !archived.every((artifact) => artifacts.includes(artifact))) {
    throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
  }
  return value;
}

function isBoundedLegacyArtifactPath(value) {
  return typeof value === "string" &&
    value !== "state/release-install.lock" &&
    value !== "state/live-operation.lock" && (
    /^state\/[a-z0-9][a-z0-9.-]*\.lock$/u.test(value) ||
    /^state\/\.[a-z0-9][a-z0-9.-]*\.lock\.recovery\.claim$/u.test(value) ||
    /^state\/\.[a-z0-9][a-z0-9.-]*\.lock\.recovery-[a-z0-9-]+\.candidate$/u.test(value)
  );
}

async function readRegularFileIdentityOrNull(filePath) {
  try {
    const identity = await lstat(filePath);
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
    }
    return identity;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectoryPath(directoryPath) {
  const handle = await open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeRound6LegacyMigrationJournal(journalPath, journal) {
  const directory = path.dirname(journalPath);
  const temporary = path.join(directory, `.${path.basename(journalPath)}.${randomUUID()}.round6.tmp`);
  let handle;
  try {
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.sync();
    const existing = await lstat(journalPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("RELEASE_LEGACY_MIGRATION_AMBIGUOUS");
    }
    await rename(temporary, journalPath);
    await syncDirectoryPath(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function stageMaintenanceLease(options) {
  assertUuid(options?.txid);
  assertUuid(options?.maintenanceNonce);
  if (typeof options?.runtimeRoot !== "string" || options.runtimeRoot.length === 0) {
    throw new Error("RELEASE_MAINTENANCE_LEASE_INVALID");
  }
  try {
    const kernelLease = await acquireReleaseMaintenanceKernelLease({
      dataRoot: path.resolve(options.runtimeRoot),
      expectedTransactionJournalSha256: options.transactionJournalSha256 ?? null,
    });
    return new StagedMaintenanceLease({
      kernelLease,
      metadata: {
        version: 2,
        purpose: "release-maintenance",
        txid: options.txid,
        maintenanceNonce: options.maintenanceNonce,
        pid: process.pid,
        processStartedAt,
        acquiredAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "KERNEL_LOCK_BUSY") {
      throw new Error("RELEASE_RUNTIME_BUSY", { cause: error });
    }
    throw error;
  }
}

async function acquireInstallerLease(options) {
  assertUuid(options?.txid);
  if (typeof options?.runtimeRoot !== "string" || options.runtimeRoot.length === 0) {
    throw new Error("RELEASE_INSTALLER_LEASE_INVALID");
  }
  const operation = options.operation;
  const installerNonce = options.installerNonce ?? randomUUID();
  const previousInstallerNonce = options.previousInstallerNonce ?? null;
  const transactionJournalSha256 = options.transactionJournalSha256 ?? null;
  if (!["install", "rollback"].includes(operation)) {
    throw new Error("RELEASE_INSTALLER_LEASE_INVALID");
  }
  assertUuid(installerNonce);
  if (previousInstallerNonce !== null) assertUuid(previousInstallerNonce);
  if (
    transactionJournalSha256 !== null
    && !manifestSha256Pattern.test(transactionJournalSha256)
  ) {
    throw new Error("RELEASE_INSTALLER_LEASE_INVALID");
  }
  try {
    await initializeKernelLockCatalogForInstaller({ dataRoot: path.resolve(options.runtimeRoot) });
    const kernelLease = await acquireKernelLease({
      dataRoot: path.resolve(options.runtimeRoot),
      purpose: "release-installer",
    });
    return new PersistentInstallerLease({
      kernelLease,
      metadata: {
        version: 2,
        purpose: "release-installer",
        operation,
        txid: options.txid,
        installerNonce,
        previousInstallerNonce,
        transactionJournalSha256,
        pid: process.pid,
        processStartedAt,
        acquiredAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "KERNEL_LOCK_BUSY") {
      throw new Error("RELEASE_INSTALLER_BUSY", { cause: error });
    }
    throw error;
  }
}

export async function resolveValidatedPreviousRelease(options) {
  try {
    if (
      typeof options?.runtimeRoot !== "string" ||
      options.runtimeRoot.length === 0 ||
      typeof options.validateRelease !== "function"
    ) {
      throw new Error("INVALID_ROLLBACK_OPTIONS");
    }

    const runtimeRoot = await realpath(path.resolve(options.runtimeRoot));
    const releaseStore = path.join(runtimeRoot, ".releases");
    const storeIdentity = await lstat(releaseStore);
    if (!storeIdentity.isDirectory() || storeIdentity.isSymbolicLink()) {
      throw new Error("INVALID_RELEASE_STORE");
    }
    const realReleaseStore = await realpath(releaseStore);

    const previousPointer = path.join(runtimeRoot, "bin.previous");
    const pointerIdentity = await lstat(previousPointer);
    if (!pointerIdentity.isSymbolicLink()) {
      throw new Error("INVALID_PREVIOUS_POINTER");
    }

    const pointerTarget = await readlink(previousPointer);
    if (pointerTarget.length === 0 || path.isAbsolute(pointerTarget) || pointerTarget.includes("\0")) {
      throw new Error("INVALID_PREVIOUS_TARGET");
    }
    const lexicalTarget = path.resolve(path.dirname(previousPointer), pointerTarget);
    if (!isStrictDescendant(realReleaseStore, lexicalTarget)) {
      throw new Error("PREVIOUS_TARGET_OUTSIDE_RELEASE_STORE");
    }

    const targetIdentity = await lstat(lexicalTarget);
    if (!targetIdentity.isDirectory() || targetIdentity.isSymbolicLink()) {
      throw new Error("INVALID_PREVIOUS_RELEASE_ROOT");
    }
    const releaseRoot = await realpath(lexicalTarget);
    if (!isStrictDescendant(realReleaseStore, releaseRoot)) {
      throw new Error("PREVIOUS_REALPATH_OUTSIDE_RELEASE_STORE");
    }

    await options.validateRelease(releaseRoot);
    return releaseRoot;
  } catch (error) {
    throw new Error("NO_VALIDATED_PREVIOUS_RELEASE", { cause: error });
  }
}

export async function installValidatedCandidate(options) {
  const context = prepareTransactionContext(options, true);
  const candidateRoot = await assertControlledStagingCandidate(
    context.runtimeRoot,
    path.resolve(options.candidateRoot),
  );
  const candidateIdentity = await immutableDirectoryIdentity(candidateRoot);
  const candidateManifestSha256 = manifestSha256FromValidation(
    await options.validateRelease(candidateRoot),
  );
  await assertDirectoryIdentity(candidateRoot, candidateIdentity, true);
  const installerLease = await acquireInstallerLease({
    runtimeRoot: context.runtimeRoot,
    txid: context.session.txid,
    operation: "install",
  });
  let lease;
  let stagedLease;
  let journal;
  try {
    await assertTransactionDecisionNotArchived(
      context.runtimeRoot,
      context.session.txid,
    );
    assertTransactionDecisionNotConsumed(context);
    const precheckDecision = acceptTransactionDecision(
      await readTransactionDecision(context, "precheck"),
      "precheck",
      context.session.precheckRequestId,
      context.session.precheckObservationId,
      context.session.precheckRequestedAt,
      context,
    );

    stagedLease = await stageMaintenanceLease({
      runtimeRoot: context.runtimeRoot,
      txid: context.session.txid,
      maintenanceNonce: context.session.maintenanceNonce,
    });
    const releaseName = `${candidateManifestSha256.slice(0, 16)}-${context.session.txid}`;
    const plannedCandidate = validatedState(
      path.posix.join(".releases", releaseName),
      candidateManifestSha256,
    );
    const stagedJournal = createMaintenanceStagedJournalRecord({
      context,
      operation: "install",
      candidate: plannedCandidate,
      candidateStagingTarget: path.posix.join(
        ".releases",
        path.basename(candidateRoot),
      ),
      candidateStagingIdentity: candidateIdentity,
      installerLease,
      maintenanceLease: stagedLease,
      precheckDecision,
    });
    await createTransactionJournal(context.runtimeRoot, stagedJournal);
    await options.hook?.("maintenance-staged");
    lease = await stagedLease.publish();
    stagedLease = undefined;
    await migrateLegacyArtifactsForMaintenance({
      runtimeRoot: context.runtimeRoot,
      txid: context.session.txid,
      maintenanceNonce: context.session.maintenanceNonce,
      maintenanceLease: lease,
      hook: options.hook,
    });

    const runtimeRoot = await realpath(context.runtimeRoot);
    const releaseStore = path.join(runtimeRoot, ".releases");
    await assertSameFileSystem(candidateRoot, releaseStore);
    const releaseRoot = path.join(releaseStore, releaseName);
    await assertPathAbsent(releaseRoot, "RELEASE_DESTINATION_EXISTS");
    const current = await inspectCurrentState(runtimeRoot, options.validateRelease);
    const previous = await inspectPreviousState(runtimeRoot, options.validateRelease);
    const candidate = validatedState(
      plannedCandidate.target,
      candidateManifestSha256,
      releaseRoot,
    );
    const legacyTarget = current.kind === "legacy"
      ? path.posix.join(".releases", `legacy-${context.session.txid}`)
      : null;
    const desiredPrevious = current.kind === "validated"
      ? current
      : absentState();
    journal = createTransactionJournalRecord({
      context,
      operation: "install",
      candidate,
      candidateStagingTarget: stagedJournal.candidateStagingTarget,
      candidateStagingIdentity: stagedJournal.candidateStagingIdentity,
      beforeCurrent: current,
      beforePrevious: previous,
      desiredCurrent: candidate,
      desiredPrevious,
      legacyTarget,
      installerLease,
      maintenanceLease: lease,
      precheckDecision,
      commitDecision: null,
    });
    journal.phase = "awaiting-commit";
    await updateTransactionJournal(runtimeRoot, journal);

    prepareCommitDecisionRequest(context);
    const commitDecision = acceptTransactionDecision(
      await readTransactionDecision(context, "commit"),
      "commit",
      context.session.commitRequestId,
      context.session.commitObservationId,
      context.session.commitRequestedAt,
      context,
    );
    await installerLease.assertCurrentOwnership();
    await lease.assertCurrentOwnership();
    journal.automationObservations.commit = {
      ...commitDecision.automationObservation,
    };
    await updateTransactionJournal(runtimeRoot, journal);
    markTransactionDecisionConsumed(context);

    if (
      current.kind === "validated" &&
      current.manifestSha256 === candidateManifestSha256
    ) {
      journal.desired.current = serializablePointerState(current);
      journal.desired.previous = serializablePointerState(previous);
      journal.phase = "current-switched";
      await updateTransactionJournal(runtimeRoot, journal);
      await assertReleaseMutationAuthority({
        runtimeRoot,
        journal,
        installerLease,
        maintenanceLease: lease,
      });
      await archiveTransactionJournal(runtimeRoot, journal);
      return { installed: false, idempotent: true, releaseRoot: current.releaseRoot };
    }
    journal.phase = "candidate-moving";
    await updateTransactionJournal(runtimeRoot, journal);
    await assertReleaseMutationAuthority({
      runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
    });
    await moveImmutableCandidate(candidateRoot, releaseRoot, options.hook);
    const movedManifestSha256 = manifestSha256FromValidation(
      await options.validateRelease(releaseRoot),
    );
    if (movedManifestSha256 !== candidateManifestSha256) {
      throw new Error("RELEASE_CANDIDATE_CHANGED_DURING_MOVE");
    }
    journal.phase = "prepared";
    await updateTransactionJournal(runtimeRoot, journal);

    if (current.kind === "legacy") {
      journal.phase = "legacy-migrating";
      await updateTransactionJournal(runtimeRoot, journal);
      await assertReleaseMutationAuthority({
        runtimeRoot,
        journal,
        installerLease,
        maintenanceLease: lease,
      });
      await migrateLegacyCurrent(runtimeRoot, legacyTarget);
      journal.phase = "legacy-migrated";
      await updateTransactionJournal(runtimeRoot, journal);
    }

    journal.phase = "previous-prepared";
    await updateTransactionJournal(runtimeRoot, journal);
    await assertReleaseMutationAuthority({
      runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
    });
    await applyPointerState(
      runtimeRoot,
      "bin.previous",
      desiredPrevious,
      options.validateRelease,
    );
    await options.hook?.("previous-prepared");

    journal.phase = "current-switched";
    await updateTransactionJournal(runtimeRoot, journal);
    await assertReleaseMutationAuthority({
      runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
    });
    await applyPointerState(runtimeRoot, "bin", candidate, options.validateRelease);
    await options.hook?.("current-switched");

    await assertPointerMatches(runtimeRoot, "bin", candidate, options.validateRelease);
    await assertPointerMatches(
      runtimeRoot,
      "bin.previous",
      desiredPrevious,
      options.validateRelease,
    );
    await assertReleaseMutationAuthority({
      runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
    });
    await archiveTransactionJournal(runtimeRoot, journal);
    await options.hook?.("journal-archived", transactionHookContext(context, lease));
    return { installed: true, idempotent: false, releaseRoot };
  } catch (error) {
    await maybeTerminalAbortReleaseTransaction({
      error,
      runtimeRoot: context.runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
      validateRelease: options.validateRelease,
    });
    throw error;
  } finally {
    await releaseTransactionLeases({
      installerLease,
      maintenanceLease: lease,
      stagedMaintenanceLease: stagedLease,
    });
  }
}

export async function rollbackValidatedRelease(options) {
  const context = prepareTransactionContext(options, false);
  const installerLease = await acquireInstallerLease({
    runtimeRoot: context.runtimeRoot,
    txid: context.session.txid,
    operation: "rollback",
  });
  let lease;
  let stagedLease;
  let journal;
  try {
    await assertTransactionDecisionNotArchived(
      context.runtimeRoot,
      context.session.txid,
    );
    assertTransactionDecisionNotConsumed(context);
    const precheckDecision = acceptTransactionDecision(
      await readTransactionDecision(context, "precheck"),
      "precheck",
      context.session.precheckRequestId,
      context.session.precheckObservationId,
      context.session.precheckRequestedAt,
      context,
    );

    stagedLease = await stageMaintenanceLease({
      runtimeRoot: context.runtimeRoot,
      txid: context.session.txid,
      maintenanceNonce: context.session.maintenanceNonce,
    });
    const stagedJournal = createMaintenanceStagedJournalRecord({
      context,
      operation: "rollback",
      candidate: null,
      candidateStagingTarget: null,
      candidateStagingIdentity: null,
      installerLease,
      maintenanceLease: stagedLease,
      precheckDecision,
    });
    await createTransactionJournal(context.runtimeRoot, stagedJournal);
    await options.hook?.("maintenance-staged");
    lease = await stagedLease.publish();
    stagedLease = undefined;
    await migrateLegacyArtifactsForMaintenance({
      runtimeRoot: context.runtimeRoot,
      txid: context.session.txid,
      maintenanceNonce: context.session.maintenanceNonce,
      maintenanceLease: lease,
      hook: options.hook,
    });
    const runtimeRoot = await realpath(context.runtimeRoot);
    const current = await inspectCurrentState(runtimeRoot, options.validateRelease);
    const previous = await inspectPreviousState(runtimeRoot, options.validateRelease);
    if (current.kind !== "validated" || previous.kind !== "validated") {
      throw new Error("NO_VALIDATED_PREVIOUS_RELEASE");
    }
    journal = createTransactionJournalRecord({
      context,
      operation: "rollback",
      candidate: null,
      beforeCurrent: current,
      beforePrevious: previous,
      desiredCurrent: previous,
      desiredPrevious: current,
      legacyTarget: null,
      installerLease,
      maintenanceLease: lease,
      precheckDecision,
      commitDecision: null,
    });
    journal.phase = "awaiting-commit";
    await updateTransactionJournal(runtimeRoot, journal);

    prepareCommitDecisionRequest(context);
    const commitDecision = acceptTransactionDecision(
      await readTransactionDecision(context, "commit"),
      "commit",
      context.session.commitRequestId,
      context.session.commitObservationId,
      context.session.commitRequestedAt,
      context,
    );
    await installerLease.assertCurrentOwnership();
    await lease.assertCurrentOwnership();
    journal.automationObservations.commit = {
      ...commitDecision.automationObservation,
    };
    await updateTransactionJournal(runtimeRoot, journal);
    markTransactionDecisionConsumed(context);

    journal.phase = "previous-prepared";
    await updateTransactionJournal(runtimeRoot, journal);
    await assertReleaseMutationAuthority({
      runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
    });
    await applyPointerState(
      runtimeRoot,
      "bin.previous",
      current,
      options.validateRelease,
    );
    await options.hook?.("previous-prepared");

    journal.phase = "current-switched";
    await updateTransactionJournal(runtimeRoot, journal);
    await assertReleaseMutationAuthority({
      runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
    });
    await applyPointerState(runtimeRoot, "bin", previous, options.validateRelease);
    await options.hook?.("current-switched");

    await assertPointerMatches(runtimeRoot, "bin", previous, options.validateRelease);
    await assertPointerMatches(
      runtimeRoot,
      "bin.previous",
      current,
      options.validateRelease,
    );
    await assertReleaseMutationAuthority({
      runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
    });
    await archiveTransactionJournal(runtimeRoot, journal);
    await options.hook?.("journal-archived", transactionHookContext(context, lease));
    return { rolledBack: true, currentReleaseRoot: previous.releaseRoot };
  } catch (error) {
    await maybeTerminalAbortReleaseTransaction({
      error,
      runtimeRoot: context.runtimeRoot,
      journal,
      installerLease,
      maintenanceLease: lease,
      validateRelease: options.validateRelease,
    });
    throw error;
  } finally {
    await releaseTransactionLeases({
      installerLease,
      maintenanceLease: lease,
      stagedMaintenanceLease: stagedLease,
    });
  }
}

export async function recoverReleaseTransaction(options) {
  if (
    typeof options?.runtimeRoot !== "string" ||
    options.runtimeRoot.length === 0 ||
    typeof options.now !== "function" ||
    typeof options.validateRelease !== "function" ||
    typeof options.readDecision !== "function"
  ) {
    throw new Error("RELEASE_TRANSACTION_INVALID");
  }
  const observedNow = options.now();
  if (!(observedNow instanceof Date) || !Number.isFinite(observedNow.getTime())) {
    throw new Error("RELEASE_TRANSACTION_INVALID");
  }

  const runtimeRoot = path.resolve(options.runtimeRoot);
  const initialBytes = await readTransactionJournal(runtimeRoot);
  const journal = parseTransactionJournal(initialBytes);
  const context = prepareRecoveryTransactionContext(options, journal);
  const precheckDecision = acceptTransactionDecision(
    await readTransactionDecision(context, "precheck"),
    "precheck",
    context.session.precheckRequestId,
    context.session.precheckObservationId,
    context.session.precheckRequestedAt,
    context,
  );
  const installerLease = await acquireInstallerLease({
    runtimeRoot,
    txid: journal.txid,
    operation: journal.operation,
    previousInstallerNonce: journal.installerClaim.nonce,
    transactionJournalSha256: sha256Text(initialBytes),
  });
  let maintenanceLease;
  try {
    const stagedMaintenanceLease = await stageMaintenanceLease({
      runtimeRoot,
      txid: journal.txid,
      maintenanceNonce: journal.maintenanceNonce,
      transactionJournalSha256: sha256Text(initialBytes),
    });
    maintenanceLease = await stagedMaintenanceLease.publish();
    await migrateLegacyArtifactsForMaintenance({
      runtimeRoot,
      txid: journal.txid,
      maintenanceNonce: journal.maintenanceNonce,
      maintenanceLease,
      hook: options.hook,
    });
    prepareCommitDecisionRequest(context);
    const commitDecision = acceptTransactionDecision(
      await readTransactionDecision(context, "commit"),
      "commit",
      context.session.commitRequestId,
      context.session.commitObservationId,
      context.session.commitRequestedAt,
      context,
    );
    const verifiedBytes = await readTransactionJournal(runtimeRoot);
    if (verifiedBytes !== initialBytes) {
      throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
    }
    if (journal.phase === "maintenance-staged") {
      const [current, previous] = await Promise.all([
        inspectCurrentState(runtimeRoot, options.validateRelease),
        inspectPreviousState(runtimeRoot, options.validateRelease),
      ]);
      journal.before = {
        current: serializablePointerState(current),
        previous: serializablePointerState(previous),
      };
      journal.desired = {
        current: serializablePointerState(current),
        previous: serializablePointerState(previous),
      };
      journal.phase = "current-switched";
    }
    if (journal.phase === "candidate-moving") {
      await stabilizeCandidateMoveState(runtimeRoot, journal, options.validateRelease);
    }
    await assertPointerPhaseLegal(runtimeRoot, journal, options.validateRelease);
    journal.maintenanceLease = maintenanceLeaseJournalIdentity(maintenanceLease);
    journal.installerClaim = installerLeaseJournalIdentity(installerLease);
    journal.recoveryAutomationObservations = {
      precheck: { ...precheckDecision.automationObservation },
      commit: { ...commitDecision.automationObservation },
    };
    await updateTransactionJournal(runtimeRoot, journal);

    if (journal.phase === "current-switched") {
      await applyPointerState(
        runtimeRoot,
        "bin.previous",
        journal.desired.previous,
        options.validateRelease,
      );
      await applyPointerState(
        runtimeRoot,
        "bin",
        journal.desired.current,
        options.validateRelease,
      );
      await assertPointerMatches(
        runtimeRoot,
        "bin.previous",
        journal.desired.previous,
        options.validateRelease,
      );
      await assertPointerMatches(
        runtimeRoot,
        "bin",
        journal.desired.current,
        options.validateRelease,
      );
    } else if (
      journal.phase === "awaiting-commit" ||
      journal.phase === "candidate-moving" ||
      journal.phase === "prepared" ||
      journal.phase === "legacy-migrating" ||
      journal.phase === "legacy-migrated" ||
      journal.phase === "previous-prepared"
    ) {
      await restoreCurrentState(
        runtimeRoot,
        journal.before.current,
        journal.legacyTarget,
        options.validateRelease,
      );
      await applyPointerState(
        runtimeRoot,
        "bin.previous",
        journal.before.previous,
        options.validateRelease,
      );
      await assertPointerMatches(
        runtimeRoot,
        "bin.previous",
        journal.before.previous,
        options.validateRelease,
      );
    } else {
      throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
    }

    await archiveTransactionJournal(runtimeRoot, journal);
    await options.hook?.("journal-archived", {
      txid: journal.txid,
      maintenanceNonce: journal.maintenanceNonce,
    });
    return { recovered: true, phase: journal.phase };
  } finally {
    await releaseTransactionLeases({ installerLease, maintenanceLease });
  }
}

async function assertPointerPhaseLegal(runtimeRoot, journal, validateRelease) {
  if (journal.phase === "maintenance-staged" || journal.before === null || journal.desired === null) {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
  }
  const [current, previous] = await Promise.all([
    inspectCurrentState(runtimeRoot, validateRelease),
    inspectPreviousState(runtimeRoot, validateRelease),
  ]);
  const observedCurrent = serializablePointerState(current);
  const observedPrevious = serializablePointerState(previous);
  const currentBefore = journal.before.current.kind === "legacy"
    && ["legacy-migrating", "legacy-migrated", "previous-prepared"].includes(journal.phase)
    ? absentState()
    : journal.before.current;
  const legal = (() => {
    if (["awaiting-commit", "candidate-moving", "prepared"].includes(journal.phase)) {
      return samePointerState(observedCurrent, journal.before.current)
        && samePointerState(observedPrevious, journal.before.previous);
    }
    if (journal.phase === "legacy-migrating") {
      return (
        samePointerState(observedCurrent, journal.before.current)
        || samePointerState(observedCurrent, absentState())
      ) && samePointerState(observedPrevious, journal.before.previous);
    }
    if (journal.phase === "legacy-migrated") {
      return samePointerState(observedCurrent, absentState())
        && samePointerState(observedPrevious, journal.before.previous);
    }
    if (journal.phase === "previous-prepared") {
      return samePointerState(observedCurrent, currentBefore)
        && (
          samePointerState(observedPrevious, journal.before.previous)
          || samePointerState(observedPrevious, journal.desired.previous)
        );
    }
    if (journal.phase === "current-switched") {
      return samePointerState(observedPrevious, journal.desired.previous)
        && (
          samePointerState(observedCurrent, currentBefore)
          || samePointerState(observedCurrent, journal.desired.current)
        );
    }
    return false;
  })();
  if (!legal) throw new Error("RELEASE_POINTER_STATE_AMBIGUOUS");
}

function samePointerState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function releaseTransactionLeases({
  installerLease,
  maintenanceLease,
  stagedMaintenanceLease,
}) {
  const failures = [];
  try {
    await installerLease.release();
  } catch (error) {
    failures.push(error);
  }
  try {
    if (maintenanceLease !== undefined) await maintenanceLease.release();
    else if (stagedMaintenanceLease !== undefined) await stagedMaintenanceLease.discard();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "RELEASE_LEASE_CLEANUP_FAILED");
  }
}

class StagedMaintenanceLease {
  constructor(options) {
    this.kernelLease = options.kernelLease;
    this.gatePath = options.kernelLease.gatePath;
    this.lockPath = this.gatePath;
    this.device = options.kernelLease.gateIdentity.dev;
    this.inode = options.kernelLease.gateIdentity.ino;
    this.metadata = options.metadata;
    this.completed = false;
    genuineMaintenanceLeases.add(this);
  }

  async publish() {
    if (this.completed) throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS");
    this.completed = true;
    genuineMaintenanceLeases.delete(this);
    return new PersistentMaintenanceLease({
      kernelLease: this.kernelLease,
      metadata: this.metadata,
    });
  }

  async discard() {
    if (this.completed) return;
    this.completed = true;
    genuineMaintenanceLeases.delete(this);
    await this.kernelLease.close();
  }
}

class PersistentMaintenanceLease {
  constructor(options) {
    this.kernelLease = options.kernelLease;
    this.gatePath = options.kernelLease.gatePath;
    this.lockPath = this.gatePath;
    this.device = options.kernelLease.gateIdentity.dev;
    this.inode = options.kernelLease.gateIdentity.ino;
    this.metadata = options.metadata;
    this.purpose = "release-maintenance";
    this.releasePromise = null;
    this.retainPromise = null;
    this.identity = Object.freeze({
      device: String(this.device),
      inode: String(this.inode),
      nonce: options.metadata.maintenanceNonce,
      txid: options.metadata.txid,
    });
    genuineMaintenanceLeases.add(this);
  }

  release() {
    if (this.releasePromise === null) this.releasePromise = this.releaseExactMarker();
    return this.releasePromise;
  }

  retain() {
    if (this.releasePromise !== null) {
      return Promise.reject(new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS"));
    }
    if (this.retainPromise === null) this.retainPromise = this.retainKernelLease();
    return this.retainPromise;
  }

  async retainKernelLease() {
    retainedKernelLeases.add(this);
  }

  async releaseExactMarker() {
    retainedKernelLeases.delete(this);
    try {
      await this.kernelLease.close();
    } finally {
      genuineMaintenanceLeases.delete(this);
    }
  }

  assertCurrentOwnership() {
    return this.kernelLease.runExclusive(() => Promise.resolve());
  }
}

class PersistentInstallerLease {
  constructor(options) {
    this.kernelLease = options.kernelLease;
    this.gatePath = options.kernelLease.gatePath;
    this.lockPath = this.gatePath;
    this.device = options.kernelLease.gateIdentity.dev;
    this.inode = options.kernelLease.gateIdentity.ino;
    this.metadata = options.metadata;
    this.releasePromise = null;
    genuineInstallerLeases.add(this);
  }

  release() {
    if (this.releasePromise === null) this.releasePromise = this.releaseExactMarker();
    return this.releasePromise;
  }

  async releaseExactMarker() {
    try {
      await this.kernelLease.close();
    } finally {
      genuineInstallerLeases.delete(this);
    }
  }

  assertCurrentOwnership() {
    return this.kernelLease.runExclusive(() => Promise.resolve());
  }
}

function parseCommitDecision(serialized) {
  return parseAutomationDecision(serialized, "commit");
}

function parseAutomationDecision(serialized, expectedOperation) {
  try {
    if (typeof serialized !== "string") throw new Error("NOT_A_STRING");
    const value = JSON.parse(serialized);
    assertExactKeys(value, ["automationObservation", "maintenanceNonce", "op", "txid"]);
    if (value.op !== expectedOperation) throw new Error("WRONG_OPERATION");
    assertUuid(value.txid);
    assertUuid(value.maintenanceNonce);

    const observation = value.automationObservation;
    assertExactKeys(observation, [
      "automationId",
      "observedAt",
      "observationId",
      "requestId",
      "status",
      "targetCount",
    ]);
    assertUuid(observation.requestId);
    assertUuid(observation.observationId);
    if (
      observation.automationId !== "automation" ||
      observation.targetCount !== 1 ||
      observation.status !== "PAUSED" ||
      !isIsoDateTime(observation.observedAt)
    ) {
      throw new Error("INVALID_AUTOMATION_OBSERVATION");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "RELEASE_COMMIT_DECISION_REPLAYED") {
      throw error;
    }
    throw new Error("RELEASE_COMMIT_DECISION_INVALID", { cause: error });
  }
}

function prepareTransactionContext(options, candidateRequired) {
  try {
    const usesFixtureDecisions = options?.readDecision === undefined;
    if (
      typeof options?.runtimeRoot !== "string" ||
      options.runtimeRoot.length === 0 ||
      typeof options.now !== "function" ||
      typeof options.validateRelease !== "function" ||
      options.automationId !== "automation" ||
      (usesFixtureDecisions
        ? (!Array.isArray(options.decisionLines) ||
          options.decisionLines.length !== 2 ||
          options.decisionLines.some((line) => typeof line !== "string") ||
          options.session === undefined)
        : (typeof options.readDecision !== "function" ||
          options.decisionLines !== undefined ||
          options.session !== undefined)) ||
      (candidateRequired && (
        typeof options.candidateRoot !== "string" ||
        options.candidateRoot.length === 0
      )) ||
      (options.hook !== undefined && typeof options.hook !== "function")
    ) {
      throw new Error("INVALID_TRANSACTION_OPTIONS");
    }
    const now = options.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("INVALID_TRANSACTION_CLOCK");
    }
    const session = usesFixtureDecisions
      ? parseFixtureDecisionSession(options.session)
      : {
        txid: randomUUID(),
        maintenanceNonce: randomUUID(),
        precheckRequestId: randomUUID(),
        precheckObservationId: randomUUID(),
        precheckRequestedAt: now.toISOString(),
        commitRequestId: null,
        commitObservationId: null,
        commitRequestedAt: null,
      };
    return {
      runtimeRoot: path.resolve(options.runtimeRoot),
      automationId: options.automationId,
      decisionLines: usesFixtureDecisions ? options.decisionLines : null,
      readDecision: usesFixtureDecisions ? null : options.readDecision,
      session,
      now: options.now,
      fixtureMode: usesFixtureDecisions,
    };
  } catch (error) {
    throw new Error("RELEASE_TRANSACTION_INVALID", { cause: error });
  }
}

function prepareRecoveryTransactionContext(options, journal) {
  const now = options.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("RELEASE_TRANSACTION_INVALID");
  }
  return {
    runtimeRoot: path.resolve(options.runtimeRoot),
    automationId: "automation",
    decisionLines: null,
    readDecision: options.readDecision,
    session: {
      txid: journal.txid,
      maintenanceNonce: journal.maintenanceNonce,
      precheckRequestId: randomUUID(),
      precheckObservationId: randomUUID(),
      precheckRequestedAt: now.toISOString(),
      commitRequestId: null,
      commitObservationId: null,
      commitRequestedAt: null,
    },
    now: options.now,
    fixtureMode: false,
  };
}

function parseFixtureDecisionSession(session) {
  assertExactKeys(session, [
    "commitObservationId",
    "commitRequestId",
    "commitRequestedAt",
    "maintenanceNonce",
    "precheckObservationId",
    "precheckRequestId",
    "precheckRequestedAt",
    "txid",
  ]);
  assertUuid(session.txid);
  assertUuid(session.maintenanceNonce);
  assertUuid(session.precheckRequestId);
  assertUuid(session.precheckObservationId);
  assertUuid(session.commitRequestId);
  assertUuid(session.commitObservationId);
  if (
    session.precheckObservationId === session.commitObservationId ||
    !isIsoDateTime(session.precheckRequestedAt) ||
    !isIsoDateTime(session.commitRequestedAt) ||
    Date.parse(session.precheckRequestedAt) > Date.parse(session.commitRequestedAt)
  ) {
    throw new Error("INVALID_TRANSACTION_SESSION");
  }
  return { ...session };
}

async function readTransactionDecision(context, operation) {
  if (context.fixtureMode) {
    return context.decisionLines[operation === "precheck" ? 0 : 1];
  }
  const request = {
    op: operation,
    txid: context.session.txid,
    maintenanceNonce: context.session.maintenanceNonce,
    requestId: context.session[`${operation}RequestId`],
    observationId: context.session[`${operation}ObservationId`],
    requestedAt: context.session[`${operation}RequestedAt`],
  };
  const serialized = await context.readDecision(Object.freeze(request));
  if (typeof serialized !== "string") {
    throw new Error("RELEASE_COMMIT_DECISION_INVALID");
  }
  return serialized;
}

function prepareCommitDecisionRequest(context) {
  if (context.fixtureMode) return;
  const now = context.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("RELEASE_COMMIT_DECISION_INVALID");
  }
  context.session.commitRequestId = randomUUID();
  do {
    context.session.commitObservationId = randomUUID();
  } while (context.session.commitObservationId === context.session.precheckObservationId);
  context.session.commitRequestedAt = now.toISOString();
}

function acceptTransactionDecision(
  serialized,
  operation,
  requestId,
  observationId,
  requestedAt,
  context,
) {
  const decision = parseAutomationDecision(serialized, operation);
  const observedAt = Date.parse(decision.automationObservation.observedAt);
  const requestTime = Date.parse(requestedAt);
  const now = context.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("RELEASE_COMMIT_DECISION_INVALID");
  }
  if (
    decision.txid !== context.session.txid ||
    decision.maintenanceNonce !== context.session.maintenanceNonce ||
    decision.automationObservation.requestId !== requestId ||
    decision.automationObservation.observationId !== observationId ||
    decision.automationObservation.automationId !== context.automationId ||
    observedAt < requestTime ||
    observedAt > now.getTime() ||
    now.getTime() - observedAt > transactionDecisionMaximumAgeMs
  ) {
    throw new Error("RELEASE_COMMIT_DECISION_INVALID");
  }
  return decision;
}

function transactionDecisionKey(context) {
  const session = context.session;
  if (
    typeof session.commitRequestId !== "string" ||
    typeof session.commitObservationId !== "string"
  ) {
    return null;
  }
  return [
    session.txid,
    session.maintenanceNonce,
    session.precheckRequestId,
    session.precheckObservationId,
    session.commitRequestId,
    session.commitObservationId,
  ].join(":");
}

function assertTransactionDecisionNotConsumed(context) {
  const key = transactionDecisionKey(context);
  if (key !== null && consumedTransactionDecisions.has(key)) {
    throw new Error("RELEASE_COMMIT_DECISION_REPLAYED");
  }
}

async function assertTransactionDecisionNotArchived(runtimeRoot, txid) {
  const archiveDirectory = path.join(
    runtimeRoot,
    "state",
    transactionArchiveDirectoryName,
  );
  for (const operation of ["install", "rollback"]) {
    const archivePath = path.join(archiveDirectory, `${txid}-${operation}.json`);
    try {
      await lstat(archivePath);
      throw new Error("RELEASE_COMMIT_DECISION_REPLAYED");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
}

function markTransactionDecisionConsumed(context) {
  const key = transactionDecisionKey(context);
  if (key === null || consumedTransactionDecisions.has(key)) {
    throw new Error("RELEASE_COMMIT_DECISION_REPLAYED");
  }
  consumedTransactionDecisions.add(key);
}

function manifestSha256FromValidation(result) {
  if (
    typeof result !== "object" ||
    result === null ||
    typeof result.manifestSha256 !== "string" ||
    !manifestSha256Pattern.test(result.manifestSha256)
  ) {
    throw new Error("RELEASE_VALIDATOR_RESULT_INVALID");
  }
  return result.manifestSha256;
}

function absentState() {
  return { kind: "absent" };
}

function validatedState(target, manifestSha256, releaseRoot = undefined) {
  return {
    kind: "validated",
    target,
    manifestSha256,
    ...(releaseRoot === undefined ? {} : { releaseRoot }),
  };
}

function serializablePointerState(state) {
  if (state.kind === "absent" || state.kind === "legacy") {
    return { kind: state.kind };
  }
  if (state.kind === "validated") {
    return {
      kind: "validated",
      target: state.target,
      manifestSha256: state.manifestSha256,
    };
  }
  throw new Error("RELEASE_POINTER_STATE_INVALID");
}

function createTransactionJournalRecord(options) {
  return {
    version: 2,
    abortReason: null,
    txid: options.context.session.txid,
    maintenanceNonce: options.context.session.maintenanceNonce,
    operation: options.operation,
    phase: "prepared",
    candidate: options.candidate === null
      ? null
      : serializablePointerState(options.candidate),
    candidateStagingTarget: options.candidateStagingTarget ?? null,
    candidateStagingIdentity: options.candidateStagingIdentity ?? null,
    before: {
      current: serializablePointerState(options.beforeCurrent),
      previous: serializablePointerState(options.beforePrevious),
    },
    desired: {
      current: serializablePointerState(options.desiredCurrent),
      previous: serializablePointerState(options.desiredPrevious),
    },
    legacyTarget: options.legacyTarget,
    installerClaim: installerLeaseJournalIdentity(options.installerLease),
    maintenanceLease: maintenanceLeaseJournalIdentity(options.maintenanceLease),
    automationObservations: {
      precheck: { ...options.precheckDecision.automationObservation },
      commit: options.commitDecision === null
        ? null
        : { ...options.commitDecision.automationObservation },
    },
    recoveryAutomationObservations: null,
  };
}

function createMaintenanceStagedJournalRecord(options) {
  return {
    version: 2,
    abortReason: null,
    txid: options.context.session.txid,
    maintenanceNonce: options.context.session.maintenanceNonce,
    operation: options.operation,
    phase: "maintenance-staged",
    candidate: options.candidate === null
      ? null
      : serializablePointerState(options.candidate),
    candidateStagingTarget: options.candidateStagingTarget ?? null,
    candidateStagingIdentity: options.candidateStagingIdentity ?? null,
    before: null,
    desired: null,
    legacyTarget: null,
    installerClaim: installerLeaseJournalIdentity(options.installerLease),
    maintenanceLease: maintenanceLeaseJournalIdentity(options.maintenanceLease),
    automationObservations: {
      precheck: { ...options.precheckDecision.automationObservation },
      commit: null,
    },
    recoveryAutomationObservations: null,
  };
}

function maintenanceLeaseJournalIdentity(lease) {
  if (!genuineMaintenanceLeases.has(lease) || typeof lease?.gatePath !== "string" ||
      !lease.gatePath.includes(`${path.sep}.kernel-lock-v1${path.sep}`)) {
    throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS");
  }
  return {
    path: path.posix.join(
      "state",
      ".kernel-lock-v1",
      path.basename(lease.gatePath),
    ),
    device: String(lease.device),
    inode: String(lease.inode),
    nonce: lease.metadata.maintenanceNonce,
    pid: lease.metadata.pid,
    processStartedAt: lease.metadata.processStartedAt,
  };
}

function installerLeaseJournalIdentity(lease) {
  if (!genuineInstallerLeases.has(lease)) {
    throw new Error("RELEASE_MUTATION_CAPABILITY_INVALID");
  }
  return {
    device: String(lease.device),
    inode: String(lease.inode),
    nonce: lease.metadata.installerNonce,
    previousNonce: lease.metadata.previousInstallerNonce,
    journalSha256: lease.metadata.transactionJournalSha256,
  };
}

function transactionHookContext(context, lease) {
  return Object.freeze({
    txid: context.session.txid,
    maintenanceNonce: context.session.maintenanceNonce,
    maintenanceLease: maintenanceLeaseJournalIdentity(lease),
  });
}

async function assertReleaseMutationAuthority(options) {
  if (!genuineInstallerLeases.has(options.installerLease) ||
      !genuineMaintenanceLeases.has(options.maintenanceLease)) {
    throw new Error("RELEASE_MUTATION_CAPABILITY_INVALID");
  }
  await options.installerLease.assertCurrentOwnership();
  await options.maintenanceLease.assertCurrentOwnership();
  const serialized = await readTransactionJournal(options.runtimeRoot);
  const observed = parseTransactionJournal(serialized);
  if (JSON.stringify(observed) !== JSON.stringify(options.journal)) {
    throw new Error("RELEASE_MUTATION_CAPABILITY_INVALID");
  }
  const mainPath = await realpath(fileURLToPath(import.meta.url));
  const mainSha256 = sha256Text(await readFile(mainPath, "utf8"));
  const capability = Object.freeze({
    txid: options.journal.txid,
    maintenanceNonce: options.journal.maintenanceNonce,
    phase: options.journal.phase,
    journalSha256: sha256Text(serialized),
    installerGate: Object.freeze({
      device: String(options.installerLease.device),
      inode: String(options.installerLease.inode),
    }),
    liveGate: Object.freeze({
      device: String(options.maintenanceLease.device),
      inode: String(options.maintenanceLease.inode),
    }),
    mainPath,
    mainSha256,
  });
  genuineMutationCapabilities.add(capability);
  await validateReleaseMutationCapability(capability, options);
  return capability;
}

async function validateReleaseMutationCapability(capability, options) {
  if (!genuineMutationCapabilities.has(capability) ||
      capability.txid !== options.journal.txid ||
      capability.maintenanceNonce !== options.journal.maintenanceNonce ||
      capability.phase !== options.journal.phase ||
      capability.installerGate.device !== String(options.installerLease.device) ||
      capability.installerGate.inode !== String(options.installerLease.inode) ||
      capability.liveGate.device !== String(options.maintenanceLease.device) ||
      capability.liveGate.inode !== String(options.maintenanceLease.inode)) {
    throw new Error("RELEASE_MUTATION_CAPABILITY_INVALID");
  }
  const [serialized, mainPath] = await Promise.all([
    readTransactionJournal(options.runtimeRoot),
    realpath(fileURLToPath(import.meta.url)),
  ]);
  if (sha256Text(serialized) !== capability.journalSha256 ||
      mainPath !== capability.mainPath ||
      sha256Text(await readFile(mainPath, "utf8")) !== capability.mainSha256) {
    throw new Error("RELEASE_MUTATION_CAPABILITY_INVALID");
  }
}

async function maybeTerminalAbortReleaseTransaction(options) {
  if (!(options.error instanceof Error) || ![
    "RELEASE_CLI_DECISION_TIMEOUT",
    "RELEASE_CLI_STDIN_CLOSED",
  ].includes(options.error.message) || options.journal === undefined ||
      options.maintenanceLease === undefined || options.journal.before === null) {
    return;
  }
  try {
    await assertReleaseMutationAuthority({
      runtimeRoot: options.runtimeRoot,
      journal: options.journal,
      installerLease: options.installerLease,
      maintenanceLease: options.maintenanceLease,
    });
    const [current, previous] = await Promise.all([
      inspectCurrentState(options.runtimeRoot, options.validateRelease),
      inspectPreviousState(options.runtimeRoot, options.validateRelease),
    ]);
    if (!samePointerState(serializablePointerState(current), options.journal.before.current) ||
        !samePointerState(serializablePointerState(previous), options.journal.before.previous)) {
      return;
    }
    options.journal.abortReason = options.error.message;
    options.journal.phase = "terminal-abort";
    await updateTransactionJournal(options.runtimeRoot, options.journal);
    await assertReleaseMutationAuthority({
      runtimeRoot: options.runtimeRoot,
      journal: options.journal,
      installerLease: options.installerLease,
      maintenanceLease: options.maintenanceLease,
    });
    await archiveTransactionJournal(options.runtimeRoot, options.journal);
  } catch {
    // An unprovable abort deliberately stays pending for explicit recovery.
  }
}

async function assertSameFileSystem(leftPath, rightPath) {
  const [left, right] = await Promise.all([stat(leftPath), stat(rightPath)]);
  if (left.dev !== right.dev) throw new Error("RELEASE_CROSS_DEVICE_TRANSACTION");
}

async function assertControlledStagingCandidate(runtimeRoot, candidateRoot) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const releaseStore = path.join(resolvedRuntimeRoot, ".releases");
  const resolvedCandidate = path.resolve(candidateRoot);
  const relative = path.relative(releaseStore, resolvedCandidate);
  if (
    relative.length === 0
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || relative.includes(path.sep)
    || !relative.startsWith(".staging-")
  ) {
    throw new Error("RELEASE_CANDIDATE_OUTSIDE_STAGING");
  }
  const [runtimeIdentity, storeIdentity, candidateIdentity] = await Promise.all([
    lstat(resolvedRuntimeRoot),
    lstat(releaseStore),
    lstat(resolvedCandidate),
  ]).catch((error) => {
    throw new Error("RELEASE_CANDIDATE_OUTSIDE_STAGING", { cause: error });
  });
  if (
    !runtimeIdentity.isDirectory()
    || runtimeIdentity.isSymbolicLink()
    || !storeIdentity.isDirectory()
    || storeIdentity.isSymbolicLink()
    || !candidateIdentity.isDirectory()
    || candidateIdentity.isSymbolicLink()
  ) {
    throw new Error("RELEASE_CANDIDATE_OUTSIDE_STAGING");
  }
  const [realStore, realCandidate] = await Promise.all([
    realpath(releaseStore),
    realpath(resolvedCandidate),
  ]);
  if (
    realCandidate !== path.join(realStore, relative)
    || runtimeIdentity.dev !== storeIdentity.dev
    || storeIdentity.dev !== candidateIdentity.dev
  ) {
    throw new Error("RELEASE_CROSS_DEVICE_TRANSACTION");
  }
  return realCandidate;
}

async function moveImmutableCandidate(candidateRoot, releaseRoot, hook) {
  const sourceIdentity = await immutableDirectoryIdentity(candidateRoot);
  let moved = false;
  try {
    // Observed Darwin rename semantics require write permission on this root.
    // candidate-moving is already durable; payload children remain immutable.
    await chmod(candidateRoot, 0o755);
    await hook?.("candidate-root-thawed");
    await rename(candidateRoot, releaseRoot);
    moved = true;
    await hook?.("candidate-renamed");
    await chmod(releaseRoot, 0o555);
    await assertDirectoryIdentity(releaseRoot, sourceIdentity, true);
    await Promise.all([
      syncDirectory(path.dirname(candidateRoot)),
      syncDirectory(path.dirname(releaseRoot)),
    ]);
  } catch (error) {
    await chmod(moved ? releaseRoot : candidateRoot, 0o555).catch(() => undefined);
    throw error;
  }
}

async function immutableDirectoryIdentity(directory) {
  const identity = await lstat(directory);
  if (
    !identity.isDirectory()
    || identity.isSymbolicLink()
    || (identity.mode & 0o777) !== 0o555
  ) {
    throw new Error("RELEASE_PAYLOAD_MODE_POLICY_INVALID");
  }
  return { device: String(identity.dev), inode: String(identity.ino) };
}

async function assertDirectoryIdentity(directory, expected, requireImmutable) {
  const identity = await lstat(directory);
  if (
    !identity.isDirectory()
    || identity.isSymbolicLink()
    || String(identity.dev) !== expected.device
    || String(identity.ino) !== expected.inode
    || (requireImmutable && (identity.mode & 0o777) !== 0o555)
  ) {
    throw new Error("RELEASE_CANDIDATE_MOVE_AMBIGUOUS");
  }
}

async function stabilizeCandidateMoveState(runtimeRoot, journal, validateRelease) {
  if (
    journal.operation !== "install"
    || journal.candidate === null
    || journal.candidateStagingTarget === null
    || journal.candidateStagingIdentity === null
  ) {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
  }
  const stagingRoot = path.resolve(runtimeRoot, journal.candidateStagingTarget);
  const releaseRoot = path.resolve(runtimeRoot, journal.candidate.target);
  const [stagingExists, releaseExists] = await Promise.all([
    pathExists(stagingRoot),
    pathExists(releaseRoot),
  ]);
  if (stagingExists === releaseExists) {
    throw new Error("RELEASE_CANDIDATE_MOVE_AMBIGUOUS");
  }
  const observedRoot = stagingExists ? stagingRoot : releaseRoot;
  await assertDirectoryIdentity(
    observedRoot,
    journal.candidateStagingIdentity,
    false,
  );
  await chmod(observedRoot, 0o555);
  await syncDirectory(path.dirname(observedRoot));
  await assertDirectoryIdentity(
    observedRoot,
    journal.candidateStagingIdentity,
    true,
  );
  const manifestSha256 = manifestSha256FromValidation(
    await validateRelease(observedRoot),
  );
  if (manifestSha256 !== journal.candidate.manifestSha256) {
    throw new Error("RELEASE_CANDIDATE_CHANGED_DURING_MOVE");
  }
}

async function inspectCurrentState(runtimeRoot, validateRelease) {
  const pointer = path.join(runtimeRoot, "bin");
  let identity;
  try {
    identity = await lstat(pointer);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return absentState();
    throw error;
  }
  if (identity.isSymbolicLink()) {
    return inspectValidatedPointer(runtimeRoot, "bin", validateRelease);
  }
  if (identity.isDirectory()) return { kind: "legacy" };
  throw new Error("RELEASE_CURRENT_POINTER_INVALID");
}

async function inspectPreviousState(runtimeRoot, validateRelease) {
  const pointer = path.join(runtimeRoot, "bin.previous");
  try {
    const identity = await lstat(pointer);
    if (!identity.isSymbolicLink()) throw new Error("INVALID_PREVIOUS_POINTER");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return absentState();
    throw error;
  }
  return inspectValidatedPointer(runtimeRoot, "bin.previous", validateRelease);
}

async function inspectValidatedPointer(runtimeRoot, pointerName, validateRelease) {
  const pointerPath = path.join(runtimeRoot, pointerName);
  const target = await readlink(pointerPath);
  const releaseRoot = await resolveControlledReleaseRoot(runtimeRoot, target);
  const manifestSha256 = manifestSha256FromValidation(
    await validateRelease(releaseRoot),
  );
  return validatedState(target, manifestSha256, releaseRoot);
}

async function resolveControlledReleaseRoot(runtimeRoot, target) {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.includes("\0") ||
    path.isAbsolute(target)
  ) {
    throw new Error("RELEASE_POINTER_TARGET_INVALID");
  }
  const resolvedRuntimeRoot = await realpath(runtimeRoot);
  const releaseStore = await realpath(path.join(resolvedRuntimeRoot, ".releases"));
  const releaseRoot = path.resolve(resolvedRuntimeRoot, target);
  const relative = path.relative(releaseStore, releaseRoot);
  const canonicalReleaseName = /^[a-f0-9]{16}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    !canonicalReleaseName.test(relative)
  ) {
    throw new Error("RELEASE_POINTER_TARGET_INVALID");
  }
  const identity = await lstat(releaseRoot);
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("RELEASE_POINTER_TARGET_INVALID");
  }
  const resolved = await realpath(releaseRoot);
  if (path.dirname(resolved) !== releaseStore) {
    throw new Error("RELEASE_POINTER_TARGET_INVALID");
  }
  return resolved;
}

async function migrateLegacyCurrent(runtimeRoot, legacyTarget) {
  if (typeof legacyTarget !== "string") {
    throw new Error("RELEASE_LEGACY_TARGET_INVALID");
  }
  const currentPath = path.join(runtimeRoot, "bin");
  const legacyPath = path.resolve(runtimeRoot, legacyTarget);
  const releaseStore = path.join(runtimeRoot, ".releases");
  if (!isStrictDescendant(releaseStore, legacyPath)) {
    throw new Error("RELEASE_LEGACY_TARGET_INVALID");
  }
  const identity = await lstat(currentPath);
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("RELEASE_LEGACY_SOURCE_INVALID");
  }
  await assertPathAbsent(legacyPath, "RELEASE_LEGACY_TARGET_EXISTS");
  await rename(currentPath, legacyPath);
  await Promise.all([syncDirectory(runtimeRoot), syncDirectory(releaseStore)]);
}

async function applyPointerState(runtimeRoot, pointerName, state, validateRelease) {
  if (state.kind === "absent") {
    await removePointerIfPresent(runtimeRoot, pointerName);
    return;
  }
  if (state.kind !== "validated") {
    throw new Error("RELEASE_POINTER_STATE_INVALID");
  }
  const releaseRoot = await resolveControlledReleaseRoot(runtimeRoot, state.target);
  const manifestSha256 = manifestSha256FromValidation(await validateRelease(releaseRoot));
  if (manifestSha256 !== state.manifestSha256) {
    throw new Error("RELEASE_POINTER_MANIFEST_MISMATCH");
  }
  await atomicReplacePointer(runtimeRoot, pointerName, state.target);
}

async function restoreCurrentState(
  runtimeRoot,
  state,
  legacyTarget,
  validateRelease,
) {
  if (state.kind !== "legacy") {
    await applyPointerState(runtimeRoot, "bin", state, validateRelease);
    return;
  }
  if (typeof legacyTarget !== "string") {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
  }
  const currentPath = path.join(runtimeRoot, "bin");
  try {
    const currentIdentity = await lstat(currentPath);
    if (currentIdentity.isDirectory() && !currentIdentity.isSymbolicLink()) return;
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const legacyPath = path.resolve(runtimeRoot, legacyTarget);
  const legacyIdentity = await lstat(legacyPath);
  if (!legacyIdentity.isDirectory() || legacyIdentity.isSymbolicLink()) {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
  }
  await rename(legacyPath, currentPath);
  await Promise.all([
    syncDirectory(runtimeRoot),
    syncDirectory(path.join(runtimeRoot, ".releases")),
  ]);
}

async function atomicReplacePointer(runtimeRoot, pointerName, target) {
  const pointerPath = path.join(runtimeRoot, pointerName);
  const temporaryPath = path.join(
    runtimeRoot,
    `.${pointerName}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await symlink(target, temporaryPath);
    await rename(temporaryPath, pointerPath);
    await syncDirectory(runtimeRoot);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function removePointerIfPresent(runtimeRoot, pointerName) {
  const pointerPath = path.join(runtimeRoot, pointerName);
  try {
    const identity = await lstat(pointerPath);
    if (!identity.isSymbolicLink()) {
      throw new Error("RELEASE_POINTER_STATE_AMBIGUOUS");
    }
    await unlink(pointerPath);
    await syncDirectory(runtimeRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function assertPointerMatches(runtimeRoot, pointerName, expected, validateRelease) {
  if (expected.kind === "absent") {
    try {
      await lstat(path.join(runtimeRoot, pointerName));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    throw new Error("RELEASE_POINTER_STATE_AMBIGUOUS");
  }
  if (expected.kind !== "validated") {
    throw new Error("RELEASE_POINTER_STATE_AMBIGUOUS");
  }
  const actual = await inspectValidatedPointer(runtimeRoot, pointerName, validateRelease);
  if (
    actual.target !== expected.target ||
    actual.manifestSha256 !== expected.manifestSha256
  ) {
    throw new Error("RELEASE_POINTER_STATE_AMBIGUOUS");
  }
}

async function createTransactionJournal(runtimeRoot, journal) {
  await assertPathAbsent(
    transactionJournalPath(runtimeRoot),
    "RELEASE_TRANSACTION_PENDING",
  );
  await updateTransactionJournal(runtimeRoot, journal);
}

async function updateTransactionJournal(runtimeRoot, journal) {
  const stateDirectory = path.join(runtimeRoot, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const journalPath = transactionJournalPath(runtimeRoot);
  const temporaryPath = path.join(
    stateDirectory,
    `.${transactionJournalFilename}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const existing = await lstat(journalPath).catch((error) => {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    });
    if (existing === null) {
      try {
        await link(temporaryPath, journalPath);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new Error("RELEASE_TRANSACTION_PENDING", { cause: error });
        }
        throw error;
      }
      await syncDirectory(stateDirectory);
    } else {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
      }
      await rename(temporaryPath, journalPath);
      await syncDirectory(stateDirectory);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readTransactionJournal(runtimeRoot) {
  const journalPath = transactionJournalPath(runtimeRoot);
  let expectedIdentity;
  try {
    expectedIdentity = await lstat(journalPath);
  } catch (error) {
    throw new Error("RELEASE_TRANSACTION_NOT_FOUND", { cause: error });
  }
  if (!expectedIdentity.isFile() || expectedIdentity.isSymbolicLink()) {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
  }
  let handle;
  try {
    handle = await open(
      journalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const openedIdentity = await handle.stat();
    assertExactRegularFile(
      openedIdentity,
      expectedIdentity.dev,
      expectedIdentity.ino,
    );
    return await readBoundedText(handle, maximumTransactionJournalBytes);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function archiveTransactionJournal(runtimeRoot, expectedJournal) {
  const journalPath = transactionJournalPath(runtimeRoot);
  const serialized = await readTransactionJournal(runtimeRoot);
  const observedJournal = parseTransactionJournal(serialized);
  if (JSON.stringify(observedJournal) !== JSON.stringify(expectedJournal)) {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS");
  }
  const stateDirectory = path.dirname(journalPath);
  const archiveDirectory = path.join(stateDirectory, transactionArchiveDirectoryName);
  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  await syncDirectory(stateDirectory);
  const archivePath = path.join(
    archiveDirectory,
    `${expectedJournal.txid}-${expectedJournal.operation}.json`,
  );
  await assertPathAbsent(archivePath, "RELEASE_TRANSACTION_ARCHIVE_EXISTS");
  await archiveFileNoReplace({
    sourcePath: journalPath,
    archiveDirectory,
    archiveName: path.basename(archivePath),
  });
}

function transactionJournalPath(runtimeRoot) {
  return path.join(runtimeRoot, "state", transactionJournalFilename);
}

function parseTransactionJournal(serialized) {
  try {
    const value = JSON.parse(serialized);
    assertExactKeys(value, [
      "abortReason",
      "automationObservations",
      "before",
      "candidate",
      "candidateStagingIdentity",
      "candidateStagingTarget",
      "desired",
      "installerClaim",
      "legacyTarget",
      "maintenanceLease",
      "maintenanceNonce",
      "operation",
      "phase",
      "recoveryAutomationObservations",
      "txid",
      "version",
    ]);
    if (
      value.version !== 2 ||
      !["install", "rollback"].includes(value.operation) ||
      ![
        "maintenance-staged",
        "awaiting-commit",
        "candidate-moving",
        "prepared",
        "legacy-migrating",
        "legacy-migrated",
        "previous-prepared",
        "current-switched",
        "terminal-abort",
      ]
        .includes(value.phase)
    ) {
      throw new Error("INVALID_TRANSACTION_JOURNAL");
    }
    assertUuid(value.txid);
    assertUuid(value.maintenanceNonce);
    if ((value.phase === "terminal-abort") !== (typeof value.abortReason === "string") ||
        (typeof value.abortReason === "string" && ![
          "RELEASE_CLI_DECISION_TIMEOUT",
          "RELEASE_CLI_STDIN_CLOSED",
        ].includes(value.abortReason)) ||
        (value.phase !== "terminal-abort" && value.abortReason !== null)) {
      throw new Error("INVALID_TRANSACTION_ABORT_REASON");
    }
    value.installerClaim = parseJournalInstallerClaim(value.installerClaim);
    value.maintenanceLease = parseJournalMaintenanceLease(
      value.maintenanceLease,
      value.maintenanceNonce,
    );
    assertExactKeys(value.automationObservations, ["commit", "precheck"]);
    value.automationObservations.precheck = parseJournalAutomationObservation(
      value.automationObservations.precheck,
    );
    if (value.automationObservations.commit !== null) {
      value.automationObservations.commit = parseJournalAutomationObservation(
        value.automationObservations.commit,
      );
      if (
        value.automationObservations.precheck.observationId ===
        value.automationObservations.commit.observationId
      ) {
        throw new Error("INVALID_TRANSACTION_OBSERVATIONS");
      }
    } else if (
      !["maintenance-staged", "awaiting-commit", "terminal-abort"].includes(value.phase)
      && value.recoveryAutomationObservations === null
    ) {
      throw new Error("INVALID_TRANSACTION_OBSERVATIONS");
    }
    if (value.recoveryAutomationObservations !== null) {
      assertExactKeys(value.recoveryAutomationObservations, ["commit", "precheck"]);
      value.recoveryAutomationObservations.precheck = parseJournalAutomationObservation(
        value.recoveryAutomationObservations.precheck,
      );
      value.recoveryAutomationObservations.commit = parseJournalAutomationObservation(
        value.recoveryAutomationObservations.commit,
      );
      if (
        value.recoveryAutomationObservations.precheck.observationId ===
        value.recoveryAutomationObservations.commit.observationId
      ) {
        throw new Error("INVALID_TRANSACTION_OBSERVATIONS");
      }
    }
    if (value.phase === "maintenance-staged") {
      if (value.before !== null || value.desired !== null) {
        throw new Error("INVALID_TRANSACTION_POINTER_STATE");
      }
    } else {
      assertExactKeys(value.before, ["current", "previous"]);
      assertExactKeys(value.desired, ["current", "previous"]);
      value.before.current = parseJournalPointerState(value.before.current, true);
      value.before.previous = parseJournalPointerState(value.before.previous, false);
      value.desired.current = parseJournalPointerState(value.desired.current, false);
      value.desired.previous = parseJournalPointerState(value.desired.previous, false);
    }
    if (value.candidate !== null) {
      value.candidate = parseJournalPointerState(value.candidate, false);
      if (value.candidate.kind !== "validated") {
        throw new Error("INVALID_TRANSACTION_CANDIDATE");
      }
    }
    if (
      value.legacyTarget !== null &&
      (typeof value.legacyTarget !== "string" ||
        value.legacyTarget !== path.posix.join(".releases", `legacy-${value.txid}`))
    ) {
      throw new Error("INVALID_TRANSACTION_LEGACY_TARGET");
    }
    if (
      value.candidateStagingTarget !== null
      && (
        value.operation !== "install"
        || typeof value.candidateStagingTarget !== "string"
        || !/^\.releases\/\.staging-[^/]+$/u.test(value.candidateStagingTarget)
      )
    ) {
      throw new Error("INVALID_TRANSACTION_CANDIDATE");
    }
    if (value.candidateStagingIdentity !== null) {
      assertExactKeys(value.candidateStagingIdentity, ["device", "inode"]);
      if (
        value.operation !== "install"
        || typeof value.candidateStagingIdentity.device !== "string"
        || !/^\d+$/u.test(value.candidateStagingIdentity.device)
        || typeof value.candidateStagingIdentity.inode !== "string"
        || !/^\d+$/u.test(value.candidateStagingIdentity.inode)
      ) {
        throw new Error("INVALID_TRANSACTION_CANDIDATE");
      }
    }
    if (
      (value.candidateStagingTarget === null)
      !== (value.candidateStagingIdentity === null)
    ) {
      throw new Error("INVALID_TRANSACTION_CANDIDATE");
    }
    return value;
  } catch (error) {
    throw new Error("RELEASE_TRANSACTION_STATE_AMBIGUOUS", { cause: error });
  }
}

function parseJournalInstallerClaim(value) {
  assertExactKeys(value, [
    "device",
    "inode",
    "journalSha256",
    "nonce",
    "previousNonce",
  ]);
  if (
    typeof value.device !== "string"
    || !/^\d+$/u.test(value.device)
    || typeof value.inode !== "string"
    || !/^\d+$/u.test(value.inode)
  ) {
    throw new Error("INVALID_TRANSACTION_INSTALLER_CLAIM");
  }
  assertUuid(value.nonce);
  if (value.previousNonce !== null) assertUuid(value.previousNonce);
  if (
    value.journalSha256 !== null
    && !manifestSha256Pattern.test(value.journalSha256)
  ) {
    throw new Error("INVALID_TRANSACTION_INSTALLER_CLAIM");
  }
  return value;
}

function parseJournalMaintenanceLease(value, maintenanceNonce) {
  assertExactKeys(value, [
    "device",
    "inode",
    "nonce",
    "path",
    "pid",
    "processStartedAt",
  ]);
  if (
    !/^state\/\.kernel-lock-v1\/[a-f0-9]{64}\.gate$/u.test(value.path) ||
    typeof value.device !== "string" ||
    !/^\d+$/u.test(value.device) ||
    typeof value.inode !== "string" ||
    !/^\d+$/u.test(value.inode) ||
    value.nonce !== maintenanceNonce ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !isIsoDateTime(value.processStartedAt)
  ) {
    throw new Error("INVALID_TRANSACTION_MAINTENANCE_LEASE");
  }
  return value;
}

function parseJournalAutomationObservation(value) {
  assertExactKeys(value, [
    "automationId",
    "observedAt",
    "observationId",
    "requestId",
    "status",
    "targetCount",
  ]);
  assertUuid(value.requestId);
  assertUuid(value.observationId);
  if (
    value.automationId !== "automation" ||
    value.targetCount !== 1 ||
    value.status !== "PAUSED" ||
    !isIsoDateTime(value.observedAt)
  ) {
    throw new Error("INVALID_TRANSACTION_AUTOMATION_OBSERVATION");
  }
  return value;
}

function parseJournalPointerState(value, allowLegacy) {
  assertExactKeys(
    value,
    value?.kind === "validated"
      ? ["kind", "manifestSha256", "target"]
      : ["kind"],
  );
  if (value.kind === "absent") return absentState();
  if (allowLegacy && value.kind === "legacy") return { kind: "legacy" };
  if (
    value.kind !== "validated" ||
    typeof value.target !== "string" ||
    !manifestSha256Pattern.test(value.manifestSha256)
  ) {
    throw new Error("INVALID_TRANSACTION_POINTER_STATE");
  }
  return validatedState(value.target, value.manifestSha256);
}

async function assertPathAbsent(targetPath, errorCode) {
  try {
    await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(errorCode);
}

function assertCommitGateOptions(options) {
  try {
    assertUuid(options?.txid);
    assertUuid(options?.maintenanceNonce);
    assertUuid(options?.automationRequestId);
    if (
      typeof options?.now !== "function" ||
      !isIsoDateTime(options.requestedAt) ||
      !Number.isSafeInteger(options.maximumAgeMs) ||
      options.maximumAgeMs <= 0
    ) {
      throw new Error("INVALID_COMMIT_GATE_OPTIONS");
    }
    const now = options.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("INVALID_COMMIT_GATE_CLOCK");
    }
  } catch (error) {
    throw new Error("RELEASE_COMMIT_DECISION_INVALID", { cause: error });
  }
}

function assertExactKeys(value, expectedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_OBJECT");
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("UNEXPECTED_FIELDS");
  }
}

function assertUuid(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error("INVALID_UUID");
  }
}

function isIsoDateTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

async function inspectProcessOwnerIdentity(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return "dead";
    return "unknown";
  }

  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(owner.pid)],
      {
        encoding: "utf8",
        env: {
          LANG: "C",
          PATH: "/usr/bin:/bin",
        },
        timeout: 2_000,
      },
    );
    const actualStartedAt = Date.parse(stdout.trim());
    const expectedStartedAt = Date.parse(owner.processStartedAt);
    if (!Number.isFinite(actualStartedAt) || !Number.isFinite(expectedStartedAt)) {
      return "unknown";
    }
    return Math.abs(actualStartedAt - expectedStartedAt) <= 2_000
      ? "alive-exact"
      : "pid-reused";
  } catch {
    try {
      process.kill(owner.pid, 0);
      return "unknown";
    } catch (error) {
      return isNodeError(error) && error.code === "ESRCH" ? "dead" : "unknown";
    }
  }
}

function isStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readBoundedText(handle, maximumBytes) {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > maximumBytes) {
    throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS");
  }
  return buffer.subarray(0, length).toString("utf8");
}

function assertExactRegularFile(identity, device, inode) {
  if (!identity.isFile() || identity.dev !== device || identity.ino !== inode) {
    throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS");
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
