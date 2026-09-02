import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SingleDispatcherAdmission } from "../../src/runtime-v2/single-dispatcher-admission.js";
import {
  FIXED_ACCEPTANCE_MESSAGE,
  FileAcceptanceRepository,
  hashReleaseBinding,
  InMemoryAcceptanceRepository,
  SupervisedAcceptanceService,
  type AcceptanceDriver,
  type ReleaseBinding,
} from "../../src/runtime-v2/supervised-acceptance.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const releaseA: ReleaseBinding = {
  payloadManifestSha256: "a".repeat(64),
  nativeSha256: "b".repeat(64),
  effectiveConfigSha256: "c".repeat(64),
};

describe("A -> B0 -> B1 supervised acceptance", () => {
  it("runs release-bound A, no-send B0, then a single release-bound B1 submit", async () => {
    const repository = new InMemoryAcceptanceRepository();
    const aDriver = driver("incoming");
    const b0Driver = driver("incoming");
    const b1Driver = driver("outgoing");
    const drivers = [aDriver, b0Driver, b1Driver];
    const admission = new SingleDispatcherAdmission({
      acquireOwner: vi.fn(() => Promise.resolve(drivers.shift() as AcceptanceDriver)),
    });
    const service = new SupervisedAcceptanceService({ repository, admission });

    const a = await service.runA(releaseA);
    const b0 = await service.runB0(releaseA);
    const b1 = await service.runB1(releaseA, "approve");

    expect(a).toMatchObject({ stage: "A", status: "verified", submitCount: 1 });
    expect(b0).toMatchObject({
      stage: "B0", status: "verified", replaceCount: 0, submitCount: 0,
      latestDirection: "incoming", closed: true, gateReleased: true,
    });
    expect(b1).toMatchObject({ stage: "B1", status: "verified", submitCount: 1 });
    expect(aDriver.replaceComposerWithFixedMessage).toHaveBeenCalledExactlyOnceWith(
      `测试信息 A-${hashReleaseBinding(releaseA).slice(0, 12)}`,
    );
    expect(b1Driver.replaceComposerWithFixedMessage)
      .toHaveBeenCalledExactlyOnceWith(
        `测试信息 R-${hashReleaseBinding(releaseA).slice(0, 12)}`,
      );
    expect(aDriver.locateFixedTarget).toHaveBeenCalledTimes(2);
    expect(b0Driver.locateFixedTarget).toHaveBeenCalledTimes(1);
    expect(b1Driver.locateFixedTarget).toHaveBeenCalledTimes(2);
    expect(drivers).toEqual([]);
  });

  it("never exposes arbitrary target, text or coordinates to a caller", () => {
    expect(FIXED_ACCEPTANCE_MESSAGE).toBe("测试信息");
    expect(SupervisedAcceptanceService.prototype.runA.length).toBe(1);
    expect(SupervisedAcceptanceService.prototype.runB0.length).toBe(1);
    expect(SupervisedAcceptanceService.prototype.runB1.length).toBe(2);
  });

  it("persists the final target-revalidation baseline immediately before submit", async () => {
    const owner = driver("incoming");
    vi.mocked(owner.locateFixedTarget)
      .mockResolvedValueOnce({
        unique: true,
        outgoingBaseline: {
          fixedOutgoingCount: 0,
          anchor: { messageId: "a".repeat(64), occurrenceOrdinal: 1 },
        },
      })
      .mockResolvedValueOnce({
        unique: true,
        outgoingBaseline: {
          fixedOutgoingCount: 1,
          anchor: { messageId: "b".repeat(64), occurrenceOrdinal: 1 },
        },
      });
    const service = new SupervisedAcceptanceService({
      repository: new InMemoryAcceptanceRepository(),
      admission: new SingleDispatcherAdmission({
        acquireOwner: vi.fn(() => Promise.resolve(owner)),
      }),
    });

    await expect(service.runA(releaseA)).resolves.toMatchObject({ status: "verified" });
    expect(owner.readOutgoingFixedMessageAfterBaseline).toHaveBeenCalledExactlyOnceWith({
      fixedOutgoingCount: 1,
      anchor: { messageId: "b".repeat(64), occurrenceOrdinal: 1 },
    }, `测试信息 A-${hashReleaseBinding(releaseA).slice(0, 12)}`);
  });

  it("enforces stage order and exact release binding", async () => {
    const harness = serviceHarness();
    await expect(harness.service.runB0(releaseA)).rejects.toThrow("ACCEPTANCE_STAGE_ORDER_INVALID");
    await harness.service.runA(releaseA);
    const changed = { ...releaseA, nativeSha256: "d".repeat(64) };
    await expect(harness.service.runB0(changed)).rejects.toThrow("ACCEPTANCE_BINDING_MISMATCH");
    expect(harness.acquireOwner).toHaveBeenCalledTimes(1);
  });

  it("allows a third zero-send B0 attempt after two offscreen-target failures", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "acceptance-b0-retry-"));
    temporaryRoots.push(fixture);
    const runtimeRoot = path.join(fixture, "runtime-v2");
    await mkdir(runtimeRoot, { mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    const unavailable = () => ({
      ...driver("incoming"),
      locateFixedTarget: vi.fn(() => Promise.resolve({
        unique: false,
        outgoingBaseline: { fixedOutgoingCount: 0, anchor: null },
      })),
    });
    const owners = [driver("incoming"), unavailable(), unavailable(), driver("incoming")];
    const repository = new FileAcceptanceRepository(runtimeRoot);
    const service = new SupervisedAcceptanceService({
      repository,
      admission: new SingleDispatcherAdmission({
        acquireOwner: vi.fn(() => Promise.resolve(owners.shift() as AcceptanceDriver)),
      }),
    });

    await service.runA(releaseA);
    await expect(service.runB0(releaseA)).rejects.toThrow("ACCEPTANCE_TARGET_NOT_UNIQUE");
    await expect(service.runB0(releaseA)).rejects.toThrow("ACCEPTANCE_TARGET_NOT_UNIQUE");
    await expect(service.runB0(releaseA)).resolves.toMatchObject({
      status: "verified",
      invocationCount: 3,
      replaceCount: 0,
      submitCount: 0,
    });
    await expect(repository.load()).resolves.toMatchObject({
      stages: { B0: { status: "verified", invocationCount: 3, submitCount: 0 } },
    });
  });

  it("aborts B1 without writing and records no submit", async () => {
    const harness = serviceHarness();
    await harness.service.runA(releaseA);
    await harness.service.runB0(releaseA);

    const receipt = await harness.service.runB1(releaseA, "abort");

    expect(receipt).toMatchObject({
      stage: "B1", status: "failed", replaceCount: 0, submitCount: 0,
      closed: true, gateReleased: true,
    });
  });

  it("terminalizes an uncertain submit and never retries it", async () => {
    const repository = new InMemoryAcceptanceRepository();
    const a = driver("incoming");
    const b0 = driver("incoming");
    const uncertain = {
      ...driver("outgoing"),
      submitOnce: vi.fn(() => Promise.reject(new Error("TRANSPORT_LOST"))),
    };
    const readback = {
      ...driver("outgoing"),
      readOutgoingFixedMessageAfterBaseline: vi.fn().mockResolvedValue(false),
    };
    const acquireOwner = vi.fn()
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b0)
      .mockResolvedValueOnce(uncertain)
      .mockResolvedValueOnce(readback);
    const service = new SupervisedAcceptanceService({
      repository,
      admission: new SingleDispatcherAdmission({ acquireOwner }),
    });
    await service.runA(releaseA);
    await service.runB0(releaseA);

    await expect(service.runB1(releaseA, "approve"))
      .rejects.toThrow("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    await expect(service.runB1(releaseA, "approve"))
      .rejects.toThrow("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    expect(uncertain.submitOnce).toHaveBeenCalledTimes(1);
    expect(readback.submitOnce).not.toHaveBeenCalled();
    expect(acquireOwner).toHaveBeenCalledTimes(4);
  });

  it("decodes a legacy plain B1 receipt but refuses to recover or touch the UI", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "acceptance-legacy-b1-"));
    temporaryRoots.push(fixture);
    const runtimeRoot = path.join(fixture, "runtime-v2");
    await mkdir(runtimeRoot, { mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    const uncertain = {
      ...driver("outgoing"),
      submitOnce: vi.fn(() => Promise.reject(new Error("TRANSPORT_LOST"))),
    };
    const acquireOwner = vi.fn()
      .mockResolvedValueOnce(driver("incoming"))
      .mockResolvedValueOnce(driver("incoming"))
      .mockResolvedValueOnce(uncertain);
    const createService = () => new SupervisedAcceptanceService({
      repository: new FileAcceptanceRepository(runtimeRoot),
      admission: new SingleDispatcherAdmission({ acquireOwner }),
    });
    await createService().runA(releaseA);
    await createService().runB0(releaseA);
    await expect(createService().runB1(releaseA, "approve"))
      .rejects.toThrow("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");

    const statePath = path.join(runtimeRoot, "state", "supervised-acceptance.json");
    const legacy = JSON.parse(await readFile(statePath, "utf8")) as {
      stages: { B1: { messageSha256: string } };
    };
    legacy.stages.B1.messageSha256 = createHash("sha256")
      .update(FIXED_ACCEPTANCE_MESSAGE)
      .digest("hex");
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    await expect(createService().runB1(releaseA, "approve"))
      .rejects.toThrow("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    expect(acquireOwner).toHaveBeenCalledTimes(3);
    expect(uncertain.submitOnce).toHaveBeenCalledTimes(1);
  });

  it("allows one readback-only recovery after a pre-submit failure and second-invocation uncertain submit", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "acceptance-recovery-state-"));
    temporaryRoots.push(fixture);
    const runtimeRoot = path.join(fixture, "runtime-v2");
    await mkdir(runtimeRoot, { mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    const preSubmitFailure = {
      ...driver("incoming"),
      readComposer: vi.fn(() => Promise.resolve("existing draft")),
    };
    const uncertainSubmit = {
      ...driver("outgoing"),
      submitOnce: vi.fn(() => Promise.reject(new Error("TRANSPORT_LOST"))),
    };
    const readbackOnly = {
      ...driver("outgoing"),
      readOutgoingFixedMessageAfterBaseline: vi.fn().mockResolvedValue(true),
    };
    const acquireOwner = vi.fn()
      .mockResolvedValueOnce(preSubmitFailure)
      .mockResolvedValueOnce(uncertainSubmit)
      .mockResolvedValueOnce(readbackOnly);
    const createService = () => new SupervisedAcceptanceService({
      repository: new FileAcceptanceRepository(runtimeRoot),
      admission: new SingleDispatcherAdmission({ acquireOwner }),
    });

    await expect(createService().runA(releaseA)).rejects.toThrow("ACCEPTANCE_COMPOSER_NOT_EMPTY");
    await expect(createService().runA(releaseA)).rejects.toThrow("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    const durableBeforeRecovery = JSON.parse(await readFile(
      path.join(runtimeRoot, "state", "supervised-acceptance.json"),
      "utf8",
    )) as { stages: { A: { outgoingBaseline?: unknown } } };
    expect(durableBeforeRecovery.stages.A.outgoingBaseline).toEqual({
      fixedOutgoingCount: 0,
      anchor: {
        messageId: "a".repeat(64),
        occurrenceOrdinal: 1,
      },
    });
    const recovered = await createService().runA(releaseA);

    expect(recovered).toMatchObject({
      status: "verified", invocationCount: 3, replaceCount: 1, submitCount: 1,
      outgoingVerified: true, closed: true, gateReleased: true,
    });
    expect(uncertainSubmit.submitOnce).toHaveBeenCalledTimes(1);
    expect(readbackOnly.submitOnce).not.toHaveBeenCalled();
    expect(readbackOnly.readOutgoingFixedMessageAfterBaseline)
      .toHaveBeenCalledExactlyOnceWith({
        fixedOutgoingCount: 0,
        anchor: { messageId: "a".repeat(64), occurrenceOrdinal: 1 },
      }, `测试信息 A-${hashReleaseBinding(releaseA).slice(0, 12)}`);
    expect(acquireOwner).toHaveBeenCalledTimes(3);
    await expect(new FileAcceptanceRepository(runtimeRoot).load()).resolves.toMatchObject({
      stages: { A: { status: "verified", invocationCount: 3, submitCount: 1 } },
    });
    const statePath = path.join(runtimeRoot, "state", "supervised-acceptance.json");
    const impossible = JSON.parse(await readFile(statePath, "utf8")) as {
      stages: { A: { replaceCount: number } };
    };
    impossible.stages.A.replaceCount = 0;
    await writeFile(statePath, `${JSON.stringify(impossible)}\n`, { mode: 0o600 });
    await expect(new FileAcceptanceRepository(runtimeRoot).load())
      .rejects.toThrow("ACCEPTANCE_STATE_INVALID");
  });

  it("fails closed when close cannot prove gate release", async () => {
    const unsafe = driver("incoming", false);
    const service = new SupervisedAcceptanceService({
      repository: new InMemoryAcceptanceRepository(),
      admission: new SingleDispatcherAdmission({
        acquireOwner: vi.fn(() => Promise.resolve(unsafe)),
      }),
    });

    await expect(service.runA(releaseA))
      .rejects.toThrow("SINGLE_DISPATCHER_GATE_RELEASE_UNPROVEN");
    expect(unsafe.submitOnce).toHaveBeenCalledTimes(1);
  });

  it("clears and proves empty after a written pre-submit draft fails verification", async () => {
    const mismatched = {
      ...driver("incoming"),
      readComposer: vi.fn()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("mismatch")
        .mockResolvedValueOnce(""),
    };
    const service = new SupervisedAcceptanceService({
      repository: new InMemoryAcceptanceRepository(),
      admission: new SingleDispatcherAdmission({
        acquireOwner: vi.fn(() => Promise.resolve(mismatched)),
      }),
    });

    await expect(service.runA(releaseA)).rejects.toThrow("ACCEPTANCE_DRAFT_MISMATCH");
    expect(mismatched.clearComposer).toHaveBeenCalledTimes(1);
    expect(mismatched.submitOnce).not.toHaveBeenCalled();
    expect(mismatched.close).toHaveBeenCalledTimes(1);
  });

  it("preserves primary, draft cleanup, and gate close failures in order", async () => {
    const broken = {
      ...driver("incoming"),
      readComposer: vi.fn()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("mismatch"),
      clearComposer: vi.fn(() => Promise.reject(new Error("CLEAR_FAILED"))),
      close: vi.fn(() => Promise.reject(new Error("CLOSE_FAILED"))),
    };
    const service = new SupervisedAcceptanceService({
      repository: new InMemoryAcceptanceRepository(),
      admission: new SingleDispatcherAdmission({
        acquireOwner: vi.fn(() => Promise.resolve(broken)),
      }),
    });

    const error = await service.runA(releaseA).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((entry: unknown) =>
      entry instanceof Error ? entry.message : String(entry))).toEqual([
      "ACCEPTANCE_DRAFT_MISMATCH",
      "CLEAR_FAILED",
      "CLOSE_FAILED",
    ]);
  });

  it("persists a hash-bound A receipt for a later B0 service instance without message text", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "acceptance-state-"));
    temporaryRoots.push(fixture);
    const runtimeRoot = path.join(fixture, "runtime-v2");
    await mkdir(runtimeRoot, { mode: 0o700 });
    await chmod(runtimeRoot, 0o700);
    await initializeTestKernelLockCatalog(runtimeRoot);
    const repository = new FileAcceptanceRepository(runtimeRoot);
    const firstAcquire = vi.fn(() => Promise.resolve(driver("incoming")));
    await new SupervisedAcceptanceService({
      repository,
      admission: new SingleDispatcherAdmission({ acquireOwner: firstAcquire }),
    }).runA(releaseA);

    const secondAcquire = vi.fn(() => Promise.resolve(driver("outgoing")));
    const receipt = await new SupervisedAcceptanceService({
      repository: new FileAcceptanceRepository(runtimeRoot),
      admission: new SingleDispatcherAdmission({ acquireOwner: secondAcquire }),
    }).runB0(releaseA);

    expect(receipt).toMatchObject({ stage: "B0", status: "verified", submitCount: 0 });
    expect(firstAcquire).toHaveBeenCalledTimes(1);
    expect(secondAcquire).toHaveBeenCalledTimes(1);
    const statePath = path.join(runtimeRoot, "state", "supervised-acceptance.json");
    expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(statePath, "utf8")).not.toContain(FIXED_ACCEPTANCE_MESSAGE);
  });

  it("rejects an acceptance state containing an unrecognized sensitive field", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "acceptance-state-strict-"));
    temporaryRoots.push(fixture);
    const runtimeRoot = path.join(fixture, "runtime-v2");
    await mkdir(runtimeRoot, { mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    const repository = new FileAcceptanceRepository(runtimeRoot);
    await new SupervisedAcceptanceService({
      repository,
      admission: new SingleDispatcherAdmission({
        acquireOwner: vi.fn(() => Promise.resolve(driver("incoming"))),
      }),
    }).runA(releaseA);
    const statePath = path.join(runtimeRoot, "state", "supervised-acceptance.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    state["candidateText"] = FIXED_ACCEPTANCE_MESSAGE;
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await expect(new FileAcceptanceRepository(runtimeRoot).load())
      .rejects.toThrow("ACCEPTANCE_STATE_INVALID");
  });

  it("loads a legacy uncertain receipt but refuses readback without a durable baseline", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "acceptance-legacy-baseline-"));
    temporaryRoots.push(fixture);
    const runtimeRoot = path.join(fixture, "runtime-v2");
    await mkdir(runtimeRoot, { mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    const initialOwner = {
      ...driver("incoming"),
      submitOnce: vi.fn(() => Promise.reject(new Error("TRANSPORT_LOST"))),
    };
    await expect(new SupervisedAcceptanceService({
      repository: new FileAcceptanceRepository(runtimeRoot),
      admission: new SingleDispatcherAdmission({
        acquireOwner: vi.fn(() => Promise.resolve(initialOwner)),
      }),
    }).runA(releaseA)).rejects.toThrow("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    const statePath = path.join(runtimeRoot, "state", "supervised-acceptance.json");
    const legacy = JSON.parse(await readFile(statePath, "utf8")) as {
      stages: { A: Record<string, unknown> };
    };
    delete legacy.stages.A["outgoingBaseline"];
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const recoveryOwner = vi.fn(() => Promise.resolve(driver("incoming")));

    await expect(new SupervisedAcceptanceService({
      repository: new FileAcceptanceRepository(runtimeRoot),
      admission: new SingleDispatcherAdmission({ acquireOwner: recoveryOwner }),
    }).runA(releaseA)).rejects.toThrow("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    expect(recoveryOwner).not.toHaveBeenCalled();
  });

  it("rejects a malformed durable outgoing baseline", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "acceptance-invalid-baseline-"));
    temporaryRoots.push(fixture);
    const runtimeRoot = path.join(fixture, "runtime-v2");
    await mkdir(runtimeRoot, { mode: 0o700 });
    await initializeTestKernelLockCatalog(runtimeRoot);
    const repository = new FileAcceptanceRepository(runtimeRoot);
    await new SupervisedAcceptanceService({
      repository,
      admission: new SingleDispatcherAdmission({
        acquireOwner: vi.fn(() => Promise.resolve(driver("incoming"))),
      }),
    }).runA(releaseA);
    const statePath = path.join(runtimeRoot, "state", "supervised-acceptance.json");
    const invalid = JSON.parse(await readFile(statePath, "utf8")) as {
      stages: { A: { outgoingBaseline: { anchor: { messageId: string } } } };
    };
    invalid.stages.A.outgoingBaseline.anchor.messageId = FIXED_ACCEPTANCE_MESSAGE;
    await writeFile(statePath, `${JSON.stringify(invalid)}\n`, { mode: 0o600 });

    await expect(new FileAcceptanceRepository(runtimeRoot).load())
      .rejects.toThrow("ACCEPTANCE_STATE_INVALID");
  });
});

function serviceHarness() {
  const acquireOwner = vi.fn(() => Promise.resolve(driver("incoming")));
  const service = new SupervisedAcceptanceService({
    repository: new InMemoryAcceptanceRepository(),
    admission: new SingleDispatcherAdmission({ acquireOwner }),
  });
  return { acquireOwner, service };
}

function driver(
  latestDirection: "incoming" | "outgoing",
  gateReleased = true,
): AcceptanceDriver {
  let composer = "";
  return {
    listTools: vi.fn(() => Promise.resolve([
      "abort-draft", "begin-scheduled-tick", "close", "prepare-broadcast",
      "prepare-latest-reply", "research-morning-weather", "show-comfort-station",
      "submit-authorized-broadcast", "submit-authorized-draft", "verify-draft", "verify-send",
    ])),
    locateFixedTarget: vi.fn(() => Promise.resolve({
      unique: true,
      outgoingBaseline: {
        fixedOutgoingCount: 0,
        anchor: { messageId: "a".repeat(64), occurrenceOrdinal: 1 },
      },
    })),
    readLatestDirection: vi.fn(() => Promise.resolve(latestDirection)),
    readComposer: vi.fn(() => Promise.resolve(composer)),
    replaceComposerWithFixedMessage: vi.fn((message: string) => {
      composer = message;
      return Promise.resolve();
    }),
    clearComposer: vi.fn(() => {
      composer = "";
      return Promise.resolve();
    }),
    submitOnce: vi.fn(() => Promise.resolve()),
    readOutgoingFixedMessageAfterBaseline: vi.fn(() => Promise.resolve(true)),
    close: vi.fn(() => Promise.resolve({ gateReleased })),
  };
}
