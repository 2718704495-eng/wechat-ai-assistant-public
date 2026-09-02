import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  canonicalAutomationPromptSha256,
  verifyAutomationContract,
  verifyWechatAutomationExclusivity,
  type AutomationContractExpectation,
  type AutomationContractObservation,
} from "../../scripts/verify-automation-contract.mjs";

const prompt = "只运行高层微信回复 supervisor；失败时安全退出。";
const promptHash = canonicalAutomationPromptSha256(prompt);
const configHash = sha256("restricted-config");
const manifestHash = sha256("release-manifest");
const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const releaseVersion = `release-${manifestHash.slice(0, 16)}-11111111-1111-4111-8111-111111111111`;
const releaseRealpath = `/Users/example/Desktop/聊天助手/runtime-v2/.releases/${releaseVersion}`;
const targetThreadId = "01a0519d-6da0-7443-b252-9f6c947f9527";
const disabledFeatures = [
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
];
const callableTools = [
  "mcp__chat-assistant-supervisor__abort-draft",
  "mcp__chat-assistant-supervisor__begin-scheduled-tick",
  "mcp__chat-assistant-supervisor__close",
  "mcp__chat-assistant-supervisor__prepare-broadcast",
  "mcp__chat-assistant-supervisor__prepare-latest-reply",
  "mcp__chat-assistant-supervisor__research-morning-weather",
  "mcp__chat-assistant-supervisor__show-comfort-station",
  "mcp__chat-assistant-supervisor__submit-authorized-broadcast",
  "mcp__chat-assistant-supervisor__submit-authorized-draft",
  "mcp__chat-assistant-supervisor__verify-draft",
  "mcp__chat-assistant-supervisor__verify-send",
  "mcp__official-research__research_latest_trigger",
];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

function expectation(): AutomationContractExpectation {
  return {
    schemaVersion: 1,
    automation: {
      id: "automation",
      status: "PAUSED",
      kind: "heartbeat",
      targetThreadId,
      rrule: "FREQ=MINUTELY;INTERVAL=10",
      notificationPolicy: "failed_runs_only",
      promptSha256: promptHash,
    },
    config: {
      lstatType: "symlink",
      relativeTarget: "../current/config/automation-restricted.config.toml",
      sha256: configHash,
    },
    release: {
      realpath: releaseRealpath,
      version: releaseVersion,
      manifestSha256: manifestHash,
    },
    capabilities: {
      executionPolicy: {
        approvalPolicy: "never",
        sandboxMode: "read-only",
        webSearch: "disabled",
        commandNetwork: false,
        filesystemWriteRoots: [],
      },
      disabledFeatures,
      callableTools,
      mcpServers: [
        {
          id: "chat-assistant-supervisor",
          commandRealpath: `${releaseRealpath}/bin/chat-assistant-supervisor`,
          required: true,
          enabledTools: [
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
          ],
        },
        {
          id: "official-research",
          commandRealpath: `${releaseRealpath}/bin/official-research`,
          required: true,
          enabledTools: ["research_latest_trigger"],
        },
      ],
    },
  };
}

function observation(): AutomationContractObservation {
  const expected = expectation();
  return structuredClone(expected);
}

describe("automation contract verifier", () => {
  test("canonicalizes only the single terminal LF removed by the automation API", () => {
    expect(canonicalAutomationPromptSha256(`${prompt}\n`)).toBe(promptHash);
    expect(canonicalAutomationPromptSha256(`${prompt}\n\n`)).not.toBe(promptHash);
    expect(canonicalAutomationPromptSha256(`${prompt} `)).not.toBe(promptHash);
  });

  test("accepts only break-before-make and unique unified-active WeChat states", () => {
    const paused = [
      { id: "automation", status: "PAUSED" },
      { id: "22", status: "PAUSED" },
      { id: "22-00", status: "PAUSED" },
    ] as const;
    expect(verifyWechatAutomationExclusivity(paused, "all-paused")).toEqual({
      status: "verified", phase: "all-paused", activeAutomationId: null,
    });
    expect(verifyWechatAutomationExclusivity([
      { id: "automation", status: "ACTIVE" },
      { id: "22", status: "PAUSED" },
      { id: "22-00", status: "PAUSED" },
    ], "unified-active")).toEqual({
      status: "verified", phase: "unified-active", activeAutomationId: "automation",
    });
  });

  test.each([
    ["legacy remains active", [
      { id: "automation", status: "ACTIVE" },
      { id: "22", status: "ACTIVE" },
      { id: "22-00", status: "PAUSED" },
    ]],
    ["both legacy tasks remain active", [
      { id: "automation", status: "PAUSED" },
      { id: "22", status: "ACTIVE" },
      { id: "22-00", status: "ACTIVE" },
    ]],
    ["duplicate unified record", [
      { id: "automation", status: "ACTIVE" },
      { id: "automation", status: "PAUSED" },
      { id: "22-00", status: "PAUSED" },
    ]],
    ["missing legacy record", [
      { id: "automation", status: "ACTIVE" },
      { id: "22", status: "PAUSED" },
    ]],
  ] as const)("rejects %s without relying on runtime lock contention", (_name, observed) => {
    expect(() => verifyWechatAutomationExclusivity(observed, "unified-active"))
      .toThrow("AUTOMATION_EXCLUSIVITY_INVALID");
  });

  test("accepts the exact paused standalone automation and immutable capability identity", () => {
    expect(verifyAutomationContract(observation(), expectation())).toEqual({
      schemaVersion: 1,
      status: "verified",
      automationId: "automation",
      promptSha256: promptHash,
      configSha256: configHash,
      releaseManifestSha256: manifestHash,
      releaseRealpath,
    });
  });

  test.each([
    ["missing provider release prefix",
      `${manifestHash.slice(0, 16)}-11111111-1111-4111-8111-111111111111`],
    ["manifest prefix drift",
      `release-${"0".repeat(16)}-11111111-1111-4111-8111-111111111111`],
  ])("rejects %s even when caller-colluded fixtures agree", (_name, version) => {
    const observed = observation();
    observed.release.version = version;
    observed.release.realpath = `/Users/example/Desktop/聊天助手/runtime-v2/.releases/${version}`;
    for (const server of observed.capabilities.mcpServers) {
      server.commandRealpath = `${observed.release.realpath}/bin/${server.id}`;
    }
    expect(() => verifyAutomationContract(observed, structuredClone(observed)))
      .toThrow("AUTOMATION_CONTRACT_INVALID");
  });

  test.each([
    ["active automation", (value: AutomationContractObservation) => { value.automation.status = "ACTIVE"; }],
    ["wrong target task", (value: AutomationContractObservation) => { value.automation.targetThreadId = "other"; }],
    ["prompt drift", (value: AutomationContractObservation) => { value.automation.promptSha256 = sha256("drift"); }],
    ["mutable config", (value: AutomationContractObservation) => { value.config.lstatType = "file"; }],
    ["config target drift", (value: AutomationContractObservation) => { value.config.relativeTarget = "../../mutable.toml"; }],
  ])("fails closed on %s", (_name, mutate) => {
    const observed = observation();
    mutate(observed);
    expect(() => verifyAutomationContract(observed, expectation())).toThrow(
      /AUTOMATION_CONTRACT_MISMATCH/u,
    );
  });

  test("rejects a manifest digest that no longer binds the release basename", () => {
    const observed = observation();
    observed.release.manifestSha256 = sha256("drift");
    expect(() => verifyAutomationContract(observed, structuredClone(observed)))
      .toThrow("AUTOMATION_CONTRACT_INVALID");
  });

  test("rejects any extra enabled MCP server or tool", () => {
    const extraServer = observation();
    extraServer.capabilities.mcpServers.push({
      id: "wechat-history",
      commandRealpath: "/tmp/history",
      required: true,
      enabledTools: ["read_history"],
    });
    expect(() => verifyAutomationContract(extraServer, expectation())).toThrow(
      /AUTOMATION_CONTRACT_MISMATCH/u,
    );

    const extraTool = observation();
    extraTool.capabilities.mcpServers[1]?.enabledTools.push("arbitrary_query");
    expect(() => verifyAutomationContract(extraTool, expectation())).toThrow(
      /AUTOMATION_CONTRACT_MISMATCH/u,
    );
  });

  test("rejects caller-colluded mutable paths even when observed equals expected", () => {
    const observed = observation();
    observed.release.realpath = "/tmp/mutable-release";
    observed.release.version = "mutable-release";
    observed.config.relativeTarget = "../evil.toml";
    observed.capabilities.mcpServers[0]!.commandRealpath = "/tmp/evil";

    expect(() => verifyAutomationContract(observed, structuredClone(observed)))
      .toThrow(/AUTOMATION_CONTRACT_INVALID/u);
  });

  test.each([
    ["optional MCP", (value: AutomationContractObservation) => {
      value.capabilities.mcpServers[1]!.required = false;
    }],
    ["wide sandbox", (value: AutomationContractObservation) => {
      value.capabilities.executionPolicy.sandboxMode = "danger-full-access";
    }],
    ["command network", (value: AutomationContractObservation) => {
      value.capabilities.executionPolicy.commandNetwork = true;
    }],
    ["filesystem write", (value: AutomationContractObservation) => {
      value.capabilities.executionPolicy.filesystemWriteRoots = ["/tmp"];
    }],
    ["extra callable tool", (value: AutomationContractObservation) => {
      value.capabilities.callableTools.push("web.search");
    }],
  ])("rejects %s even when both fixtures collude", (_name, mutate) => {
    const observed = observation();
    mutate(observed);
    expect(() => verifyAutomationContract(observed, structuredClone(observed)))
      .toThrow(/AUTOMATION_CONTRACT_INVALID/u);
  });

  test("rejects a missing disabled feature instead of accepting future capability drift", () => {
    const observed = observation();
    observed.capabilities.disabledFeatures = observed.capabilities.disabledFeatures
      .filter((feature) => feature !== "shell_tool");
    expect(() => verifyAutomationContract(observed, expectation())).toThrow(
      /AUTOMATION_CONTRACT_MISMATCH/u,
    );
  });

  test.each([
    "/tmp/release/config.toml",
    "../../mutable/config.toml",
    "../bin/../mutable/config.toml",
    "./bin/config.toml",
    "../bin//config.toml",
  ])("rejects unsafe config symlink target %s even when both fixtures agree", (relativeTarget) => {
    const observed = observation();
    const expected = expectation();
    observed.config.relativeTarget = relativeTarget;
    expected.config.relativeTarget = relativeTarget;
    expect(() => verifyAutomationContract(observed, expected)).toThrow(
      /AUTOMATION_CONTRACT_INVALID/u,
    );
  });

  test("CLI refuses a structurally valid fixture when no matching installed release exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "automation-contract-"));
    temporaryRoots.push(root);
    const observedPath = path.join(root, "observed.json");
    const expectedPath = path.join(root, "expected.json");
    await writeFile(observedPath, JSON.stringify(observation()), "utf8");
    await writeFile(expectedPath, JSON.stringify(expectation()), "utf8");
    const scriptPath = fileURLToPath(new URL(
      "../../scripts/verify-automation-contract.mjs",
      import.meta.url,
    ));

    await expect(execFileAsync(process.execPath, [scriptPath, observedPath, expectedPath]))
      .rejects.toMatchObject({
        code: 1,
        stderr: "AUTOMATION_CONTRACT_FILESYSTEM_MISMATCH\n",
      });

    const drifted = observation();
    drifted.capabilities.mcpServers[0]?.enabledTools.push("read_arbitrary_file");
    await writeFile(observedPath, JSON.stringify(drifted), "utf8");
    await expect(execFileAsync(process.execPath, [
      scriptPath,
      observedPath,
      expectedPath,
    ])).rejects.toMatchObject({
      code: 1,
      stderr: "AUTOMATION_CONTRACT_MISMATCH\n",
    });
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
