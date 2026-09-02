import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ReleaseBinding } from "./supervised-acceptance.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const configPath = "config/automation-restricted.config.toml";
const nativePath =
  "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge";

export interface PackagedReleaseBinding {
  readonly releaseRoot: string;
  readonly binding: ReleaseBinding;
}

export async function resolvePackagedReleaseBinding(
  moduleUrl: string,
): Promise<PackagedReleaseBinding> {
  const modulePath = fileURLToPath(moduleUrl);
  const releaseRoot = await realpath(path.resolve(path.dirname(modulePath), "../../.."));
  const relativeModule = path.relative(releaseRoot, await realpath(modulePath));
  if (relativeModule.startsWith("..") || path.isAbsolute(relativeModule) ||
      !relativeModule.startsWith(`dist${path.sep}src${path.sep}`)) {
    throw new Error("ACTIVATION_RELEASE_ROOT_INVALID");
  }
  const manifestPath = path.join(releaseRoot, "payload-manifest.json");
  const sidecarPath = path.join(releaseRoot, "payload-manifest.sha256");
  await Promise.all([
    assertRegularFile(manifestPath),
    assertRegularFile(sidecarPath),
  ]);
  const [manifestBytes, sidecar] = await Promise.all([
    readFile(manifestPath),
    readFile(sidecarPath, "utf8"),
  ]);
  const payloadManifestSha256 = sha256(manifestBytes);
  if (!sha256Pattern.test(payloadManifestSha256) ||
      sidecar !== `${payloadManifestSha256}\n`) {
    throw new Error("ACTIVATION_RELEASE_MANIFEST_INVALID");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error("ACTIVATION_RELEASE_MANIFEST_INVALID", { cause: error });
  }
  const entries = manifestEntries(manifest);
  const [effectiveConfigSha256, nativeSha256] = await Promise.all([
    verifyBoundEntry(releaseRoot, entries, configPath),
    verifyBoundEntry(releaseRoot, entries, nativePath),
  ]);
  return Object.freeze({
    releaseRoot,
    binding: Object.freeze({
      payloadManifestSha256,
      nativeSha256,
      effectiveConfigSha256,
    }),
  });
}

export async function assertInstalledCurrentRelease(
  runtimeRoot: string,
  releaseRoot: string,
): Promise<void> {
  if (!path.isAbsolute(runtimeRoot) || path.basename(runtimeRoot) !== "runtime-v2") {
    throw new Error("ACTIVATION_RUNTIME_ROOT_INVALID");
  }
  const currentPath = path.join(runtimeRoot, "current");
  const status = await lstat(currentPath);
  if (!status.isSymbolicLink()) throw new Error("ACTIVATION_CURRENT_RELEASE_INVALID");
  const target = await readlink(currentPath);
  if (path.isAbsolute(target) || target.includes("\0")) {
    throw new Error("ACTIVATION_CURRENT_RELEASE_INVALID");
  }
  const resolved = await realpath(path.resolve(runtimeRoot, target));
  if (resolved !== await realpath(releaseRoot)) {
    throw new Error("ACTIVATION_CURRENT_RELEASE_INVALID");
  }
}

type ManifestEntry = {
  readonly path: string;
  readonly type: "file";
  readonly sha256: string;
};

function manifestEntries(manifest: unknown): ManifestEntry[] {
  if (!isPlainRecord(manifest) || !Array.isArray(manifest["entries"])) {
    throw new Error("ACTIVATION_RELEASE_MANIFEST_INVALID");
  }
  const entries: ManifestEntry[] = [];
  for (const value of manifest["entries"]) {
    if (!isPlainRecord(value) || typeof value["path"] !== "string" ||
        value["type"] !== "file" || typeof value["sha256"] !== "string" ||
        !sha256Pattern.test(value["sha256"])) {
      continue;
    }
    entries.push({
      path: value["path"],
      type: "file",
      sha256: value["sha256"],
    });
  }
  return entries;
}

async function verifyBoundEntry(
  releaseRoot: string,
  entries: ManifestEntry[],
  relativePath: string,
): Promise<string> {
  const matches = entries.filter((entry) => entry.path === relativePath);
  if (matches.length !== 1) throw new Error("ACTIVATION_RELEASE_MANIFEST_INVALID");
  const entry = matches[0];
  if (entry === undefined) throw new Error("ACTIVATION_RELEASE_MANIFEST_INVALID");
  const absolutePath = path.join(releaseRoot, ...relativePath.split("/"));
  await assertRegularFile(absolutePath);
  const digest = sha256(await readFile(absolutePath));
  if (digest !== entry.sha256) throw new Error("ACTIVATION_RELEASE_MANIFEST_INVALID");
  return digest;
}

async function assertRegularFile(candidate: string): Promise<void> {
  const status = await lstat(candidate);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error("ACTIVATION_RELEASE_PATH_INVALID");
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
