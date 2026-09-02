import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

export const PAYLOAD_MANIFEST_VERSION = 1;
export const PAYLOAD_MANIFEST_FILENAME = "payload-manifest.json";
export const PAYLOAD_MANIFEST_SHA256_FILENAME = "payload-manifest.sha256";
export const NATIVE_RUNTIME_PATH =
  "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge";
const KERNEL_LOCK_ADDON_PATH =
  `native/kernel-lock/build/${process.platform}-${process.arch}/kernel_lock.node`;
const KERNEL_LOCK_MANIFEST_PATH =
  `native/kernel-lock/build/${process.platform}-${process.arch}/kernel_lock.manifest.json`;
const KERNEL_LOCK_BUILD_INPUTS = [
  "native/kernel-lock/kernel_lock.c",
  "scripts/build-kernel-lock-addon.mjs",
];

const metadataFilenames = new Set([
  PAYLOAD_MANIFEST_FILENAME,
  PAYLOAD_MANIFEST_SHA256_FILENAME,
]);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const bridgeProtocolVersion = 2;
const nativeProtocolVersion = 1;
const runtimeContractVersion = 4;
const productionRuntimeV2Root = "/Users/example/Desktop/聊天助手/runtime-v2";
const commandTimeoutMs = 120_000;
const bridgeTimeoutMs = 15_000;
const sourceSnapshotInputs = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  "src",
  "tests",
  "native/kernel-lock",
  "scripts/clean-dist.mjs",
  "scripts/build-kernel-lock-addon.mjs",
  "scripts/kernel-lock-runtime.mjs",
  "scripts/runtime-v2-clean-install.mjs",
  "scripts/runtime-v2-upgrade.mjs",
  "scripts/runtime-v2-install-journal.mjs",
  "scripts/runtime-v2-payload-container.mjs",
  "scripts/unicode-full-casefold.mjs",
  "scripts/runtime-v2-payload-validator.mjs",
  "scripts/verify-automation-contract.mjs",
  "scripts/verify-automation-contract.d.mts",
  "config/automation-restricted.config.toml",
  "config/local.wechat-ai-assistant-public.system-weather.plist",
  "prompts/automation-single-scheduler-v1.md",
  "runtime-bin",
  "native/WechatVisionBridge/Package.swift",
  "native/WechatVisionBridge/Sources",
  "native/WechatVisionBridge/Tests",
];
const productionInputProjection = Object.freeze([
  Object.freeze({ logicalPath: "package.json", sourcePath: "package.json", candidatePath: "package.json", type: "file" }),
  Object.freeze({ logicalPath: "package-lock.json", sourcePath: "package-lock.json", candidatePath: "package-lock.json", type: "file" }),
  Object.freeze({ logicalPath: "dist", sourcePath: "dist", candidatePath: "dist", type: "directory" }),
  Object.freeze({ logicalPath: "bin", sourcePath: "runtime-bin", candidatePath: "bin", type: "directory" }),
  Object.freeze({ logicalPath: "config/automation-restricted.config.toml", sourcePath: "config/automation-restricted.config.toml", candidatePath: "config/automation-restricted.config.toml", type: "file" }),
  Object.freeze({ logicalPath: "config/local.wechat-ai-assistant-public.system-weather.plist", sourcePath: "config/local.wechat-ai-assistant-public.system-weather.plist", candidatePath: "config/local.wechat-ai-assistant-public.system-weather.plist", type: "file" }),
  Object.freeze({ logicalPath: "prompts/automation-single-scheduler-v1.md", sourcePath: "prompts/automation-single-scheduler-v1.md", candidatePath: "prompts/automation-single-scheduler-v1.md", type: "file" }),
  Object.freeze({ logicalPath: "native/kernel-lock/build", sourcePath: "native/kernel-lock/build", candidatePath: "native/kernel-lock/build", type: "directory" }),
]);

export async function cleanBuildAuthoritativeSource(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      Reflect.ownKeys(options).map(String).sort().join(",") !== "sourceRoot" ||
      typeof options.sourceRoot !== "string") {
    throw new Error("RELEASE_SOURCE_ROOT_INVALID");
  }
  const sourceRoot = path.resolve(options.sourceRoot);
  await assertSourceRoot(sourceRoot);
  await runCommand("npm", ["run", "build"], {
    cwd: sourceRoot,
    environment: commandEnvironment(),
    errorCode: "RELEASE_NODE_BUILD_FAILED",
  });
  return captureReleaseLineage(sourceRoot);
}

export async function buildReleasePayload(options, hooks = {}, expectedSourceLineage = null) {
  assertReleaseBuildHooks(hooks);
  const sourceRoot = path.resolve(options.sourceRoot);
  const payloadRoot = path.resolve(options.payloadRoot);
  const workRoot = path.resolve(options.workRoot);
  await assertSourceRoot(sourceRoot);
  await createEmptyDirectory(payloadRoot, "RELEASE_PAYLOAD_ROOT_NOT_EMPTY");
  await createEmptyDirectory(workRoot, "RELEASE_WORK_ROOT_NOT_EMPTY");

  try {
    const buildEnvironment = commandEnvironment();
    const sourceLineage = await captureReleaseLineage(sourceRoot);
    if (expectedSourceLineage !== null) {
      assertAuthoritativeLineageStable(expectedSourceLineage, sourceLineage);
    }
    const sourceInputSha256 = sourceLineage.inputSha256;
    const sourceDistTreeSha256 = sourceLineage.distTreeSha256;
    const sourceInputStamp = sourceLineage.stamp;
    await hooks.beforeLineageBoundary?.("after-authoritative-capture");
    const sourceKernelLockAddonReceipt = await readKernelLockBuildReceipt(sourceRoot);
    const sourceProductionInputSha256 = await productionInputProjectionSha256(
      sourceRoot,
      "source",
      sourceKernelLockAddonReceipt,
    );
    const sourceSnapshot = path.join(workRoot, "source");
    const nativeScratch = path.join(workRoot, "swift-build");
    await mkdir(sourceSnapshot, { mode: 0o700 });
    for (const relativePath of sourceSnapshotInputs) {
      const source = path.join(sourceRoot, ...relativePath.split("/"));
      const destination = path.join(sourceSnapshot, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await cp(source, destination, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: false,
      });
    }
    await cp(path.join(sourceRoot, "dist"), path.join(sourceSnapshot, "dist"), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });
    assertAuthoritativeLineageStable(
      sourceLineage,
      await captureReleaseLineage(sourceRoot),
    );
    const snapshotLineage = await captureReleaseLineage(sourceSnapshot);
    assertLineageContentMatches(sourceLineage, snapshotLineage);
    await hooks.beforeLineageBoundary?.("after-snapshot-capture");
    const snapshotInputSha256 = snapshotLineage.inputSha256;
    const snapshotDistTreeSha256 = snapshotLineage.distTreeSha256;
    const snapshotKernelLockAddonReceipt = await readKernelLockBuildReceipt(sourceSnapshot);
    const snapshotProductionInputSha256 = await productionInputProjectionSha256(
      sourceSnapshot,
      "source",
      snapshotKernelLockAddonReceipt,
    );
    if (snapshotProductionInputSha256 !== sourceProductionInputSha256) {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }

    await copyFile(path.join(sourceSnapshot, "package.json"), path.join(payloadRoot, "package.json"));
    await copyFile(
      path.join(sourceSnapshot, "package-lock.json"),
      path.join(payloadRoot, "package-lock.json"),
    );
    await cp(path.join(sourceSnapshot, "dist"), path.join(payloadRoot, "dist"), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });
    const candidateDistTreeSha256 = await sourceTreeSha256(path.join(payloadRoot, "dist"));
    if (candidateDistTreeSha256 !== sourceDistTreeSha256) {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
    await hooks.beforeLineageBoundary?.("after-candidate-dist-capture");
    await cp(
      path.join(sourceSnapshot, "native", "kernel-lock", "build"),
      path.join(payloadRoot, "native", "kernel-lock", "build"),
      {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: false,
      },
    );
    await mkdir(path.join(payloadRoot, "config"), { mode: 0o700 });
    await copyFile(
      path.join(sourceSnapshot, "config", "automation-restricted.config.toml"),
      path.join(payloadRoot, "config", "automation-restricted.config.toml"),
    );
    await copyFile(
      path.join(sourceSnapshot, "config", "local.wechat-ai-assistant-public.system-weather.plist"),
      path.join(payloadRoot, "config", "local.wechat-ai-assistant-public.system-weather.plist"),
    );
    await mkdir(path.join(payloadRoot, "prompts"), { mode: 0o700 });
    await copyFile(
      path.join(sourceSnapshot, "prompts", "automation-single-scheduler-v1.md"),
      path.join(payloadRoot, "prompts", "automation-single-scheduler-v1.md"),
    );
    await mkdir(path.join(payloadRoot, "assets", "relationship-care"), {
      recursive: true,
      mode: 0o700,
    });
    await copyFile(
      path.join(sourceSnapshot, "assets", "relationship-care", "intro-card.png"),
      path.join(payloadRoot, "assets", "relationship-care", "intro-card.png"),
    );
    await cp(path.join(sourceSnapshot, "runtime-bin"), path.join(payloadRoot, "bin"), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });
    await Promise.all([
      chmod(path.join(payloadRoot, "bin", "chat-assistant-activate"), 0o555),
      chmod(path.join(payloadRoot, "bin", "chat-assistant-supervisor"), 0o555),
      chmod(path.join(payloadRoot, "bin", "daily-care-supervisor"), 0o555),
      chmod(path.join(payloadRoot, "bin", "daily-care-test"), 0o555),
      chmod(path.join(payloadRoot, "bin", "official-research"), 0o555),
      chmod(path.join(payloadRoot, "bin", "weather-network-canary"), 0o555),
      chmod(path.join(payloadRoot, "bin", "system-weather-snapshot-producer"), 0o555),
    ]);
    await runCommand(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: payloadRoot,
        environment: buildEnvironment,
        errorCode: "RELEASE_NODE_DEPENDENCIES_INVALID",
      },
    );

    const hostArchitecture = (await runCommand("/usr/bin/uname", ["-m"], {
      cwd: workRoot,
      environment: buildEnvironment,
      errorCode: "RELEASE_NATIVE_PLATFORM_UNSUPPORTED",
    })).stdout.trim();
    if (hostArchitecture !== "arm64" || process.arch !== "arm64") {
      throw new Error("RELEASE_NATIVE_PLATFORM_UNSUPPORTED");
    }

    const nativePackage = path.join(sourceSnapshot, "native", "WechatVisionBridge");
    const swiftArguments = [
      "build",
      "--package-path",
      nativePackage,
      "--scratch-path",
      nativeScratch,
      "-c",
      "release",
      "--arch",
      "arm64",
      "--product",
      "WechatVisionBridge",
    ];
    await runCommand("/usr/bin/swift", swiftArguments, {
      cwd: workRoot,
      environment: buildEnvironment,
      errorCode: "RELEASE_NATIVE_BUILD_FAILED",
    });
    const binPathResult = await runCommand(
      "/usr/bin/swift",
      [...swiftArguments, "--show-bin-path"],
      {
        cwd: workRoot,
        environment: buildEnvironment,
        errorCode: "RELEASE_NATIVE_BUILD_FAILED",
      },
    );
    const nativeBuildRoot = lastNonemptyLine(binPathResult.stdout);
    const builtNative = path.join(nativeBuildRoot, "WechatVisionBridge");
    const packagedNative = path.join(payloadRoot, ...NATIVE_RUNTIME_PATH.split("/"));
    await mkdir(path.dirname(packagedNative), { recursive: true, mode: 0o700 });
    await copyFile(builtNative, packagedNative);
    await removeNonSystemRpaths(packagedNative, workRoot, buildEnvironment);
    await runCommand("/usr/bin/codesign", ["--force", "--sign", "-", packagedNative], {
      cwd: workRoot,
      environment: buildEnvironment,
      errorCode: "RELEASE_NATIVE_CODESIGN_FAILED",
    });

    const validationEnvironment = runtimeValidationEnvironment({
      HOME: workRoot,
      TMPDIR: workRoot,
      PATH: buildEnvironment.PATH,
    });
    const native = await validateNativeExecutable(
      packagedNative,
      workRoot,
      validationEnvironment,
    );
    const packageDocument = parseJsonDocument(
      await readFile(path.join(payloadRoot, "package.json"), "utf8"),
      "RELEASE_PACKAGE_JSON_INVALID",
    );
    const lockDocument = parseJsonDocument(
      await readFile(path.join(payloadRoot, "package-lock.json"), "utf8"),
      "RELEASE_PACKAGE_LOCK_INVALID",
    );
    const npmVersion = (await runCommand("npm", ["--version"], {
      cwd: workRoot,
      environment: buildEnvironment,
      errorCode: "RELEASE_NODE_DEPENDENCIES_INVALID",
    })).stdout.trim();
    const swiftVersion = (await runCommand("/usr/bin/swift", ["--version"], {
      cwd: workRoot,
      environment: buildEnvironment,
      errorCode: "RELEASE_NATIVE_BUILD_FAILED",
    })).stdout.trim();
    const nativeSourceSha256 = await sourceTreeSha256(
      path.join(sourceSnapshot, "native", "WechatVisionBridge", "Sources"),
    );
    const candidateKernelLockAddonReceipt = await readKernelLockBuildReceipt(payloadRoot, {
      buildInputRoot: sourceSnapshot,
    });
    if (sourceKernelLockAddonReceipt.buildInputSha256 !==
        candidateKernelLockAddonReceipt.buildInputSha256) {
      throw new Error("RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
    }

    await normalizePayloadModes(payloadRoot);
    const initialProductionDependency = await captureProductionDependencyReceipt(
      payloadRoot,
      validationEnvironment,
    );
    const candidateProductionInputSha256 = await productionInputProjectionSha256(
      payloadRoot,
      "candidate",
      candidateKernelLockAddonReceipt,
    );
    if (candidateProductionInputSha256 !== sourceProductionInputSha256) {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
    await hooks.beforeLineageBoundary?.("before-final-lineage-capture");
    const [
      finalSourceLineage,
      finalSnapshotLineage,
      finalCandidateDistTreeSha256,
      finalSourceProductionInputSha256,
      finalSnapshotProductionInputSha256,
      finalCandidateProductionInputSha256,
      finalProductionDependency,
    ] =
      await Promise.all([
        captureReleaseLineage(sourceRoot),
        captureReleaseLineage(sourceSnapshot),
        sourceTreeSha256(path.join(payloadRoot, "dist")),
        productionInputProjectionSha256(
          sourceRoot,
          "source",
          sourceKernelLockAddonReceipt,
        ),
        productionInputProjectionSha256(
          sourceSnapshot,
          "source",
          snapshotKernelLockAddonReceipt,
        ),
        productionInputProjectionSha256(
          payloadRoot,
          "candidate",
          candidateKernelLockAddonReceipt,
        ),
        captureProductionDependencyReceipt(payloadRoot, validationEnvironment),
      ]);
    assertAuthoritativeLineageStable(sourceLineage, finalSourceLineage);
    assertAuthoritativeLineageStable(snapshotLineage, finalSnapshotLineage);
    const candidateInputSha256 = finalCandidateProductionInputSha256;
    if (finalSourceProductionInputSha256 !== sourceProductionInputSha256 ||
        finalSnapshotProductionInputSha256 !== snapshotProductionInputSha256 ||
        finalCandidateProductionInputSha256 !== candidateProductionInputSha256 ||
        finalSourceProductionInputSha256 !== finalSnapshotProductionInputSha256 ||
        finalSourceProductionInputSha256 !== finalCandidateProductionInputSha256 ||
        JSON.stringify(initialProductionDependency.receipt) !==
          JSON.stringify(finalProductionDependency.receipt) ||
        finalCandidateDistTreeSha256 !== candidateDistTreeSha256) {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
    const manifest = await createPayloadManifest({
      payloadRoot,
      provenance: {
        architecture: "arm64",
        bridgeProtocolVersion,
        candidateDistTreeSha256,
        candidateInputSha256,
        lockfileVersion: lockDocument.lockfileVersion,
        nativeConfiguration: "release",
        nativeProtocolVersion,
        nodeEngine: packageDocument.engines?.node,
        nodeVersion: process.version,
        npmVersion,
        nativeReceipt: {
          binaryPath: NATIVE_RUNTIME_PATH,
          binarySha256: native.binarySha256,
          codesign: native.codesign,
          configuration: "release",
          hostArchitecture,
          linkedLibraries: native.linkedLibraries,
          machoArchitecture: native.architecture,
          protocolVersion: native.protocolVersion,
          rpaths: native.rpaths,
          sourceSha256: nativeSourceSha256,
          swiftVersion,
        },
        kernelLockAddonReceipt: {
          sourceBuild: sourceKernelLockAddonReceipt,
          candidateBuild: candidateKernelLockAddonReceipt,
        },
        packageVersion: packageDocument.version,
        productionDependencyReceipt: finalProductionDependency.receipt,
        productionDependencyTreeSha256:
          finalProductionDependency.receipt.dependencyTreeSha256,
        runtimeContractVersion,
        snapshotDistTreeSha256,
        snapshotInputSha256,
        snapshotProductionInputSha256,
        sourceDistTreeSha256,
        sourceInputSha256,
        sourceProductionInputSha256,
        sourceInputStamp,
        swiftVersion,
      },
    });
    await Promise.all([
      chmod(path.join(payloadRoot, PAYLOAD_MANIFEST_FILENAME), 0o444),
      chmod(path.join(payloadRoot, PAYLOAD_MANIFEST_SHA256_FILENAME), 0o444),
      chmod(payloadRoot, 0o555),
    ]);
    return {
      manifestSha256: manifest.manifestSha256,
      native: {
        architecture: native.architecture,
        configuration: "release",
        protocolVersion: native.protocolVersion,
      },
    };
  } catch (error) {
    throw error instanceof Error && error.message.startsWith("RELEASE_")
      ? error
      : new Error("RELEASE_PAYLOAD_BUILD_FAILED", { cause: error });
  }
}

function assertReleaseBuildHooks(hooks) {
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks) ||
      Reflect.ownKeys(hooks).some((key) => key !== "beforeLineageBoundary") ||
      (hooks.beforeLineageBoundary !== undefined &&
        typeof hooks.beforeLineageBoundary !== "function")) {
    throw new Error("RELEASE_BUILD_HOOK_INVALID");
  }
}

export async function validateReleasePayload(options) {
  const payloadRoot = path.resolve(options.payloadRoot);
  const manifest = await validatePayloadManifest({ payloadRoot });
  await assertCandidateProductionInputProjection(payloadRoot, manifest.provenance);
  await assertRequiredPayloadFiles(payloadRoot, manifest.provenance.runtimeContractVersion);
  await validatePackagedRuntimeConfig(payloadRoot, productionRuntimeV2Root);
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "release-bridge-probe-"));
  try {
    const validationHome = path.join(probeRoot, "validation-home");
    await mkdir(validationHome, { mode: 0o700 });
    const environment = runtimeValidationEnvironment({
      HOME: validationHome,
      TMPDIR: probeRoot,
    });
    const productionDependency = await captureProductionDependencyReceipt(
      payloadRoot,
      environment,
    );
    assertProductionDependencyReceipt(
      manifest.provenance,
      productionDependency.receipt,
    );
    const dependencyTree = productionDependency.dependencyTree;
    const problems = Array.isArray(dependencyTree.problems) ? dependencyTree.problems : [];
    await validateCriticalImports(
      payloadRoot,
      environment,
      manifest.provenance.runtimeContractVersion,
    );
    const native = await validateNativeExecutable(
      path.join(payloadRoot, ...NATIVE_RUNTIME_PATH.split("/")),
      payloadRoot,
      environment,
    );
    const [hostArchitecture, swiftVersion] = await Promise.all([
      runCommand("/usr/bin/uname", ["-m"], {
        cwd: payloadRoot,
        environment,
        errorCode: "RELEASE_NATIVE_PROVENANCE_INVALID",
      }).then(({ stdout }) => stdout.trim()),
      runCommand("/usr/bin/swift", ["--version"], {
        cwd: payloadRoot,
        environment,
        errorCode: "RELEASE_NATIVE_PROVENANCE_INVALID",
      }).then(({ stdout }) => stdout.trim()),
    ]);
    assertNativeProvenance(manifest.provenance, native, hostArchitecture, swiftVersion);
    await assertKernelLockAddonProvenance(manifest.provenance, payloadRoot, manifest);
    const bridge = await runIsolatedBridge(payloadRoot, path.join(probeRoot, "bridge"));
    return {
      manifestSha256: manifest.manifestSha256,
      bridgeProtocolVersion: bridge.protocolVersion,
      nativeProtocolVersion: native.protocolVersion,
      productionDependencyProblems: problems.length,
    };
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export async function validateInstalledRuntimeV2(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      Reflect.ownKeys(options).length !== 1 || typeof options.runtimeRoot !== "string" ||
      !path.isAbsolute(options.runtimeRoot) || path.normalize(options.runtimeRoot) !== options.runtimeRoot ||
      options.runtimeRoot.includes("\0") || path.basename(options.runtimeRoot) !== "runtime-v2") {
    throw new Error("RELEASE_INSTALLED_RUNTIME_INVALID");
  }
  const runtimeRoot = options.runtimeRoot;
  const rootIdentity = await lstat(runtimeRoot).catch((error) => {
    throw new Error("RELEASE_INSTALLED_RUNTIME_INVALID", { cause: error });
  });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() ||
      rootIdentity.uid !== currentUid() || (rootIdentity.mode & 0o777) !== 0o700) {
    throw new Error("RELEASE_INSTALLED_RUNTIME_INVALID");
  }
  const currentPath = path.join(runtimeRoot, "current");
  const currentIdentity = await lstat(currentPath).catch((error) => {
    throw new Error("RELEASE_INSTALLED_CURRENT_INVALID", { cause: error });
  });
  if (!currentIdentity.isSymbolicLink()) throw new Error("RELEASE_INSTALLED_CURRENT_INVALID");
  const currentTarget = await readlink(currentPath);
  if (path.isAbsolute(currentTarget) || currentTarget.includes("..") ||
      !currentTarget.startsWith(".releases/release-")) {
    throw new Error("RELEASE_INSTALLED_CURRENT_INVALID");
  }
  const releaseRoot = await realpath(currentPath);
  const releaseStore = await realpath(path.join(runtimeRoot, ".releases"));
  if (!isPathDescendant(releaseRoot, releaseStore)) {
    throw new Error("RELEASE_INSTALLED_CURRENT_INVALID");
  }
  const validation = await validateReleasePayload({ payloadRoot: releaseRoot });
  const commands = await validatePackagedRuntimeConfig(releaseRoot, productionRuntimeV2Root);
  const installedCommands = {
    supervisor: mapInstalledCommandRole(commands.supervisor, runtimeRoot),
    research: mapInstalledCommandRole(commands.research, runtimeRoot),
  };
  const wrapperRealPath = await realpath(installedCommands.supervisor);
  const expectedWrapper = await realpath(path.join(releaseRoot, "bin", "chat-assistant-supervisor"));
  if (wrapperRealPath !== expectedWrapper) throw new Error("RELEASE_CONFIG_COMMAND_INVALID");
  const manifest = parseJsonDocument(
    await readFile(path.join(releaseRoot, PAYLOAD_MANIFEST_FILENAME), "utf8"),
    "RELEASE_MANIFEST_INVALID",
  );
  const entry = manifest.entries?.find?.((candidate) =>
    candidate?.path === "bin/chat-assistant-supervisor" && candidate?.type === "file"
  );
  if (!isPlainRecord(entry) || entry.sha256 !== sha256(await readFile(wrapperRealPath))) {
    throw new Error("RELEASE_CONFIG_WRAPPER_HASH_INVALID");
  }
  return Object.freeze({
    manifestSha256: validation.manifestSha256,
    releaseRoot,
    supervisorRealPath: wrapperRealPath,
  });
}

export function mapInstalledCommandRole(command, runtimeRoot) {
  if (typeof command !== "string" || typeof runtimeRoot !== "string" ||
      !path.isAbsolute(command) || !path.isAbsolute(runtimeRoot)) {
    throw new Error("RELEASE_CONFIG_COMMAND_INVALID");
  }
  const roles = new Map([
    [
      path.join(productionRuntimeV2Root, "current", "bin", "chat-assistant-supervisor"),
      "chat-assistant-supervisor",
    ],
    [
      path.join(productionRuntimeV2Root, "current", "bin", "official-research"),
      "official-research",
    ],
  ]);
  const role = roles.get(command);
  if (role === undefined) throw new Error("RELEASE_CONFIG_COMMAND_INVALID");
  return path.join(runtimeRoot, "current", "bin", role);
}

export async function validatePackagedRuntimeConfig(payloadRoot, expectedRuntimeRoot) {
  const configPath = path.join(payloadRoot, "config", "automation-restricted.config.toml");
  const serialized = await readFile(configPath, "utf8");
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024 || serialized.includes("\0")) {
    throw new Error("RELEASE_CONFIG_INVALID");
  }
  const supervisor = parseExactTomlCommand(serialized, "chat-assistant-supervisor");
  const research = parseExactTomlCommand(serialized, "official-research");
  if (supervisor !== path.join(expectedRuntimeRoot, "current", "bin", "chat-assistant-supervisor") ||
      research !== path.join(expectedRuntimeRoot, "current", "bin", "official-research")) {
    throw new Error("RELEASE_CONFIG_COMMAND_INVALID");
  }
  validateExactWeatherPermissionProfile(serialized);
  await validateSystemWeatherLaunchAgent(payloadRoot, expectedRuntimeRoot);
  await validateExactUndiciDependency(payloadRoot);
  return { supervisor, research };
}

function validateExactWeatherPermissionProfile(serialized) {
  const requiredTopLevel = [
    /^approval_policy = "never"$/gmu,
    /^default_permissions = "weather-read-only"$/gmu,
  ];
  if (requiredTopLevel.some((pattern) => [...serialized.matchAll(pattern)].length !== 1) ||
      /^sandbox_mode\s*=/mu.test(serialized) ||
      /^\[sandbox_workspace_write\]$/mu.test(serialized)) {
    throw new Error("RELEASE_CONFIG_NETWORK_POLICY_INVALID");
  }
  const permissionSections = [...serialized.matchAll(/^\[permissions\.([^\]]+)\]$/gmu)];
  if (permissionSections.length !== 2 ||
      permissionSections[0]?.[1] !== "weather-read-only" ||
      permissionSections[1]?.[1] !== "weather-read-only.network") {
    throw new Error("RELEASE_CONFIG_NETWORK_POLICY_INVALID");
  }
  const profile = extractExactTomlSection(serialized, "permissions.weather-read-only");
  const network = extractExactTomlSection(serialized, "permissions.weather-read-only.network");
  const features = extractExactTomlSection(serialized, "features");
  if (profile.trim() !== 'extends = ":read-only"' ||
      network.trim() !== [
        "enabled = false",
        "enable_socks5 = false",
        "enable_socks5_udp = false",
        "allow_upstream_proxy = false",
        "allow_local_binding = false",
        "dangerously_allow_non_loopback_proxy = false",
        "dangerously_allow_all_unix_sockets = false",
      ].join("\n") ||
      [...serialized.matchAll(/^network_proxy\s*=/gmu)].length !== 1 ||
      [...features.matchAll(/^network_proxy = false$/gmu)].length !== 1 ||
      /domains\s*=|www\.weather\.com\.cn/u.test(serialized)) {
    throw new Error("RELEASE_CONFIG_NETWORK_POLICY_INVALID");
  }
}

async function validateSystemWeatherLaunchAgent(payloadRoot, expectedRuntimeRoot) {
  const serialized = await readFile(
    path.join(payloadRoot, "config", "local.wechat-ai-assistant-public.system-weather.plist"),
    "utf8",
  ).catch((error) => {
    throw new Error("RELEASE_SYSTEM_WEATHER_LAUNCH_AGENT_INVALID", { cause: error });
  });
  const expected = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n` +
    `  <key>Label</key>\n  <string>local.wechat-ai-assistant-public.system-weather</string>\n` +
    `  <key>ProgramArguments</key>\n  <array>\n` +
    `    <string>/Users/example/.nvm/versions/node/v20.20.2/bin/node</string>\n` +
    `    <string>${expectedRuntimeRoot}/current/dist/src/mcp/system-weather-snapshot-main.js</string>\n` +
    `  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n` +
    `    <key>CHAT_ASSISTANT_DATA_DIR</key>\n    <string>${expectedRuntimeRoot}</string>\n` +
    `    <key>HOME</key>\n    <string>/Users/example</string>\n` +
    `    <key>NODE_OPTIONS</key>\n    <string></string>\n` +
    `    <key>NODE_PATH</key>\n    <string></string>\n  </dict>\n` +
    `  <key>RunAtLoad</key>\n  <true/>\n` +
    `  <key>StartCalendarInterval</key>\n  <dict>\n` +
    `    <key>Hour</key>\n    <integer>6</integer>\n` +
    `    <key>Minute</key>\n    <integer>20</integer>\n  </dict>\n` +
    `  <key>ProcessType</key>\n  <string>Background</string>\n` +
    `  <key>ThrottleInterval</key>\n  <integer>300</integer>\n` +
    `  <key>StandardOutPath</key>\n  <string>/dev/null</string>\n` +
    `  <key>StandardErrorPath</key>\n  <string>/dev/null</string>\n` +
    `</dict>\n</plist>\n`;
  if (serialized !== expected || /networksetup|HTTP_PROXY|HTTPS_PROXY|SOCKS|Clash|curl/u.test(serialized)) {
    throw new Error("RELEASE_SYSTEM_WEATHER_LAUNCH_AGENT_INVALID");
  }
}

async function validateExactUndiciDependency(payloadRoot) {
  const exactResolved = "https://registry.npmjs.org/undici/-/undici-6.24.1.tgz";
  const exactIntegrity = "sha512-sC+b0tB1whOCzbtlx20fx3WgCXwkW627p4EA9uM+/tNNPkSS+eSEld6pAs9nDv7WbY1UUljBMYPtu9BCOrCWKA==";
  try {
    const [packageSerialized, lockSerialized] = await Promise.all([
      readFile(path.join(payloadRoot, "package.json"), "utf8"),
      readFile(path.join(payloadRoot, "package-lock.json"), "utf8"),
    ]);
    const packageDocument = parseJsonDocument(packageSerialized, "RELEASE_CONFIG_NETWORK_POLICY_INVALID");
    const lockDocument = parseJsonDocument(lockSerialized, "RELEASE_CONFIG_NETWORK_POLICY_INVALID");
    const lockedUndici = lockDocument?.packages?.["node_modules/undici"];
    if (
      packageDocument?.dependencies?.undici !== "6.24.1" ||
      lockDocument?.packages?.[""]?.dependencies?.undici !== "6.24.1" ||
      lockedUndici?.version !== "6.24.1" ||
      lockedUndici?.resolved !== exactResolved ||
      lockedUndici?.integrity !== exactIntegrity
    ) {
      throw new Error("RELEASE_CONFIG_NETWORK_POLICY_INVALID");
    }
  } catch (error) {
    throw error instanceof Error && error.message === "RELEASE_CONFIG_NETWORK_POLICY_INVALID"
      ? error
      : new Error("RELEASE_CONFIG_NETWORK_POLICY_INVALID");
  }
}

function extractExactTomlSection(serialized, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const sections = [...serialized.matchAll(
    new RegExp(`^\\[${escaped}\\]\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "gmu"),
  )];
  if (sections.length !== 1 || sections[0]?.[1] === undefined) {
    throw new Error("RELEASE_CONFIG_NETWORK_POLICY_INVALID");
  }
  return sections[0][1];
}

function parseExactTomlCommand(serialized, sectionName) {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const sections = [...serialized.matchAll(
    new RegExp(`^\\[mcp_servers\\.${escaped}\\]\\n([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "gmu"),
  )];
  if (sections.length !== 1 || sections[0][1] === undefined) {
    throw new Error("RELEASE_CONFIG_INVALID");
  }
  const commands = [...sections[0][1].matchAll(/^command = "([^"\\\\\r\n]+)"$/gmu)];
  if (commands.length !== 1 || commands[0][1] === undefined || !path.isAbsolute(commands[0][1])) {
    throw new Error("RELEASE_CONFIG_INVALID");
  }
  return commands[0][1];
}

export async function smokeReleasePayload(options) {
  const payloadRoot = path.resolve(options.payloadRoot);
  const smokeRoot = path.resolve(options.smokeRoot);
  const productionRuntimeRoot = path.resolve(options.productionRuntimeRoot);
  const [resolvedSmokeRoot, resolvedProductionRuntimeRoot] = await Promise.all([
    resolveProspectiveRealPath(smokeRoot),
    resolveProspectiveRealPath(productionRuntimeRoot),
  ]);
  if (
    pathsOverlap(resolvedSmokeRoot, resolvedProductionRuntimeRoot)
  ) {
    throw new Error("RELEASE_SMOKE_ROOT_OVERLAPS_PRODUCTION");
  }
  await validatePayloadManifest({ payloadRoot });
  const before = await inspectProductionMaintenanceLease(options);
  await createEmptyDirectory(smokeRoot, "RELEASE_SMOKE_ROOT_NOT_EMPTY");
  const native = await validateNativeExecutable(
    path.join(payloadRoot, ...NATIVE_RUNTIME_PATH.split("/")),
    smokeRoot,
    runtimeValidationEnvironment({
      HOME: path.join(smokeRoot, "validation-home"),
      TMPDIR: smokeRoot,
    }),
  );
  const bridge = await runIsolatedBridge(payloadRoot, smokeRoot);
  const after = await inspectProductionMaintenanceLease(options);
  if (!sameMaintenanceSnapshot(before, after)) {
    throw new Error("RELEASE_PRODUCTION_PATH_TOUCHED");
  }
  return {
    bridgeProtocolVersion: bridge.protocolVersion,
    nativeProtocolVersion: native.protocolVersion,
    lockObserved: bridge.lockObserved,
    lockReleased: bridge.lockReleased,
    productionWrites: 0,
  };
}

async function assertSourceRoot(sourceRoot) {
  const identity = await lstat(sourceRoot).catch((error) => {
    throw new Error("RELEASE_SOURCE_ROOT_INVALID", { cause: error });
  });
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("RELEASE_SOURCE_ROOT_INVALID");
  }
  await Promise.all(sourceSnapshotInputs.map(async (relativePath) => {
    const input = path.join(sourceRoot, ...relativePath.split("/"));
    await lstat(input).catch((error) => {
      throw new Error("RELEASE_SOURCE_INPUT_MISSING", { cause: error });
    });
  }));
}

async function createEmptyDirectory(directory, errorCode) {
  try {
    await mkdir(directory, { mode: 0o700 });
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const identity = await lstat(directory);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error(errorCode);
  if ((await readdir(directory)).length !== 0) throw new Error(errorCode);
}

function commandEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    ...overrides,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
  };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  return environment;
}

function runtimeValidationEnvironment(overrides = {}) {
  const environment = {
    HOME: overrides.HOME,
    LANG: overrides.LANG ?? "en_US.UTF-8",
    LC_ALL: overrides.LC_ALL ?? "C",
    PATH: overrides.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: overrides.TMPDIR,
  };
  return Object.fromEntries(
    Object.entries(environment).filter(([, value]) => (
      typeof value === "string" && value.length > 0
    )),
  );
}

async function runCommand(executable, arguments_, options) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      {
        cwd: options.cwd,
        env: options.environment,
        encoding: "utf8",
        maxBuffer: 32 * 1_024 * 1_024,
        timeout: options.timeoutMs ?? commandTimeoutMs,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(options.errorCode, {
            cause: new Error(`${error.message}\n${stderr}`),
          }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function lastNonemptyLine(value) {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const result = lines.at(-1);
  if (result === undefined || !path.isAbsolute(result)) {
    throw new Error("RELEASE_NATIVE_BUILD_FAILED");
  }
  return result;
}

async function removeNonSystemRpaths(nativePath, cwd, environment) {
  const before = await runCommand("/usr/bin/otool", ["-l", nativePath], {
    cwd,
    environment,
    errorCode: "RELEASE_NATIVE_INVALID",
  });
  for (const rpath of parseRpaths(before.stdout)) {
    if (isAllowedRpath(rpath)) continue;
    await runCommand("/usr/bin/install_name_tool", ["-delete_rpath", rpath, nativePath], {
      cwd,
      environment,
      errorCode: "RELEASE_NATIVE_RPATH_INVALID",
    });
  }
}

async function validateNativeExecutable(nativePath, cwd, environment) {
  const identity = await lstat(nativePath).catch((error) => {
    throw new Error("RELEASE_NATIVE_INVALID", { cause: error });
  });
  if (!identity.isFile() || identity.isSymbolicLink() || (identity.mode & 0o111) === 0) {
    throw new Error("RELEASE_NATIVE_INVALID");
  }
  const [fileResult, architectureResult, versionResult, librariesResult, loadCommandsResult] =
    await Promise.all([
      runCommand("/usr/bin/file", [nativePath], {
        cwd,
        environment,
        errorCode: "RELEASE_NATIVE_INVALID",
      }),
      runCommand("/usr/bin/lipo", ["-archs", nativePath], {
        cwd,
        environment,
        errorCode: "RELEASE_NATIVE_INVALID",
      }),
      runCommand(nativePath, ["version"], {
        cwd,
        environment,
        errorCode: "RELEASE_NATIVE_INVALID",
      }),
      runCommand("/usr/bin/otool", ["-L", nativePath], {
        cwd,
        environment,
        errorCode: "RELEASE_NATIVE_INVALID",
      }),
      runCommand("/usr/bin/otool", ["-l", nativePath], {
        cwd,
        environment,
        errorCode: "RELEASE_NATIVE_INVALID",
      }),
      runCommand("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", nativePath], {
        cwd,
        environment,
        errorCode: "RELEASE_NATIVE_INVALID",
      }),
    ]);
  if (
    !fileResult.stdout.includes("Mach-O 64-bit executable arm64")
    || architectureResult.stdout.trim() !== "arm64"
  ) {
    throw new Error("RELEASE_NATIVE_ARCHITECTURE_INVALID");
  }
  const version = parseJsonDocument(versionResult.stdout, "RELEASE_NATIVE_PROTOCOL_INVALID");
  if (
    !isPlainRecord(version)
    || Object.keys(version).length !== 1
    || version.protocolVersion !== nativeProtocolVersion
  ) {
    throw new Error("RELEASE_NATIVE_PROTOCOL_INVALID");
  }
  const linkedLibraries = parseLinkedLibraries(librariesResult.stdout);
  for (const library of linkedLibraries) {
    if (!library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/")) {
      throw new Error("RELEASE_NATIVE_DEPENDENCY_INVALID");
    }
  }
  const rpaths = parseRpaths(loadCommandsResult.stdout);
  if (rpaths.some((rpath) => !isAllowedRpath(rpath))) {
    throw new Error("RELEASE_NATIVE_RPATH_INVALID");
  }
  return {
    architecture: "arm64",
    binarySha256: sha256(await readFile(nativePath)),
    codesign: "adhoc-verified",
    linkedLibraries,
    protocolVersion: nativeProtocolVersion,
    rpaths,
  };
}

function assertNativeProvenance(provenance, native, hostArchitecture, swiftVersion) {
  assertPlainObject(provenance, "RELEASE_NATIVE_PROVENANCE_INVALID");
  const receipt = provenance.nativeReceipt;
  assertPlainObject(receipt, "RELEASE_NATIVE_PROVENANCE_INVALID");
  assertExactKeys(receipt, [
    "binaryPath",
    "binarySha256",
    "codesign",
    "configuration",
    "hostArchitecture",
    "linkedLibraries",
    "machoArchitecture",
    "protocolVersion",
    "rpaths",
    "sourceSha256",
    "swiftVersion",
  ]);
  if (
    receipt.binaryPath !== NATIVE_RUNTIME_PATH
    || receipt.binarySha256 !== native.binarySha256
    || receipt.codesign !== native.codesign
    || receipt.configuration !== "release"
    || receipt.hostArchitecture !== hostArchitecture
    || receipt.machoArchitecture !== native.architecture
    || receipt.protocolVersion !== native.protocolVersion
    || receipt.swiftVersion !== swiftVersion
    || !sha256Pattern.test(receipt.sourceSha256)
    || !Array.isArray(receipt.linkedLibraries)
    || !Array.isArray(receipt.rpaths)
    || JSON.stringify(receipt.linkedLibraries) !== JSON.stringify(native.linkedLibraries)
    || JSON.stringify(receipt.rpaths) !== JSON.stringify(native.rpaths)
  ) {
    throw new Error("RELEASE_NATIVE_PROVENANCE_INVALID");
  }
}

async function readKernelLockBuildReceipt(root, options = {}) {
  const buildInputRoot = Object.hasOwn(options, "buildInputRoot")
    ? options.buildInputRoot
    : root;
  const [binaryBytes, manifestBytes, buildInputs] = await Promise.all([
    readFile(path.join(root, ...KERNEL_LOCK_ADDON_PATH.split("/"))),
    readFile(path.join(root, ...KERNEL_LOCK_MANIFEST_PATH.split("/"))),
    buildInputRoot === null
      ? Promise.resolve(null)
      : Promise.all(KERNEL_LOCK_BUILD_INPUTS.map(async (relativePath) => ({
        path: relativePath,
        sha256: sha256(await readFile(path.join(buildInputRoot, ...relativePath.split("/")))),
      }))),
  ]).catch((error) => {
    throw new Error("RELEASE_KERNEL_LOCK_PROVENANCE_INVALID", { cause: error });
  });
  const binarySha256 = sha256(binaryBytes);
  const document = parseJsonDocument(
    manifestBytes.toString("utf8"),
    "RELEASE_KERNEL_LOCK_PROVENANCE_INVALID",
  );
  if (!isPlainRecord(document) ||
      Reflect.ownKeys(document).sort().join(",") !== "arch,napi,platform,sha256,version" ||
      document.platform !== process.platform || document.arch !== process.arch ||
      !Number.isInteger(document.version) || !Number.isInteger(document.napi) ||
      document.sha256 !== binarySha256) {
    throw new Error("RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
  }
  return {
    binaryPath: KERNEL_LOCK_ADDON_PATH,
    binarySha256,
    buildInputSha256: buildInputs === null
      ? null
      : sha256(canonicalManifestBytes(buildInputs)),
    manifestDeclaredBinarySha256: document.sha256,
    manifestPath: KERNEL_LOCK_MANIFEST_PATH,
    manifestSha256: sha256(manifestBytes),
  };
}

async function assertKernelLockAddonProvenance(provenance, payloadRoot, payloadManifest) {
  assertPlainObject(provenance, "RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
  const receipt = provenance.kernelLockAddonReceipt;
  assertPlainObject(receipt, "RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
  assertExactKeys(receipt, ["candidateBuild", "sourceBuild"]);
  const expectedKeys = [
    "binaryPath",
    "binarySha256",
    "buildInputSha256",
    "manifestDeclaredBinarySha256",
    "manifestPath",
    "manifestSha256",
  ];
  for (const build of [receipt.sourceBuild, receipt.candidateBuild]) {
    assertPlainObject(build, "RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
    assertExactKeys(build, expectedKeys);
    if (build.binaryPath !== KERNEL_LOCK_ADDON_PATH ||
        build.manifestPath !== KERNEL_LOCK_MANIFEST_PATH ||
        !sha256Pattern.test(build.binarySha256) ||
        !sha256Pattern.test(build.buildInputSha256) ||
        !sha256Pattern.test(build.manifestSha256) ||
        build.manifestDeclaredBinarySha256 !== build.binarySha256) {
      throw new Error("RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
    }
  }
  if (receipt.sourceBuild.buildInputSha256 !== receipt.candidateBuild.buildInputSha256) {
    throw new Error("RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
  }
  const actualCandidate = await readKernelLockBuildReceipt(payloadRoot, {
    buildInputRoot: null,
  });
  for (const key of expectedKeys.filter((key) => key !== "buildInputSha256")) {
    if (actualCandidate[key] !== receipt.candidateBuild[key]) {
      throw new Error("RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
    }
  }
  const binaryEntry = payloadManifest.entries.find(({ path: entryPath }) =>
    entryPath === KERNEL_LOCK_ADDON_PATH);
  const manifestEntry = payloadManifest.entries.find(({ path: entryPath }) =>
    entryPath === KERNEL_LOCK_MANIFEST_PATH);
  if (binaryEntry?.type !== "file" ||
      binaryEntry.sha256 !== receipt.candidateBuild.binarySha256 ||
      manifestEntry?.type !== "file" ||
      manifestEntry.sha256 !== receipt.candidateBuild.manifestSha256) {
    throw new Error("RELEASE_KERNEL_LOCK_PROVENANCE_INVALID");
  }
}

async function captureReleaseLineage(root) {
  const before = {
    sourceRoot: await sourcePathIdentityStamp(root, "directory"),
    dist: await sourcePathIdentityStamp(path.join(root, "dist"), "directory"),
  };
  const [inputSha256, distTreeSha256, inputIdentitySha256] = await Promise.all([
    releaseInputSha256(root),
    sourceTreeSha256(path.join(root, "dist")),
    releaseInputIdentitySha256(root),
  ]);
  const after = {
    sourceRoot: await sourcePathIdentityStamp(root, "directory"),
    dist: await sourcePathIdentityStamp(path.join(root, "dist"), "directory"),
  };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
  }
  return Object.freeze({
    inputSha256,
    distTreeSha256,
    stamp: Object.freeze({
      sourceRoot: before.sourceRoot,
      dist: before.dist,
      inputIdentitySha256,
    }),
  });
}

function assertLineageContentMatches(authoritative, observed) {
  if (authoritative.inputSha256 !== observed.inputSha256 ||
      authoritative.distTreeSha256 !== observed.distTreeSha256) {
    throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
  }
}

function assertAuthoritativeLineageStable(expected, observed) {
  assertLineageContentMatches(expected, observed);
  if (JSON.stringify(expected.stamp) !== JSON.stringify(observed.stamp)) {
    throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
  }
}

async function sourcePathIdentityStamp(target, type) {
  const identity = await lstat(target, { bigint: true }).catch((error) => {
    throw new Error("RELEASE_SOURCE_LINEAGE_INVALID", { cause: error });
  });
  const matches = type === "directory" ? identity.isDirectory() : identity.isFile();
  if (!matches || identity.isSymbolicLink()) throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
  return Object.freeze({
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    uid: Number(identity.uid),
    mode: Number(identity.mode),
    nlink: Number(identity.nlink),
    size: identity.size.toString(),
    ctimeNs: identity.ctimeNs.toString(),
    mtimeNs: identity.mtimeNs.toString(),
  });
}

async function releaseInputIdentitySha256(root) {
  const inputs = sourceSnapshotInputs.filter((entry) => entry !== "native/kernel-lock");
  inputs.push("native/kernel-lock/kernel_lock.c");
  inputs.sort(compareUtf8);
  const records = [];
  for (const relativePath of inputs) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const identity = await lstat(absolutePath);
    if (identity.isDirectory() && !identity.isSymbolicLink()) {
      records.push({
        path: relativePath,
        type: "directory",
        identitySha256: await sourceTreeIdentitySha256(absolutePath),
      });
    } else if (identity.isFile() && !identity.isSymbolicLink()) {
      records.push({
        path: relativePath,
        type: "file",
        identity: await sourcePathIdentityStamp(absolutePath, "file"),
      });
    } else {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
  }
  return sha256(canonicalManifestBytes(records));
}

async function sourceTreeIdentitySha256(root) {
  const records = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      validateRelativePayloadPath(relativePath);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        records.push({
          path: relativePath,
          type: "directory",
          identity: await sourcePathIdentityStamp(absolutePath, "directory"),
        });
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        records.push({
          path: relativePath,
          type: "file",
          identity: await sourcePathIdentityStamp(absolutePath, "file"),
        });
      } else {
        throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
      }
    }
  }
  await visit(root, "");
  return sha256(canonicalManifestBytes(records));
}

async function releaseInputSha256(root) {
  const records = [];
  const inputs = sourceSnapshotInputs.filter((entry) => entry !== "native/kernel-lock");
  inputs.push("native/kernel-lock/kernel_lock.c");
  inputs.sort(compareUtf8);
  for (const relativePath of inputs) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const identity = await lstat(absolutePath);
    if (identity.isDirectory() && !identity.isSymbolicLink()) {
      records.push({ path: relativePath, sha256: await sourceTreeSha256(absolutePath) });
    } else if (identity.isFile() && !identity.isSymbolicLink()) {
      records.push({ path: relativePath, sha256: sha256(await readFile(absolutePath)) });
    } else {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
  }
  return sha256(canonicalManifestBytes(records));
}

async function productionInputProjectionSha256(root, layout, kernelLockAddonReceipt) {
  if ((layout !== "source" && layout !== "candidate") ||
      !isPlainRecord(kernelLockAddonReceipt)) {
    throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
  }
  try {
    const records = [];
    for (const input of productionInputProjection) {
      const relativePath = layout === "source" ? input.sourcePath : input.candidatePath;
      const absolutePath = path.join(root, ...relativePath.split("/"));
      const identity = await lstat(absolutePath);
      if (input.type === "directory") {
        if (!identity.isDirectory() || identity.isSymbolicLink()) {
          throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
        }
        records.push({
          path: input.logicalPath,
          type: input.type,
          sha256: await sourceTreeSha256(absolutePath),
        });
      } else {
        if (!identity.isFile() || identity.isSymbolicLink()) {
          throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
        }
        records.push({
          path: input.logicalPath,
          type: input.type,
          sha256: sha256(await readFile(absolutePath)),
        });
      }
    }
    records.sort((left, right) => compareUtf8(left.path, right.path));
    return sha256(canonicalManifestBytes({
      version: 1,
      inputs: records,
      kernelLockAddonReceipt: normalizeJsonValue(kernelLockAddonReceipt),
    }));
  } catch (error) {
    throw error instanceof Error && error.message === "RELEASE_SOURCE_LINEAGE_INVALID"
      ? error
      : new Error("RELEASE_SOURCE_LINEAGE_INVALID", { cause: error });
  }
}

async function assertCandidateProductionInputProjection(payloadRoot, provenance) {
  try {
    assertPlainObject(provenance, "RELEASE_SOURCE_LINEAGE_INVALID");
    const receipt = provenance.kernelLockAddonReceipt;
    assertPlainObject(receipt, "RELEASE_SOURCE_LINEAGE_INVALID");
    assertPlainObject(receipt.candidateBuild, "RELEASE_SOURCE_LINEAGE_INVALID");
    const expected = provenance.candidateInputSha256;
    const source = provenance.sourceProductionInputSha256;
    const snapshot = provenance.snapshotProductionInputSha256;
    if (!sha256Pattern.test(expected) || !sha256Pattern.test(source) ||
        !sha256Pattern.test(snapshot) || expected !== source || expected !== snapshot) {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
    const actual = await productionInputProjectionSha256(
      payloadRoot,
      "candidate",
      receipt.candidateBuild,
    );
    if (actual !== expected) throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
  } catch (error) {
    throw error instanceof Error && error.message === "RELEASE_SOURCE_LINEAGE_INVALID"
      ? error
      : new Error("RELEASE_SOURCE_LINEAGE_INVALID", { cause: error });
  }
}

async function sourceTreeSha256(root) {
  const records = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      validateRelativePayloadPath(relativePath);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        records.push({ path: relativePath, sha256: sha256(await readFile(absolutePath)) });
      } else {
        throw new Error("RELEASE_NATIVE_SOURCE_INVALID");
      }
    }
  }
  await visit(root, "");
  if (records.length === 0) throw new Error("RELEASE_NATIVE_SOURCE_INVALID");
  return sha256(Buffer.from(JSON.stringify(records), "utf8"));
}

function parseRpaths(output) {
  const lines = output.split(/\r?\n/u);
  const rpaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "cmd LC_RPATH") continue;
    for (let offset = 1; offset <= 4 && index + offset < lines.length; offset += 1) {
      const match = /^\s*path\s+(.+?)\s+\(offset\s+\d+\)\s*$/u.exec(lines[index + offset]);
      if (match !== null) {
        rpaths.push(match[1]);
        break;
      }
    }
  }
  return rpaths;
}

function isAllowedRpath(rpath) {
  return rpath === "/usr/lib/swift" || rpath === "@loader_path";
}

function parseLinkedLibraries(output) {
  return output.split(/\r?\n/u).slice(1).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.replace(/\s+\(compatibility version.*$/u, ""));
}

async function inspectProductionDependencies(payloadRoot, environment) {
  let result;
  try {
    result = await runCommand("npm", ["ls", "--omit=dev", "--all", "--json"], {
      cwd: payloadRoot,
      environment,
      errorCode: "RELEASE_NODE_DEPENDENCIES_INVALID",
    });
  } catch (error) {
    throw new Error("RELEASE_NODE_DEPENDENCIES_INVALID", { cause: error });
  }
  const tree = parseJsonDocument(result.stdout, "RELEASE_NODE_DEPENDENCIES_INVALID");
  if (!isPlainRecord(tree)) throw new Error("RELEASE_NODE_DEPENDENCIES_INVALID");
  const problems = tree.problems;
  if (problems !== undefined && (!Array.isArray(problems) || problems.length > 0)) {
    throw new Error("RELEASE_NODE_DEPENDENCIES_INVALID");
  }
  return tree;
}

async function captureProductionDependencyReceipt(
  payloadRoot,
  environment,
) {
  try {
    const nodeModulesRoot = path.join(payloadRoot, "node_modules");
    const rootBefore = await lstat(nodeModulesRoot);
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
    const entries = await collectPayloadEntries(nodeModulesRoot, {
      excludeRootMetadata: false,
    });
    assertProductionDependencySymlinks(entries);
    const [lockBytes, dependencyTree] = await Promise.all([
      readFile(path.join(payloadRoot, "package-lock.json")),
      inspectProductionDependencies(payloadRoot, environment),
    ]);
    const rootAfter = await lstat(nodeModulesRoot);
    assertUnchangedIdentity(rootBefore, rootAfter, "directory");
    const counts = entries.reduce((result, entry) => {
      result[entry.type] += 1;
      return result;
    }, { directory: 0, file: 0, symlink: 0 });
    const receipt = Object.freeze({
      receiptVersion: 1,
      nodeModulesContentSha256: sha256(canonicalManifestBytes({
        contentVersion: 1,
        entries,
      })),
      directoryCount: counts.directory,
      fileCount: counts.file,
      symlinkCount: counts.symlink,
      packageLockSha256: sha256(lockBytes),
      dependencyTreeSha256: sha256(canonicalManifestBytes(dependencyTree)),
    });
    return Object.freeze({ dependencyTree, receipt });
  } catch (error) {
    throw error instanceof Error && error.message === "RELEASE_SOURCE_LINEAGE_INVALID"
      ? error
      : new Error("RELEASE_SOURCE_LINEAGE_INVALID", { cause: error });
  }
}

function assertProductionDependencySymlinks(entries) {
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (entry.type !== "symlink") continue;
    if (entry.target.includes("\\") || entry.target.normalize("NFC") !== entry.target ||
        path.posix.normalize(entry.target) !== entry.target) {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
    const visited = new Set([entry.path]);
    let current = entry;
    while (current.type === "symlink") {
      const targetPath = path.posix.normalize(path.posix.join(
        path.posix.dirname(current.path),
        current.target,
      ));
      if (targetPath === "." || targetPath === ".." || targetPath.startsWith("../") ||
          path.posix.isAbsolute(targetPath)) {
        throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
      }
      const target = entriesByPath.get(targetPath);
      if (target === undefined || visited.has(targetPath)) {
        throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
      }
      visited.add(targetPath);
      current = target;
    }
    if (current.type !== "file") throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
  }
}

function assertProductionDependencyReceipt(provenance, actual) {
  try {
    assertPlainObject(provenance, "RELEASE_SOURCE_LINEAGE_INVALID");
    const expected = provenance.productionDependencyReceipt;
    assertPlainObject(expected, "RELEASE_SOURCE_LINEAGE_INVALID");
    assertExactKeys(expected, [
      "dependencyTreeSha256",
      "directoryCount",
      "fileCount",
      "nodeModulesContentSha256",
      "packageLockSha256",
      "receiptVersion",
      "symlinkCount",
    ]);
    if (expected.receiptVersion !== 1 ||
        !sha256Pattern.test(expected.nodeModulesContentSha256) ||
        !sha256Pattern.test(expected.packageLockSha256) ||
        !sha256Pattern.test(expected.dependencyTreeSha256) ||
        !Number.isSafeInteger(expected.directoryCount) || expected.directoryCount < 1 ||
        !Number.isSafeInteger(expected.fileCount) || expected.fileCount < 1 ||
        !Number.isSafeInteger(expected.symlinkCount) || expected.symlinkCount < 0 ||
        provenance.productionDependencyTreeSha256 !== expected.dependencyTreeSha256 ||
        Reflect.ownKeys(expected).some((key) => expected[key] !== actual[key])) {
      throw new Error("RELEASE_SOURCE_LINEAGE_INVALID");
    }
  } catch (error) {
    throw error instanceof Error && error.message === "RELEASE_SOURCE_LINEAGE_INVALID"
      ? error
      : new Error("RELEASE_SOURCE_LINEAGE_INVALID", { cause: error });
  }
}

function parseJsonDocument(serialized, errorCode) {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
}

async function normalizePayloadModes(payloadRoot) {
  const entries = await collectPayloadEntries(payloadRoot, {
    excludeRootMetadata: true,
  });
  const files = entries.filter((entry) => entry.type === "file");
  for (const entry of files) {
    const executable = (entry.mode & 0o111) !== 0;
    await chmod(
      path.join(payloadRoot, ...entry.path.split("/")),
      executable ? 0o555 : 0o444,
    );
  }
  const directories = entries.filter((entry) => entry.type === "directory")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const entry of directories) {
    await chmod(path.join(payloadRoot, ...entry.path.split("/")), 0o555);
  }
}

async function assertRequiredPayloadFiles(payloadRoot, contractVersion) {
  const required = [
    "package.json",
    "package-lock.json",
    "dist/src/mcp/live-cli-bridge-main.js",
    "dist/src/mcp/live-cli-bridge.js",
    "dist/src/mcp/live-bootstrap.js",
    "dist/src/mcp/live-server.js",
    "dist/src/mcp/live-supervisor-mcp-main.js",
    "dist/src/mcp/live-supervisor-mcp-server.js",
    "dist/src/mcp/daily-care-bootstrap.js",
    "dist/src/mcp/daily-care-mcp-server.js",
    "dist/src/mcp/daily-care-runtime.js",
    "dist/src/mcp/daily-care-session.js",
    "dist/src/mcp/daily-care-supervisor-main.js",
    "dist/src/mcp/daily-care-test-main.js",
    "dist/src/mcp/official-research-server-main.js",
    "dist/src/mcp/official-research-server.js",
    "dist/src/mcp/weather-network-canary.js",
    "dist/src/mcp/weather-network-canary-main.js",
    "dist/src/mcp/weather-proxy-transport.js",
    "dist/src/mcp/system-weather-snapshot-main.js",
    "dist/src/mcp/system-weather-snapshot-producer.js",
    "dist/src/runtime-v2/production-acceptance-driver.js",
    "dist/src/runtime-v2/release-binding.js",
    "dist/src/runtime-v2/runtime-activation.js",
    "dist/src/runtime-v2/runtime-activation-cli.js",
    "dist/src/runtime-v2/runtime-activation-main.js",
    "dist/src/runtime-v2/runtime-activation-production.js",
    "bin/chat-assistant-activate",
    "bin/chat-assistant-supervisor",
    "bin/daily-care-supervisor",
    "bin/daily-care-test",
    "bin/official-research",
    "bin/weather-network-canary",
    "bin/system-weather-snapshot-producer",
    "bin/system-weather-snapshot.swift",
    "config/automation-restricted.config.toml",
    "config/local.wechat-ai-assistant-public.system-weather.plist",
    "prompts/automation-single-scheduler-v1.md",
    "dist/src/artifacts/travel-demo-job.js",
    "native/kernel-lock/build/darwin-arm64/kernel_lock.node",
    "native/kernel-lock/build/darwin-arm64/kernel_lock.manifest.json",
    "node_modules/zod/package.json",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/undici/package.json",
    NATIVE_RUNTIME_PATH,
  ];
  if (contractVersion >= 2) {
    required.push(
      "dist/src/mcp/fixed-heartbeat-supervisor.js",
      "dist/src/mcp/fixed-heartbeat-supervisor-main.js",
    );
  }
  if (contractVersion >= 3) {
    required.push(
      "dist/src/runtime-v2/bootstrap.js",
      "dist/src/runtime-v2/single-dispatcher-admission.js",
      "dist/src/runtime-v2/single-scheduler.js",
      "dist/src/runtime-v2/supervised-acceptance.js",
      "dist/src/runtime-v2/supervised-acceptance-cli.js",
    );
  }
  if (contractVersion >= 4) {
    required.push("dist/src/runtime-v2/operation-quarantine.js");
  }
  await Promise.all(required.map(async (relativePath) => {
    const identity = await lstat(path.join(payloadRoot, ...relativePath.split("/"))).catch((error) => {
      throw new Error("RELEASE_REQUIRED_PAYLOAD_MISSING", { cause: error });
    });
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new Error("RELEASE_REQUIRED_PAYLOAD_MISSING");
    }
  }));
}

async function validateCriticalImports(payloadRoot, environment, contractVersion) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "release-import-check-"));
  try {
    const home = path.join(temporaryRoot, "home");
    const cwd = path.join(temporaryRoot, "cwd");
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(cwd, { mode: 0o700 }),
    ]);
    const targets = [
      "dist/src/artifacts/travel-demo-job.js",
      "dist/src/mcp/live-cli-bridge.js",
      "dist/src/mcp/live-bootstrap.js",
      "dist/src/mcp/live-server.js",
      "dist/src/mcp/live-supervisor-mcp-server.js",
      "dist/src/mcp/daily-care-bootstrap.js",
      "dist/src/mcp/daily-care-mcp-server.js",
      "dist/src/mcp/daily-care-runtime.js",
      "dist/src/mcp/daily-care-session.js",
      "dist/src/mcp/daily-care-supervisor-main.js",
      "dist/src/mcp/official-research-server.js",
      "dist/src/mcp/weather-network-canary.js",
      "dist/src/mcp/weather-network-canary-main.js",
      "dist/src/mcp/weather-proxy-transport.js",
      "dist/src/mcp/system-weather-snapshot-main.js",
      "dist/src/mcp/system-weather-snapshot-producer.js",
      "dist/src/runtime-v2/production-acceptance-driver.js",
      "dist/src/runtime-v2/release-binding.js",
      "dist/src/runtime-v2/runtime-activation.js",
      "dist/src/runtime-v2/runtime-activation-cli.js",
      "dist/src/runtime-v2/runtime-activation-main.js",
      "dist/src/runtime-v2/runtime-activation-production.js",
    ];
    if (contractVersion >= 2) {
      targets.push(
        "dist/src/mcp/fixed-heartbeat-supervisor.js",
        "dist/src/mcp/fixed-heartbeat-supervisor-main.js",
      );
    }
    if (contractVersion >= 3) {
      targets.push(
        "dist/src/runtime-v2/bootstrap.js",
        "dist/src/runtime-v2/single-dispatcher-admission.js",
        "dist/src/runtime-v2/single-scheduler.js",
        "dist/src/runtime-v2/supervised-acceptance.js",
        "dist/src/runtime-v2/supervised-acceptance-cli.js",
      );
    }
    if (contractVersion >= 4) {
      targets.push("dist/src/runtime-v2/operation-quarantine.js");
    }
    const urls = targets.map((relativePath) => pathToFileURL(
      path.join(payloadRoot, ...relativePath.split("/")),
    ).href);
    const source = `for (const target of ${JSON.stringify(urls)}) await import(target);`;
    await runCommand(process.execPath, ["--input-type=module", "--eval", source], {
      cwd,
      environment: runtimeValidationEnvironment({
        HOME: home,
        TMPDIR: temporaryRoot,
        PATH: environment.PATH,
      }),
      errorCode: "RELEASE_NODE_IMPORT_FAILED",
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runIsolatedBridge(payloadRoot, smokeRoot) {
  const home = path.join(smokeRoot, "home");
  const cwd = path.join(smokeRoot, "cwd");
  const temporaryDirectory = path.join(smokeRoot, "temp");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(cwd, { recursive: true, mode: 0o700 }),
    mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const dataRoot = path.join(home, "Desktop", "聊天助手");
  const runtimeRoot = path.join(dataRoot, "runtime-v2");
  const kernelLock = await loadPayloadKernelLock(payloadRoot);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await kernelLock.initializeKernelLockCatalogForInstaller({ dataRoot: runtimeRoot });
  const entry = path.join(payloadRoot, "dist", "src", "mcp", "live-cli-bridge-main.js");
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: {
      CHAT_ASSISTANT_MODE: "observe",
      HOME: home,
      LANG: "en_US.UTF-8",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: temporaryDirectory,
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let completed = false;
  try {
    const ready = await readBridgeResponse(iterator);
    if (
      !isPlainRecord(ready)
      || ready.ok !== true
      || ready.type !== "ready"
      || ready.protocolVersion !== bridgeProtocolVersion
      || ready.active !== true
      || Object.keys(ready).sort().join(",") !== "active,ok,protocolVersion,type"
    ) {
      throw new Error("RELEASE_BRIDGE_PROTOCOL_INVALID");
    }
    await assertKernelLeaseBusy(kernelLock, runtimeRoot, "live-operation", "RELEASE_SMOKE_LOCK_NOT_OBSERVED");
    await writeBridgeCommand(child, { op: "close" });
    const closed = await readBridgeResponse(iterator);
    if (
      !isPlainRecord(closed)
      || closed.ok !== true
      || !isPlainRecord(closed.result)
      || closed.result.closed !== true
    ) {
      throw new Error("RELEASE_BRIDGE_CLOSE_FAILED");
    }
    child.stdin.end();
    await assertChildExit(child, stderr);
    completed = true;
    const successor = await kernelLock.acquireKernelLease({
      dataRoot: runtimeRoot,
      purpose: "live-operation",
    });
    await successor.close();
    return {
      protocolVersion: bridgeProtocolVersion,
      lockObserved: true,
      lockReleased: true,
    };
  } finally {
    lines.close();
    if (!completed && child.exitCode === null && child.signalCode === null) {
      if (child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
        child.stdin.end();
      }
      try {
        await waitForExit(child, 2_000);
      } catch {
        child.kill("SIGTERM");
        try {
          await waitForExit(child, 2_000);
        } catch {
          child.kill("SIGKILL");
          await waitForExit(child, 2_000);
        }
      }
    }
  }
}

async function loadPayloadKernelLock(payloadRoot) {
  const modulePath = path.join(payloadRoot, "dist", "src", "storage", "kernel-lock.js");
  const loaded = await import(pathToFileURL(modulePath).href);
  if (
    typeof loaded.acquireKernelLease !== "function"
    || typeof loaded.initializeKernelLockCatalogForInstaller !== "function"
  ) {
    throw new Error("RELEASE_KERNEL_LOCK_MODULE_INVALID");
  }
  return loaded;
}

async function assertKernelLeaseBusy(kernelLock, dataRoot, purpose, errorCode) {
  let lease;
  try {
    lease = await kernelLock.acquireKernelLease({ dataRoot, purpose });
  } catch (error) {
    if (error instanceof Error && error.message === "KERNEL_LOCK_BUSY") return;
    throw new Error(errorCode, { cause: error });
  }
  await lease.close();
  throw new Error(errorCode);
}

async function readBridgeResponse(iterator) {
  const next = await withTimeout(iterator.next(), bridgeTimeoutMs, "RELEASE_BRIDGE_TIMEOUT");
  if (next.done) throw new Error("RELEASE_BRIDGE_CLOSED_EARLY");
  return parseJsonDocument(next.value, "RELEASE_BRIDGE_PROTOCOL_INVALID");
}

async function writeBridgeCommand(child, command) {
  if (!child.stdin.write(`${JSON.stringify(command)}\n`, "utf8")) {
    await once(child.stdin, "drain");
  }
}

async function assertChildExit(child, stderr) {
  const [code, signal] = await waitForExit(child, bridgeTimeoutMs);
  if (code !== 0 || signal !== null) {
    throw new Error("RELEASE_BRIDGE_EXIT_INVALID", {
      cause: new Error(`code=${String(code)} signal=${String(signal)} ${stderr}`),
    });
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return withTimeout(once(child, "exit"), timeoutMs, "RELEASE_BRIDGE_TIMEOUT");
}

function withTimeout(promise, timeoutMs, errorCode) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function inspectProductionMaintenanceLease(options) {
  const expected = options.productionMaintenanceLease;
  if (!isPlainRecord(expected)) throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS");
  const expectedPath = path.join(
    path.resolve(options.productionRuntimeRoot),
    "state",
    ".kernel-lock-v1",
    `${createHash("sha256").update("live-operation", "utf8").digest("hex")}.gate`,
  );
  if (path.resolve(expected.path) !== expectedPath) {
    throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS");
  }
  const identity = await lstat(expectedPath).catch((error) => {
    throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS", { cause: error });
  });
  if (
    !identity.isFile()
    || identity.isSymbolicLink()
    || String(identity.dev) !== expected.device
    || String(identity.ino) !== expected.inode
    || (identity.mode & 0o777) !== 0o600
    || identity.nlink !== 2
  ) {
    throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS");
  }
  if (
    typeof expected.nonce !== "string"
    || typeof expected.txid !== "string"
    || expected.nonce.length === 0
    || expected.txid.length === 0
  ) {
    throw new Error("RELEASE_MAINTENANCE_LEASE_AMBIGUOUS");
  }
  return {
    device: String(identity.dev),
    inode: String(identity.ino),
    mode: identity.mode,
    modifiedAt: identity.mtimeMs,
    nlink: identity.nlink,
    size: identity.size,
  };
}

function sameMaintenanceSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("RELEASE_OWNER_UNVERIFIED");
  return process.getuid();
}

export async function createPayloadManifest(options) {
  const payloadRoot = path.resolve(options.payloadRoot);
  await assertPayloadRoot(payloadRoot);
  assertPlainObject(options.provenance, "RELEASE_MANIFEST_INVALID");
  const entries = await collectPayloadEntries(payloadRoot, {
    excludeRootMetadata: true,
  });
  const manifest = {
    manifestVersion: PAYLOAD_MANIFEST_VERSION,
    provenance: normalizeJsonValue(options.provenance),
    entries,
  };
  const manifestBytes = canonicalManifestBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);

  await atomicWrite(
    payloadRoot,
    PAYLOAD_MANIFEST_FILENAME,
    manifestBytes,
  );
  await atomicWrite(
    payloadRoot,
    PAYLOAD_MANIFEST_SHA256_FILENAME,
    Buffer.from(`${manifestSha256}\n`, "utf8"),
  );

  return { manifestSha256 };
}

export async function validatePayloadManifest(options) {
  const payloadRoot = path.resolve(options.payloadRoot);
  const rootIdentity = await assertPayloadRoot(payloadRoot);
  if ((rootIdentity.mode & 0o777) !== 0o555) {
    throw new Error("RELEASE_PAYLOAD_MODE_POLICY_INVALID");
  }
  const manifestBytes = await readMetadataFile(
    path.join(payloadRoot, PAYLOAD_MANIFEST_FILENAME),
  );
  const sidecarBytes = await readMetadataFile(
    path.join(payloadRoot, PAYLOAD_MANIFEST_SHA256_FILENAME),
  );
  const sidecar = sidecarBytes.toString("utf8");
  if (!/^[a-f0-9]{64}\n$/u.test(sidecar)) {
    throw new Error("RELEASE_MANIFEST_INVALID");
  }

  const manifestSha256 = sha256(manifestBytes);
  if (sidecar !== `${manifestSha256}\n`) {
    throw new Error("RELEASE_MANIFEST_HASH_MISMATCH");
  }

  let parsed;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error("RELEASE_MANIFEST_INVALID", { cause: error });
  }
  assertManifest(parsed);
  if (!manifestBytes.equals(canonicalManifestBytes(parsed))) {
    throw new Error("RELEASE_MANIFEST_INVALID");
  }

  const actualEntries = await collectPayloadEntries(payloadRoot, {
    excludeRootMetadata: true,
  });
  const expectedByPath = new Map(parsed.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actualEntries.map((entry) => [entry.path, entry]));
  if (
    expectedByPath.size !== actualByPath.size
    || [...expectedByPath.keys()].some((entryPath) => !actualByPath.has(entryPath))
  ) {
    throw new Error("RELEASE_PAYLOAD_SET_MISMATCH");
  }

  for (const [entryPath, expected] of expectedByPath) {
    const actual = actualByPath.get(entryPath);
    if (actual.type !== expected.type) {
      throw new Error("RELEASE_PAYLOAD_ENTRY_INVALID");
    }
    if (expected.type === "file" && actual.sha256 !== expected.sha256) {
      throw new Error("RELEASE_PAYLOAD_HASH_MISMATCH");
    }
    if (!sameEntry(expected, actual)) {
      throw new Error("RELEASE_PAYLOAD_ENTRY_INVALID");
    }
    assertPayloadEntryMode(actual);
  }
  const finalRootIdentity = await lstat(payloadRoot);
  if (
    !finalRootIdentity.isDirectory()
    || finalRootIdentity.isSymbolicLink()
    || finalRootIdentity.dev !== rootIdentity.dev
    || finalRootIdentity.ino !== rootIdentity.ino
    || finalRootIdentity.mode !== rootIdentity.mode
    || finalRootIdentity.nlink !== rootIdentity.nlink
  ) {
    throw new Error("RELEASE_PAYLOAD_ROOT_INVALID");
  }

  return {
    ok: true,
    manifestSha256,
    entryCount: actualEntries.length,
    entries: parsed.entries,
    provenance: parsed.provenance,
  };
}

export function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(normalizeJsonValue(manifest), null, 2)}\n`, "utf8");
}

export function validateRelativePayloadPath(relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.includes("\0")
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || relativePath.normalize("NFC") !== relativePath
  ) {
    throw new Error("RELEASE_PAYLOAD_PATH_UNSAFE");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => /^\.env(?:\..+)?$/u.test(segment))) {
    throw new Error("RELEASE_PAYLOAD_SECRET_FILE_FORBIDDEN");
  }
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || path.posix.normalize(relativePath) !== relativePath
    || !/^[A-Za-z0-9._@+/-]+$/u.test(relativePath)
  ) {
    throw new Error("RELEASE_PAYLOAD_PATH_UNSAFE");
  }
  return relativePath;
}

async function collectPayloadEntries(payloadRoot, options = {}) {
  const excludeRootMetadata = options.excludeRootMetadata === true;
  const rootRealPath = await realpath(payloadRoot);
  const entries = [];
  const foldedPaths = new Set();

  async function visit(directory, relativeDirectory) {
    const names = await readdir(directory);
    names.sort(compareUtf8);
    for (const name of names) {
      if (excludeRootMetadata && relativeDirectory === "" && metadataFilenames.has(name)) {
        continue;
      }
      const relativePath = validateRelativePayloadPath(
        relativeDirectory === "" ? name : `${relativeDirectory}/${name}`,
      );
      const folded = relativePath.toLowerCase();
      if (foldedPaths.has(folded)) {
        throw new Error("RELEASE_PAYLOAD_PATH_COLLISION");
      }
      foldedPaths.add(folded);

      const absolutePath = path.join(payloadRoot, ...relativePath.split("/"));
      const identity = await lstat(absolutePath);
      const mode = identity.mode & 0o777;
      if (identity.isDirectory()) {
        await assertRealPathInsideRoot(rootRealPath, absolutePath);
        entries.push({ path: relativePath, type: "directory", size: 0, mode });
        await visit(absolutePath, relativePath);
        const finalIdentity = await lstat(absolutePath);
        assertUnchangedIdentity(identity, finalIdentity, "directory");
      } else if (identity.isFile()) {
        if (identity.nlink !== 1) throw new Error("RELEASE_PAYLOAD_HARDLINK_INVALID");
        await assertRealPathInsideRoot(rootRealPath, absolutePath);
        const contents = await readExactRegularFile(absolutePath, identity);
        const finalIdentity = await lstat(absolutePath);
        assertUnchangedIdentity(identity, finalIdentity, "file");
        entries.push({
          path: relativePath,
          type: "file",
          size: contents.byteLength,
          mode,
          sha256: sha256(contents),
        });
      } else if (identity.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        assertSymlinkTargetInsideRoot(payloadRoot, absolutePath, target);
        const finalIdentity = await lstat(absolutePath);
        assertUnchangedIdentity(identity, finalIdentity, "symlink");
        entries.push({
          path: relativePath,
          type: "symlink",
          size: Buffer.byteLength(target, "utf8"),
          mode,
          target,
        });
      } else {
        throw new Error("RELEASE_PAYLOAD_SPECIAL_FILE");
      }
    }
  }

  await visit(payloadRoot, "");
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  assertSymlinkTargetsExist(payloadRoot, entries);
  return entries;
}

async function assertPayloadRoot(payloadRoot) {
  let identity;
  try {
    identity = await lstat(payloadRoot);
  } catch (error) {
    throw new Error("RELEASE_PAYLOAD_ROOT_INVALID", { cause: error });
  }
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("RELEASE_PAYLOAD_ROOT_INVALID");
  }
  return identity;
}

function assertPayloadEntryMode(entry) {
  if (entry.type === "directory") {
    if (entry.mode !== 0o555) throw new Error("RELEASE_PAYLOAD_MODE_POLICY_INVALID");
    return;
  }
  if (entry.type === "file" && entry.mode !== 0o444 && entry.mode !== 0o555) {
    throw new Error("RELEASE_PAYLOAD_MODE_POLICY_INVALID");
  }
}

function assertUnchangedIdentity(before, after, expectedType) {
  const typeMatches = expectedType === "directory"
    ? after.isDirectory() && !after.isSymbolicLink()
    : expectedType === "file"
      ? after.isFile() && !after.isSymbolicLink()
      : after.isSymbolicLink();
  if (
    !typeMatches
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.mode !== after.mode
    || before.size !== after.size
    || before.nlink !== after.nlink
  ) {
    throw new Error("RELEASE_PAYLOAD_ENTRY_INVALID");
  }
}

async function assertRealPathInsideRoot(rootRealPath, candidate) {
  const candidateRealPath = await realpath(candidate);
  const relative = path.relative(rootRealPath, candidateRealPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("RELEASE_PAYLOAD_REALPATH_OUTSIDE_ROOT");
  }
}

function assertSymlinkTargetInsideRoot(payloadRoot, linkPath, target) {
  if (target.includes("\0") || path.isAbsolute(target)) {
    throw new Error("RELEASE_PAYLOAD_SYMLINK_OUTSIDE_ROOT");
  }
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  const relative = path.relative(payloadRoot, resolvedTarget);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("RELEASE_PAYLOAD_SYMLINK_OUTSIDE_ROOT");
  }
}

function assertSymlinkTargetsExist(payloadRoot, entries) {
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    if (entry.type !== "symlink") continue;
    const visited = new Set([entry.path]);
    let current = entry;
    while (current.type === "symlink") {
      const linkPath = path.join(payloadRoot, ...current.path.split("/"));
      const resolvedTarget = path.resolve(path.dirname(linkPath), current.target);
      const targetPath = path.relative(payloadRoot, resolvedTarget).split(path.sep).join("/");
      const target = entriesByPath.get(targetPath);
      if (target === undefined) {
        throw new Error("RELEASE_PAYLOAD_SYMLINK_TARGET_INVALID");
      }
      if (visited.has(targetPath)) {
        throw new Error("RELEASE_PAYLOAD_SYMLINK_CYCLE");
      }
      visited.add(targetPath);
      current = target;
    }
  }
}

async function readExactRegularFile(filePath, expectedIdentity) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedIdentity = await handle.stat();
    if (
      !openedIdentity.isFile()
      || openedIdentity.dev !== expectedIdentity.dev
      || openedIdentity.ino !== expectedIdentity.ino
    ) {
      throw new Error("RELEASE_PAYLOAD_ENTRY_INVALID");
    }
    return await handle.readFile();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readMetadataFile(filePath) {
  let identity;
  try {
    identity = await lstat(filePath);
  } catch (error) {
    throw new Error("RELEASE_MANIFEST_INVALID", { cause: error });
  }
  if (!identity.isFile() || identity.isSymbolicLink()) {
    throw new Error("RELEASE_MANIFEST_INVALID");
  }
  if (identity.nlink !== 1) throw new Error("RELEASE_MANIFEST_INVALID");
  if ((identity.mode & 0o777) !== 0o444) {
    throw new Error("RELEASE_MANIFEST_METADATA_MODE_INVALID");
  }
  try {
    const contents = await readExactRegularFile(filePath, identity);
    const finalIdentity = await lstat(filePath);
    assertUnchangedIdentity(identity, finalIdentity, "file");
    return contents;
  } catch (error) {
    throw new Error("RELEASE_MANIFEST_INVALID", { cause: error });
  }
}

async function atomicWrite(payloadRoot, filename, contents) {
  const temporaryPath = path.join(
    payloadRoot,
    `.${filename}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.chmod(0o444);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path.join(payloadRoot, filename));
    await syncDirectory(payloadRoot);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function assertManifest(value) {
  assertPlainObject(value, "RELEASE_MANIFEST_INVALID");
  assertExactKeys(value, ["entries", "manifestVersion", "provenance"]);
  if (value.manifestVersion !== PAYLOAD_MANIFEST_VERSION || !Array.isArray(value.entries)) {
    throw new Error("RELEASE_MANIFEST_INVALID");
  }
  assertPlainObject(value.provenance, "RELEASE_MANIFEST_INVALID");
  normalizeJsonValue(value.provenance);

  const seen = new Set();
  let previousPath = null;
  for (const entry of value.entries) {
    assertManifestEntry(entry);
    const folded = entry.path.toLowerCase();
    if (seen.has(folded) || (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0)) {
      throw new Error("RELEASE_MANIFEST_INVALID");
    }
    seen.add(folded);
    previousPath = entry.path;
  }
}

function assertManifestEntry(entry) {
  assertPlainObject(entry, "RELEASE_MANIFEST_INVALID");
  validateRelativePayloadPath(entry.path);
  if (!Number.isInteger(entry.size) || entry.size < 0 || !isMode(entry.mode)) {
    throw new Error("RELEASE_MANIFEST_INVALID");
  }
  switch (entry.type) {
    case "file":
      assertExactKeys(entry, ["mode", "path", "sha256", "size", "type"]);
      if (!sha256Pattern.test(entry.sha256)) throw new Error("RELEASE_MANIFEST_INVALID");
      break;
    case "directory":
      assertExactKeys(entry, ["mode", "path", "size", "type"]);
      if (entry.size !== 0) throw new Error("RELEASE_MANIFEST_INVALID");
      break;
    case "symlink":
      assertExactKeys(entry, ["mode", "path", "size", "target", "type"]);
      if (typeof entry.target !== "string") throw new Error("RELEASE_MANIFEST_INVALID");
      break;
    default:
      throw new Error("RELEASE_MANIFEST_INVALID");
  }
}

function assertExactKeys(value, expected) {
  const actual = Object.keys(value).sort(compareUtf8);
  const sortedExpected = [...expected].sort(compareUtf8);
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("RELEASE_MANIFEST_INVALID");
  }
}

function assertPlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
}

function normalizeJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("RELEASE_MANIFEST_INVALID");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("RELEASE_MANIFEST_INVALID");
    seen.add(value);
    const result = value.map((item) => normalizeJsonValue(item, seen));
    seen.delete(value);
    return result;
  }
  assertPlainObject(value, "RELEASE_MANIFEST_INVALID");
  if (seen.has(value)) throw new Error("RELEASE_MANIFEST_INVALID");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort(compareUtf8)) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
      throw new Error("RELEASE_MANIFEST_INVALID");
    }
    result[key] = normalizeJsonValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function sameEntry(left, right) {
  return JSON.stringify(normalizeJsonValue(left)) === JSON.stringify(normalizeJsonValue(right));
}

function isMode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0o777;
}

function pathsOverlap(left, right) {
  return left === right || isPathDescendant(left, right) || isPathDescendant(right, left);
}

function isPathDescendant(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function resolveProspectiveRealPath(candidate) {
  let existingAncestor = candidate;
  const missingSegments = [];
  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new Error("RELEASE_SMOKE_PATH_INVALID", { cause: error });
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error("RELEASE_SMOKE_PATH_INVALID", { cause: error });
      }
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  let resolvedAncestor;
  try {
    resolvedAncestor = await realpath(existingAncestor);
  } catch (error) {
    throw new Error("RELEASE_SMOKE_PATH_INVALID", { cause: error });
  }
  return path.resolve(resolvedAncestor, ...missingSegments);
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
