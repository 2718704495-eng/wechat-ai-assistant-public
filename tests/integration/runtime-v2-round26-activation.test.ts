import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationSnapshot, WeChatSurface } from "../../src/adapters/wechat.js";
import { readSendGate } from "../../src/mcp/live-runtime.js";
import { acquireLiveOperationCoordinator } from
  "../../src/mcp/live-operation-coordinator.js";
import {
  createProductionAcceptanceDriver,
  ProductionAcceptanceDriver,
} from
  "../../src/runtime-v2/production-acceptance-driver.js";
import {
  assertInstalledCurrentRelease,
  resolvePackagedReleaseBinding,
} from "../../src/runtime-v2/release-binding.js";
import { runRuntimeActivationCli } from
  "../../src/runtime-v2/runtime-activation-cli.js";
import {
  RuntimeActivationService,
  type RuntimeActivationEvidence,
} from "../../src/runtime-v2/runtime-activation.js";
import { SingleDispatcherAdmission } from
  "../../src/runtime-v2/single-dispatcher-admission.js";
import {
  FIXED_ACCEPTANCE_MESSAGE,
  hashReleaseBinding,
  InMemoryAcceptanceRepository,
  SupervisedAcceptanceService,
  type AcceptanceReceipt,
  type AcceptanceState,
  type ReleaseBinding,
} from "../../src/runtime-v2/supervised-acceptance.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { StateRepository } from "../../src/storage/repositories.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

const roots: string[] = [];
const binding: ReleaseBinding = {
  payloadManifestSha256: "a".repeat(64),
  nativeSha256: "b".repeat(64),
  effectiveConfigSha256: "c".repeat(64),
};

class FixedKeyProvider implements KeyProvider {
  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(32, 26));
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Round26 activation and release-bound send gate", () => {
  it("rejects legacy consent and requires the exact current release binding", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "round26-gate-"));
    roots.push(root);
    const store = new EncryptedStore(root, new FixedKeyProvider());
    await store.write("profiles/initialization-report.enc", {
      report: {},
      hash: "a".repeat(64),
      approvedHash: "a".repeat(64),
    });
    await store.write("state/consent.enc", { consentConfirmed: true });

    const legacy = await (readSendGate as unknown as (
      input: EncryptedStore,
      bindingSha256: string,
    ) => Promise<{ consentConfirmed: boolean; initializationReportApproved: boolean }>)(
      store,
      "b".repeat(64),
    );
    expect(legacy).toEqual({ consentConfirmed: false, initializationReportApproved: true });

    await store.write("state/consent.enc", {
      version: 1,
      consentConfirmed: true,
      reportHash: "a".repeat(64),
      acceptanceBindingSha256: "b".repeat(64),
      activatedAt: "2026-08-29T00:00:00.000Z",
    });
    await expect((readSendGate as unknown as (
      input: EncryptedStore,
      bindingSha256: string,
    ) => Promise<unknown>)(store, "b".repeat(64))).resolves.toEqual({
      consentConfirmed: true,
      initializationReportApproved: true,
    });
    await expect((readSendGate as unknown as (
      input: EncryptedStore,
      bindingSha256: string,
    ) => Promise<unknown>)(store, "c".repeat(64))).resolves.toEqual({
      consentConfirmed: false,
      initializationReportApproved: true,
    });
  });

  it("exports one canonical release-binding digest", async () => {
    const module = await import("../../src/runtime-v2/supervised-acceptance.js") as Record<
      string,
      unknown
    >;
    expect(typeof module["hashReleaseBinding"]).toBe("function");
    const digest = (module["hashReleaseBinding"] as (binding: unknown) => string)({
      payloadManifestSha256: "a".repeat(64),
      nativeSha256: "b".repeat(64),
      effectiveConfigSha256: "c".repeat(64),
    });
    expect(digest).toBe(createHash("sha256").update(JSON.stringify({
      effectiveConfigSha256: "c".repeat(64),
      nativeSha256: "b".repeat(64),
      payloadManifestSha256: "a".repeat(64),
    })).digest("hex"));
  });

  it("provides an import-safe activation service and production acceptance driver", async () => {
    const activationUrl = pathToFileURL(path.resolve(
      "src/runtime-v2/runtime-activation.ts",
    )).href;
    const driverUrl = pathToFileURL(path.resolve(
      "src/runtime-v2/production-acceptance-driver.ts",
    )).href;
    const activation = await import(/* @vite-ignore */ activationUrl) as unknown as
      Record<string, unknown>;
    const driver = await import(/* @vite-ignore */ driverUrl) as unknown as
      Record<string, unknown>;
    expect(typeof activation["RuntimeActivationService"]).toBe("function");
    expect(typeof driver["ProductionAcceptanceDriver"]).toBe("function");
  });

  it("binds the production acceptance owner to runtime-v2", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "round26-production-owner-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const runtimeRoot = path.join(dataDir, "runtime-v2");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await initializeTestKernelLockCatalog(dataDir);
    await initializeTestKernelLockCatalog(runtimeRoot);
    const unrelatedParentOwner = await acquireLiveOperationCoordinator({
      dataDir,
      ownerKind: "mcp",
    });
    try {
      const driver = await createProductionAcceptanceDriver({
        releaseRoot: root,
        dataDir,
        home: root,
      });
      await expect(driver.close()).resolves.toEqual({ gateReleased: true });
    } finally {
      await unrelatedParentOwner.close();
    }
  });

  it("packages one operator-only activation wrapper", async () => {
    await expect(access(path.resolve("runtime-bin/chat-assistant-activate"))).resolves.toBeUndefined();
    const wrapper = await readFile("runtime-bin/chat-assistant-activate", "utf8");
    expect(wrapper).toContain(
      "prepare-report|approve-report|boundary|A|B0|B1|finalize|recover-image-quarantine|accept-card|inspect",
    );
  });

  it("writes release-bound consent only after report, boundary, and A/B0/B1 are exact", async () => {
    let evidence = completeEvidence();
    const written: unknown[] = [];
    const service = activationService(() => evidence, written);
    evidence = { ...evidence, report: { hash: "d".repeat(64), approvedHash: null } };
    await expect(service.finalize({ decision: "approve", reportHash: "d".repeat(64) }))
      .rejects.toThrow("INITIALIZATION_REPORT_NOT_APPROVED");
    evidence = { ...completeEvidence(), control: {
      stopped: true,
      controlBoundary: { status: "active" },
    } };
    await expect(service.finalize({ decision: "approve", reportHash: "d".repeat(64) }))
      .rejects.toThrow("CONTROL_BOUNDARY_REQUIRED");
    const incomplete = completeEvidence();
    evidence = {
      ...incomplete,
      acceptance: incomplete.acceptance === null ? null : {
        ...incomplete.acceptance,
        stages: { ...incomplete.acceptance.stages, B1: undefined },
      },
    };
    await expect(service.finalize({ decision: "approve", reportHash: "d".repeat(64) }))
      .rejects.toThrow("ACCEPTANCE_STAGE_INCOMPLETE");
    expect(written).toEqual([]);

    evidence = completeEvidence();
    await expect(service.finalize({ decision: "approve", reportHash: "d".repeat(64) }))
      .resolves.toEqual({
        version: 1,
        consentConfirmed: true,
        reportHash: "d".repeat(64),
        acceptanceBindingSha256: hashReleaseBinding(binding),
        activatedAt: "2026-08-29T01:00:00.000Z",
      });
    expect(written).toHaveLength(1);
  });

  it("prevents every UI acceptance stage from running before report and boundary", async () => {
    let evidence = completeEvidence();
    const boundary = vi.fn(() => Promise.resolve({ status: "active" }));
    const runA = vi.fn(() => Promise.resolve(receipt("A")));
    const service = new RuntimeActivationService({
      binding,
      prepareReport: () => Promise.resolve({ hash: "d".repeat(64) }),
      approveReport: () => Promise.resolve(),
      establishBoundary: boundary,
      runA,
      runB0: () => Promise.resolve(receipt("B0")),
      runB1: () => Promise.resolve(receipt("B1")),
      readEvidence: () => Promise.resolve(evidence),
      writeConsent: () => Promise.resolve(),
    });
    evidence = { ...evidence, report: { hash: "d".repeat(64), approvedHash: null } };
    await expect(service.establishBoundary()).rejects.toThrow(
      "INITIALIZATION_REPORT_NOT_APPROVED",
    );
    await expect(service.runA()).rejects.toThrow("INITIALIZATION_REPORT_NOT_APPROVED");
    evidence = { ...completeEvidence(), control: {
      stopped: true,
      controlBoundary: { status: "awaiting-boundary" },
    } };
    await expect(service.runA()).rejects.toThrow("CONTROL_BOUNDARY_REQUIRED");
    expect(boundary).not.toHaveBeenCalled();
    expect(runA).not.toHaveBeenCalled();
  });

  it("drives the release-bound Chinese B1 message only through the formal surface", async () => {
    const surface = new AcceptanceSurface();
    let released = 0;
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([]),
      release: () => { released += 1; return Promise.resolve(); },
    });

    const message = `测试信息 R-${hashReleaseBinding(binding).slice(0, 12)}`;
    const located = await driver.locateFixedTarget("example-contact", message);
    expect(located.unique).toBe(true);
    await expect(driver.readComposer()).resolves.toBe("");
    await driver.replaceComposerWithFixedMessage(message);
    expect(FIXED_ACCEPTANCE_MESSAGE).toBe("测试信息");
    await expect(driver.readComposer()).resolves.toBe(message);
    await driver.submitOnce();
    await expect(driver.readOutgoingFixedMessageAfterBaseline(
      located.outgoingBaseline,
      message,
    ))
      .resolves.toBe(true);
    await expect(driver.close()).resolves.toEqual({ gateReleased: true });

    expect(surface.replaced).toEqual([message]);
    expect(surface.submitCount).toBe(1);
    expect(released).toBe(1);
  });

  it("retains the exact Native draft proof when screenshot OCR loses the release suffix", async () => {
    const surface = new AcceptanceSurface();
    surface.draftReadback = (text) => text.replace(/-[a-f0-9]{12}$/u, "");
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([]),
      release: () => Promise.resolve(),
    });
    const message = `测试信息 A-${hashReleaseBinding(binding).slice(0, 12)}`;

    await driver.locateFixedTarget("file-transfer", message);
    await expect(driver.readComposer()).resolves.toBe("");
    await driver.replaceComposerWithFixedMessage(message);

    await expect(driver.readComposer()).resolves.toBe(message);
    expect(surface.replaced).toEqual([message]);
    expect(surface.submitCount).toBe(0);
  });

  it("verifies a new repeated fixed message by occurrence count instead of content-derived id", async () => {
    const surface = new AcceptanceSurface();
    surface.appendExistingFixedOutgoing("repeated-fixed-id");
    surface.submittedMessageId = "repeated-fixed-id";
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([]),
      release: () => Promise.resolve(),
    });

    const located = await driver.locateFixedTarget("file-transfer", FIXED_ACCEPTANCE_MESSAGE);
    await driver.replaceComposerWithFixedMessage(FIXED_ACCEPTANCE_MESSAGE);
    await driver.submitOnce();

    await expect(driver.readOutgoingFixedMessageAfterBaseline(
      located.outgoingBaseline,
      FIXED_ACCEPTANCE_MESSAGE,
    ))
      .resolves.toBe(true);
    expect(surface.submitCount).toBe(1);
  });

  it("verifies the submitted fixed message when newer concurrent messages follow it", async () => {
    const surface = new AcceptanceSurface();
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([]),
      release: () => Promise.resolve(),
    });

    const message = `测试信息 R-${hashReleaseBinding(binding).slice(0, 12)}`;
    const located = await driver.locateFixedTarget("example-contact", message);
    await driver.replaceComposerWithFixedMessage(message);
    await driver.submitOnce();
    surface.appendConcurrentMessage("incoming", "after-incoming", "后来回复");
    surface.appendConcurrentMessage("outgoing", "after-outgoing", "随后补充");

    await expect(driver.readOutgoingFixedMessageAfterBaseline(
      located.outgoingBaseline,
      message,
    ))
      .resolves.toBe(true);
    expect(surface.submitCount).toBe(1);
  });

  it("uses a release-bound A message when repeated fixed messages saturate the visible window", async () => {
    const surface = new AcceptanceSurface();
    for (let index = 0; index < 3; index += 1) {
      surface.appendExistingFixedOutgoing("repeated-fixed-id");
    }
    surface.limitVisibleMessages(3);
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([
        "abort-draft", "begin-scheduled-tick", "close", "prepare-broadcast",
        "prepare-latest-reply", "research-morning-weather", "show-comfort-station",
        "submit-authorized-broadcast", "submit-authorized-draft", "verify-draft", "verify-send",
      ]),
      release: () => Promise.resolve(),
    });
    const service = new SupervisedAcceptanceService({
      repository: new InMemoryAcceptanceRepository(),
      admission: new SingleDispatcherAdmission({
        acquireOwner: () => Promise.resolve(driver),
      }),
    });

    await expect(service.runA(binding)).resolves.toMatchObject({
      status: "verified", submitCount: 1, outgoingVerified: true,
    });
    expect(surface.replaced).toEqual([
      `测试信息 A-${hashReleaseBinding(binding).slice(0, 12)}`,
    ]);
  });

  it("uses a release-bound B1 message when repeated fixed messages saturate the visible window", async () => {
    const surface = new AcceptanceSurface();
    for (let index = 0; index < 3; index += 1) {
      surface.appendExistingFixedOutgoing("repeated-fixed-id");
    }
    surface.limitVisibleMessages(3);
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([]),
      release: () => Promise.resolve(),
    });
    const message = `测试信息 R-${hashReleaseBinding(binding).slice(0, 12)}`;

    const located = await driver.locateFixedTarget("example-contact", message);
    await driver.replaceComposerWithFixedMessage(message);
    await driver.submitOnce();

    await expect(driver.readOutgoingFixedMessageAfterBaseline(
      located.outgoingBaseline,
      message,
    )).resolves.toBe(true);
    expect(located.outgoingBaseline.fixedOutgoingCount).toBe(0);
    expect(surface.replaced).toEqual([message]);
    expect(surface.submitCount).toBe(1);
  });

  it("does not treat a pre-existing fixed message as a newly submitted message", async () => {
    const surface = new AcceptanceSurface();
    surface.appendExistingFixedOutgoing("already-submitted-id");
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([]),
      release: () => Promise.resolve(),
    });

    const located = await driver.locateFixedTarget("file-transfer", FIXED_ACCEPTANCE_MESSAGE);

    await expect(driver.readOutgoingFixedMessageAfterBaseline(
      located.outgoingBaseline,
      FIXED_ACCEPTANCE_MESSAGE,
    ))
      .resolves.toBe(false);
    expect(surface.submitCount).toBe(0);
  });

  it("fails closed when the durable pre-submit anchor is no longer visible", async () => {
    const surface = new AcceptanceSurface();
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([]),
      release: () => Promise.resolve(),
    });
    const message = `测试信息 R-${hashReleaseBinding(binding).slice(0, 12)}`;
    surface.appendConcurrentMessage("outgoing", "existing-release-bound", message);
    const located = await driver.locateFixedTarget("example-contact", message);
    await driver.replaceComposerWithFixedMessage(message);
    await driver.submitOnce();
    surface.appendConcurrentMessage("outgoing", "concurrent-release-bound", message);
    surface.removeMessage("existing-release-bound");

    await expect(driver.readOutgoingFixedMessageAfterBaseline(
      located.outgoingBaseline,
      message,
    ))
      .resolves.toBe(false);
    expect(surface.submitCount).toBe(1);
  });

  it("all-attempts draft cleanup and gate release on driver close", async () => {
    const surface = new AcceptanceSurface();
    surface.clearError = new Error("CLEAR_FAILED");
    const driver = new ProductionAcceptanceDriver({
      surface,
      listTools: () => Promise.resolve([]),
      release: () => Promise.reject(new Error("RELEASE_FAILED")),
    });
    await driver.locateFixedTarget("file-transfer", FIXED_ACCEPTANCE_MESSAGE);
    await driver.replaceComposerWithFixedMessage(FIXED_ACCEPTANCE_MESSAGE);

    const error = await driver.close().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((entry: unknown) =>
      entry instanceof Error ? entry.message : String(entry))).toEqual([
      "CLEAR_FAILED",
      "RELEASE_FAILED",
    ]);
    expect(surface.clearCount).toBe(1);
    const second = await driver.close().catch((caught: unknown) => caught);
    expect(second).toBe(error);
    expect(surface.clearCount).toBe(1);
  });

  it("provides import-safe production composition and an executable main target", async () => {
    const productionUrl = pathToFileURL(path.resolve(
      "src/runtime-v2/runtime-activation-production.ts",
    )).href;
    const production = await import(/* @vite-ignore */ productionUrl) as unknown as
      Record<string, unknown>;
    expect(typeof production["createProductionRuntimeActivationService"]).toBe("function");
    await expect(access(path.resolve(
      "src/runtime-v2/runtime-activation-main.ts",
    ))).resolves.toBeUndefined();
    expect(await readFile("runtime-bin/chat-assistant-activate", "utf8"))
      .toContain("runtime-activation-main.js");
  });

  it("accepts only exact stdin decisions and never accepts operator text or target", async () => {
    const written: unknown[] = [];
    const service = activationService(completeEvidence, written);
    const approved = await runCli(service, ["--stage", "B1"],
      '{"decision":"approve"}\n');
    expect(approved).toMatchObject({ stage: "B1", status: "verified" });
    await expect(runCli(service, ["--stage", "B1"],
      '{"decision":"approve","text":"任意文本"}\n'))
      .rejects.toThrow("ACTIVATION_INPUT_INVALID");
    await expect(runCli(service, ["--stage", "finalize"],
      `{"decision":"approve","reportHash":"${"d".repeat(64)}","target":"示例联系人"}\n`))
      .rejects.toThrow("ACTIVATION_INPUT_INVALID");
    expect(written).toEqual([]);
  });

  it("runs release acceptance card only after consent is bound and accepts no operator input", async () => {
    let consentBound = false;
    const runComfortStationAcceptance = vi.fn(() => Promise.resolve({
      status: "verified" as const,
      conversationId: "example-contact" as const,
    }));
    const service = new RuntimeActivationService({
      binding,
      prepareReport: () => Promise.resolve({ hash: "d".repeat(64) }),
      approveReport: () => Promise.resolve(),
      establishBoundary: () => Promise.resolve({ status: "active" }),
      runA: () => Promise.resolve(receipt("A")),
      runB0: () => Promise.resolve(receipt("B0")),
      runB1: () => Promise.resolve(receipt("B1")),
      readEvidence: () => Promise.resolve(completeEvidence()),
      readConsentBound: () => Promise.resolve(consentBound),
      runComfortStationAcceptance,
      writeConsent: () => Promise.resolve(),
    });

    await expect(runCli(service, ["--stage", "accept-card"], ""))
      .rejects.toThrow("RUNTIME_CONSENT_NOT_BOUND");
    consentBound = true;
    await expect(runCli(service, ["--stage", "accept-card"], ""))
      .resolves.toEqual({ status: "verified", conversationId: "example-contact" });
    expect(runComfortStationAcceptance).toHaveBeenCalledTimes(1);
    await expect(runCli(service, ["--stage", "accept-card", "extra"], ""))
      .rejects.toThrow("ACTIVATION_ARGUMENTS_INVALID");
  });

  it("recovers image quarantine only after the current release is fully activated", async () => {
    let consentBound = false;
    const recover = vi.fn(() => Promise.resolve({
      status: "recovered" as const,
      archiveName: `dirty-archive-${"a".repeat(64)}`,
      composerEmpty: true as const,
    }));
    const service = new RuntimeActivationService({
      binding,
      prepareReport: () => Promise.resolve({ hash: "d".repeat(64) }),
      approveReport: () => Promise.resolve(),
      establishBoundary: () => Promise.resolve({ status: "active" }),
      runA: () => Promise.resolve(receipt("A")),
      runB0: () => Promise.resolve(receipt("B0")),
      runB1: () => Promise.resolve(receipt("B1")),
      readEvidence: () => Promise.resolve(completeEvidence()),
      readConsentBound: () => Promise.resolve(consentBound),
      runImageAttachmentQuarantineRecovery: recover,
      writeConsent: () => Promise.resolve(),
    });

    await expect(runCli(service, ["--stage", "recover-image-quarantine"], ""))
      .rejects.toThrow("RUNTIME_ACTIVATION_INCOMPLETE");
    consentBound = true;
    await expect(runCli(service, ["--stage", "recover-image-quarantine"], ""))
      .resolves.toEqual({
        status: "recovered",
        archiveName: `dirty-archive-${"a".repeat(64)}`,
        composerEmpty: true,
      });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await readFile("runtime-bin/chat-assistant-activate", "utf8"))
      .toContain("recover-image-quarantine");
  });

  it("derives release binding from the actual manifest, Native, and config bytes", async () => {
    const fixture = await fakePackagedRelease();
    const moduleUrl = pathToFileURL(path.join(
      fixture.releaseRoot,
      "dist/src/runtime-v2/runtime-activation-production.js",
    )).href;
    await expect(resolvePackagedReleaseBinding(moduleUrl)).resolves.toEqual({
      releaseRoot: fixture.releaseRoot,
      binding: fixture.binding,
    });

    await chmod(fixture.configPath, 0o644);
    await writeFile(fixture.configPath, "tampered", "utf8");
    await expect(resolvePackagedReleaseBinding(moduleUrl))
      .rejects.toThrow("ACTIVATION_RELEASE_MANIFEST_INVALID");
  });

  it("requires the activation module to be the installed current release", async () => {
    const fixture = await fakePackagedRelease();
    const runtimeRoot = path.join(path.dirname(fixture.releaseRoot), "runtime-v2");
    const releases = path.join(runtimeRoot, ".releases");
    const installed = path.join(releases, "release-round26");
    await mkdir(releases, { recursive: true, mode: 0o700 });
    await symlink(fixture.releaseRoot, installed);
    await symlink(".releases/release-round26", path.join(runtimeRoot, "current"));
    await expect(assertInstalledCurrentRelease(runtimeRoot, fixture.releaseRoot))
      .resolves.toBeUndefined();
    await rm(path.join(runtimeRoot, "current"));
    await symlink(".releases/foreign", path.join(runtimeRoot, "current"));
    await expect(assertInstalledCurrentRelease(runtimeRoot, fixture.releaseRoot)).rejects.toThrow();
  });

  it("inspects an absent control state without initializing or writing it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "round26-inspect-"));
    roots.push(root);
    const state = new StateRepository(new EncryptedStore(root, new FixedKeyProvider()));
    await expect(state.peekControlState()).resolves.toBeNull();
    await expect(lstat(path.join(root, "state/control.enc")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function runCli(
  service: RuntimeActivationService,
  argv: string[],
  inputText: string,
): Promise<unknown> {
  const input = new PassThrough();
  const output = new PassThrough();
  input.end(inputText);
  return runRuntimeActivationCli({ argv, input, output, service });
}

async function fakePackagedRelease(): Promise<{
  releaseRoot: string;
  configPath: string;
  binding: ReleaseBinding;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "round26-release-"));
  roots.push(parent);
  const releaseRoot = path.join(await realpath(parent), "payload");
  const modulePath = path.join(
    releaseRoot,
    "dist/src/runtime-v2/runtime-activation-production.js",
  );
  const configPath = path.join(releaseRoot, "config/automation-restricted.config.toml");
  const nativePath = path.join(
    releaseRoot,
    "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
  );
  await Promise.all([
    mkdir(path.dirname(modulePath), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(nativePath), { recursive: true, mode: 0o700 }),
  ]);
  const config = Buffer.from("profile=round26\n", "utf8");
  const native = Buffer.from("native-round26", "utf8");
  await Promise.all([
    writeFile(modulePath, "export {};\n", { mode: 0o444 }),
    writeFile(configPath, config, { mode: 0o444 }),
    writeFile(nativePath, native, { mode: 0o555 }),
  ]);
  const manifest = Buffer.from(JSON.stringify({
    entries: [
      {
        path: "config/automation-restricted.config.toml",
        type: "file",
        sha256: sha256(config),
      },
      {
        path: "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
        type: "file",
        sha256: sha256(native),
      },
    ],
    manifestVersion: 1,
    provenance: {},
  }), "utf8");
  const manifestSha256 = sha256(manifest);
  await Promise.all([
    writeFile(path.join(releaseRoot, "payload-manifest.json"), manifest, { mode: 0o444 }),
    writeFile(path.join(releaseRoot, "payload-manifest.sha256"), `${manifestSha256}\n`, {
      mode: 0o444,
    }),
  ]);
  return {
    releaseRoot,
    configPath,
    binding: {
      payloadManifestSha256: manifestSha256,
      nativeSha256: sha256(native),
      effectiveConfigSha256: sha256(config),
    },
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function activationService(
  readEvidence: () => RuntimeActivationEvidence,
  written: unknown[],
): RuntimeActivationService {
  return new RuntimeActivationService({
    binding,
    prepareReport: () => Promise.resolve({ hash: "d".repeat(64) }),
    approveReport: () => Promise.resolve(),
    establishBoundary: () => Promise.resolve({ status: "active" }),
    runA: () => Promise.resolve(receipt("A")),
    runB0: () => Promise.resolve(receipt("B0")),
    runB1: () => Promise.resolve(receipt("B1")),
    readEvidence: () => Promise.resolve(readEvidence()),
    writeConsent: (document) => { written.push(document); return Promise.resolve(); },
    now: () => new Date("2026-08-29T01:00:00.000Z"),
  });
}

function completeEvidence(): RuntimeActivationEvidence {
  const bindingSha256 = hashReleaseBinding(binding);
  const acceptance: AcceptanceState = {
    version: 1,
    binding,
    bindingSha256,
    stages: {
      A: receipt("A"),
      B0: receipt("B0"),
      B1: receipt("B1"),
    },
  };
  return {
    report: { hash: "d".repeat(64), approvedHash: "d".repeat(64) },
    control: { stopped: false, controlBoundary: { status: "active" } },
    acceptance,
  };
}

function receipt(stage: "A" | "B0" | "B1"): AcceptanceReceipt {
  return {
    stage,
    status: "verified",
    bindingSha256: hashReleaseBinding(binding),
    target: stage === "A" ? "file-transfer" : "example-contact",
    messageSha256: stage === "B0" ? null : createHash("sha256")
      .update(stage === "A"
        ? `测试信息 A-${hashReleaseBinding(binding).slice(0, 12)}`
        : `测试信息 R-${hashReleaseBinding(binding).slice(0, 12)}`)
      .digest("hex"),
    invocationCount: 1,
    replaceCount: stage === "B0" ? 0 : 1,
    submitCount: stage === "B0" ? 0 : 1,
    outgoingBaseline: stage === "B0" ? null : {
      fixedOutgoingCount: 0,
      anchor: { messageId: "a".repeat(64), occurrenceOrdinal: 1 },
    },
    ...(stage === "B0" ? { latestDirection: "incoming" as const } : {}),
    composerEmpty: true,
    draftVerified: stage !== "B0",
    outgoingVerified: stage !== "B0",
    closed: true,
    gateReleased: true,
  };
}

class AcceptanceSurface implements WeChatSurface {
  public readonly replaced: string[] = [];
  public draftReadback = (text: string): string => text;
  public submitCount = 0;
  public clearCount = 0;
  public clearError: Error | null = null;
  public submittedMessageId = "submitted";
  private draft = "";
  private visibleMessageLimit = Number.POSITIVE_INFINITY;
  private messages: ConversationSnapshot["messages"] = [{
    id: "baseline",
    conversationId: "example-contact",
    direction: "incoming",
    kind: "text",
    text: "早",
    occurredAt: "2026-08-29T00:00:00.000Z",
    source: "wechat",
    confidence: 0.99,
  }];

  public locateConversation(id: "example-contact" | "file-transfer"): Promise<ConversationSnapshot> {
    return Promise.resolve({
      conversationId: id,
      identity: {
        conversationId: id,
        visibleName: id === "example-contact" ? "示例联系人" : "文件传输助手",
        avatarFingerprint: "a".repeat(64),
        recentMessageFingerprint: "b".repeat(64),
        confidence: 0.99,
      },
      messages: this.messages.slice(-this.visibleMessageLimit)
        .map((message) => ({ ...message, conversationId: id })),
      draftText: this.draftReadback(this.draft),
      draftAlternatives: [],
      composerEvidence: this.draft === "" ? "proven-empty" : "meaningful-content",
      unreadIndicator: false,
      windowRevision: "window-1",
    });
  }

  public focusConversation(): Promise<void> { return Promise.resolve(); }

  public appendExistingFixedOutgoing(id: string): void {
    this.messages = [...this.messages, {
      id,
      conversationId: "file-transfer",
      direction: "outgoing",
      kind: "text",
      text: FIXED_ACCEPTANCE_MESSAGE,
      occurredAt: "2026-08-29T00:30:00.000Z",
      source: "wechat",
      confidence: 0.99,
    }];
  }

  public limitVisibleMessages(limit: number): void {
    this.visibleMessageLimit = limit;
  }

  public appendConcurrentMessage(
    direction: "incoming" | "outgoing",
    id: string,
    text: string,
  ): void {
    this.messages = [...this.messages, {
      id,
      conversationId: "example-contact",
      direction,
      kind: "text",
      text,
      occurredAt: "2026-08-29T01:01:00.000Z",
      source: "wechat",
      confidence: 0.99,
    }];
  }

  public removeMessage(id: string): void {
    this.messages = this.messages.filter((message) => message.id !== id);
  }

  public replaceDraft(
    _id: "example-contact" | "file-transfer",
    text: string,
  ): Promise<void> {
    this.replaced.push(text);
    this.draft = text;
    return Promise.resolve();
  }

  public clearDraft(): Promise<void> {
    this.clearCount += 1;
    if (this.clearError !== null) return Promise.reject(this.clearError);
    this.draft = "";
    return Promise.resolve();
  }

  public submitDraft(id: "example-contact" | "file-transfer"): Promise<void> {
    this.submitCount += 1;
    this.messages = [...this.messages, {
      id: this.submittedMessageId,
      conversationId: id,
      direction: "outgoing",
      kind: "text",
      text: this.draft,
      occurredAt: "2026-08-29T01:00:00.000Z",
      source: "wechat",
      confidence: 0.99,
    }];
    this.draft = "";
    return Promise.resolve();
  }
}
