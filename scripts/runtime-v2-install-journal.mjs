import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { fstatSync, fsyncSync, readSync, writeSync } from "node:fs";

export const INSTALL_PHASES = Object.freeze([
  "intent-recorded",
  "container-created",
  "population-started",
  "container-validated",
  "gates-held",
  "materialized",
  "release-validated",
  "ready-to-link",
  "current-published",
  "complete",
  "error",
]);

const linearPhases = INSTALL_PHASES.slice(0, -1);
const digestPattern = /^[a-f0-9]{64}$/u;
const txidPattern = /^[a-z0-9-]{16,128}$/u;

export async function appendInstallPhase(input) {
  assertAppendInput(input);
  const existing = readAll(input.fd);
  const observed = existing.length === 0 ? null : parseInstallJournal(existing);
  assertPreviousMatches(input.previous, observed);
  const nextSequence = observed === null ? 1 : observed.sequence + 1;
  assertTransition(observed?.phase ?? null, input.phase);
  const body = {
    facts: normalizeJson(input.facts),
    phase: input.phase,
    previousRecordSha256: observed?.recordSha256 ?? null,
    sequence: nextSequence,
    txid: input.txid,
    version: 1,
  };
  const recordSha256 = sha256(canonicalBytes(body));
  const record = { ...body, recordSha256 };
  const bytes = canonicalBytes(record);
  writeExact(input.fd, bytes, existing.length);
  fsyncSync(input.fd);
  return freezeState(record);
}

export function parseInstallJournal(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) fail("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
  const lines = bytes.toString("utf8").split("\n");
  lines.pop();
  let previous = null;
  for (const serialized of lines) {
    if (serialized.length === 0) fail("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
    let record;
    try {
      record = JSON.parse(serialized);
    } catch (error) {
      throw new Error("RUNTIME_V2_INSTALL_JOURNAL_INVALID", { cause: error });
    }
    validateRecord(record, previous);
    previous = record;
  }
  if (previous === null) fail("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
  return freezeState(previous);
}

function validateRecord(record, previous) {
  if (!isRecord(record) || exactKeys(record) !==
      "facts,phase,previousRecordSha256,recordSha256,sequence,txid,version" ||
      record.version !== 1 || !txidPattern.test(record.txid) ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
      !INSTALL_PHASES.includes(record.phase) || !isRecord(record.facts) ||
      !digestPattern.test(record.recordSha256) ||
      (record.previousRecordSha256 !== null && !digestPattern.test(record.previousRecordSha256))) {
    fail("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
  }
  const body = {
    facts: record.facts,
    phase: record.phase,
    previousRecordSha256: record.previousRecordSha256,
    sequence: record.sequence,
    txid: record.txid,
    version: record.version,
  };
  if (!canonicalBytes(record).equals(Buffer.from(`${JSON.stringify(normalizeJson(record))}\n`)) ||
      sha256(canonicalBytes(body)) !== record.recordSha256 ||
      record.sequence !== (previous === null ? 1 : previous.sequence + 1) ||
      record.txid !== (previous?.txid ?? record.txid) ||
      record.previousRecordSha256 !== (previous?.recordSha256 ?? null)) {
    fail("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
  }
  try {
    assertTransition(previous?.phase ?? null, record.phase);
  } catch (error) {
    throw new Error("RUNTIME_V2_INSTALL_JOURNAL_INVALID", { cause: error });
  }
}

function assertTransition(previous, next) {
  if (next === "error") {
    if (previous === null || previous === "complete" || previous === "error") {
      fail("RUNTIME_V2_INSTALL_PHASE_INVALID");
    }
    return;
  }
  const expected = previous === null
    ? linearPhases[0]
    : linearPhases[linearPhases.indexOf(previous) + 1];
  if (next !== expected) fail("RUNTIME_V2_INSTALL_PHASE_INVALID");
}

function assertAppendInput(input) {
  if (!isRecord(input) || exactKeys(input) !== "facts,fd,phase,previous,txid" ||
      !Number.isInteger(input.fd) || input.fd < 0 || !txidPattern.test(input.txid) ||
      !INSTALL_PHASES.includes(input.phase) || !isRecord(input.facts) ||
      (input.previous !== null && !isState(input.previous))) {
    fail("RUNTIME_V2_INSTALL_JOURNAL_ARGUMENT_INVALID");
  }
}

function assertPreviousMatches(expected, observed) {
  if (expected === null || observed === null) {
    if (expected !== observed) fail("RUNTIME_V2_INSTALL_JOURNAL_STALE");
    return;
  }
  if (expected.txid !== observed.txid || expected.sequence !== observed.sequence ||
      expected.phase !== observed.phase || expected.recordSha256 !== observed.recordSha256) {
    fail("RUNTIME_V2_INSTALL_JOURNAL_STALE");
  }
}

function isState(value) {
  return isRecord(value) && txidPattern.test(value.txid) &&
    Number.isSafeInteger(value.sequence) && INSTALL_PHASES.includes(value.phase) &&
    digestPattern.test(value.recordSha256);
}

function freezeState(record) {
  return Object.freeze({
    txid: record.txid,
    sequence: record.sequence,
    phase: record.phase,
    recordSha256: record.recordSha256,
    facts: deepFreeze(normalizeJson(record.facts)),
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function readAll(fd) {
  const identity = fstatSync(fd);
  if (!identity.isFile() || identity.size < 0 || identity.size > 16 * 1024 * 1024) {
    fail("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
  }
  const bytes = Buffer.alloc(identity.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) fail("RUNTIME_V2_INSTALL_JOURNAL_INVALID");
    offset += count;
  }
  return bytes;
}

function writeExact(fd, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, position + offset);
    if (count <= 0) fail("RUNTIME_V2_INSTALL_JOURNAL_WRITE_FAILED");
    offset += count;
  }
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(normalizeJson(value))}\n`);
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJson(value[key])]));
}

function exactKeys(value) {
  return Reflect.ownKeys(value).map(String).sort().join(",");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code) {
  throw new Error(code);
}
