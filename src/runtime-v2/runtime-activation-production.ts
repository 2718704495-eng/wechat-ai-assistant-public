import path from "node:path";

import { z } from "zod";

import { NativeBridge } from "../adapters/native-bridge.js";
import { NativeWechatSurface } from "../adapters/native-wechat-surface.js";

import { HistoryImporter } from "../application/history-import.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { createLiveProductionRuntime } from "../mcp/live-bootstrap.js";
import { runtimeConsentSchema } from "../mcp/live-runtime.js";
import { readSendGate } from "../mcp/live-runtime.js";
import { MacOSKeychainKeyProvider } from "../security/keychain.js";
import { EncryptedStore } from "../storage/encrypted-store.js";
import { MessageRepository, StateRepository } from "../storage/repositories.js";
import { createProductionAcceptanceDriver } from "./production-acceptance-driver.js";
import {
  assertInstalledCurrentRelease,
  resolvePackagedReleaseBinding,
} from "./release-binding.js";
import { RuntimeActivationService } from "./runtime-activation.js";
import { SingleDispatcherAdmission } from "./single-dispatcher-admission.js";
import { acquireLiveOperationCoordinator } from "../mcp/live-operation-coordinator.js";
import {
  FileAcceptanceRepository,
  hashReleaseBinding,
  SupervisedAcceptanceService,
} from "./supervised-acceptance.js";

const reportSchema = z.object({
  report: z.unknown(),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  approvedHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).strict();

export async function createProductionRuntimeActivationService(options: {
  readonly environment?: Record<string, string | undefined>;
  readonly moduleUrl?: string;
  readonly now?: () => Date;
} = {}): Promise<RuntimeActivationService> {
  const environment = options.environment ?? process.env;
  const config = loadRuntimeConfig(environment);
  if (config.mode !== "live") throw new Error("ACTIVATION_LIVE_MODE_REQUIRED");
  const home = environment.HOME;
  if (home === undefined || home.length === 0) throw new Error("INVALID_RUNTIME_CONFIG");
  const packaged = await resolvePackagedReleaseBinding(options.moduleUrl ?? import.meta.url);
  const runtimeRoot = path.join(config.dataDir, "runtime-v2");
  await assertInstalledCurrentRelease(runtimeRoot, packaged.releaseRoot);

  const store = new EncryptedStore(config.dataDir, new MacOSKeychainKeyProvider());
  const messages = new MessageRepository(store);
  const history = new HistoryImporter(
    store,
    messages,
    path.join(config.dataDir, "state", "history-import-temporary"),
  );
  const state = new StateRepository(store, options.now);
  const acceptanceRepository = new FileAcceptanceRepository(runtimeRoot);
  const activationBindingSha256 = hashReleaseBinding(packaged.binding);
  const acceptance = new SupervisedAcceptanceService({
    repository: acceptanceRepository,
    admission: new SingleDispatcherAdmission({
      acquireOwner: () => createProductionAcceptanceDriver({
        releaseRoot: packaged.releaseRoot,
        dataDir: config.dataDir,
        home,
        environment,
      }),
    }),
  });

  return new RuntimeActivationService({
    binding: packaged.binding,
    prepareReport: () => history.buildReport().then(({ hash }) => ({ hash })),
    approveReport: (hash) => history.approveReport(hash),
    establishBoundary: async () => {
      const runtime = await createLiveProductionRuntime({ ownerKind: "cli" });
      let operationError: unknown;
      let result: unknown;
      try {
        result = await runtime.dependencies.establishControlBoundaryForSupervisor();
      } catch (error: unknown) {
        operationError = error;
      }
      let closeError: unknown;
      try {
        await runtime.close();
      } catch (error: unknown) {
        closeError = error;
      }
      if (operationError !== undefined && closeError !== undefined) {
        throw new AggregateError(
          [asError(operationError), asError(closeError)],
          "ACTIVATION_BOUNDARY_FAILED",
        );
      }
      if (operationError !== undefined) throw asError(operationError);
      if (closeError !== undefined) throw asError(closeError);
      return result;
    },
    runA: (binding) => acceptance.runA(binding),
    runB0: (binding) => acceptance.runB0(binding),
    runB1: (binding, decision) => acceptance.runB1(binding, decision),
    readEvidence: async () => ({
      report: await store.read("profiles/initialization-report.enc", reportSchema),
      control: await state.getControlState(),
      acceptance: await acceptanceRepository.load(),
    }),
    readInspectionEvidence: async () => {
      const control = await state.peekControlState();
      return {
        report: await store.read("profiles/initialization-report.enc", reportSchema),
        control: control ?? {
          stopped: true,
          controlBoundary: { status: "awaiting-boundary" as const },
        },
        acceptance: await acceptanceRepository.load(),
      };
    },
    readConsentBound: async () =>
      (await readSendGate(store, activationBindingSha256)).consentConfirmed,
    runComfortStationAcceptance: async () => {
      const runtime = await createLiveProductionRuntime({ ownerKind: "cli" });
      let operationError: unknown;
      let result: {
        readonly status: "verified" | "already-handled";
        readonly conversationId: "example-contact";
      } | undefined;
      try {
        if (runtime.dependencies.showComfortStationCardForReleaseAcceptance === undefined) {
          throw new Error("COMFORT_STATION_ACCEPTANCE_UNAVAILABLE");
        }
        result = await runtime.dependencies.showComfortStationCardForReleaseAcceptance();
      } catch (error: unknown) {
        operationError = error;
      }
      let closeError: unknown;
      try {
        await runtime.close();
      } catch (error: unknown) {
        closeError = error;
      }
      if (operationError !== undefined && closeError !== undefined) {
        throw new AggregateError(
          [asError(operationError), asError(closeError)],
          "COMFORT_STATION_ACCEPTANCE_FAILED",
        );
      }
      if (operationError !== undefined) throw asError(operationError);
      if (closeError !== undefined) throw asError(closeError);
      if (result === undefined) throw new Error("COMFORT_STATION_ACCEPTANCE_FAILED");
      return result;
    },
    runImageAttachmentQuarantineRecovery: async () => {
      const coordinator = await acquireLiveOperationCoordinator({
        dataDir: runtimeRoot,
        ownerKind: "cli",
      });
      let operationError: unknown;
      let result: Awaited<ReturnType<NativeWechatSurface["recoverImageAttachmentQuarantine"]>> |
        undefined;
      try {
        const surface = new NativeWechatSurface(new NativeBridge({
          executablePath: path.join(
            packaged.releaseRoot,
            "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
          ),
          dataDir: runtimeRoot,
          environment,
        }));
        result = await surface.recoverImageAttachmentQuarantine();
      } catch (error: unknown) {
        operationError = error;
      }
      let closeError: unknown;
      try {
        await coordinator.close();
      } catch (error: unknown) {
        closeError = error;
      }
      if (operationError !== undefined && closeError !== undefined) {
        throw new AggregateError(
          [asError(operationError), asError(closeError)],
          "WECHAT_IMAGE_ATTACHMENT_RECOVERY_FAILED",
        );
      }
      if (operationError !== undefined) throw asError(operationError);
      if (closeError !== undefined) throw asError(closeError);
      if (result === undefined) throw new Error("WECHAT_IMAGE_ATTACHMENT_RECOVERY_FAILED");
      return result;
    },
    writeConsent: (document) => store.write(
      "state/consent.enc",
      runtimeConsentSchema.parse(document),
    ),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("RUNTIME_ACTIVATION_UNKNOWN_FAILURE", { cause: error });
}
