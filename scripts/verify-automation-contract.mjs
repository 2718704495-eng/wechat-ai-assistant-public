import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumFixtureBytes = 128 * 1024;
const runtimeRoot = "/Users/example/Desktop/聊天助手/runtime-v2";
const requiredConfigTarget = "../current/config/automation-restricted.config.toml";
const requiredAutomation = Object.freeze({
  id: "automation",
  status: "PAUSED",
  kind: "heartbeat",
  rrule: "FREQ=MINUTELY;INTERVAL=10",
  notificationPolicy: "failed_runs_only",
});
const requiredDisabledFeatures = Object.freeze([
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
]);
const requiredSupervisorTools = Object.freeze([
  "abort-draft",
  "begin-scheduled-tick",
  "close",
  "prepare-broadcast",
  "prepare-latest-reply",
  "research-morning-weather",
  "show-comfort-station",
  "submit-authorized-broadcast",
  "submit-authorized-draft",
  "verify-draft",
  "verify-send",
]);
const requiredCallableTools = Object.freeze([
  ...requiredSupervisorTools.map((name) => `mcp__chat-assistant-supervisor__${name}`),
  "mcp__official-research__research_latest_trigger",
]);

export function verifyAutomationContract(observed, expected) {
  const canonicalExpected = canonicalContract(expected);
  let canonicalObserved;
  try {
    canonicalObserved = canonicalContract(observed);
  } catch {
    throw new Error("AUTOMATION_CONTRACT_MISMATCH");
  }
  if (JSON.stringify(canonicalObserved) !== JSON.stringify(canonicalExpected)) {
    throw new Error("AUTOMATION_CONTRACT_MISMATCH");
  }

  return {
    schemaVersion: 1,
    status: "verified",
    automationId: canonicalObserved.automation.id,
    promptSha256: canonicalObserved.automation.promptSha256,
    configSha256: canonicalObserved.config.sha256,
    releaseManifestSha256: canonicalObserved.release.manifestSha256,
    releaseRealpath: canonicalObserved.release.realpath,
  };
}

export function verifyWechatAutomationExclusivity(observed, phase) {
  const requiredIds = ["automation", "22", "22-00"];
  if (!Array.isArray(observed) || observed.length !== requiredIds.length ||
      (phase !== "all-paused" && phase !== "unified-active")) {
    throw new Error("AUTOMATION_EXCLUSIVITY_INVALID");
  }
  const statuses = new Map();
  for (const entry of observed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "id,status" ||
        !requiredIds.includes(entry.id) ||
        (entry.status !== "ACTIVE" && entry.status !== "PAUSED") ||
        statuses.has(entry.id)) {
      throw new Error("AUTOMATION_EXCLUSIVITY_INVALID");
    }
    statuses.set(entry.id, entry.status);
  }
  if (requiredIds.some((id) => !statuses.has(id)) ||
      statuses.get("22") !== "PAUSED" || statuses.get("22-00") !== "PAUSED" ||
      statuses.get("automation") !== (phase === "all-paused" ? "PAUSED" : "ACTIVE")) {
    throw new Error("AUTOMATION_EXCLUSIVITY_INVALID");
  }
  return {
    status: "verified",
    phase,
    activeAutomationId: phase === "unified-active" ? "automation" : null,
  };
}

export async function verifyInstalledAutomationContract(observed, expected) {
  const receipt = verifyAutomationContract(observed, expected);
  const canonical = canonicalContract(observed);
  try {
    const configPath = path.join(runtimeRoot, ".codex", "config.toml");
    const binPath = path.join(runtimeRoot, "current");
    const [configIdentity, configTarget, releasePath] = await Promise.all([
      lstat(configPath),
      readlink(configPath),
      realpath(binPath),
    ]);
    if (!configIdentity.isSymbolicLink() || configTarget !== requiredConfigTarget) {
      throw new Error("CONFIG_LINK_INVALID");
    }
    if (releasePath !== canonical.release.realpath) throw new Error("RELEASE_POINTER_INVALID");

    const releaseIdentity = await lstat(releasePath);
    if (
      !releaseIdentity.isDirectory()
      || releaseIdentity.isSymbolicLink()
      || (releaseIdentity.mode & 0o777) !== 0o555
    ) {
      throw new Error("RELEASE_IDENTITY_INVALID");
    }
    const { validatePayloadManifest } = await import("./release-payload.mjs");
    const validatedManifest = await validatePayloadManifest({ payloadRoot: releasePath });
    if (validatedManifest.manifestSha256 !== canonical.release.manifestSha256) {
      throw new Error("MANIFEST_IDENTITY_INVALID");
    }

    const configRealpath = await realpath(configPath);
    if (configRealpath !== path.join(releasePath, "config", "automation-restricted.config.toml")) {
      throw new Error("CONFIG_REALPATH_INVALID");
    }
    const manifestSha = (await readBoundedFile(
      path.join(releasePath, "payload-manifest.sha256"),
    )).toString("utf8");
    if (manifestSha !== `${canonical.release.manifestSha256}\n`) {
      throw new Error("MANIFEST_IDENTITY_INVALID");
    }

    const promptPath = path.join(releasePath, "prompts", "automation-single-scheduler-v1.md");
    const [configBytes, promptBytes, configPayloadIdentity, promptIdentity] = await Promise.all([
      readBoundedFile(configRealpath),
      readBoundedFile(promptPath),
      lstat(configRealpath),
      lstat(promptPath),
    ]);
    if (
      !configPayloadIdentity.isFile()
      || configPayloadIdentity.isSymbolicLink()
      || (configPayloadIdentity.mode & 0o777) !== 0o444
      || !promptIdentity.isFile()
      || promptIdentity.isSymbolicLink()
      || (promptIdentity.mode & 0o777) !== 0o444
    ) {
      throw new Error("AUTOMATION_PAYLOAD_MODE_INVALID");
    }
    if (sha256(configBytes) !== canonical.config.sha256) throw new Error("CONFIG_HASH_INVALID");
    if (canonicalAutomationPromptSha256(promptBytes) !== canonical.automation.promptSha256) {
      throw new Error("PROMPT_HASH_INVALID");
    }

    for (const server of canonical.capabilities.mcpServers) {
      const stableCommand = path.join(runtimeRoot, "current", "bin", server.id === "official-research"
        ? "official-research"
        : "chat-assistant-supervisor");
      const [commandRealpath, commandIdentity] = await Promise.all([
        realpath(stableCommand),
        lstat(server.commandRealpath),
      ]);
      if (
        commandRealpath !== server.commandRealpath
        || !commandIdentity.isFile()
        || commandIdentity.isSymbolicLink()
        || (commandIdentity.mode & 0o777) !== 0o555
      ) {
        throw new Error("MCP_COMMAND_IDENTITY_INVALID");
      }
    }
    return receipt;
  } catch (error) {
    throw new Error("AUTOMATION_CONTRACT_FILESYSTEM_MISMATCH", { cause: error });
  }
}

function canonicalContract(value) {
  assertPlainObject(value);
  assertExactKeys(value, ["schemaVersion", "automation", "config", "release", "capabilities"]);
  if (value.schemaVersion !== 1) throw new Error("AUTOMATION_CONTRACT_INVALID");

  const automation = canonicalAutomation(value.automation);
  const config = canonicalConfig(value.config);
  const release = canonicalRelease(value.release);
  const capabilities = canonicalCapabilities(value.capabilities, release);
  return { schemaVersion: 1, automation, config, release, capabilities };
}

function canonicalAutomation(value) {
  assertPlainObject(value);
  assertExactKeys(value, [
    "id",
    "status",
    "kind",
    "targetThreadId",
    "rrule",
    "notificationPolicy",
    "promptSha256",
  ]);
  for (const key of Object.keys(value)) assertNonEmptyString(value[key]);
  if (!sha256Pattern.test(value.promptSha256) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
        .test(value.targetThreadId)) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
  for (const [key, expectedValue] of Object.entries(requiredAutomation)) {
    if (value[key] !== expectedValue) throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
  return { ...value };
}

function canonicalConfig(value) {
  assertPlainObject(value);
  assertExactKeys(value, ["lstatType", "relativeTarget", "sha256"]);
  assertNonEmptyString(value.lstatType);
  assertNonEmptyString(value.relativeTarget);
  if (
    value.lstatType !== "symlink"
    || value.relativeTarget !== requiredConfigTarget
    || !isSafeRelativePath(value.relativeTarget)
  ) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
  if (!sha256Pattern.test(value.sha256)) throw new Error("AUTOMATION_CONTRACT_INVALID");
  return { ...value };
}

function canonicalRelease(value) {
  assertPlainObject(value);
  assertExactKeys(value, ["realpath", "version", "manifestSha256"]);
  assertNonEmptyString(value.realpath);
  assertNonEmptyString(value.version);
  const releaseNameMatch = /^release-([a-f0-9]{16})-[a-f0-9]{8}-[a-f0-9]{4}-[4][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
    .exec(value.version);
  if (
    !sha256Pattern.test(value.manifestSha256)
    || releaseNameMatch === null
    || releaseNameMatch[1] !== value.manifestSha256.slice(0, 16)
    || value.realpath !== path.join(runtimeRoot, ".releases", value.version)
  ) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
  return { ...value };
}

function canonicalCapabilities(value, release) {
  assertPlainObject(value);
  assertExactKeys(value, [
    "executionPolicy",
    "disabledFeatures",
    "callableTools",
    "mcpServers",
  ]);
  if (
    !Array.isArray(value.disabledFeatures)
    || !Array.isArray(value.callableTools)
    || !Array.isArray(value.mcpServers)
  ) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }

  const disabledFeatures = sortedUniqueStrings(value.disabledFeatures);
  const callableTools = sortedUniqueStrings(value.callableTools);
  if (
    JSON.stringify(disabledFeatures) !== JSON.stringify([...requiredDisabledFeatures].sort())
    || JSON.stringify(callableTools) !== JSON.stringify([...requiredCallableTools].sort())
  ) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
  const executionPolicy = canonicalExecutionPolicy(value.executionPolicy);
  const mcpServers = value.mcpServers.map((server) => {
    assertPlainObject(server);
    assertExactKeys(server, ["id", "commandRealpath", "required", "enabledTools"]);
    assertNonEmptyString(server.id);
    assertNonEmptyString(server.commandRealpath);
    if (server.required !== true) throw new Error("AUTOMATION_CONTRACT_INVALID");
    return {
      id: server.id,
      commandRealpath: server.commandRealpath,
      required: true,
      enabledTools: sortedUniqueStrings(server.enabledTools),
    };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (new Set(mcpServers.map((server) => server.id)).size !== mcpServers.length) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
  const expectedServers = [
    {
      id: "chat-assistant-supervisor",
      commandRealpath: path.join(release.realpath, "bin", "chat-assistant-supervisor"),
      required: true,
      enabledTools: [...requiredSupervisorTools].sort(),
    },
    {
      id: "official-research",
      commandRealpath: path.join(release.realpath, "bin", "official-research"),
      required: true,
      enabledTools: ["research_latest_trigger"],
    },
  ];
  if (JSON.stringify(mcpServers) !== JSON.stringify(expectedServers)) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
  return { executionPolicy, disabledFeatures, callableTools, mcpServers };
}

function canonicalExecutionPolicy(value) {
  assertPlainObject(value);
  assertExactKeys(value, [
    "approvalPolicy",
    "sandboxMode",
    "webSearch",
    "commandNetwork",
    "filesystemWriteRoots",
  ]);
  if (
    value.approvalPolicy !== "never"
    || value.sandboxMode !== "read-only"
    || value.webSearch !== "disabled"
    || value.commandNetwork !== false
    || !Array.isArray(value.filesystemWriteRoots)
    || value.filesystemWriteRoots.length !== 0
  ) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
  return {
    approvalPolicy: "never",
    sandboxMode: "read-only",
    webSearch: "disabled",
    commandNetwork: false,
    filesystemWriteRoots: [],
  };
}

function sortedUniqueStrings(value) {
  if (!Array.isArray(value)) throw new Error("AUTOMATION_CONTRACT_INVALID");
  for (const item of value) assertNonEmptyString(item);
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw new Error("AUTOMATION_CONTRACT_INVALID");
  return unique.sort((left, right) => left.localeCompare(right, "en"));
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
}

function assertExactKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
}

function assertNonEmptyString(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("AUTOMATION_CONTRACT_INVALID");
  }
}

function isSafeRelativePath(value) {
  if (value.startsWith("/") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.length > 1
    && segments[0] === ".."
    && segments.slice(1).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

async function readJsonFixture(path) {
  const raw = await readFile(path);
  if (raw.byteLength === 0 || raw.byteLength > maximumFixtureBytes) {
    throw new Error("AUTOMATION_CONTRACT_FIXTURE_INVALID");
  }
  return JSON.parse(raw.toString("utf8"));
}

async function readBoundedFile(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.byteLength === 0 || bytes.byteLength > maximumFixtureBytes) {
    throw new Error("AUTOMATION_CONTRACT_FILE_INVALID");
  }
  return bytes;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalAutomationPromptSha256(value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const canonical = bytes.at(-1) === 0x0a ? bytes.subarray(0, -1) : bytes;
  if (canonical.byteLength === 0) throw new Error("AUTOMATION_PROMPT_INVALID");
  return sha256(canonical);
}

async function main() {
  if (process.argv.length !== 4) throw new Error("AUTOMATION_CONTRACT_ARGUMENTS_INVALID");
  const observed = await readJsonFixture(process.argv[2]);
  const expected = await readJsonFixture(process.argv[3]);
  process.stdout.write(`${JSON.stringify(
    await verifyInstalledAutomationContract(observed, expected),
  )}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const code = error instanceof Error ? error.message : "AUTOMATION_CONTRACT_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
