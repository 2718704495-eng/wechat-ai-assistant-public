import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, fstatSync, fsyncSync, ftruncateSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import { unicodeFullCaseFold } from "./unicode-full-casefold.mjs";

export const PAYLOAD_CONTAINER_MAGIC = "WCAPC001";
export const PAYLOAD_CONTAINER_FORMAT_VERSION = 1;
export const PAYLOAD_CONTAINER_LIMITS = Object.freeze({
  maximumEntries: 200_000,
  maximumPathBytes: 4_096,
  maximumSymlinkTargetBytes: 4_096,
  maximumFileBytes: 256 * 1024 * 1024,
  maximumHeaderBytes: 32 * 1024 * 1024,
  maximumDataBytes: 1024 * 1024 * 1024,
  maximumContainerBytes: 1024 * 1024 * 1024,
});

const prefixSize = 52;
const emptySha256 = sha256(Buffer.alloc(0));
const sha256Pattern = /^[a-f0-9]{64}$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const metadataManifestPath = "payload-manifest.json";
const metadataSidecarPath = "payload-manifest.sha256";

export async function writePayloadContainerFromDirectory(input) {
  assertWriterInput(input);
  const created = await createEmptyPayloadContainer({
    parentFd: input.parentFd,
    name: input.name,
    addon: input.addon,
  });
  try {
    return await populatePayloadContainerFromDirectory({
      container: created,
      candidate: input.candidate,
      addon: input.addon,
      beforeResourceClose: input.beforeResourceClose,
    });
  } catch (error) {
    let closeError = null;
    try {
      statusOk(input.addon.closeFd(created.fd));
    } catch (caught) {
      closeError = caught;
    }
    throw combineErrors(error, closeError);
  }
}

export async function createEmptyPayloadContainer(input) {
  assertCreateInput(input);
  const created = input.addon.createFileAtNoReplace(input.parentFd, input.name, 0o600);
  assertNativeCreatedFile(created, input.name);
  let operationError = null;
  let result = null;
  try {
    const identity = bindContainerIdentity(fstatSync(created.fd, { bigint: true }));
    assertSameObjectIdentity(created, identity, "PAYLOAD_CONTAINER_IDENTITY_DRIFT");
    if (identity.size !== 0) fail("PAYLOAD_CONTAINER_CREATE_FAILED");
    statusOk(input.addon.fsyncFd(input.parentFd));
    result = Object.freeze({
      fd: created.fd,
      name: created.name,
      identity,
    });
  } catch (error) {
    operationError = error;
  }
  if (operationError !== null) {
    let closeError = null;
    try {
      statusOk(input.addon.closeFd(created.fd));
    } catch (error) {
      closeError = error;
    }
    throw combineErrors(operationError, closeError);
  }
  if (result === null) fail("PAYLOAD_CONTAINER_RESULT_MISSING");
  return result;
}

export async function populatePayloadContainerFromDirectory(input) {
  assertPopulateInput(input);
  const created = input.container;
  const initialIdentity = bindContainerIdentity(fstatSync(created.fd, { bigint: true }));
  assertSameIdentity(created.identity, initialIdentity, "PAYLOAD_CONTAINER_IDENTITY_DRIFT");
  const scanned = await scanCandidateDirectory(
    input.candidate,
    input.addon,
    input.beforeResourceClose,
  );
  let operationError = null;
  let result = null;
  try {
    const header = buildHeader(scanned.entries);
    const headerBytes = canonicalJsonBytes(header);
    if (headerBytes.length > PAYLOAD_CONTAINER_LIMITS.maximumHeaderBytes ||
        scanned.dataSize > PAYLOAD_CONTAINER_LIMITS.maximumDataBytes) {
      fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
    }
    const expectedSize = checkedContainerSize(headerBytes.length, scanned.dataSize);
    const prepopulationIdentity = bindContainerIdentity(fstatSync(created.fd, { bigint: true }));
    assertSameIdentity(created.identity, prepopulationIdentity, "PAYLOAD_CONTAINER_IDENTITY_DRIFT");
    if (prepopulationIdentity.size !== 0) fail("PAYLOAD_CONTAINER_PREPOPULATION_INVALID");
    await input.beforePopulationStart?.(deepFreeze({
      expectedTargetSize: expectedSize,
      partialState: "partial-possible",
      prepopulationIdentity,
    }));
    const authorizedIdentity = bindContainerIdentity(fstatSync(created.fd, { bigint: true }));
    assertSameIdentity(prepopulationIdentity, authorizedIdentity, "PAYLOAD_CONTAINER_IDENTITY_DRIFT");
    ftruncateSync(created.fd, expectedSize);
    const prefix = buildPrefix(headerBytes, scanned.dataSize);
    writeExact(created.fd, prefix, 0);
    writeExact(created.fd, headerBytes, prefixSize);
    let dataPosition = prefixSize + headerBytes.length;
    for (const entry of scanned.entries) {
      if (entry.type !== "file") continue;
      const copied = await copyVerifiedFileToFd(
        entry,
        input.candidate,
        input.addon,
        created.fd,
        dataPosition,
        input.beforeResourceClose,
      );
      if (copied.size !== entry.size || copied.sha256 !== entry.sha256) {
        fail("PAYLOAD_CONTAINER_SOURCE_DRIFT");
      }
      dataPosition += copied.size;
    }
    if (dataPosition !== expectedSize) fail("PAYLOAD_CONTAINER_SIZE_INVALID");
    fsyncSync(created.fd);
    const identity = bindContainerIdentity(fstatSync(created.fd, { bigint: true }));
    assertSameObjectIdentity(created.identity, identity, "PAYLOAD_CONTAINER_IDENTITY_DRIFT");
    const receipt = await validatePayloadContainerFd({
      fd: created.fd,
      expectedIdentity: identity,
    });
    result = Object.freeze({
      fd: created.fd,
      name: created.name,
      identity,
      receipt,
    });
  } catch (error) {
    operationError = error;
  }
  if (operationError !== null) throw operationError;
  if (result === null) fail("PAYLOAD_CONTAINER_RESULT_MISSING");
  return result;
}

export async function validatePayloadContainerFd(input) {
  assertValidatorInput(input);
  const before = bindContainerIdentity(fstatSync(input.fd, { bigint: true }));
  if (input.expectedIdentity !== undefined) {
    assertSameIdentity(input.expectedIdentity, before, "PAYLOAD_CONTAINER_IDENTITY_DRIFT");
  }
  if (before.size < prefixSize || before.size > PAYLOAD_CONTAINER_LIMITS.maximumContainerBytes) {
    fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
  }
  const prefix = readExact(input.fd, prefixSize, 0);
  if (prefix.subarray(0, 8).toString("ascii") !== PAYLOAD_CONTAINER_MAGIC) {
    fail("PAYLOAD_CONTAINER_MAGIC_INVALID");
  }
  const headerLength = prefix.readUInt32BE(8);
  const dataLengthBig = prefix.readBigUInt64BE(12);
  if (headerLength <= 0 || headerLength > PAYLOAD_CONTAINER_LIMITS.maximumHeaderBytes ||
      dataLengthBig > BigInt(PAYLOAD_CONTAINER_LIMITS.maximumDataBytes)) {
    fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
  }
  const dataLength = Number(dataLengthBig);
  const expectedSize = checkedContainerSize(headerLength, dataLength);
  if (before.size !== expectedSize) fail("PAYLOAD_CONTAINER_SIZE_INVALID");
  const headerBytes = readExact(input.fd, headerLength, prefixSize);
  const expectedHeaderHash = prefix.subarray(20, 52).toString("hex");
  const headerSha256 = sha256(headerBytes);
  if (headerSha256 !== expectedHeaderHash) fail("PAYLOAD_CONTAINER_HEADER_HASH_MISMATCH");
  let header;
  try {
    const serialized = utf8Decoder.decode(headerBytes);
    header = JSON.parse(serialized);
    if (!headerBytes.equals(canonicalJsonBytes(header))) {
      fail("PAYLOAD_CONTAINER_HEADER_NONCANONICAL");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PAYLOAD_CONTAINER_")) throw error;
    throw new Error("PAYLOAD_CONTAINER_HEADER_INVALID", { cause: error });
  }
  const entries = validateHeader(header, dataLength);
  const dataStart = prefixSize + headerLength;
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const actual = hashFdRange(input.fd, dataStart + entry.offset, entry.size);
    if (actual !== entry.sha256) fail("PAYLOAD_CONTAINER_ENTRY_HASH_MISMATCH");
  }
  const payloadManifest = readRequiredMetadata(input.fd, dataStart, entries, metadataManifestPath);
  const payloadManifestSha256 = sha256(payloadManifest);
  const sidecar = readRequiredMetadata(input.fd, dataStart, entries, metadataSidecarPath)
    .toString("utf8");
  if (sidecar !== `${payloadManifestSha256}\n`) {
    fail("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_INVALID");
  }
  let runtimeContractVersion;
  try {
    const document = JSON.parse(utf8Decoder.decode(payloadManifest));
    runtimeContractVersion = document?.provenance?.runtimeContractVersion;
    validateManifestEntrySet(document, entries);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PAYLOAD_CONTAINER_")) throw error;
    throw new Error("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_INVALID", { cause: error });
  }
  if (runtimeContractVersion !== 4) fail("PAYLOAD_CONTAINER_RUNTIME_CONTRACT_INVALID");
  const containerSha256 = hashFdRange(input.fd, 0, before.size);
  const after = bindContainerIdentity(fstatSync(input.fd, { bigint: true }));
  assertSameIdentity(before, after, "PAYLOAD_CONTAINER_IDENTITY_DRIFT");
  return deepFreeze({
    formatVersion: PAYLOAD_CONTAINER_FORMAT_VERSION,
    containerSha256,
    headerSha256,
    payloadManifestSha256,
    runtimeContractVersion,
    entryCount: entries.length,
    size: before.size,
    identity: before,
  });
}

function validateManifestEntrySet(document, containerEntries) {
  if (!isPlainRecord(document) || !Array.isArray(document.entries)) {
    fail("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_INVALID");
  }
  const payloadEntries = containerEntries.filter((entry) =>
    entry.path !== metadataManifestPath && entry.path !== metadataSidecarPath);
  if (document.entries.length !== payloadEntries.length) {
    fail("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_MISMATCH");
  }
  for (let index = 0; index < payloadEntries.length; index += 1) {
    const expected = document.entries[index];
    const observed = payloadEntries[index];
    if (!isPlainRecord(expected) || observed === undefined || expected.path !== observed.path ||
        expected.type !== observed.type || expected.mode !== observed.mode ||
        expected.size !== observed.size) {
      fail("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_MISMATCH");
    }
    if (observed.type === "file" && expected.sha256 !== observed.sha256) {
      fail("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_MISMATCH");
    }
    if (observed.type === "symlink" && expected.target !== observed.target) {
      fail("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_MISMATCH");
    }
  }
}

export function readPayloadContainerEntries(fd) {
  const before = bindContainerIdentity(fstatSync(fd, { bigint: true }));
  const prefix = readExact(fd, prefixSize, 0);
  if (prefix.subarray(0, 8).toString("ascii") !== PAYLOAD_CONTAINER_MAGIC) {
    fail("PAYLOAD_CONTAINER_MAGIC_INVALID");
  }
  const headerLength = prefix.readUInt32BE(8);
  const dataLengthBig = prefix.readBigUInt64BE(12);
  if (headerLength <= 0 || headerLength > PAYLOAD_CONTAINER_LIMITS.maximumHeaderBytes ||
      dataLengthBig > BigInt(PAYLOAD_CONTAINER_LIMITS.maximumDataBytes)) {
    fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
  }
  const dataLength = Number(dataLengthBig);
  if (before.size !== checkedContainerSize(headerLength, dataLength)) {
    fail("PAYLOAD_CONTAINER_SIZE_INVALID");
  }
  const headerBytes = readExact(fd, headerLength, prefixSize);
  if (sha256(headerBytes) !== prefix.subarray(20, 52).toString("hex")) {
    fail("PAYLOAD_CONTAINER_HEADER_HASH_MISMATCH");
  }
  let header;
  try {
    header = JSON.parse(utf8Decoder.decode(headerBytes));
  } catch (error) {
    throw new Error("PAYLOAD_CONTAINER_HEADER_INVALID", { cause: error });
  }
  if (!headerBytes.equals(canonicalJsonBytes(header))) {
    fail("PAYLOAD_CONTAINER_HEADER_NONCANONICAL");
  }
  return deepFreeze({
    dataStart: prefixSize + headerLength,
    entries: validateHeader(header, dataLength),
    identity: before,
  });
}

export async function materializePayloadContainer(input) {
  assertMaterializeInput(input);
  const preAuthorizationStamp = bindContainerMutationStamp(input.fd);
  await input.beforeAuthorizationStage?.("after-pre-stamp");
  const validation = await validatePayloadContainerFd({
    fd: input.fd,
    expectedIdentity: input.expectedReceipt.identity,
  });
  assertReceiptMatches(input.expectedReceipt, validation);
  const parsed = readPayloadContainerEntries(input.fd);
  assertSameIdentity(
    input.expectedReceipt.identity,
    parsed.identity,
    "PAYLOAD_CONTAINER_IDENTITY_DRIFT",
  );
  await input.beforeAuthorizationStage?.("after-full-validation");
  const mutationStamp = bindContainerMutationStamp(input.fd);
  assertSameMutationStamp(preAuthorizationStamp, mutationStamp);
  assertOpenedDirectory(input.destination, input.addon, "PAYLOAD_CONTAINER_DESTINATION_DRIFT");
  const directories = new Map([["", input.destination]]);
  const openedDirectories = [];
  let operationError = null;
  try {
    for (const entry of parsed.entries) {
      const parentPath = path.posix.dirname(entry.path);
      const parent = directories.get(parentPath === "." ? "" : parentPath);
      if (parent === undefined) fail("PAYLOAD_CONTAINER_PARENT_INVALID");
      const name = path.posix.basename(entry.path);
      await input.assertBoundary();
      await input.beforeMutation?.("materialize-entry", Object.freeze({
        path: entry.path,
        type: entry.type,
      }));
      await input.assertBoundary();
      assertContainerReceiptFresh(input, mutationStamp);
      if (entry.type === "directory") {
        statusOk(input.addon.mkdirAtNoReplace(parent.fd, name, 0o700));
        const opened = input.addon.openDirectoryAtNoFollow(parent.fd, name);
        const child = bindOpenedDirectory(opened, input.addon);
        directories.set(entry.path, child);
        openedDirectories.push({ entry, parent, name, handle: child });
      } else if (entry.type === "file") {
        const bytes = readExact(input.fd, entry.size, parsed.dataStart + entry.offset);
        if (sha256(bytes) !== entry.sha256) fail("PAYLOAD_CONTAINER_ENTRY_HASH_MISMATCH");
        statusOk(input.addon.writeFileAtNoReplace(parent.fd, name, bytes, entry.mode));
        const opened = input.addon.openReadFileAtNoFollow(parent.fd, name);
        statusOk(opened);
        let fileOperationError = null;
        const closeErrors = [];
        try {
          if (hashFdRange(opened.fd, 0, entry.size) !== entry.sha256 ||
              fstatSync(opened.fd).size !== entry.size) {
            fail("PAYLOAD_CONTAINER_MATERIALIZED_FILE_INVALID");
          }
        } catch (error) {
          fileOperationError = error;
        }
        try {
          await input.beforeResourceClose?.("container-close-materialized-file", Object.freeze({
            path: entry.path,
          }));
        } catch (error) {
          closeErrors.push(error);
        }
        try {
          statusOk(input.addon.closeFd(opened.fd));
        } catch (error) {
          closeErrors.push(error);
        }
        const fileError = combineErrors(fileOperationError, ...closeErrors);
        if (fileError !== null) throw fileError;
      } else {
        statusOk(input.addon.symlinkAtNoReplace(parent.fd, entry.target, name));
        const observed = input.addon.readLinkAtNoFollow(parent.fd, name);
        statusOk(observed);
        if (observed.target !== entry.target) fail("PAYLOAD_CONTAINER_MATERIALIZED_LINK_INVALID");
      }
      statusOk(input.addon.fsyncFd(parent.fd));
      assertContainerReceiptFresh(input, mutationStamp);
    }
    for (const value of [...openedDirectories].reverse()) {
      await input.assertBoundary();
      assertContainerReceiptFresh(input, mutationStamp);
      statusOk(input.addon.fsyncFd(value.handle.fd));
      statusOk(input.addon.chmodAtExpected(
        value.parent.fd,
        value.name,
        value.handle.dev,
        value.handle.ino,
        value.entry.mode,
        true,
      ));
      statusOk(input.addon.fsyncFd(value.parent.fd));
      assertContainerReceiptFresh(input, mutationStamp);
    }
    await input.assertBoundary();
    assertOpenedDirectory(input.destination, input.addon, "PAYLOAD_CONTAINER_DESTINATION_DRIFT");
    const finalValidation = await validatePayloadContainerFd({
      fd: input.fd,
      expectedIdentity: input.expectedReceipt.identity,
    });
    assertReceiptMatches(input.expectedReceipt, finalValidation);
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  for (const value of [...openedDirectories].reverse()) {
    try {
      await input.beforeResourceClose?.("container-close-materialized-directory", Object.freeze({
        path: value.entry.path,
      }));
    } catch (error) {
      closeErrors.push(error);
    }
    try {
      statusOk(input.addon.closeFd(value.handle.fd));
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const finalError = combineErrors(operationError, ...closeErrors);
  if (finalError !== null) throw finalError;
  return Object.freeze({
    containerSha256: input.expectedReceipt.containerSha256,
    entryCount: input.expectedReceipt.entryCount,
    payloadManifestSha256: input.expectedReceipt.payloadManifestSha256,
  });
}

function assertContainerReceiptFresh(input, expectedMutationStamp) {
  const observed = bindContainerIdentity(fstatSync(input.fd, { bigint: true }));
  assertSameIdentity(
    input.expectedReceipt.identity,
    observed,
    "PAYLOAD_CONTAINER_RECEIPT_MISMATCH",
  );
  if (observed.size !== input.expectedReceipt.size) {
    fail("PAYLOAD_CONTAINER_RECEIPT_MISMATCH");
  }
  assertSameMutationStamp(expectedMutationStamp, bindContainerMutationStamp(input.fd));
}

async function scanCandidateDirectory(candidate, addon, beforeResourceClose) {
  assertOpenedCandidateDirectory(candidate, addon);
  const internalEntries = [];
  const folded = new Set();
  async function visit(directory, relativeDirectory) {
    const listed = addon.readDirectoryNames(directory.fd);
    statusOk(listed);
    if (!Array.isArray(listed.names) || listed.names.some((name) => typeof name !== "string")) {
      fail("PAYLOAD_CONTAINER_CANDIDATE_INVALID");
    }
    const names = [...listed.names];
    names.sort(compareUtf8);
    for (const name of names) {
      const relativePath = validateContainerPath(
        relativeDirectory === "" ? name : `${relativeDirectory}/${name}`,
      );
      const foldKey = caseFoldKey(relativePath);
      if (folded.has(foldKey)) fail("PAYLOAD_CONTAINER_PATH_COLLISION");
      folded.add(foldKey);
      if (internalEntries.length >= PAYLOAD_CONTAINER_LIMITS.maximumEntries) {
        fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
      }
      const identity = addon.inspectEntryAtNoFollow(directory.fd, name);
      statusOk(identity);
      assertEntryIdentity(identity);
      const mode = identity.mode & 0o777;
      const type = identity.mode & constants.S_IFMT;
      if (type === constants.S_IFDIR) {
        assertMode("directory", mode);
        const child = addon.openDirectoryAtNoFollow(directory.fd, name);
        statusOk(child);
        assertSameNativeIdentity(identity, child, "PAYLOAD_CONTAINER_SOURCE_DRIFT");
        internalEntries.push({
          path: relativePath,
          type: "directory",
          mode,
          size: 0,
          sha256: emptySha256,
          identity: nativeIdentityReceipt(identity),
          segments: relativePath.split("/"),
        });
        let operationError = null;
        try {
          await visit(child, relativePath);
          assertSameNativeIdentity(identity, addon.inspectEntryAtNoFollow(directory.fd, name),
            "PAYLOAD_CONTAINER_SOURCE_DRIFT");
        } catch (error) {
          operationError = error;
        }
        const closeError = await closeNativeResource(
          child,
          addon,
          beforeResourceClose,
          "container-close-source-directory",
          { path: relativePath, phase: "scan" },
        );
        const finalError = combineErrors(operationError, closeError);
        if (finalError !== null) throw finalError;
      } else if (type === constants.S_IFREG) {
        if (identity.nlink !== 1) fail("PAYLOAD_CONTAINER_HARDLINK_INVALID");
        assertMode("file", mode);
        if (identity.size > PAYLOAD_CONTAINER_LIMITS.maximumFileBytes) {
          fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
        }
        const observed = await hashCandidateFileAt(
          directory,
          name,
          identity,
          addon,
          beforeResourceClose,
          relativePath,
          "hash",
        );
        internalEntries.push({
          path: relativePath,
          type: "file",
          mode,
          size: observed.size,
          sha256: observed.sha256,
          identity: nativeIdentityReceipt(identity),
          segments: relativePath.split("/"),
        });
      } else if (type === constants.S_IFLNK) {
        if (identity.nlink !== 1) fail("PAYLOAD_CONTAINER_HARDLINK_INVALID");
        assertMode("symlink", mode);
        const link = addon.readLinkAtNoFollow(directory.fd, name);
        statusOk(link);
        assertSameNativeIdentity(identity, link, "PAYLOAD_CONTAINER_SOURCE_DRIFT");
        const target = link.target;
        if (Buffer.byteLength(target, "utf8") >
            PAYLOAD_CONTAINER_LIMITS.maximumSymlinkTargetBytes) {
          fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
        }
        validateSymlinkTarget(relativePath, target);
        internalEntries.push({
          path: relativePath,
          type: "symlink",
          mode,
          size: Buffer.byteLength(target, "utf8"),
          sha256: sha256(Buffer.from(target, "utf8")),
          target,
          identity: nativeIdentityReceipt(identity),
          segments: relativePath.split("/"),
        });
      } else {
        fail("PAYLOAD_CONTAINER_SPECIAL_FILE");
      }
    }
  }
  await visit(candidate, "");
  internalEntries.sort((left, right) => compareUtf8(left.path, right.path));
  validateLogicalTree(internalEntries);
  let offset = 0;
  const entries = internalEntries.map((entry) => {
    if (entry.type !== "file") return entry;
    const withOffset = { ...entry, offset };
    offset += entry.size;
    if (offset > PAYLOAD_CONTAINER_LIMITS.maximumDataBytes) {
      fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
    }
    return withOffset;
  });
  assertOpenedCandidateDirectory(candidate, addon);
  return { entries, dataSize: offset };
}

function buildHeader(internalEntries) {
  const entries = internalEntries.map((entry) => {
    const base = {
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      sha256: entry.sha256,
    };
    if (entry.type === "file") return { ...base, offset: entry.offset };
    if (entry.type === "symlink") return { ...base, target: entry.target };
    return base;
  });
  const dataSize = entries.filter((entry) => entry.type === "file")
    .reduce((total, entry) => total + entry.size, 0);
  return {
    formatVersion: PAYLOAD_CONTAINER_FORMAT_VERSION,
    entryCount: entries.length,
    dataSize,
    entries,
  };
}

function validateHeader(header, dataLength) {
  if (!isPlainRecord(header) || exactKeys(header) !== "dataSize,entries,entryCount,formatVersion" ||
      header.formatVersion !== PAYLOAD_CONTAINER_FORMAT_VERSION ||
      !Number.isSafeInteger(header.entryCount) || header.entryCount < 0 ||
      header.entryCount > PAYLOAD_CONTAINER_LIMITS.maximumEntries ||
      !Number.isSafeInteger(header.dataSize) || header.dataSize < 0 ||
      header.dataSize > PAYLOAD_CONTAINER_LIMITS.maximumDataBytes ||
      header.dataSize !== dataLength || !Array.isArray(header.entries) ||
      header.entries.length !== header.entryCount) {
    if (Number(header?.entryCount) > PAYLOAD_CONTAINER_LIMITS.maximumEntries ||
        Number(header?.dataSize) > PAYLOAD_CONTAINER_LIMITS.maximumDataBytes) {
      fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
    }
    fail("PAYLOAD_CONTAINER_HEADER_INVALID");
  }
  const folded = new Set();
  let previous = null;
  let expectedOffset = 0;
  const entries = [];
  for (const value of header.entries) {
    if (!isPlainRecord(value) ||
        (value.type !== "directory" && value.type !== "file" && value.type !== "symlink")) {
      fail("PAYLOAD_CONTAINER_ENTRY_INVALID");
    }
    const expectedKeys = value.type === "file"
      ? "mode,offset,path,sha256,size,type"
      : value.type === "symlink"
        ? "mode,path,sha256,size,target,type"
        : "mode,path,sha256,size,type";
    if (exactKeys(value) !== expectedKeys) fail("PAYLOAD_CONTAINER_ENTRY_INVALID");
    const entryPath = validateContainerPath(value.path);
    if (previous !== null && compareUtf8(previous, entryPath) >= 0) {
      fail(previous === entryPath ? "PAYLOAD_CONTAINER_PATH_DUPLICATE" :
        "PAYLOAD_CONTAINER_ENTRY_ORDER_INVALID");
    }
    previous = entryPath;
    const foldKey = caseFoldKey(entryPath);
    if (folded.has(foldKey)) fail("PAYLOAD_CONTAINER_PATH_COLLISION");
    folded.add(foldKey);
    if (!Number.isSafeInteger(value.mode) || !Number.isSafeInteger(value.size) || value.size < 0 ||
        !sha256Pattern.test(value.sha256)) {
      fail("PAYLOAD_CONTAINER_ENTRY_INVALID");
    }
    assertMode(value.type, value.mode);
    if (value.type === "directory") {
      if (value.size !== 0 || value.sha256 !== emptySha256) {
        fail("PAYLOAD_CONTAINER_ENTRY_INVALID");
      }
      entries.push(Object.freeze({ ...value, path: entryPath }));
      continue;
    }
    if (value.type === "symlink") {
      if (typeof value.target !== "string" || value.target.normalize("NFC") !== value.target ||
          Buffer.byteLength(value.target, "utf8") !== value.size ||
          value.size > PAYLOAD_CONTAINER_LIMITS.maximumSymlinkTargetBytes ||
          sha256(Buffer.from(value.target, "utf8")) !== value.sha256) {
        fail("PAYLOAD_CONTAINER_ENTRY_INVALID");
      }
      validateSymlinkTarget(entryPath, value.target);
      entries.push(Object.freeze({ ...value, path: entryPath }));
      continue;
    }
    if (!Number.isSafeInteger(value.offset) || value.offset !== expectedOffset ||
        value.size > PAYLOAD_CONTAINER_LIMITS.maximumFileBytes) {
      if (value.size > PAYLOAD_CONTAINER_LIMITS.maximumFileBytes) {
        fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
      }
      fail("PAYLOAD_CONTAINER_ENTRY_INVALID");
    }
    expectedOffset += value.size;
    if (expectedOffset > dataLength) fail("PAYLOAD_CONTAINER_SIZE_INVALID");
    entries.push(Object.freeze({ ...value, path: entryPath }));
  }
  if (expectedOffset !== dataLength) fail("PAYLOAD_CONTAINER_SIZE_INVALID");
  validateLogicalTree(entries);
  return Object.freeze(entries);
}

function validateLogicalTree(entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const parent = path.posix.dirname(entry.path);
    if (parent !== "." && byPath.get(parent)?.type !== "directory") {
      fail("PAYLOAD_CONTAINER_PARENT_INVALID");
    }
  }
  for (const entry of entries) {
    if (entry.type !== "symlink") continue;
    const visited = new Set([entry.path]);
    let current = entry;
    while (current.type === "symlink") {
      const resolved = resolveSymlinkTarget(current.path, current.target);
      const target = byPath.get(resolved);
      if (target === undefined) fail("PAYLOAD_CONTAINER_SYMLINK_TARGET_INVALID");
      if (visited.has(resolved)) fail("PAYLOAD_CONTAINER_SYMLINK_CYCLE");
      visited.add(resolved);
      current = target;
    }
  }
}

async function hashCandidateFileAt(
  directory,
  name,
  expectedIdentity,
  addon,
  beforeResourceClose,
  diagnosticPath,
  phase,
) {
  let handle = null;
  let result = null;
  let operationError = null;
  try {
    handle = addon.openReadFileAtNoFollow(directory.fd, name);
    statusOk(handle);
    assertSameNativeIdentity(expectedIdentity, handle, "PAYLOAD_CONTAINER_SOURCE_DRIFT");
    const bytes = readExact(handle.fd, expectedIdentity.size, 0);
    assertSameNativeIdentity(expectedIdentity, addon.inspect(handle.fd),
      "PAYLOAD_CONTAINER_SOURCE_DRIFT");
    assertSameNativeIdentity(expectedIdentity, addon.inspectEntryAtNoFollow(directory.fd, name),
      "PAYLOAD_CONTAINER_SOURCE_DRIFT");
    result = { size: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    operationError = error;
  }
  const closeError = await closeNativeResource(
    handle,
    addon,
    beforeResourceClose,
    "container-close-source-file",
    { path: diagnosticPath, phase },
  );
  const finalError = combineErrors(operationError, closeError);
  if (finalError !== null) throw finalError;
  if (result === null) fail("PAYLOAD_CONTAINER_SOURCE_RESULT_MISSING");
  return result;
}

async function copyVerifiedFileToFd(
  entry,
  candidate,
  addon,
  destinationFd,
  destinationPosition,
  beforeResourceClose,
) {
  const openedDirectories = [];
  let parent = candidate;
  let handle = null;
  let result = null;
  let operationError = null;
  try {
    for (const segment of entry.segments.slice(0, -1)) {
      const directory = addon.openDirectoryAtNoFollow(parent.fd, segment);
      statusOk(directory);
      openedDirectories.push(directory);
      parent = directory;
    }
    const name = entry.segments.at(-1);
    handle = addon.openReadFileAtNoFollow(parent.fd, name);
    statusOk(handle);
    assertSameNativeIdentity(entry.identity, handle, "PAYLOAD_CONTAINER_SOURCE_DRIFT");
    const bytes = readExact(handle.fd, entry.size, 0);
    if (sha256(bytes) !== entry.sha256) fail("PAYLOAD_CONTAINER_SOURCE_DRIFT");
    writeExact(destinationFd, bytes, destinationPosition);
    assertSameNativeIdentity(entry.identity, addon.inspect(handle.fd),
      "PAYLOAD_CONTAINER_SOURCE_DRIFT");
    assertSameNativeIdentity(entry.identity, addon.inspectEntryAtNoFollow(parent.fd, name),
      "PAYLOAD_CONTAINER_SOURCE_DRIFT");
    result = { size: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    operationError = error;
  }
  const closeErrors = [];
  closeErrors.push(await closeNativeResource(
    handle, addon, beforeResourceClose, "container-close-source-file",
    { path: entry.path, phase: "copy" },
  ));
  for (const directory of openedDirectories.reverse()) {
    closeErrors.push(await closeNativeResource(
      directory, addon, beforeResourceClose, "container-close-source-directory",
      { path: entry.path, phase: "copy" },
    ));
  }
  const finalError = combineErrors(operationError, ...closeErrors);
  if (finalError !== null) throw finalError;
  if (result === null) fail("PAYLOAD_CONTAINER_SOURCE_RESULT_MISSING");
  return result;
}

async function closeNativeResource(handle, addon, beforeResourceClose, stage, context) {
  if (handle === null || handle === undefined) return null;
  const errors = [];
  try {
    await beforeResourceClose?.(stage, Object.freeze(context));
  } catch (error) {
    errors.push(error);
  }
  try {
    statusOk(addon.closeFd(handle.fd));
  } catch (error) {
    errors.push(error);
  }
  return combineErrors(...errors);
}

function readRequiredMetadata(fd, dataStart, entries, entryPath) {
  const entry = entries.find((candidate) => candidate.path === entryPath);
  if (entry?.type !== "file" || entry.size > PAYLOAD_CONTAINER_LIMITS.maximumHeaderBytes) {
    fail("PAYLOAD_CONTAINER_PAYLOAD_MANIFEST_INVALID");
  }
  return readExact(fd, entry.size, dataStart + entry.offset);
}

function buildPrefix(headerBytes, dataLength) {
  const prefix = Buffer.alloc(prefixSize);
  prefix.write(PAYLOAD_CONTAINER_MAGIC, 0, "ascii");
  prefix.writeUInt32BE(headerBytes.length, 8);
  prefix.writeBigUInt64BE(BigInt(dataLength), 12);
  createHash("sha256").update(headerBytes).digest().copy(prefix, 20);
  return prefix;
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(normalizeJson(value))}\n`, "utf8");
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareUtf8)
    .map((key) => [key, normalizeJson(value[key])]));
}

function validateContainerPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      value.includes("\\") || path.posix.isAbsolute(value) || value.normalize("NFC") !== value ||
      Buffer.byteLength(value, "utf8") > PAYLOAD_CONTAINER_LIMITS.maximumPathBytes ||
      path.posix.normalize(value) !== value ||
      value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      containsForbiddenControl(value)) {
    fail("PAYLOAD_CONTAINER_PATH_INVALID");
  }
  return value;
}

function containsForbiddenControl(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && ((codePoint >= 1 && codePoint <= 31) || codePoint === 127);
  });
}

function validateSymlinkTarget(entryPath, target) {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0") ||
      path.posix.isAbsolute(target) || target.includes("\\")) {
    fail("PAYLOAD_CONTAINER_SYMLINK_ESCAPE");
  }
  resolveSymlinkTarget(entryPath, target);
}

function resolveSymlinkTarget(entryPath, target) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  if (resolved === "." || resolved === ".." || resolved.startsWith("../") ||
      path.posix.isAbsolute(resolved)) {
    fail("PAYLOAD_CONTAINER_SYMLINK_ESCAPE");
  }
  return validateContainerPath(resolved);
}

function assertMode(type, mode) {
  const valid = type === "directory"
    ? mode === 0o555
    : type === "file"
      ? mode === 0o444 || mode === 0o555
      // Darwin reports symlinks as 0755 and does not expose a portable way to
      // chmod the link itself.  Preserve and verify either platform spelling;
      // both are metadata-only because links are never followed here.
      : mode === 0o755 || mode === 0o777;
  if (!valid) fail("PAYLOAD_CONTAINER_MODE_INVALID");
}

function bindContainerIdentity(stat) {
  const identity = identityReceipt(stat);
  if (!stat.isFile() || stat.isSymbolicLink?.() === true || identity.uid !== currentUid() ||
      identity.mode !== (constants.S_IFREG | 0o600) || identity.nlink !== 1 ||
      !Number.isSafeInteger(identity.size) || identity.size < 0) {
    fail("PAYLOAD_CONTAINER_IDENTITY_INVALID");
  }
  return Object.freeze(identity);
}

function identityReceipt(stat) {
  if (!Number.isSafeInteger(Number(stat.dev)) || !Number.isSafeInteger(Number(stat.ino)) ||
      !Number.isSafeInteger(Number(stat.uid)) || !Number.isSafeInteger(Number(stat.mode)) ||
      !Number.isSafeInteger(Number(stat.nlink)) || !Number.isSafeInteger(Number(stat.size))) {
    fail("PAYLOAD_CONTAINER_IDENTITY_INVALID");
  }
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    uid: Number(stat.uid),
    mode: Number(stat.mode),
    nlink: Number(stat.nlink),
    size: Number(stat.size),
  };
}

function bindContainerMutationStamp(fd) {
  const stat = fstatSync(fd, { bigint: true });
  return Object.freeze({
    ...identityReceipt(stat),
    ctimeNs: typeof stat.ctimeNs === "bigint"
      ? stat.ctimeNs.toString()
      : String(Math.trunc(Number(stat.ctimeMs) * 1_000_000)),
  });
}

function assertSameMutationStamp(before, after) {
  assertSameIdentity(before, after, "PAYLOAD_CONTAINER_RECEIPT_MISMATCH");
  if (before.ctimeNs !== after.ctimeNs) fail("PAYLOAD_CONTAINER_RECEIPT_MISMATCH");
}

function nativeIdentityReceipt(identity) {
  if (!isPlainRecord(identity) || !Number.isSafeInteger(identity.dev) ||
      !Number.isSafeInteger(identity.ino) || !Number.isSafeInteger(identity.uid) ||
      !Number.isSafeInteger(identity.mode) || !Number.isSafeInteger(identity.nlink) ||
      !Number.isSafeInteger(identity.size)) {
    fail("PAYLOAD_CONTAINER_IDENTITY_INVALID");
  }
  return {
    dev: identity.dev,
    ino: identity.ino,
    uid: identity.uid,
    mode: identity.mode,
    nlink: identity.nlink,
    size: identity.size,
  };
}

function assertEntryIdentity(identity) {
  const receipt = nativeIdentityReceipt(identity);
  if (receipt.uid !== currentUid() || receipt.nlink < 1 || receipt.size < 0) {
    fail("PAYLOAD_CONTAINER_IDENTITY_INVALID");
  }
}

function assertSameNativeIdentity(expected, observed, code) {
  statusOk(observed);
  assertSameIdentity(nativeIdentityReceipt(expected), nativeIdentityReceipt(observed), code);
}

function assertOpenedCandidateDirectory(candidate, addon) {
  if (!isPlainRecord(candidate) || !Number.isInteger(candidate.fd) || candidate.fd < 0 ||
      candidate.uid !== currentUid() || (candidate.mode & constants.S_IFMT) !== constants.S_IFDIR) {
    fail("PAYLOAD_CONTAINER_CANDIDATE_INVALID");
  }
  const observed = addon.inspect(candidate.fd);
  statusOk(observed);
  if (observed.dev !== candidate.dev || observed.ino !== candidate.ino ||
      observed.uid !== candidate.uid || observed.mode !== candidate.mode ||
      observed.nlink !== candidate.nlink) {
    fail("PAYLOAD_CONTAINER_CANDIDATE_INVALID");
  }
}

function assertNativeCreatedFile(value, expectedName) {
  if (!isPlainRecord(value) || value.ok !== true || value.name !== expectedName ||
      !Number.isInteger(value.fd) || value.fd < 0 || value.uid !== currentUid() ||
      (value.mode & constants.S_IFMT) !== constants.S_IFREG ||
      (value.mode & 0o777) !== 0o600 || value.nlink !== 1) {
    fail("PAYLOAD_CONTAINER_CREATE_FAILED");
  }
}

function assertCreateInput(input) {
  if (!isPlainRecord(input) || exactKeys(input) !== "addon,name,parentFd" ||
      !Number.isInteger(input.parentFd) || input.parentFd < 0 ||
      typeof input.name !== "string" || input.name.length === 0 || input.name.includes("/") ||
      input.name.includes("\0") || input.name === "." || input.name === ".." ||
      !isPlainRecord(input.addon) || typeof input.addon.createFileAtNoReplace !== "function" ||
      typeof input.addon.fsyncFd !== "function" || typeof input.addon.closeFd !== "function") {
    fail("PAYLOAD_CONTAINER_ARGUMENT_INVALID");
  }
}

function assertPopulateInput(input) {
  if (!isPlainRecord(input) ||
      ![
        "addon,candidate,container",
        "addon,beforePopulationStart,candidate,container",
        "addon,beforePopulationStart,beforeResourceClose,candidate,container",
        "addon,beforeResourceClose,candidate,container",
      ]
        .includes(exactKeys(input)) ||
      !isPlainRecord(input.container) || exactKeys(input.container) !== "fd,identity,name" ||
      !Number.isInteger(input.container.fd) || input.container.fd < 0 ||
      typeof input.container.name !== "string" || !isPlainRecord(input.container.identity) ||
      !isPlainRecord(input.candidate) || !Number.isInteger(input.candidate.fd) ||
      !isPlainRecord(input.addon) || typeof input.addon.inspect !== "function" ||
      typeof input.addon.inspectEntryAtNoFollow !== "function" ||
      typeof input.addon.openDirectoryAtNoFollow !== "function" ||
      typeof input.addon.openReadFileAtNoFollow !== "function" ||
      typeof input.addon.readDirectoryNames !== "function" ||
      typeof input.addon.readLinkAtNoFollow !== "function" ||
      (input.beforePopulationStart !== undefined &&
        typeof input.beforePopulationStart !== "function") ||
      (input.beforeResourceClose !== undefined && typeof input.beforeResourceClose !== "function")) {
    fail("PAYLOAD_CONTAINER_ARGUMENT_INVALID");
  }
}

function assertWriterInput(input) {
  if (!isPlainRecord(input) ||
      !["addon,candidate,name,parentFd", "addon,beforeResourceClose,candidate,name,parentFd"]
        .includes(exactKeys(input)) ||
      !Number.isInteger(input.parentFd) || input.parentFd < 0 ||
      typeof input.name !== "string" || input.name.length === 0 || input.name.includes("/") ||
      input.name.includes("\0") || input.name === "." || input.name === ".." ||
      !isPlainRecord(input.candidate) || !Number.isInteger(input.candidate.fd) ||
      !isPlainRecord(input.addon) || typeof input.addon.createFileAtNoReplace !== "function" ||
      typeof input.addon.inspect !== "function" ||
      typeof input.addon.inspectEntryAtNoFollow !== "function" ||
      typeof input.addon.openDirectoryAtNoFollow !== "function" ||
      typeof input.addon.openReadFileAtNoFollow !== "function" ||
      typeof input.addon.readDirectoryNames !== "function" ||
      typeof input.addon.readLinkAtNoFollow !== "function" ||
      typeof input.addon.closeFd !== "function" ||
      (input.beforeResourceClose !== undefined && typeof input.beforeResourceClose !== "function")) {
    fail("PAYLOAD_CONTAINER_ARGUMENT_INVALID");
  }
}

function assertValidatorInput(input) {
  if (!isPlainRecord(input) || !Number.isInteger(input.fd) || input.fd < 0 ||
      Object.keys(input).some((key) => key !== "fd" && key !== "expectedIdentity")) {
    fail("PAYLOAD_CONTAINER_ARGUMENT_INVALID");
  }
}

function assertMaterializeInput(input) {
  if (!isPlainRecord(input) ||
      ![
        "addon,assertBoundary,beforeMutation,beforeResourceClose,destination,expectedReceipt,fd",
        "addon,assertBoundary,beforeAuthorizationStage,beforeMutation,beforeResourceClose,destination,expectedReceipt,fd",
      ].includes(exactKeys(input)) ||
      !Number.isInteger(input.fd) || input.fd < 0 ||
      !isPlainRecord(input.expectedReceipt) || !isPlainRecord(input.destination) ||
      !isPlainRecord(input.addon) || typeof input.assertBoundary !== "function" ||
      (input.beforeAuthorizationStage !== undefined &&
        typeof input.beforeAuthorizationStage !== "function") ||
      (input.beforeMutation !== undefined && typeof input.beforeMutation !== "function") ||
      (input.beforeResourceClose !== undefined && typeof input.beforeResourceClose !== "function")) {
    fail("PAYLOAD_CONTAINER_ARGUMENT_INVALID");
  }
}

function assertOpenedDirectory(expected, addon, code) {
  if (!Number.isInteger(expected.fd) || expected.fd < 0 ||
      !Number.isSafeInteger(expected.dev) || !Number.isSafeInteger(expected.ino) ||
      expected.uid !== currentUid()) {
    fail(code);
  }
  const observed = addon.inspect(expected.fd);
  statusOk(observed);
  if ((observed.mode & constants.S_IFMT) !== constants.S_IFDIR ||
      observed.dev !== expected.dev || observed.ino !== expected.ino ||
      observed.uid !== expected.uid) {
    fail(code);
  }
}

function bindOpenedDirectory(value, addon) {
  let operationError = null;
  try {
    statusOk(value);
    if (!Number.isInteger(value.fd) || value.fd < 0 ||
        (value.mode & constants.S_IFMT) !== constants.S_IFDIR ||
        value.uid !== currentUid()) {
      fail("PAYLOAD_CONTAINER_DESTINATION_DRIFT");
    }
  } catch (error) {
    operationError = error;
  }
  if (operationError !== null) {
    let closeError = null;
    try {
      if (Number.isInteger(value.fd) && value.fd >= 0) statusOk(addon.closeFd(value.fd));
    } catch (error) {
      closeError = error;
    }
    throw combineErrors(operationError, closeError);
  }
  return Object.freeze({
    fd: value.fd,
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
  });
}

function assertReceiptMatches(expected, observed) {
  const keys = [
    "formatVersion",
    "containerSha256",
    "headerSha256",
    "payloadManifestSha256",
    "runtimeContractVersion",
    "entryCount",
    "size",
  ];
  if (keys.some((key) => expected[key] !== observed[key])) {
    fail("PAYLOAD_CONTAINER_RECEIPT_MISMATCH");
  }
  assertSameIdentity(expected.identity, observed.identity, "PAYLOAD_CONTAINER_RECEIPT_MISMATCH");
}

function statusOk(result) {
  if (!isPlainRecord(result) || result.ok !== true) {
    fail("PAYLOAD_CONTAINER_NATIVE_OPERATION_FAILED");
  }
}

function checkedContainerSize(headerLength, dataLength) {
  const total = prefixSize + headerLength + dataLength;
  if (!Number.isSafeInteger(total) || total > PAYLOAD_CONTAINER_LIMITS.maximumContainerBytes) {
    fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
  }
  return total;
}

function readExact(fd, length, position) {
  if (!Number.isSafeInteger(length) || length < 0 ||
      length > PAYLOAD_CONTAINER_LIMITS.maximumContainerBytes) {
    fail("PAYLOAD_CONTAINER_LIMIT_EXCEEDED");
  }
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, position + offset);
    if (count <= 0) fail("PAYLOAD_CONTAINER_TRUNCATED");
    offset += count;
  }
  return buffer;
}

function writeExact(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (count <= 0) fail("PAYLOAD_CONTAINER_WRITE_FAILED");
    offset += count;
  }
}

function hashFdRange(fd, position, length) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < length) {
    const requested = Math.min(buffer.length, length - offset);
    const count = readSync(fd, buffer, 0, requested, position + offset);
    if (count <= 0) fail("PAYLOAD_CONTAINER_TRUNCATED");
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest("hex");
}

function assertSameIdentity(before, after, code) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid ||
      before.mode !== after.mode || before.nlink !== after.nlink || before.size !== after.size) {
    fail(code);
  }
}

function assertSameObjectIdentity(before, after, code) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid ||
      before.mode !== after.mode || before.nlink !== after.nlink) {
    fail(code);
  }
}

function exactKeys(value) {
  return Reflect.ownKeys(value).map(String).sort(compareUtf8).join(",");
}

function caseFoldKey(value) {
  return unicodeFullCaseFold(value);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function currentUid() {
  if (typeof process.getuid !== "function") fail("PAYLOAD_CONTAINER_OWNER_UNVERIFIED");
  return process.getuid();
}

function fail(code) {
  throw new Error(code);
}

function combineErrors(...errors) {
  const present = errors.filter((error) => error !== null && error !== undefined);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, "PAYLOAD_CONTAINER_RESOURCE_FAILURE");
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
