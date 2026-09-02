import { writeFile } from "node:fs/promises";

import { expect, test } from "vitest";

import {
  FileAcceptanceRepository,
  SupervisedAcceptanceService,
  type AcceptanceDriver,
  type ReleaseBinding,
} from "../../src/runtime-v2/supervised-acceptance.js";
import { SingleDispatcherAdmission } from
  "../../src/runtime-v2/single-dispatcher-admission.js";
import {
  FileSingleSchedulerStateRepository,
} from "../../src/runtime-v2/single-scheduler.js";

const workerTest = process.env.RUNTIME_V2_ROUND5_WORKER === "1" ? test : test.skip;

workerTest("holds a runtime-v2 state transaction until the parent SIGKILLs this process", async () => {
  const mode = requiredEnv("RUNTIME_V2_ROUND5_MODE");
  const runtimeRoot = requiredEnv("RUNTIME_V2_ROUND5_ROOT");
  const acquiredPath = requiredEnv("RUNTIME_V2_ROUND5_ACQUIRED");
  if (mode === "acceptance") {
    const service = new SupervisedAcceptanceService({
      repository: new FileAcceptanceRepository(runtimeRoot),
      admission: new SingleDispatcherAdmission({ acquireOwner: () => Promise.resolve(driver(
        acquiredPath,
      )) }),
    });
    await service.runA(binding);
  } else if (mode === "scheduler") {
    const repository = new FileSingleSchedulerStateRepository(runtimeRoot);
    await repository.transact(async (state) => {
      await writeFile(acquiredPath, "acquired\n", { flag: "wx", mode: 0o600 });
      await new Promise<never>(() => undefined);
      return { state, result: null };
    });
  } else {
    throw new Error("RUNTIME_V2_ROUND5_MODE_INVALID");
  }
  expect.fail("worker transaction unexpectedly completed");
}, 20_000);

const binding: ReleaseBinding = {
  payloadManifestSha256: "a".repeat(64),
  nativeSha256: "b".repeat(64),
  effectiveConfigSha256: "c".repeat(64),
};

function driver(acquiredPath: string): AcceptanceDriver {
  let composer = "";
  return {
    listTools: () => Promise.resolve([
      "abort-draft", "begin-scheduled-tick", "close", "prepare-broadcast",
      "prepare-latest-reply", "research-morning-weather", "show-comfort-station",
      "submit-authorized-broadcast",
      "submit-authorized-draft", "verify-draft", "verify-send",
    ]),
    locateFixedTarget: () => Promise.resolve({
      unique: true,
      outgoingBaseline: {
        fixedOutgoingCount: 0,
        anchor: { messageId: "a".repeat(64), occurrenceOrdinal: 1 },
      },
    }),
    readLatestDirection: () => Promise.resolve("incoming"),
    readComposer: () => Promise.resolve(composer),
    replaceComposerWithFixedMessage: (message: string) => {
      composer = message;
      return Promise.resolve();
    },
    clearComposer: () => {
      composer = "";
      return Promise.resolve();
    },
    submitOnce: async () => {
      await writeFile(acquiredPath, "submit-started\n", { flag: "wx", mode: 0o600 });
      await new Promise<never>(() => undefined);
    },
    readOutgoingFixedMessageAfterBaseline: () => Promise.resolve(false),
    close: () => Promise.resolve({ gateReleased: true }),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`MISSING_${name}`);
  return value;
}
