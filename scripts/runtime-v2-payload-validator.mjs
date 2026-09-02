#!/usr/bin/env node

import { Buffer } from "node:buffer";
import process from "node:process";

import { validateReleasePayload } from "./release-payload.mjs";

const maximumRequestBytes = 16 * 1024;

try {
  const request = await readRequest();
  const result = await validateReleasePayload({ payloadRoot: request.payloadRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error instanceof Error && /^RELEASE_[A-Z0-9_]+$/u.test(error.message)
    ? error.message
    : "RELEASE_VALIDATION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) throw new Error("RELEASE_VALIDATION_REQUEST_INVALID");
    chunks.push(buffer);
  }
  const serialized = Buffer.concat(chunks).toString("utf8");
  if (!serialized.endsWith("\n") || serialized.slice(0, -1).includes("\n")) {
    throw new Error("RELEASE_VALIDATION_REQUEST_INVALID");
  }
  let value;
  try {
    value = JSON.parse(serialized.slice(0, -1));
  } catch {
    throw new Error("RELEASE_VALIDATION_REQUEST_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 1 || typeof value.payloadRoot !== "string") {
    throw new Error("RELEASE_VALIDATION_REQUEST_INVALID");
  }
  return value;
}
