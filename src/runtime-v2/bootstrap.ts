import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export interface CleanRuntimeV2AdmissionOptions {
  readonly sourceRoot: string;
  readonly runtimeRoot: string;
}

export interface CleanRuntimeV2AdmissionReceipt {
  readonly status: "created" | "admitted";
  readonly runtimeRoot: string;
}

export async function admitCleanRuntimeV2Root(
  options: CleanRuntimeV2AdmissionOptions,
): Promise<CleanRuntimeV2AdmissionReceipt> {
  assertAbsolutePath(options?.sourceRoot);
  assertAbsolutePath(options?.runtimeRoot);
  const sourceRoot = path.resolve(options.sourceRoot);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  if (path.basename(runtimeRoot) !== "runtime-v2") {
    throw new Error("RUNTIME_V2_DESTINATION_INVALID");
  }

  const sourceStatus = await lstat(sourceRoot);
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    throw new Error("RUNTIME_V2_SOURCE_INVALID");
  }
  const canonicalSource = await realpath(sourceRoot);
  const canonicalParent = await realpath(path.dirname(runtimeRoot));
  const canonicalRuntime = path.join(canonicalParent, path.basename(runtimeRoot));
  if (pathsOverlap(canonicalSource, canonicalRuntime)) {
    throw new Error("RUNTIME_V2_SOURCE_RUNTIME_OVERLAP");
  }

  try {
    const status = await lstat(runtimeRoot);
    await validateEmptyOwnedRoot(runtimeRoot, status);
    return Object.freeze({ status: "admitted", runtimeRoot });
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  try {
    await mkdir(runtimeRoot, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const status = await lstat(runtimeRoot);
    await validateEmptyOwnedRoot(runtimeRoot, status);
    return Object.freeze({ status: "admitted", runtimeRoot });
  }
  const createdStatus = await lstat(runtimeRoot);
  await validateEmptyOwnedRoot(runtimeRoot, createdStatus);
  return Object.freeze({ status: "created", runtimeRoot });
}

async function validateEmptyOwnedRoot(
  runtimeRoot: string,
  status: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("RUNTIME_V2_ROOT_TYPE_INVALID");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null || status.uid !== uid) throw new Error("RUNTIME_V2_ROOT_OWNER_INVALID");
  if ((Number(status.mode) & 0o777) !== 0o700) throw new Error("RUNTIME_V2_ROOT_MODE_INVALID");
  if ((await readdir(runtimeRoot)).length !== 0) throw new Error("RUNTIME_V2_ROOT_NOT_EMPTY");
}

function pathsOverlap(first: string, second: string): boolean {
  const firstToSecond = path.relative(first, second);
  const secondToFirst = path.relative(second, first);
  return firstToSecond === "" || secondToFirst === "" ||
    (!firstToSecond.startsWith(`..${path.sep}`) && firstToSecond !== ".." &&
      !path.isAbsolute(firstToSecond)) ||
    (!secondToFirst.startsWith(`..${path.sep}`) && secondToFirst !== ".." &&
      !path.isAbsolute(secondToFirst));
}

function assertAbsolutePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !path.isAbsolute(value)) {
    throw new Error("RUNTIME_V2_PATH_INVALID");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
