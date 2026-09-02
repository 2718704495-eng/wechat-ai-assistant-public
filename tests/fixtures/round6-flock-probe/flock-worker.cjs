"use strict";
/* global process */

const { constants } = require("node:fs");
const { open } = require("node:fs/promises");

async function readReleaseCommand() {
  for await (const chunk of process.stdin) {
    if (chunk.toString("utf8").trim() === "release") return;
    throw new Error("ROUND6_WORKER_PROTOCOL_INVALID");
  }
  throw new Error("ROUND6_WORKER_RELEASE_MISSING");
}

async function main() {
  const [addonPath, targetPath, kind] = process.argv.slice(2);
  if (typeof addonPath !== "string" || typeof targetPath !== "string" ||
      !["regular", "directory"].includes(kind)) {
    throw new Error("ROUND6_WORKER_ARGUMENTS_INVALID");
  }
  const addon = require(addonPath);
  const flags = kind === "directory"
    ? constants.O_RDONLY | constants.O_DIRECTORY
    : constants.O_RDWR | constants.O_NOFOLLOW;
  const handle = await open(targetPath, flags);
  try {
    const identity = addon.inspect(handle.fd);
    const lock = addon.lockExclusiveNonblocking(handle.fd);
    process.stdout.write(`${JSON.stringify({ type: "attempt", identity, lock })}\n`);
    if (!lock.ok) return;
    await readReleaseCommand();
    const unlock = addon.unlock(handle.fd);
    if (!unlock.ok) throw new Error(`ROUND6_WORKER_UNLOCK_FAILED:${unlock.errno}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    stage: "worker-failed",
    code: error && typeof error === "object" ? error.code ?? null : null,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  })}\n`);
  process.exitCode = 1;
});
