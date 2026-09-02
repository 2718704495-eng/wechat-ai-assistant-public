#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { constants, fstatSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function cleanDist(input) {
  assertInput(input);
  const sourceRoot = input.sourceRoot;
  const components = parseCanonicalAbsoluteComponents(sourceRoot);

  const addon = loadKernelAddon();
  const resources = [];
  let operationError = null;
  try {
    const rootHandle = await open(
      "/",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    resources.push({ kind: "node", handle: rootHandle });
    const rootIdentity = bindNodeDirectoryIdentity(
      await rootHandle.stat(),
      "CLEAN_DIST_SOURCE_INVALID",
    );

    const pathChain = [];
    let parentFd = rootHandle.fd;
    for (const name of components) {
      const directory = bindNativeDirectory(
        addon.openDirectoryAtNoFollow(parentFd, name),
        "CLEAN_DIST_SOURCE_INVALID",
      );
      resources.push({ kind: "native", handle: directory });
      assertNamedDirectoryIdentity(
        addon.inspectEntryAtNoFollow(parentFd, name),
        directory,
        "CLEAN_DIST_SOURCE_INVALID",
      );
      pathChain.push(Object.freeze({ directory, name, parentFd }));
      parentFd = directory.fd;
    }
    const source = pathChain.at(-1)?.directory;
    if (source === undefined || source.uid !== currentUid()) {
      throw new Error("CLEAN_DIST_SOURCE_INVALID");
    }

    const packageFile = bindNativeFile(
      addon.openReadFileAtNoFollow(source.fd, "package.json"),
      "CLEAN_DIST_SOURCE_INVALID",
    );
    resources.push({ kind: "native", handle: packageFile });
    const packageDocument = JSON.parse(readBoundFile(packageFile));
    if (packageDocument?.name !== "wechat-ai-assistant-public") {
      throw new Error("CLEAN_DIST_SOURCE_INVALID");
    }
    assertNamedIdentity(
      addon.inspectEntryAtNoFollow(source.fd, "package.json"),
      packageFile,
      constants.S_IFREG,
      "CLEAN_DIST_SOURCE_INVALID",
    );

    const namedDist = addon.inspectEntryAtNoFollow(source.fd, "dist");
    if (namedDist?.ok !== true) {
      if (namedDist?.errno !== os.constants.errno.ENOENT) {
        throw new Error("CLEAN_DIST_IDENTITY_INVALID");
      }
    } else {
      const dist = bindNativeDirectory(
        addon.openDirectoryAtNoFollow(source.fd, "dist"),
        "CLEAN_DIST_IDENTITY_INVALID",
      );
      if (dist.uid !== currentUid()) throw new Error("CLEAN_DIST_IDENTITY_INVALID");
      resources.push({ kind: "native", handle: dist });
      assertNamedDirectoryIdentity(
        namedDist,
        dist,
        "CLEAN_DIST_IDENTITY_INVALID",
      );

      await input.beforeRemove?.();
      assertNodeDirectoryIdentity(
        fstatSync(rootHandle.fd),
        rootIdentity,
        "CLEAN_DIST_SOURCE_INVALID",
      );
      for (const entry of pathChain) {
        assertNamedDirectoryIdentity(
          addon.inspectEntryAtNoFollow(entry.parentFd, entry.name),
          entry.directory,
          "CLEAN_DIST_SOURCE_INVALID",
        );
      }
      assertNamedDirectoryIdentity(
        addon.inspectEntryAtNoFollow(source.fd, "dist"),
        dist,
        "CLEAN_DIST_IDENTITY_INVALID",
      );
      const removed = addon.removePrivateTreeAtExpected(
        source.fd,
        "dist",
        dist.dev,
        dist.ino,
        dist.uid,
      );
      statusOk(removed, "CLEAN_DIST_IDENTITY_INVALID");
      statusOk(addon.fsyncFd(source.fd), "CLEAN_DIST_FSYNC_FAILED");
    }
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  for (const resource of resources.reverse()) {
    try {
      if (resource.kind === "native") {
        statusOk(addon.closeFd(resource.handle.fd), "CLEAN_DIST_CLOSE_FAILED");
      } else {
        await resource.handle.close();
      }
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const finalError = combineErrors(operationError, ...closeErrors);
  if (finalError !== null) throw finalError;
}

function assertInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
      !["sourceRoot", "beforeRemove,sourceRoot"].includes(
        Reflect.ownKeys(input).map(String).sort().join(","),
      ) || typeof input.sourceRoot !== "string" || !path.isAbsolute(input.sourceRoot) ||
      path.normalize(input.sourceRoot) !== input.sourceRoot || input.sourceRoot.includes("\0") ||
      (input.beforeRemove !== undefined && typeof input.beforeRemove !== "function")) {
    throw new Error("CLEAN_DIST_SOURCE_INVALID");
  }
}

function parseCanonicalAbsoluteComponents(sourceRoot) {
  if (path.parse(sourceRoot).root !== "/" || sourceRoot === "/" ||
      path.normalize(sourceRoot) !== sourceRoot || sourceRoot.normalize("NFC") !== sourceRoot) {
    throw new Error("CLEAN_DIST_SOURCE_INVALID");
  }
  const components = sourceRoot.slice(1).split("/");
  if (components.length === 0 || components.some((component) => (
    component.length === 0 || component === "." || component === ".." ||
    component.includes("\0") || component.normalize("NFC") !== component
  ))) {
    throw new Error("CLEAN_DIST_SOURCE_INVALID");
  }
  return Object.freeze(components);
}

function loadKernelAddon() {
  const require = createRequire(import.meta.url);
  const addonPath = path.join(
    moduleDirectory,
    "..",
    "native/kernel-lock/build",
    `${process.platform}-${process.arch}`,
    "kernel_lock.node",
  );
  const addon = require(addonPath);
  for (const key of [
    "closeFd", "fsyncFd", "inspectEntryAtNoFollow", "openDirectoryAtNoFollow",
    "openReadFileAtNoFollow", "removePrivateTreeAtExpected",
  ]) {
    if (typeof addon?.[key] !== "function") throw new Error("CLEAN_DIST_ADDON_INVALID");
  }
  return addon;
}

function bindNativeDirectory(value, code) {
  statusOk(value, code);
  if (!Number.isInteger(value.fd) || value.fd < 0 ||
      (value.mode & constants.S_IFMT) !== constants.S_IFDIR ||
      !Number.isSafeInteger(value.uid) || value.uid < 0 ||
      !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino) ||
      !Number.isSafeInteger(value.mode)) {
    throw new Error(code);
  }
  return Object.freeze(value);
}

function bindNativeFile(value, code) {
  statusOk(value, code);
  if (!Number.isInteger(value.fd) || value.fd < 0 ||
      (value.mode & constants.S_IFMT) !== constants.S_IFREG || value.nlink !== 1 ||
      value.uid !== currentUid() || !Number.isSafeInteger(value.dev) ||
      !Number.isSafeInteger(value.ino) || !Number.isSafeInteger(value.size) ||
      value.size < 1 || value.size > 1024 * 1024) {
    throw new Error(code);
  }
  return Object.freeze(value);
}

function assertNamedIdentity(observed, expected, expectedType, code) {
  statusOk(observed, code);
  if ((observed.mode & constants.S_IFMT) !== expectedType ||
      observed.dev !== expected.dev || observed.ino !== expected.ino ||
      observed.uid !== expected.uid || observed.mode !== expected.mode ||
      observed.nlink !== expected.nlink) {
    throw new Error(code);
  }
}

function assertNamedDirectoryIdentity(observed, expected, code) {
  statusOk(observed, code);
  if ((observed.mode & constants.S_IFMT) !== constants.S_IFDIR ||
      observed.dev !== expected.dev || observed.ino !== expected.ino ||
      observed.uid !== expected.uid || observed.mode !== expected.mode) {
    throw new Error(code);
  }
}

function readBoundFile(handle) {
  const before = fstatSync(handle.fd);
  if (!before.isFile() || before.size !== handle.size) throw new Error("CLEAN_DIST_SOURCE_INVALID");
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(handle.fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw new Error("CLEAN_DIST_SOURCE_INVALID");
    offset += count;
  }
  const after = fstatSync(handle.fd);
  if (Number(after.dev) !== handle.dev || Number(after.ino) !== handle.ino ||
      after.uid !== handle.uid || after.mode !== handle.mode || after.nlink !== handle.nlink ||
      after.size !== handle.size) {
    throw new Error("CLEAN_DIST_SOURCE_INVALID");
  }
  return bytes.toString("utf8");
}

function bindNodeDirectoryIdentity(identity, code) {
  if (!identity.isDirectory() || identity.isSymbolicLink() ||
      !Number.isSafeInteger(Number(identity.dev)) || !Number.isSafeInteger(Number(identity.ino)) ||
      !Number.isSafeInteger(identity.uid) || identity.uid < 0 || !Number.isSafeInteger(identity.mode)) {
    throw new Error(code);
  }
  return Object.freeze({
    dev: Number(identity.dev),
    ino: Number(identity.ino),
    uid: identity.uid,
    mode: identity.mode,
  });
}

function assertNodeDirectoryIdentity(identity, expected, code) {
  const observed = bindNodeDirectoryIdentity(identity, code);
  if (observed.dev !== expected.dev || observed.ino !== expected.ino ||
      observed.uid !== expected.uid || observed.mode !== expected.mode) {
    throw new Error(code);
  }
}

function statusOk(value, code) {
  if (value === null || typeof value !== "object" || value.ok !== true) {
    throw new Error(code, { cause: value?.errno });
  }
}

function combineErrors(...errors) {
  const present = errors.filter((error) => error !== null && error !== undefined);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, "CLEAN_DIST_RESOURCE_FAILURE");
}

function currentUid() {
  if (typeof process.getuid !== "function") throw new Error("CLEAN_DIST_OWNER_UNVERIFIED");
  return process.getuid();
}

if (process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await cleanDist({ sourceRoot: process.cwd() });
}
