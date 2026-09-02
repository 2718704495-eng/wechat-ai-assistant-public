#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runReleaseCliSession } from "./release-cli-session.mjs";
import {
  installValidatedCandidate,
  recoverReleaseTransaction,
  rollbackValidatedRelease,
} from "./release-manager.mjs";
import {
  buildReleasePayload,
  cleanBuildAuthoritativeSource,
  validateReleasePayload,
} from "./release-payload.mjs";

export async function runReleaseCli(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const configuredHome = options.home ?? process.env.HOME;
  if (
    typeof configuredHome !== "string"
    || configuredHome.length === 0
    || configuredHome.includes("\0")
    || !path.isAbsolute(configuredHome)
  ) {
    throw new Error("RELEASE_HOME_REQUIRED");
  }
  const home = path.resolve(configuredHome);
  const now = options.now ?? (() => new Date());
  const [command, ...argumentTokens] = argv;
  if (typeof command !== "string") throw new Error("RELEASE_COMMAND_REQUIRED");
  const arguments_ = parseArguments(argumentTokens);

  if (command === "package") {
    assertExactArgumentNames(arguments_, ["payload-root", "source-root", "work-root"]);
    const sourceRoot = requireAbsoluteArgument(arguments_, "source-root");
    const sourceLineage = await cleanBuildAuthoritativeSource({ sourceRoot });
    const result = await buildReleasePayload({
      sourceRoot,
      payloadRoot: requireAbsoluteArgument(arguments_, "payload-root"),
      workRoot: requireAbsoluteArgument(arguments_, "work-root"),
    }, {}, sourceLineage);
    await writeResult(output, command, result);
    return result;
  }

  if (command === "validate") {
    assertExactArgumentNames(arguments_, ["payload-root"]);
    const result = await validateReleasePayload({
      payloadRoot: requireAbsoluteArgument(arguments_, "payload-root"),
    });
    await writeResult(output, command, result);
    return result;
  }

  if (command !== "install" && command !== "rollback" && command !== "recover") {
    throw new Error("RELEASE_COMMAND_INVALID");
  }

  const expectedNames = command === "install"
    ? ["candidate", "runtime-root"]
    : ["runtime-root"];
  assertExactArgumentNames(arguments_, expectedNames);
  const runtimeRoot = requireAbsoluteArgument(arguments_, "runtime-root");
  const expectedRuntimeRoot = path.join(home, "Desktop", "聊天助手");
  if (runtimeRoot !== expectedRuntimeRoot) throw new Error("DESTINATION_NOT_ALLOWED");
  const candidateRoot = command === "install"
    ? requireAbsoluteArgument(arguments_, "candidate")
    : null;
  if (candidateRoot !== null) {
    assertControlledStagingCandidate(runtimeRoot, candidateRoot);
  }
  const validateRelease = (releaseRoot) => validateReleasePayload({ payloadRoot: releaseRoot });

  const result = await runReleaseCliSession({
    input,
    output,
    operation: ({ readDecision }) => {
      const common = {
        runtimeRoot,
        automationId: "automation",
        now,
        validateRelease,
        readDecision: (request) => readDecision(automationRequest(request)),
      };
      if (command === "install") {
        return installValidatedCandidate({
          ...common,
          candidateRoot,
        });
      }
      if (command === "recover") return recoverReleaseTransaction(common);
      return rollbackValidatedRelease(common);
    },
  });
  await writeResult(output, command, result);
  return result;
}

function assertControlledStagingCandidate(runtimeRoot, candidateRoot) {
  const releaseStore = path.join(runtimeRoot, ".releases");
  const relative = path.relative(releaseStore, candidateRoot);
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
}

function automationRequest(request) {
  return Object.freeze({
    type: "automation-observation-request",
    phase: request.op,
    txid: request.txid,
    maintenanceNonce: request.maintenanceNonce,
    automationId: "automation",
    requestId: request.requestId,
    observationId: request.observationId,
    requestedAt: request.requestedAt,
  });
}

function parseArguments(tokens) {
  const result = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (
      typeof name !== "string"
      || !/^--[a-z][a-z-]*$/u.test(name)
      || typeof value !== "string"
      || value.length === 0
      || result.has(name.slice(2))
    ) {
      throw new Error("RELEASE_ARGUMENT_INVALID");
    }
    result.set(name.slice(2), value);
  }
  return result;
}

function assertExactArgumentNames(arguments_, expected) {
  const actual = [...arguments_.keys()].sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((name, index) => name !== sortedExpected[index])
  ) {
    throw new Error("RELEASE_ARGUMENT_INVALID");
  }
}

function requireAbsoluteArgument(arguments_, name) {
  const value = arguments_.get(name);
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("RELEASE_ARGUMENT_INVALID");
  }
  return path.resolve(value);
}

async function writeResult(output, command, result) {
  const serialized = `${JSON.stringify({
    type: "release-result",
    command,
    ok: true,
    result,
  })}\n`;
  if (!output.write(serialized, "utf8")) {
    await new Promise((resolve) => output.once("drain", resolve));
  }
}

async function main() {
  try {
    await runReleaseCli();
  } catch (error) {
    const code = error instanceof Error ? error.message : "RELEASE_UNKNOWN_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
