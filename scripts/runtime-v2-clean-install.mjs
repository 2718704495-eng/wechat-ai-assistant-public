#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants, readSync } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createEmptyPayloadContainer,
  materializePayloadContainer,
  populatePayloadContainerFromDirectory,
  validatePayloadContainerFd,
} from "./runtime-v2-payload-container.mjs";
import { appendInstallPhase, parseInstallJournal } from "./runtime-v2-install-journal.mjs";

const runtimeBasename = "runtime-v2";
const releaseStoreBasename = ".releases";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const compatibilityTombstone =
  "{\"purpose\":\"round7-compatibility-tombstone\",\"version\":1}\n";
const catalogPurposes = ["release-installer", "live-operation", "encrypted-store-global"];
const addonKeys = [
  "lockExclusiveNonblocking", "unlock", "inspect", "archiveNoReplace",
  "openDirectoryAtNoFollow", "openFileAtNoFollow", "openReadFileAtNoFollow",
  "readDirectoryNames", "inspectEntryAtNoFollow", "readLinkAtNoFollow", "closeFd", "fsyncFd",
  "mkdirAtNoReplace", "createPrivateDirectoryAtNoReplace",
  "createFileAtNoReplace",
  "writeFileAtNoReplace", "linkAtNoReplace",
  "symlinkAtNoReplace", "chmodAtExpected", "directoryIsEmpty",
  "removePrivateTreeAtExpected",
];

export async function installCleanRuntimeV2(options, hooks = {}) {
  assertExactOptions(options);
  assertInstallHooks(hooks);
  const sourceRoot = assertNormalizedAbsolutePath(options.sourceRoot);
  const runtimeRoot = assertNormalizedAbsolutePath(options.runtimeRoot);
  const candidateRoot = assertNormalizedAbsolutePath(options.candidateRoot);
  if (path.basename(runtimeRoot) !== runtimeBasename) {
    throw new Error("RUNTIME_V2_DESTINATION_INVALID");
  }

  const [sourceIdentity, candidateIdentity] = await Promise.all([
    lstat(sourceRoot).catch((error) => {
      throw new Error("RUNTIME_V2_SOURCE_INVALID", { cause: error });
    }),
    lstat(candidateRoot).catch((error) => {
      throw new Error("RUNTIME_V2_CANDIDATE_INVALID", { cause: error });
    }),
  ]);
  if (!sourceIdentity.isDirectory() || sourceIdentity.isSymbolicLink()) {
    throw new Error("RUNTIME_V2_SOURCE_INVALID");
  }
  if (!candidateIdentity.isDirectory() || candidateIdentity.isSymbolicLink()) {
    throw new Error("RUNTIME_V2_CANDIDATE_INVALID");
  }
  const canonicalParent = await realpath(path.dirname(runtimeRoot)).catch((error) => {
    throw new Error("RUNTIME_V2_PARENT_INVALID", { cause: error });
  });
  const canonicalRuntime = path.join(canonicalParent, runtimeBasename);
  const [canonicalSource, canonicalCandidate] = await Promise.all([
    realpath(sourceRoot),
    realpath(candidateRoot),
  ]);
  if (pathsOverlap(canonicalSource, canonicalRuntime) ||
      pathsOverlap(canonicalCandidate, canonicalRuntime) ||
      pathsOverlap(canonicalSource, canonicalCandidate)) {
    throw new Error("RUNTIME_V2_PATH_OVERLAP");
  }

  const rootPreflight = await inspectRuntimeRoot(runtimeRoot);
  let runtimeParent = null;
  let candidate = null;
  let addonBinding = null;
  let addon = null;
  let containerParent = null;
  let payloadContainer = null;
  let runtime = null;
  let releaseStore = null;
  let release = null;
  let catalogBinding = null;
  let materializationGates = null;
  let currentBinding = null;
  let journal = null;
  let journalState = null;
  let transactionId = null;
  let containerName = null;
  let installResult = null;
  let installError = null;
  try {
    runtimeParent = await openBoundRuntimeParent(path.dirname(runtimeRoot), canonicalParent);
    candidate = await openBoundCandidateInput(candidateRoot, canonicalCandidate);
    addonBinding = await loadInstallerAddon(sourceRoot, hooks);
    addon = addonBinding.api;
    const assertBoundary = async () => {
      await assertInstallBoundaryBound({
        runtimeRoot, runtimeParent, candidateRoot, candidate, addonBinding,
        runtime, releaseStore, release, catalogBinding, currentBinding,
        materializationGates,
      });
      if (payloadContainer !== null) {
        await assertPayloadContainerBound(payloadContainer, containerParent, addon);
      }
    };
    await assertPreinstallInputsBound({
      runtimeRoot, runtimeParent, candidateRoot, candidate, addonBinding,
    });
    await assertNoExistingInstallJournal({ runtimeParent, addon, runtimeRoot });
    containerParent = await openBoundContainerParent();
    transactionId = randomUUID();
    containerName = `runtime-v2-payload-${transactionId}.container`;
    const createdJournal = addon.createFileAtNoReplace(
      runtimeParent.fd,
      `${runtimeBasename}.install-journal.jsonl`,
      0o600,
    );
    statusOk(createdJournal);
    journal = createdJournal;
    journalState = await appendInstallPhase({
      fd: journal.fd,
      txid: transactionId,
      previous: null,
      phase: "intent-recorded",
      facts: {
        candidate: identityFact(candidate),
        runtimePreflight: identityFact(rootPreflight),
        ...containerRetentionFacts(containerParent, null, containerName),
      },
    });
    statusOk(addon.fsyncFd(runtimeParent.fd));
    payloadContainer = await createEmptyPayloadContainer({
      parentFd: containerParent.fd,
      name: containerName,
      addon,
    });
    journalState = await appendDurableInstallPhase({
      addon, journal, journalState, parent: runtimeParent, transactionId,
      phase: "container-created",
      facts: {
        ...containerRetentionFacts(containerParent, payloadContainer, containerName),
      },
    });
    payloadContainer = await populatePayloadContainerFromDirectory({
      container: payloadContainer,
      candidate,
      addon,
      beforePopulationStart: async (population) => {
        journalState = await appendDurableInstallPhase({
          addon, journal, journalState, parent: runtimeParent, transactionId,
          phase: "population-started",
          facts: {
            expectedTargetSize: population.expectedTargetSize,
            partialState: population.partialState,
            prepopulationIdentity: durableContainerIdentityFact(
              population.prepopulationIdentity,
            ),
            ...containerRetentionFacts(containerParent, payloadContainer, containerName),
          },
        });
      },
      beforeResourceClose: async (stage, context) => runInstallHook(hooks, stage, context),
    });
    await runInstallHook(hooks, "container-before-validator");
    const candidateValidation = await validatePayloadContainerFd({
      fd: payloadContainer.fd,
      expectedIdentity: payloadContainer.identity,
    });
    journalState = await appendDurableInstallPhase({
      addon, journal, journalState, parent: runtimeParent, transactionId,
      phase: "container-validated",
      facts: {
        ...containerFacts(candidateValidation),
        ...containerRetentionFacts(containerParent, payloadContainer, containerName),
      },
    });
    await runInstallHook(hooks, "before-first-mutation");
    await assertBoundary();
    if (rootPreflight === null) {
      statusOk(addon.mkdirAtNoReplace(runtimeParent.fd, runtimeBasename, 0o700));
    }
    runtime = openDirectoryAt(addon, runtimeParent.fd, runtimeBasename, canonicalRuntime);
    if (rootPreflight !== null &&
        (Number(rootPreflight.dev) !== runtime.dev || Number(rootPreflight.ino) !== runtime.ino ||
         rootPreflight.uid !== currentUid() || (rootPreflight.mode & 0o777) !== 0o700)) {
      throw new Error("RUNTIME_V2_IDENTITY_DRIFT");
    }
    assertDirectoryEmpty(addon, runtime.fd);
    await assertBoundary();

    catalogBinding = await initializeCatalogAt(runtime, addon, async (localCatalogBinding) => {
      await assertInstallBoundaryBound({
        runtimeRoot, runtimeParent, candidateRoot, candidate, addonBinding,
        runtime, releaseStore, release,
        catalogBinding: localCatalogBinding,
        currentBinding,
        materializationGates,
      });
    });
    materializationGates = acquireMaterializationGates(catalogBinding, addon);
    journalState = await appendDurableInstallPhase({
      addon, journal, journalState, parent: runtimeParent, transactionId,
      phase: "gates-held",
      facts: {
        purposes: ["release-installer", "live-operation"],
        runtime: observedNativeIdentityFact(addon, runtime),
        catalog: catalogIdentityFacts(catalogBinding),
        gates: materializationGateIdentityFacts(materializationGates, addon),
        ...containerRetentionFacts(containerParent, payloadContainer, containerName),
      },
    });
    await assertBoundary();

    statusOk(addon.mkdirAtNoReplace(runtime.fd, releaseStoreBasename, 0o700));
    releaseStore = openDirectoryAt(
      addon,
      runtime.fd,
      releaseStoreBasename,
      path.join(canonicalRuntime, releaseStoreBasename),
    );
    const releaseBasename =
      `release-${candidateValidation.payloadManifestSha256.slice(0, 16)}-${transactionId}`;
    const releaseRoot = path.join(canonicalRuntime, releaseStoreBasename, releaseBasename);
    await runInstallHook(hooks, "before-release-create");
    await assertBoundary();
    statusOk(addon.mkdirAtNoReplace(releaseStore.fd, releaseBasename, 0o700));
    release = openDirectoryAt(addon, releaseStore.fd, releaseBasename, releaseRoot);
    await materializePayloadContainer({
      fd: payloadContainer.fd,
      expectedReceipt: candidateValidation,
      destination: release,
      addon,
      assertBoundary,
      beforeMutation: async (stage, context) => runInstallHook(hooks, stage, context),
      beforeResourceClose: async (stage, context) => runInstallHook(hooks, stage, context),
    });
    journalState = await appendDurableInstallPhase({
      addon, journal, journalState, parent: runtimeParent, transactionId,
      phase: "materialized",
      facts: {
        runtime: observedNativeIdentityFact(addon, runtime),
        releaseStore: observedNativeIdentityFact(addon, releaseStore),
        release: identityFact(release),
        releaseBasename,
        ...containerFacts(candidateValidation),
        ...containerRetentionFacts(containerParent, payloadContainer, containerName),
      },
    });
    statusOk(addon.fsyncFd(release.fd));
    await runInstallHook(hooks, "before-release-chmod");
    await assertBoundary();
    statusOk(addon.chmodAtExpected(
      releaseStore.fd,
      releaseBasename,
      release.dev,
      release.ino,
      0o555,
      true,
    ));
    statusOk(addon.fsyncFd(releaseStore.fd));
    await assertBoundary();
    const stagedValidation = await validateReleaseUnderBoundRuntime(
      releaseRoot,
      runtimeRoot,
      runtime,
    );
    if (stagedValidation.manifestSha256 !== candidateValidation.payloadManifestSha256) {
      throw new Error("RUNTIME_V2_STAGED_MANIFEST_MISMATCH");
    }

    await runInstallHook(hooks, "before-final-validation", { releaseRoot });
    await assertInstallBoundaryBound({
      runtimeRoot, runtimeParent, candidateRoot, candidate, addonBinding,
      runtime, releaseStore, release, catalogBinding, currentBinding,
      materializationGates,
    });
    const finalValidation = await validateReleaseUnderBoundRuntime(
      releaseRoot,
      runtimeRoot,
      runtime,
    );
    if (finalValidation.manifestSha256 !== candidateValidation.payloadManifestSha256) {
      throw new Error("RUNTIME_V2_FINAL_MANIFEST_MISMATCH");
    }
    journalState = await appendDurableInstallPhase({
      addon, journal, journalState, parent: runtimeParent, transactionId,
      phase: "release-validated",
      facts: {
        release: observedNativeIdentityFact(addon, release),
        releaseBasename,
        manifestSha256: finalValidation.manifestSha256,
        ...containerRetentionFacts(containerParent, payloadContainer, containerName),
      },
    });
    const currentTarget = `${releaseStoreBasename}/${releaseBasename}`;
    const durableReceipt = Buffer.from(`${JSON.stringify({
      version: 1,
      phase: "ready-to-link-current",
      transactionId,
      currentTarget,
      containerSha256: candidateValidation.containerSha256,
      headerSha256: candidateValidation.headerSha256,
      manifestSha256: candidateValidation.payloadManifestSha256,
      release: { dev: String(release.dev), ino: String(release.ino) },
      runtime: { dev: String(runtime.dev), ino: String(runtime.ino) },
    })}\n`);
    await runInstallHook(hooks, "before-durable-receipt");
    await assertBoundary();
    statusOk(addon.writeFileAtNoReplace(
      catalogBinding.state.fd,
      `install-receipt-${transactionId}.json`,
      durableReceipt,
      0o600,
    ));
    statusOk(addon.fsyncFd(catalogBinding.state.fd));
    await assertBoundary();
    journalState = await appendDurableInstallPhase({
      addon, journal, journalState, parent: runtimeParent, transactionId,
      phase: "ready-to-link",
      facts: {
        currentTarget,
        release: observedNativeIdentityFact(addon, release),
        ...containerFacts(candidateValidation),
        ...containerRetentionFacts(containerParent, payloadContainer, containerName),
      },
    });
    await runInstallHook(hooks, "before-current-container-validation");
    await assertBoundary();
    await runInstallHook(hooks, "before-current-symlink");
    await assertBoundary();
    const beforeCurrentContainerValidation = await validatePayloadContainerFd({
      fd: payloadContainer.fd,
      expectedIdentity: payloadContainer.identity,
    });
    assertInstallContainerReceiptMatches(candidateValidation, beforeCurrentContainerValidation);
    statusOk(addon.symlinkAtNoReplace(runtime.fd, currentTarget, "current"));
    statusOk(addon.fsyncFd(runtime.fd));
    const currentPath = path.join(runtimeRoot, "current");
    const [currentIdentity, observedTarget, resolvedCurrent, resolvedRelease] = await Promise.all([
      lstat(currentPath),
      readlink(currentPath),
      realpath(currentPath),
      realpath(releaseRoot),
    ]);
    if (!currentIdentity.isSymbolicLink() || observedTarget !== currentTarget ||
        resolvedCurrent !== resolvedRelease) {
      throw new Error("RUNTIME_V2_CURRENT_POINTER_INVALID");
    }
    const currentNoFollow = addon.readLinkAtNoFollow(runtime.fd, "current");
    statusOk(currentNoFollow);
    currentBinding = bindCurrentIdentity({
      ...currentNoFollow,
      target: currentTarget,
      resolvedRelease,
      manifestSha256: candidateValidation.payloadManifestSha256,
    });
    const { validateInstalledRuntimeV2 } = await import(pathToFileURL(path.join(
      moduleDirectory,
      "release-payload.mjs",
    )).href);
    const installedValidation = await validateInstalledRuntimeV2({ runtimeRoot });
    if (installedValidation.manifestSha256 !== candidateValidation.payloadManifestSha256) {
      throw new Error("RUNTIME_V2_INSTALLED_VALIDATION_MISMATCH");
    }
    journalState = await appendDurableInstallPhase({
      addon, journal, journalState, parent: runtimeParent, transactionId,
      phase: "current-published",
      facts: {
        current: currentIdentityFact(currentBinding),
        currentTarget,
        manifestSha256: installedValidation.manifestSha256,
        ...containerRetentionFacts(containerParent, payloadContainer, containerName),
      },
    });
    await runInstallHook(hooks, "before-install-success", { releaseRoot });
    await assertBoundary();
    journalState = await appendDurableInstallPhase({
      addon, journal, journalState, parent: runtimeParent, transactionId,
      phase: "complete",
      facts: {
        currentTarget,
        manifestSha256: installedValidation.manifestSha256,
        ...containerRetentionFacts(containerParent, payloadContainer, containerName),
      },
    });
    installResult = Object.freeze({
      status: "installed",
      currentTarget,
      manifestSha256: candidateValidation.payloadManifestSha256,
      candidateValidationSha256: candidateValidation.payloadManifestSha256,
      stagedValidationSha256: stagedValidation.manifestSha256,
      containerSha256: candidateValidation.containerSha256,
      receipt: `state/install-receipt-${transactionId}.json`,
      runtimeDevice: String(runtime.dev),
      releaseDevice: String(release.dev),
    });
  } catch (error) {
    installError = error;
    if (journal !== null && journalState !== null && journalState.phase !== "complete" &&
        journalState.phase !== "error" && transactionId !== null) {
      try {
        journalState = await appendDurableInstallPhase({
          addon, journal, journalState, parent: runtimeParent, transactionId,
          phase: "error",
          facts: {
            ...journalState.facts,
            code: safeInstallErrorCode(error),
            terminalFromPhase: journalState.phase,
            ...containerRetentionFacts(
              containerParent,
              payloadContainer,
              payloadContainer?.name ?? containerName,
            ),
          },
        });
      } catch (journalError) {
        installError = combineInstallErrors(installError, journalError);
      }
    }
  } finally {
    let cleanupError = null;
    // The opened container is deliberately retained for forensic recovery. Darwin has no
    // compare-and-unlink primitive that can safely delete the same named object.
    const gateError = releaseMaterializationGates(materializationGates, addon);
    const closeError = await closeAllInstallerResources(addon, {
      native: [
        catalogBinding?.catalogShaFile,
        catalogBinding?.catalogFile,
        catalogBinding?.gateDirectory,
        catalogBinding?.state,
        journal,
        release,
        releaseStore,
        runtime,
      ],
      node: [
        candidate?.handle,
        candidate?.parentHandle,
        addonBinding?.addonHandle,
        addonBinding?.manifestHandle,
        runtimeParent?.handle,
      ],
    });
    const containerCloseError = await closePayloadContainer(payloadContainer, addon, hooks);
    const containerParentCloseError = await closeContainerParent(containerParent, hooks);
    installError = combineInstallErrors(
      installError,
      cleanupError,
      gateError,
      containerCloseError,
      containerParentCloseError,
      closeError,
    );
  }
  if (installError !== null) throw installError;
  if (installResult === null) throw new Error("RUNTIME_V2_INSTALL_RESULT_MISSING");
  return installResult;
}

export function assertOwnedRuntimeV2RootIdentity(identity, expectedUid) {
  if (identity === null || typeof identity !== "object" ||
      typeof identity.isDirectory !== "function" ||
      typeof identity.isSymbolicLink !== "function" ||
      !identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("RUNTIME_V2_ROOT_TYPE_INVALID");
  }
  if (!Number.isInteger(expectedUid) || identity.uid !== expectedUid) {
    throw new Error("RUNTIME_V2_ROOT_OWNER_INVALID");
  }
  if ((Number(identity.mode) & 0o777) !== 0o700) {
    throw new Error("RUNTIME_V2_ROOT_MODE_INVALID");
  }
}

async function initializeCatalogAt(runtime, addon, assertBoundary) {
  await assertBoundary(null);
  statusOk(addon.mkdirAtNoReplace(runtime.fd, "state", 0o700));
  const state = openDirectoryAt(
    addon,
    runtime.fd,
    "state",
    path.join(runtime.realpath, "state"),
  );
  let gateDirectory = null;
  let catalogFile = null;
  let catalogShaFile = null;
  let catalogSha256 = null;
  let catalogShaFileSha256 = null;
  let operationError = null;
  let result = null;
  const currentBinding = () => Object.freeze({
    state,
    gateDirectory,
    catalogFile,
    catalogShaFile,
    catalogSha256,
    catalogShaFileSha256,
  });
  try {
    for (const name of ["release-install.lock", "live-operation.lock"]) {
      await assertBoundary(currentBinding());
      statusOk(addon.writeFileAtNoReplace(
        state.fd,
        name,
        Buffer.from(compatibilityTombstone),
        0o600,
      ));
    }
    await assertBoundary(currentBinding());
    statusOk(addon.mkdirAtNoReplace(state.fd, ".kernel-lock-v1", 0o700));
    gateDirectory = openDirectoryAt(
      addon,
      state.fd,
      ".kernel-lock-v1",
      path.join(state.realpath, ".kernel-lock-v1"),
    );
    const purposes = [];
    for (const purpose of catalogPurposes) {
      const digest = createHash("sha256").update(purpose).digest("hex");
      const anchor = `${digest}.anchor`;
      const gate = `${digest}.gate`;
      await assertBoundary(currentBinding());
      statusOk(addon.writeFileAtNoReplace(gateDirectory.fd, anchor, Buffer.alloc(0), 0o600));
      await assertBoundary(currentBinding());
      statusOk(addon.linkAtNoReplace(gateDirectory.fd, anchor, gate));
      const handle = openFileAt(
        addon,
        gateDirectory.fd,
        gate,
        path.join(gateDirectory.realpath, gate),
      );
      try {
        purposes.push({
          purpose,
          anchor,
          gate,
          dev: String(handle.dev),
          ino: String(handle.ino),
          uid: currentUid(),
          mode: handle.mode & 0o777,
          nlink: handle.nlink,
          sha256: createHash("sha256").update("").digest("hex"),
        });
      } finally {
        closeNative(addon, handle);
      }
    }
    const catalog = `${JSON.stringify({
      version: 1,
      state: { dev: String(state.dev), ino: String(state.ino) },
      purposes,
    })}\n`;
    const digest = `${createHash("sha256").update(catalog).digest("hex")}  catalog.json\n`;
    catalogSha256 = createHash("sha256").update(catalog).digest("hex");
    catalogShaFileSha256 = createHash("sha256").update(digest).digest("hex");
    await assertBoundary(currentBinding());
    statusOk(addon.writeFileAtNoReplace(
      gateDirectory.fd,
      "catalog.json",
      Buffer.from(catalog),
      0o600,
    ));
    catalogFile = openFileAt(
      addon,
      gateDirectory.fd,
      "catalog.json",
      path.join(gateDirectory.realpath, "catalog.json"),
    );
    await assertBoundary(currentBinding());
    statusOk(addon.writeFileAtNoReplace(
      gateDirectory.fd,
      "catalog.sha256",
      Buffer.from(digest),
      0o600,
    ));
    catalogShaFile = openFileAt(
      addon,
      gateDirectory.fd,
      "catalog.sha256",
      path.join(gateDirectory.realpath, "catalog.sha256"),
    );
    await assertBoundary(currentBinding());
    statusOk(addon.fsyncFd(gateDirectory.fd));
    await assertBoundary(currentBinding());
    statusOk(addon.fsyncFd(state.fd));
    await assertBoundary(currentBinding());
    statusOk(addon.fsyncFd(runtime.fd));
    await assertBoundary(currentBinding());
    result = currentBinding();
  } catch (error) {
    operationError = error;
  } finally {
    if (operationError !== null) {
      const closeError = await closeAllInstallerResources(addon, {
        native: [catalogShaFile, catalogFile, gateDirectory, state],
        node: [],
      });
      operationError = combineInstallErrors(operationError, closeError);
    }
  }
  if (operationError !== null) throw operationError;
  if (result === null) throw new Error("RUNTIME_V2_CATALOG_BINDING_MISSING");
  return result;
}

async function loadInstallerAddon(sourceRoot, hooks) {
  let manifestHandle = null;
  let addonHandle = null;
  try {
    const directory = path.join(
      sourceRoot,
      "native",
      "kernel-lock",
      "build",
      `${process.platform}-${process.arch}`,
    );
    manifestHandle = await open(
      path.join(directory, "kernel_lock.manifest.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    addonHandle = await open(
      path.join(directory, "kernel_lock.node"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const [manifestBytes, addonBytes] = await Promise.all([
      manifestHandle.readFile(),
      addonHandle.readFile(),
    ]);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const sourceAddonIdentity = await addonHandle.stat();
    const sourceAddonHash = createHash("sha256").update(addonBytes).digest("hex");
    if (manifest?.version !== 2 || manifest.platform !== process.platform ||
        manifest.arch !== process.arch || manifest.napi !== Number(process.versions.napi) ||
        manifest.sha256 !== sourceAddonHash) {
      throw new Error("RUNTIME_V2_KERNEL_ADDON_INVALID");
    }

    if (!sourceAddonIdentity.isFile() || sourceAddonIdentity.uid !== currentUid()) {
      throw new Error("RUNTIME_V2_KERNEL_ADDON_INVALID");
    }
    const sourceAddonPath = path.join(directory, "kernel_lock.node");
    await runInstallHook(hooks, "before-native-addon-load", { sourceAddonPath });
    const nativeModule = { exports: {} };
    process.dlopen(nativeModule, `/dev/fd/${addonHandle.fd}`);
    const addon = nativeModule.exports;
    const [postHandleIdentity, postPathIdentity] = await Promise.all([
      addonHandle.stat(),
      lstat(sourceAddonPath),
    ]).catch((error) => {
      throw new Error("RUNTIME_V2_KERNEL_ADDON_IDENTITY_DRIFT", { cause: error });
    });
    assertSameNodeIdentity(
      sourceAddonIdentity,
      postHandleIdentity,
      "RUNTIME_V2_KERNEL_ADDON_IDENTITY_DRIFT",
    );
    assertSameNodeIdentity(
      sourceAddonIdentity,
      postPathIdentity,
      "RUNTIME_V2_KERNEL_ADDON_IDENTITY_DRIFT",
    );
    const keys = Reflect.ownKeys(addon);
    if (keys.length !== addonKeys.length || keys.some((key, index) => key !== addonKeys[index])) {
      throw new Error("RUNTIME_V2_KERNEL_ADDON_INVALID");
    }
    return Object.freeze({
      api: addon,
      manifestHandle,
      addonHandle,
      manifestPath: path.join(directory, "kernel_lock.manifest.json"),
      addonPath: sourceAddonPath,
      manifestIdentity: bindNodeIdentity(
        manifestHandle,
        await manifestHandle.stat(),
        await realpath(path.join(directory, "kernel_lock.manifest.json")),
        "file",
      ),
      addonIdentity: bindNodeIdentity(
        addonHandle,
        sourceAddonIdentity,
        await realpath(sourceAddonPath),
        "file",
      ),
    });
  } catch (error) {
    const closeError = await closeAllInstallerResources(null, {
      native: [],
      node: [manifestHandle, addonHandle],
    });
    throw combineInstallErrors(error, closeError);
  }
}

async function openBoundRuntimeParent(parentPath, expectedRealpath) {
  const handle = await open(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory() || identity.uid !== currentUid()) {
      throw new Error("RUNTIME_V2_PARENT_INVALID");
    }
    return bindNodeIdentity(handle, identity, expectedRealpath, "directory");
  } catch (error) {
    const closeError = await closeAllInstallerResources(null, { native: [], node: [handle] });
    throw combineInstallErrors(error, closeError);
  }
}

async function openBoundCandidateInput(candidateRoot, expectedRealpath) {
  const parentPath = path.dirname(candidateRoot);
  const parentRealpath = await realpath(parentPath).catch((error) => {
    throw new Error("RUNTIME_V2_CANDIDATE_PARENT_INVALID", { cause: error });
  });
  const parentHandle = await open(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let handle = null;
  try {
    const parentIdentity = await parentHandle.stat();
    const boundParent = bindNodeIdentity(
      parentHandle,
      parentIdentity,
      parentRealpath,
      "directory",
    );
    handle = await open(
      candidateRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = await handle.stat();
    const bound = bindNodeIdentity(handle, identity, expectedRealpath, "directory");
    return Object.freeze({
      ...bound,
      parentHandle,
      parent: boundParent,
    });
  } catch (error) {
    const closeError = await closeAllInstallerResources(null, {
      native: [],
      node: [handle, parentHandle],
    });
    throw combineInstallErrors(error, closeError);
  }
}

async function openBoundContainerParent() {
  const parentPath = await realpath(os.tmpdir());
  const handle = await open(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    return bindNodeIdentity(handle, await handle.stat(), parentPath, "directory");
  } catch (error) {
    const closeError = await closeAllInstallerResources(null, { native: [], node: [handle] });
    throw combineInstallErrors(error, closeError);
  }
}

async function assertPayloadContainerBound(container, parent, addon) {
  if (parent === null) throw new Error("PAYLOAD_CONTAINER_PARENT_MISSING");
  await assertNodePathBound(parent.realpath, parent, "PAYLOAD_CONTAINER_PARENT_DRIFT");
  const observed = addon.inspect(container.fd);
  statusOk(observed);
  if (observed.dev !== container.identity.dev || observed.ino !== container.identity.ino ||
      observed.uid !== container.identity.uid || observed.mode !== container.identity.mode ||
      observed.nlink !== container.identity.nlink) {
    throw new Error("PAYLOAD_CONTAINER_IDENTITY_DRIFT");
  }
}

async function closePayloadContainer(container, addon, hooks) {
  if (container === null || addon === null) return null;
  const errors = [];
  try {
    await runInstallHook(hooks, "container-close-fd");
  } catch (error) {
    errors.push(error);
  }
  try {
    closeNative(addon, container);
  } catch (error) {
    errors.push(error);
  }
  return combineInstallErrors(...errors);
}

async function closeContainerParent(parent, hooks) {
  if (parent === null) return null;
  const errors = [];
  try {
    await runInstallHook(hooks, "container-close-parent");
  } catch (error) {
    errors.push(error);
  }
  try {
    await parent.handle.close();
  } catch (error) {
    errors.push(new Error("RUNTIME_V2_NODE_CLOSE_FAILED", { cause: error }));
  }
  return combineInstallErrors(...errors);
}

async function appendDurableInstallPhase({
  addon,
  journal,
  journalState,
  parent,
  transactionId,
  phase,
  facts,
}) {
  if (addon === null || journal === null || parent === null || transactionId === null) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_MISSING");
  }
  const next = await appendInstallPhase({
    fd: journal.fd,
    txid: transactionId,
    previous: journalState,
    phase,
    facts: {
      ...(journalState?.facts ?? {}),
      ...facts,
    },
  });
  statusOk(addon.fsyncFd(parent.fd));
  return next;
}

function containerFacts(receipt) {
  return {
    containerSha256: receipt.containerSha256,
    headerSha256: receipt.headerSha256,
    manifestSha256: receipt.payloadManifestSha256,
    containerIdentity: identityFact(receipt.identity),
  };
}

function containerRetentionFacts(parent, container, name) {
  if (parent === null || typeof parent?.realpath !== "string" ||
      typeof name !== "string" || name.length === 0 || name.includes("/") ||
      name.includes("\0")) {
    throw new Error("RUNTIME_V2_CONTAINER_RETENTION_INVALID");
  }
  return {
    containerName: name,
    containerParent: {
      ...identityFact(parent),
      realpath: parent.realpath,
    },
    containerIdentity: container === null ? null : {
      ...identityFact(container.identity),
      size: container.identity.size,
    },
    retained: container !== null,
  };
}

function durableContainerIdentityFact(identity) {
  const fact = identityFact(identity);
  if (fact === null || !Number.isSafeInteger(identity?.size) || identity.size < 0) {
    throw new Error("RUNTIME_V2_CONTAINER_RETENTION_INVALID");
  }
  return { ...fact, size: identity.size };
}

function assertInstallContainerReceiptMatches(expected, observed) {
  for (const key of [
    "formatVersion", "containerSha256", "headerSha256", "payloadManifestSha256",
    "runtimeContractVersion", "entryCount", "size",
  ]) {
    if (expected?.[key] !== observed?.[key]) {
      throw new Error("RUNTIME_V2_CONTAINER_RECEIPT_MISMATCH");
    }
  }
  const left = identityFact(expected?.identity);
  const right = identityFact(observed?.identity);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("RUNTIME_V2_CONTAINER_RECEIPT_MISMATCH");
  }
}

function identityFact(identity) {
  if (identity === null || identity === undefined) return null;
  return {
    dev: String(identity.dev),
    ino: String(identity.ino),
    mode: identity.mode,
    nlink: identity.nlink,
    uid: identity.uid,
  };
}

function observedNativeIdentityFact(addon, expected) {
  const observed = addon.inspect(expected.fd);
  statusOk(observed);
  if (observed.dev !== expected.dev || observed.ino !== expected.ino ||
      observed.uid !== expected.uid) {
    throw new Error("RUNTIME_V2_NATIVE_IDENTITY_DRIFT");
  }
  return identityFact(observed);
}

function catalogIdentityFacts(binding) {
  if (binding === null || binding.state === null || binding.gateDirectory === null ||
      binding.catalogFile === null || binding.catalogShaFile === null ||
      typeof binding.catalogSha256 !== "string" ||
      typeof binding.catalogShaFileSha256 !== "string") {
    throw new Error("RUNTIME_V2_CATALOG_IDENTITY_DRIFT");
  }
  return {
    state: identityFact(binding.state),
    gateDirectory: identityFact(binding.gateDirectory),
    catalogFile: identityFact(binding.catalogFile),
    catalogShaFile: identityFact(binding.catalogShaFile),
    catalogSha256: binding.catalogSha256,
    catalogShaFileSha256: binding.catalogShaFileSha256,
  };
}

function materializationGateIdentityFacts(gates, addon) {
  assertMaterializationGatesBound(gates, addon);
  return gates.map((gate) => ({
    purpose: gate.purpose,
    ...identityFact(gate.handle),
  }));
}

function currentIdentityFact(binding) {
  return {
    ...identityFact(binding),
    target: binding.target,
    resolvedRelease: binding.resolvedRelease,
    manifestSha256: binding.manifestSha256,
  };
}

function safeInstallErrorCode(error) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : "RUNTIME_V2_INSTALL_FAILED";
}

function acquireMaterializationGates(catalogBinding, addon) {
  if (catalogBinding?.gateDirectory === null || catalogBinding?.gateDirectory === undefined) {
    throw new Error("RUNTIME_V2_CATALOG_BINDING_MISSING");
  }
  const acquired = [];
  try {
    for (const purpose of ["release-installer", "live-operation"]) {
      const digest = createHash("sha256").update(purpose).digest("hex");
      const name = `${digest}.gate`;
      const handle = openFileAt(
        addon,
        catalogBinding.gateDirectory.fd,
        name,
        path.join(catalogBinding.gateDirectory.realpath, name),
      );
      const locked = addon.lockExclusiveNonblocking(handle.fd);
      if (locked?.ok !== true) {
        closeNative(addon, handle);
        throw new Error("RUNTIME_V2_MATERIALIZATION_GATE_BUSY");
      }
      acquired.push(Object.freeze({ purpose, handle }));
    }
    return Object.freeze(acquired);
  } catch (error) {
    const releaseError = releaseMaterializationGates(acquired, addon);
    throw combineInstallErrors(error, releaseError);
  }
}

function assertMaterializationGatesBound(gates, addon) {
  if (!Array.isArray(gates) || gates.length !== 2 ||
      gates[0]?.purpose !== "release-installer" || gates[1]?.purpose !== "live-operation") {
    throw new Error("RUNTIME_V2_MATERIALIZATION_GATE_INVALID");
  }
  for (const gate of gates) {
    const observed = addon.inspect(gate.handle.fd);
    statusOk(observed);
    if (observed.dev !== gate.handle.dev || observed.ino !== gate.handle.ino ||
        observed.uid !== gate.handle.uid || observed.mode !== gate.handle.mode) {
      throw new Error("RUNTIME_V2_MATERIALIZATION_GATE_INVALID");
    }
  }
}

function releaseMaterializationGates(gates, addon) {
  if (gates === null || addon === null) return null;
  const errors = [];
  for (const gate of [...gates].reverse()) {
    try {
      statusOk(addon.unlock(gate.handle.fd));
    } catch (error) {
      errors.push(error);
    }
    try {
      closeNative(addon, gate.handle);
    } catch (error) {
      errors.push(error);
    }
  }
  return combineInstallErrors(...errors);
}

function bindNodeIdentity(handle, identity, expectedRealpath, type) {
  const matchesType = type === "directory" ? identity.isDirectory() : identity.isFile();
  if (!matchesType || identity.uid !== currentUid() ||
      !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino) ||
      typeof expectedRealpath !== "string" || !path.isAbsolute(expectedRealpath)) {
    throw new Error("RUNTIME_V2_NODE_IDENTITY_INVALID");
  }
  return Object.freeze({
    handle,
    fd: handle.fd,
    realpath: expectedRealpath,
    dev: Number(identity.dev),
    ino: Number(identity.ino),
    uid: identity.uid,
    mode: identity.mode,
    nlink: identity.nlink,
    size: identity.size,
    type,
  });
}

async function assertCandidatePathBound(candidateRoot, candidate, addon) {
  const openIdentity = addon.inspect(candidate.fd);
  statusOk(openIdentity);
  await assertNodePathBound(
    path.dirname(candidateRoot),
    candidate.parent,
    "RUNTIME_V2_CANDIDATE_PARENT_IDENTITY_DRIFT",
  );
  const [identity, observedRealpath] = await Promise.all([
    lstat(candidateRoot),
    realpath(candidateRoot),
  ]).catch((error) => {
    throw new Error("RUNTIME_V2_CANDIDATE_IDENTITY_DRIFT", { cause: error });
  });
  if (observedRealpath !== candidate.realpath || identity.isSymbolicLink() ||
      !identity.isDirectory() || Number(identity.dev) !== candidate.dev ||
      Number(identity.ino) !== candidate.ino || identity.uid !== candidate.uid ||
      openIdentity.dev !== candidate.dev || openIdentity.ino !== candidate.ino ||
      openIdentity.uid !== candidate.uid) {
    throw new Error("RUNTIME_V2_CANDIDATE_IDENTITY_DRIFT");
  }
}

async function assertPreinstallInputsBound(input) {
  await Promise.all([
    assertNodePathBound(
      path.dirname(input.runtimeRoot),
      input.runtimeParent,
      "RUNTIME_V2_PARENT_INVALID",
    ),
    assertCandidatePathBound(input.candidateRoot, input.candidate, input.addonBinding.api),
    assertAddonBindingBound(input.addonBinding),
  ]);
}

async function assertInstallBoundaryBound(input) {
  await assertPreinstallInputsBound(input);
  if (input.runtime !== null) {
    await assertRuntimePathBound(input.runtimeRoot, input.runtime);
  }
  if (input.releaseStore !== null) {
    await assertNativePathBound(
      path.join(input.runtimeRoot, releaseStoreBasename),
      input.releaseStore,
      input.addonBinding.api,
      "RUNTIME_V2_RELEASE_STORE_IDENTITY_DRIFT",
    );
  }
  if (input.release !== null) {
    await assertNativePathBound(
      input.release.realpath,
      input.release,
      input.addonBinding.api,
      "RUNTIME_V2_RELEASE_IDENTITY_DRIFT",
    );
  }
  if (input.catalogBinding !== null) {
    await assertCatalogBindingBound(input.catalogBinding, input.addonBinding.api);
  }
  if (input.currentBinding !== null) {
    await assertCurrentBindingBound({
      runtimeRoot: input.runtimeRoot,
      runtime: input.runtime,
      release: input.release,
      current: input.currentBinding,
      addon: input.addonBinding.api,
    });
  }
  if (input.materializationGates !== null) {
    assertMaterializationGatesBound(input.materializationGates, input.addonBinding.api);
  }
}

async function assertCatalogBindingBound(binding, addon) {
  await assertNativeIdentityBound(
    binding.state,
    addon,
    "RUNTIME_V2_STATE_IDENTITY_DRIFT",
  );
  if (binding.gateDirectory !== null) {
    await assertNativeIdentityBound(
      binding.gateDirectory,
      addon,
      "RUNTIME_V2_GATE_DIRECTORY_IDENTITY_DRIFT",
    );
  }
  if (binding.catalogFile !== null) {
    await assertNativeIdentityBound(
      binding.catalogFile,
      addon,
      "RUNTIME_V2_CATALOG_IDENTITY_DRIFT",
    );
    if (sha256Buffer(readNativeFile(binding.catalogFile, addon)) !== binding.catalogSha256) {
      throw new Error("RUNTIME_V2_CATALOG_IDENTITY_DRIFT");
    }
  }
  if (binding.catalogShaFile !== null) {
    await assertNativeIdentityBound(
      binding.catalogShaFile,
      addon,
      "RUNTIME_V2_CATALOG_IDENTITY_DRIFT",
    );
    if (sha256Buffer(readNativeFile(binding.catalogShaFile, addon)) !==
        binding.catalogShaFileSha256) {
      throw new Error("RUNTIME_V2_CATALOG_IDENTITY_DRIFT");
    }
  }
}

async function assertNativeIdentityBound(expected, addon, code) {
  const [identity, observedRealpath] = await Promise.all([
    lstat(expected.realpath),
    realpath(expected.realpath),
  ]).catch((error) => {
    throw new Error(code, { cause: error });
  });
  const openIdentity = addon.inspect(expected.fd);
  statusOk(openIdentity);
  const expectedType = expected.type === "directory" ? constants.S_IFDIR : constants.S_IFREG;
  if (observedRealpath !== expected.realpath || identity.isSymbolicLink() ||
      (identity.mode & constants.S_IFMT) !== expectedType ||
      Number(identity.dev) !== expected.dev || Number(identity.ino) !== expected.ino ||
      identity.uid !== expected.uid || identity.mode !== expected.mode ||
      openIdentity.dev !== expected.dev || openIdentity.ino !== expected.ino ||
      openIdentity.uid !== expected.uid || openIdentity.mode !== expected.mode) {
    throw new Error(code);
  }
}

function bindCurrentIdentity(value) {
  if (!Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino) ||
      value.uid !== currentUid() || (value.mode & constants.S_IFMT) !== constants.S_IFLNK ||
      typeof value.target !== "string" || typeof value.resolvedRelease !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.manifestSha256)) {
    throw new Error("RUNTIME_V2_CURRENT_POINTER_INVALID");
  }
  return Object.freeze(value);
}

async function assertCurrentBindingBound(input) {
  if (input.runtime === null || input.release === null) {
    throw new Error("RUNTIME_V2_CURRENT_POINTER_IDENTITY_DRIFT");
  }
  const observed = input.addon.readLinkAtNoFollow(input.runtime.fd, "current");
  if (observed === null || typeof observed !== "object" || observed.ok !== true) {
    throw new Error("RUNTIME_V2_CURRENT_POINTER_IDENTITY_DRIFT", {
      cause: observed !== null && typeof observed === "object" ? observed.errno : undefined,
    });
  }
  const currentPath = path.join(input.runtimeRoot, "current");
  const [identity, target, resolvedCurrent, resolvedRelease] = await Promise.all([
    lstat(currentPath),
    readlink(currentPath),
    realpath(currentPath),
    realpath(input.release.realpath),
  ]).catch((error) => {
    throw new Error("RUNTIME_V2_CURRENT_POINTER_IDENTITY_DRIFT", { cause: error });
  });
  if (!identity.isSymbolicLink() || observed.target !== input.current.target ||
      target !== input.current.target || Number(identity.dev) !== input.current.dev ||
      Number(identity.ino) !== input.current.ino || identity.uid !== input.current.uid ||
      identity.mode !== input.current.mode || observed.dev !== input.current.dev ||
      observed.ino !== input.current.ino || observed.uid !== input.current.uid ||
      observed.mode !== input.current.mode || resolvedCurrent !== input.current.resolvedRelease ||
      resolvedRelease !== input.current.resolvedRelease) {
    throw new Error("RUNTIME_V2_CURRENT_POINTER_IDENTITY_DRIFT");
  }
}

async function assertAddonBindingBound(binding) {
  await Promise.all([
    assertNodePathBound(
      binding.manifestPath,
      binding.manifestIdentity,
      "RUNTIME_V2_KERNEL_ADDON_IDENTITY_DRIFT",
    ),
    assertNodePathBound(
      binding.addonPath,
      binding.addonIdentity,
      "RUNTIME_V2_KERNEL_ADDON_IDENTITY_DRIFT",
    ),
  ]);
}

async function assertNativePathBound(nativePath, expected, addon, code) {
  const [identity, observedRealpath] = await Promise.all([
    lstat(nativePath),
    realpath(nativePath),
  ]).catch((error) => {
    throw new Error(code, { cause: error });
  });
  const openIdentity = addon.inspect(expected.fd);
  statusOk(openIdentity);
  if (observedRealpath !== expected.realpath || identity.isSymbolicLink() ||
      !identity.isDirectory() || Number(identity.dev) !== expected.dev ||
      Number(identity.ino) !== expected.ino || identity.uid !== expected.uid ||
      openIdentity.dev !== expected.dev || openIdentity.ino !== expected.ino ||
      openIdentity.uid !== expected.uid) {
    throw new Error(code);
  }
}

async function assertNodePathBound(nodePath, expected, code) {
  const [identity, observedRealpath, openIdentity] = await Promise.all([
    lstat(nodePath),
    realpath(nodePath),
    expected.handle.stat(),
  ]).catch((error) => {
    throw new Error(code, { cause: error });
  });
  if (observedRealpath !== expected.realpath || identity.isSymbolicLink() ||
      Number(identity.dev) !== expected.dev || Number(identity.ino) !== expected.ino ||
      identity.uid !== expected.uid || Number(openIdentity.dev) !== expected.dev ||
      Number(openIdentity.ino) !== expected.ino || openIdentity.uid !== expected.uid ||
      (expected.type === "directory" && (!identity.isDirectory() || !openIdentity.isDirectory())) ||
      (expected.type === "file" && (!identity.isFile() || !openIdentity.isFile()))) {
    throw new Error(code);
  }
}

function assertSameNodeIdentity(expected, actual, code) {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.uid !== actual.uid ||
      expected.mode !== actual.mode) {
    throw new Error(code);
  }
}

function readNativeFile(handle, addon) {
  const chunks = [];
  let total = 0;
  let position = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const count = readSync(handle.fd, chunk, 0, chunk.length, position);
    if (count === 0) break;
    position += count;
    total += count;
    if (total > 256 * 1024 * 1024) {
      throw new Error("RUNTIME_V2_CANDIDATE_FILE_TOO_LARGE");
    }
    chunks.push(chunk.subarray(0, count));
  }
  const finalIdentity = addon.inspect(handle.fd);
  statusOk(finalIdentity);
  if (finalIdentity.dev !== handle.dev || finalIdentity.ino !== handle.ino ||
      finalIdentity.uid !== handle.uid || finalIdentity.mode !== handle.mode) {
    throw new Error("RUNTIME_V2_CANDIDATE_IDENTITY_DRIFT");
  }
  return Buffer.concat(chunks, total);
}

async function assertNoExistingInstallJournal({ runtimeParent, addon, runtimeRoot }) {
  const name = `${runtimeBasename}.install-journal.jsonl`;
  const named = addon.inspectEntryAtNoFollow(runtimeParent.fd, name);
  if (named?.ok !== true) {
    if (named?.errno === os.constants.errno.ENOENT) return;
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
  }
  if ((named.mode & constants.S_IFMT) !== constants.S_IFREG ||
      named.uid !== currentUid() || named.nlink !== 1 ||
      (named.mode & 0o777) !== 0o600 || named.size <= 0 || named.size > 16 * 1024 * 1024) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
  }
  let handle = null;
  let operationError = null;
  let state = null;
  try {
    handle = bindOpenedNativeIdentity(
      addon,
      addon.openReadFileAtNoFollow(runtimeParent.fd, name),
      path.join(runtimeParent.realpath, name),
      "file",
    );
    if (handle.dev !== named.dev || handle.ino !== named.ino || handle.uid !== named.uid ||
        handle.mode !== named.mode || handle.nlink !== named.nlink || handle.size !== named.size) {
      throw new Error("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
    }
    state = parseInstallJournal(readNativeFile(handle, addon));
    await verifyExistingInstallJournalState({ state, runtimeRoot, runtimeParent, addon });
  } catch (error) {
    operationError = error;
  }
  let closeError = null;
  if (handle !== null) {
    try {
      closeNative(addon, handle);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== null || closeError !== null) {
    throw combineInstallErrors(operationError, closeError);
  }
  throw new Error("RUNTIME_V2_INSTALL_RECOVERY_REQUIRED", { cause: state });
}

async function verifyExistingInstallJournalState({ state, runtimeRoot, runtimeParent, addon }) {
  if (state === null || typeof state !== "object" ||
      !state.facts || typeof state.facts !== "object") {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  const retention = state.facts;
  if (typeof retention.containerName !== "string" ||
      retention.containerName.length === 0 || retention.containerName.includes("/") ||
      retention.containerName.includes("\0") ||
      typeof retention.containerParent !== "object" || retention.containerParent === null ||
      typeof retention.containerParent.realpath !== "string" ||
      typeof retention.retained !== "boolean" ||
      (retention.retained && (typeof retention.containerIdentity !== "object" ||
        retention.containerIdentity === null)) ||
      (!retention.retained && retention.containerIdentity !== null)) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  if (state.phase === "error" &&
      (typeof retention.terminalFromPhase !== "string" ||
       !INSTALL_RECOVERABLE_PHASES.has(retention.terminalFromPhase))) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  const effectivePhase = state.phase === "error" ? retention.terminalFromPhase : state.phase;
  await assertRecoveryStableParentIdentity(
    retention.containerParent.realpath,
    retention.containerParent,
    "RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID",
  );
  const containerPath = path.join(
    retention.containerParent.realpath,
    retention.containerName,
  );
  if (retention.retained) {
    const containerHandle = await open(
      containerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((error) => {
      throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID", { cause: error });
    });
    let operationError = null;
    try {
      const identity = await containerHandle.stat();
      assertIdentityFact(identity, retention.containerIdentity, "file",
        "RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
      if (effectivePhase === "container-created") {
        if (retention.containerIdentity.size !== 0 || identity.size !== 0) {
          throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
        }
      } else if (effectivePhase === "population-started") {
        assertPopulationStartedRecoveryFacts(retention, identity);
      } else {
        const receipt = await validatePayloadContainerFd({
          fd: containerHandle.fd,
          expectedIdentity: decodeDurableContainerIdentityFact(retention.containerIdentity),
        });
        if (typeof retention.containerSha256 === "string" &&
            receipt.containerSha256 !== retention.containerSha256) {
          throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
        }
      }
    } catch (error) {
      operationError = error;
    }
    let closeError = null;
    try {
      await containerHandle.close();
    } catch (error) {
      closeError = error;
    }
    const containerError = combineInstallErrors(operationError, closeError);
    if (containerError !== null) throw containerError;
  } else {
    await assertPathAbsent(containerPath, "RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }

  const published = effectivePhase === "current-published" || effectivePhase === "complete";
  const currentPath = path.join(runtimeRoot, "current");
  const gatePhases = new Set([
    "gates-held", "materialized", "release-validated", "ready-to-link",
    "current-published", "complete",
  ]);
  const releasePhases = new Set([
    "materialized", "release-validated", "ready-to-link", "current-published", "complete",
  ]);
  const runtimePhases = new Set([...gatePhases, ...releasePhases]);
  let recoveryRuntime = null;
  let recoveryReleaseStore = null;
  let recoveryRelease = null;
  let recoveryError = null;
  try {
    if (runtimePhases.has(effectivePhase)) {
      recoveryRuntime = openRecoveryDirectoryAt(
        addon,
        runtimeParent.fd,
        runtimeBasename,
        retention.runtime,
        runtimeRoot,
      );
    } else if (!published) {
      await assertPathAbsent(currentPath, "RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
    }
    if (!published && recoveryRuntime !== null) {
      assertRecoveryEntryAbsent(addon, recoveryRuntime.fd, "current");
    }
    if (gatePhases.has(effectivePhase)) {
      await verifyRecoveryCatalogAndGates(
        recoveryRuntime,
        retention.catalog,
        retention.gates,
        addon,
      );
    }
    if (releasePhases.has(effectivePhase)) {
    const releaseName = typeof retention.releaseBasename === "string"
      ? retention.releaseBasename
      : typeof retention.currentTarget === "string"
        ? path.posix.basename(retention.currentTarget)
        : null;
    if (recoveryRuntime === null || releaseName === null || releaseName.includes("/") ||
        typeof retention.releaseStore !== "object" || retention.releaseStore === null ||
        typeof retention.release !== "object" || retention.release === null) {
      throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
    }
    const releaseRoot = path.join(runtimeRoot, releaseStoreBasename, releaseName);
    recoveryReleaseStore = openRecoveryDirectoryAt(
      addon,
      recoveryRuntime.fd,
      releaseStoreBasename,
      retention.releaseStore,
      path.join(runtimeRoot, releaseStoreBasename),
    );
    recoveryRelease = openRecoveryDirectoryAt(
      addon,
      recoveryReleaseStore.fd,
      releaseName,
      retention.release,
      releaseRoot,
    );
    if (effectivePhase !== "materialized") {
      const { validateReleasePayload } = await import(pathToFileURL(path.join(
        moduleDirectory,
        "release-payload.mjs",
      )).href);
      const validation = await validateReleasePayload({ payloadRoot: releaseRoot });
      const expectedManifest = retention.manifestSha256 ?? retention.payloadManifestSha256;
      if (validation.manifestSha256 !== expectedManifest) {
        throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
      }
      assertRecoveryNamedIdentity(
        addon,
        recoveryReleaseStore.fd,
        releaseName,
        retention.release,
        constants.S_IFDIR,
      );
    }
    }
    if (published) {
      if (recoveryRuntime === null || recoveryRelease === null ||
          typeof retention.currentTarget !== "string" ||
          typeof retention.manifestSha256 !== "string" ||
          typeof retention.current !== "object" || retention.current === null) {
      throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
      }
      const observedCurrent = addon.readLinkAtNoFollow(recoveryRuntime.fd, "current");
      assertRecoveryNativeFact(observedCurrent, retention.current, constants.S_IFLNK);
      if (observedCurrent.target !== retention.currentTarget ||
          retention.current.target !== retention.currentTarget ||
          retention.current.manifestSha256 !== retention.manifestSha256) {
      throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
      }
      const [resolvedCurrent, resolvedRelease] = await Promise.all([
        realpath(currentPath),
        realpath(recoveryRelease.realpath),
      ]).catch((error) => {
        throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID", { cause: error });
      });
      if (resolvedCurrent !== resolvedRelease ||
          resolvedCurrent !== retention.current.resolvedRelease) {
        throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
      }
      const { validateInstalledRuntimeV2 } = await import(pathToFileURL(path.join(
        moduleDirectory,
        "release-payload.mjs",
      )).href);
      const installed = await validateInstalledRuntimeV2({ runtimeRoot });
      if (installed.manifestSha256 !== retention.manifestSha256) {
        throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
      }
      assertRecoveryNamedIdentity(
        addon,
        recoveryRuntime.fd,
        "current",
        retention.current,
        constants.S_IFLNK,
      );
    }
  } catch (error) {
    recoveryError = error;
  }
  const recoveryCloseErrors = [];
  for (const handle of [recoveryRelease, recoveryReleaseStore, recoveryRuntime]) {
    if (handle === null) continue;
    try {
      closeNative(addon, handle);
    } catch (error) {
      recoveryCloseErrors.push(error);
    }
  }
  const finalRecoveryError = combineInstallErrors(recoveryError, ...recoveryCloseErrors);
  if (finalRecoveryError !== null) throw finalRecoveryError;
}

const INSTALL_RECOVERABLE_PHASES = new Set([
  "intent-recorded", "container-created", "population-started", "container-validated",
  "gates-held", "materialized",
  "release-validated", "ready-to-link", "current-published",
]);

async function verifyRecoveryCatalogAndGates(runtime, expectedCatalog, expectedGates, addon) {
  if (runtime === null || expectedCatalog === null || typeof expectedCatalog !== "object" ||
      !Array.isArray(expectedGates) || expectedGates.length !== 2) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  const resources = [];
  const locked = [];
  let operationError = null;
  try {
    const state = openRecoveryDirectoryAt(
      addon, runtime.fd, "state", expectedCatalog.state, path.join(runtime.realpath, "state"),
    );
    resources.push(state);
    const gateDirectory = openRecoveryDirectoryAt(
      addon,
      state.fd,
      ".kernel-lock-v1",
      expectedCatalog.gateDirectory,
      path.join(state.realpath, ".kernel-lock-v1"),
    );
    resources.push(gateDirectory);
    const catalogFile = openRecoveryFileAt(
      addon, gateDirectory.fd, "catalog.json", expectedCatalog.catalogFile,
    );
    resources.push(catalogFile);
    const catalogShaFile = openRecoveryFileAt(
      addon, gateDirectory.fd, "catalog.sha256", expectedCatalog.catalogShaFile,
    );
    resources.push(catalogShaFile);
    if (sha256Buffer(readNativeFile(catalogFile, addon)) !== expectedCatalog.catalogSha256 ||
        sha256Buffer(readNativeFile(catalogShaFile, addon)) !==
          expectedCatalog.catalogShaFileSha256) {
      throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
    }
    for (const purpose of ["release-installer", "live-operation"]) {
      const expected = expectedGates.find((gate) => gate?.purpose === purpose);
      if (expected === undefined) throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
      const digest = createHash("sha256").update(purpose).digest("hex");
      const handle = openRecoveryFileAt(
        addon, gateDirectory.fd, `${digest}.gate`, expected,
      );
      resources.push(handle);
      locked.push(handle);
      const receipt = addon.lockExclusiveNonblocking(handle.fd);
      if (receipt?.ok !== true) throw new Error("RUNTIME_V2_INSTALL_RECOVERY_GATE_BUSY");
    }
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  for (const handle of [...locked].reverse()) {
    try {
      const unlocked = addon.unlock(handle.fd);
      statusOk(unlocked);
    } catch (error) {
      closeErrors.push(error);
    }
    try {
      closeNative(addon, handle);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const lockedFds = new Set(locked.map((handle) => handle.fd));
  for (const handle of [...resources].reverse()) {
    if (lockedFds.has(handle.fd)) continue;
    try {
      closeNative(addon, handle);
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const finalError = combineInstallErrors(operationError, ...closeErrors);
  if (finalError !== null) throw finalError;
}

function openRecoveryDirectoryAt(addon, parentFd, name, fact, expectedRealpath) {
  assertRecoveryNamedIdentity(addon, parentFd, name, fact, constants.S_IFDIR);
  const opened = addon.openDirectoryAtNoFollow(parentFd, name);
  assertRecoveryNativeFact(opened, fact, constants.S_IFDIR);
  assertRecoveryNamedIdentity(addon, parentFd, name, fact, constants.S_IFDIR);
  return Object.freeze({ ...opened, realpath: expectedRealpath, type: "directory" });
}

function openRecoveryFileAt(addon, parentFd, name, fact) {
  assertRecoveryNamedIdentity(addon, parentFd, name, fact, constants.S_IFREG);
  const opened = addon.openFileAtNoFollow(parentFd, name);
  assertRecoveryNativeFact(opened, fact, constants.S_IFREG);
  assertRecoveryNamedIdentity(addon, parentFd, name, fact, constants.S_IFREG);
  return Object.freeze({ ...opened, type: "file" });
}

function assertRecoveryNamedIdentity(addon, parentFd, name, fact, expectedType) {
  const observed = addon.inspectEntryAtNoFollow(parentFd, name);
  assertRecoveryNativeFact(observed, fact, expectedType);
}

function assertRecoveryNativeFact(observed, fact, expectedType) {
  if (observed === null || typeof observed !== "object" || observed.ok !== true ||
      fact === null || typeof fact !== "object" || Array.isArray(fact) ||
      (observed.mode & constants.S_IFMT) !== expectedType ||
      String(observed.dev) !== fact.dev || String(observed.ino) !== fact.ino ||
      observed.uid !== currentUid() || observed.uid !== fact.uid ||
      observed.mode !== fact.mode ||
      (expectedType !== constants.S_IFDIR && observed.nlink !== fact.nlink)) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
}

function assertRecoveryEntryAbsent(addon, parentFd, name) {
  const observed = addon.inspectEntryAtNoFollow(parentFd, name);
  if (observed?.ok !== false || observed.errno !== os.constants.errno.ENOENT) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
}

async function assertRecoveryStableParentIdentity(target, fact, code) {
  const identity = await lstat(target).catch((error) => {
    throw new Error(code, { cause: error });
  });
  assertStableParentIdentityFact(identity, fact);
  const resolved = await realpath(target).catch((error) => {
    throw new Error(code, { cause: error });
  });
  if (typeof fact.realpath !== "string" || resolved !== fact.realpath) throw new Error(code);
}

export function decodeDurableContainerIdentityFact(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Reflect.ownKeys(value).map(String).sort().join(",") !==
        "dev,ino,mode,nlink,size,uid") {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  const dev = decodeSafePositiveInteger(value.dev);
  const ino = decodeSafePositiveInteger(value.ino);
  if (!Number.isSafeInteger(value.uid) || value.uid !== currentUid() ||
      !Number.isSafeInteger(value.mode) || value.mode !== (constants.S_IFREG | 0o600) ||
      value.nlink !== 1 || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  return Object.freeze({
    dev,
    ino,
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
  });
}

function assertPopulationStartedRecoveryFacts(retention, observedIdentity) {
  if (retention.partialState !== "partial-possible" ||
      !Number.isSafeInteger(retention.expectedTargetSize) ||
      retention.expectedTargetSize <= 0 ||
      retention.expectedTargetSize > 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(observedIdentity.size) || observedIdentity.size < 0 ||
      observedIdentity.size > retention.expectedTargetSize) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  const prepopulation = decodeDurableContainerIdentityFact(retention.prepopulationIdentity);
  const retained = decodeDurableContainerIdentityFact(retention.containerIdentity);
  if (prepopulation.size !== 0 || retained.size !== 0 ||
      prepopulation.dev !== retained.dev || prepopulation.ino !== retained.ino ||
      prepopulation.uid !== retained.uid || prepopulation.mode !== retained.mode ||
      prepopulation.nlink !== retained.nlink) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
}

export function assertStableParentIdentityFact(observed, fact) {
  if (observed === null || typeof observed !== "object" ||
      typeof observed.isDirectory !== "function" || !observed.isDirectory() ||
      typeof observed.isSymbolicLink !== "function" || observed.isSymbolicLink() ||
      fact === null || typeof fact !== "object" || Array.isArray(fact) ||
      String(observed.dev) !== fact.dev || String(observed.ino) !== fact.ino ||
      observed.uid !== currentUid() || observed.uid !== fact.uid ||
      observed.mode !== fact.mode || (observed.mode & constants.S_IFMT) !== constants.S_IFDIR ||
      !Number.isSafeInteger(fact.nlink) || fact.nlink < 1) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
}

function decodeSafePositiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded <= 0 || String(decoded) !== value) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_STATE_INVALID");
  }
  return decoded;
}

function assertIdentityFact(identity, fact, type, code) {
  const typeMatches = type === "directory" ? identity.isDirectory() : identity.isFile();
  if (!typeMatches || identity.isSymbolicLink() || identity.uid !== currentUid() ||
      String(identity.dev) !== fact.dev || String(identity.ino) !== fact.ino ||
      identity.mode !== fact.mode || identity.nlink !== fact.nlink) {
    throw new Error(code);
  }
}

async function assertPathAbsent(target, code) {
  try {
    await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new Error(code, { cause: error });
  }
  throw new Error(code);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function openDirectoryAt(addon, directoryFd, name, expectedRealpath) {
  const result = addon.openDirectoryAtNoFollow(directoryFd, name);
  return bindOpenedNativeIdentity(addon, result, expectedRealpath, "directory");
}

function openFileAt(addon, directoryFd, name, expectedRealpath) {
  const result = addon.openFileAtNoFollow(directoryFd, name);
  return bindOpenedNativeIdentity(addon, result, expectedRealpath, "file");
}

function bindOpenedNativeIdentity(addon, result, expectedRealpath, type) {
  try {
    return bindNativeIdentity(result, expectedRealpath, type);
  } catch (error) {
    let closeError = null;
    if (result !== null && typeof result === "object" && result.ok === true &&
        Number.isInteger(result.fd)) {
      try {
        closeNative(addon, result);
      } catch (caught) {
        closeError = caught;
      }
    }
    throw combineInstallErrors(error, closeError);
  }
}

function bindNativeIdentity(result, expectedRealpath, type) {
  statusOk(result);
  const expectedType = type === "directory" ? constants.S_IFDIR : constants.S_IFREG;
  if (!Number.isInteger(result.uid) || result.uid !== currentUid() ||
      !Number.isSafeInteger(result.dev) || !Number.isSafeInteger(result.ino) ||
      (result.mode & constants.S_IFMT) !== expectedType ||
      typeof expectedRealpath !== "string" || !path.isAbsolute(expectedRealpath)) {
    throw new Error("RUNTIME_V2_NATIVE_IDENTITY_INVALID");
  }
  return Object.freeze({ ...result, realpath: expectedRealpath, type });
}

function closeNative(addon, handle) {
  if (handle === null || handle === undefined) return;
  const result = addon.closeFd(handle.fd);
  if (!result.ok) throw new Error("RUNTIME_V2_NATIVE_CLOSE_FAILED");
}

async function closeAllInstallerResources(addon, resources) {
  const errors = [];
  for (const handle of resources.native) {
    if (handle === null || handle === undefined) continue;
    try {
      closeNative(addon, handle);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const handle of resources.node) {
    if (handle === null || handle === undefined) continue;
    try {
      await handle.close();
    } catch (error) {
      errors.push(new Error("RUNTIME_V2_NODE_CLOSE_FAILED", { cause: error }));
    }
  }
  return combineInstallErrors(...errors);
}

function combineInstallErrors(...errors) {
  const present = errors.filter((error) => error !== null && error !== undefined);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, "RUNTIME_V2_INSTALL_CLEANUP_FAILED");
}

function statusOk(result) {
  if (result === null || typeof result !== "object" || result.ok !== true) {
    throw new Error("RUNTIME_V2_SECURE_MUTATION_FAILED", {
      cause: result !== null && typeof result === "object" ? result.errno : undefined,
    });
  }
}

function assertDirectoryEmpty(addon, fd) {
  const result = addon.directoryIsEmpty(fd);
  statusOk(result);
  if (result.empty !== true) throw new Error("RUNTIME_V2_ROOT_NOT_EMPTY");
}

async function inspectRuntimeRoot(runtimeRoot) {
  try {
    const identity = await lstat(runtimeRoot);
    assertOwnedRuntimeV2RootIdentity(identity, currentUid());
    return identity;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRuntimePathBound(runtimeRoot, expected) {
  const identity = await lstat(runtimeRoot).catch((error) => {
    throw new Error("RUNTIME_V2_IDENTITY_DRIFT", { cause: error });
  });
  const observedRealpath = await realpath(runtimeRoot).catch((error) => {
    throw new Error("RUNTIME_V2_IDENTITY_DRIFT", { cause: error });
  });
  if (expected.type !== "directory" || expected.uid !== currentUid() ||
      observedRealpath !== expected.realpath ||
      !identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== currentUid() ||
      Number(identity.dev) !== expected.dev || Number(identity.ino) !== expected.ino ||
      (identity.mode & 0o777) !== 0o700) {
    throw new Error("RUNTIME_V2_IDENTITY_DRIFT");
  }
}

async function validateReleaseUnderBoundRuntime(releaseRoot, runtimeRoot, runtime) {
  await assertRuntimePathBound(runtimeRoot, runtime);
  try {
    const validation = await validatePayloadInFreshProcess(releaseRoot);
    await assertRuntimePathBound(runtimeRoot, runtime);
    return validation;
  } catch (error) {
    await assertRuntimePathBound(runtimeRoot, runtime);
    throw error;
  }
}

async function validatePayloadInFreshProcess(payloadRoot, directoryFd = null) {
  const childPayloadRoot = directoryFd === null ? payloadRoot : "/dev/fd/3";
  const child = spawn(process.execPath, [path.join(moduleDirectory, "runtime-v2-payload-validator.mjs")], {
    cwd: moduleDirectory,
    env: {
      HOME: process.env.HOME ?? path.dirname(moduleDirectory),
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "",
      NODE_PATH: "",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
    shell: false,
    stdio: directoryFd === null
      ? ["pipe", "pipe", "pipe"]
      : ["pipe", "pipe", "pipe", directoryFd],
  });
  const stdout = collectBounded(child.stdout, 64 * 1024);
  const stderr = collectBounded(child.stderr, 8 * 1024);
  child.stdin.end(`${JSON.stringify({ payloadRoot: childPayloadRoot })}\n`, "utf8");
  const [code, signal] = await once(child, "exit");
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (code !== 0 || signal !== null) {
    const reason = stderrText.trim();
    throw new Error(/^RELEASE_[A-Z0-9_]+$/u.test(reason)
      ? reason
      : "RUNTIME_V2_CANDIDATE_VALIDATION_FAILED");
  }
  let result;
  try {
    result = JSON.parse(stdoutText);
  } catch (error) {
    throw new Error("RUNTIME_V2_VALIDATION_RECEIPT_INVALID", { cause: error });
  }
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      Reflect.ownKeys(result).length !== 4 ||
      !/^[a-f0-9]{64}$/u.test(result.manifestSha256) ||
      result.bridgeProtocolVersion !== 2 || result.nativeProtocolVersion !== 1 ||
      result.productionDependencyProblems !== 0) {
    throw new Error("RUNTIME_V2_VALIDATION_RECEIPT_INVALID");
  }
  return result;
}

function collectBounded(stream, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximumBytes) {
        reject(new Error("RUNTIME_V2_VALIDATOR_OUTPUT_TOO_LARGE"));
        return;
      }
      chunks.push(buffer);
    });
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.once("error", reject);
  });
}

function assertExactOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("RUNTIME_V2_ARGUMENT_INVALID");
  }
  const keys = Reflect.ownKeys(options).sort();
  const expected = ["candidateRoot", "runtimeRoot", "sourceRoot"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("RUNTIME_V2_ARGUMENT_INVALID");
  }
}

function assertInstallHooks(hooks) {
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks) ||
      Reflect.ownKeys(hooks).some((key) => key !== "beforeMutation") ||
      (hooks.beforeMutation !== undefined && typeof hooks.beforeMutation !== "function")) {
    throw new Error("RUNTIME_V2_TEST_HOOK_INVALID");
  }
}

async function runInstallHook(hooks, stage, context = undefined) {
  await hooks.beforeMutation?.(stage, context);
}

function assertNormalizedAbsolutePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !path.isAbsolute(value) || path.normalize(value) !== value || value.normalize("NFC") !== value) {
    throw new Error("RUNTIME_V2_PATH_NOT_NORMALIZED");
  }
  return value;
}

function pathsOverlap(first, second) {
  const firstToSecond = path.relative(first, second);
  const secondToFirst = path.relative(second, first);
  return firstToSecond === "" || isDescendant(firstToSecond) || isDescendant(secondToFirst);
}

function isDescendant(relativePath) {
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("RUNTIME_V2_ROOT_OWNER_UNVERIFIED");
  return process.getuid();
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) throw new Error("RUNTIME_V2_ARGUMENT_INVALID");
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name !== "--source-root" && name !== "--runtime-root" && name !== "--candidate") ||
        typeof value !== "string" || Object.hasOwn(result, name)) {
      throw new Error("RUNTIME_V2_ARGUMENT_INVALID");
    }
    result[name] = value;
  }
  return {
    sourceRoot: result["--source-root"],
    runtimeRoot: result["--runtime-root"],
    candidateRoot: result["--candidate"],
  };
}

async function main() {
  try {
    const receipt = await installCleanRuntimeV2(parseCliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "RUNTIME_V2_INSTALL_FAILED"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
