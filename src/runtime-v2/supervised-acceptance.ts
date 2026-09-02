import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { acquireKernelLease } from "../storage/kernel-lock.js";

import type {
  DispatcherSession,
  SingleDispatcherAdmission,
} from "./single-dispatcher-admission.js";
import type { DispatcherOwner } from "./single-dispatcher-admission.js";

export const FIXED_ACCEPTANCE_MESSAGE = "测试信息";

const expectedTools = [
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
] as const;

export interface ReleaseBinding {
  readonly payloadManifestSha256: string;
  readonly nativeSha256: string;
  readonly effectiveConfigSha256: string;
}

export type AcceptanceStage = "A" | "B0" | "B1";
export type AcceptanceStatus = "pending" | "invocation-started" | "submit-started" |
  "verified" | "failed" | "submitted-uncertain";

export interface AcceptanceReceipt {
  readonly stage: AcceptanceStage;
  readonly status: Exclude<AcceptanceStatus, "pending">;
  readonly bindingSha256: string;
  readonly target: "file-transfer" | "example-contact";
  readonly messageSha256: string | null;
  readonly invocationCount: number;
  readonly replaceCount: number;
  readonly submitCount: number;
  readonly outgoingBaseline: OutgoingMessageBaseline | null;
  readonly latestDirection?: "incoming" | "outgoing";
  readonly composerEmpty: boolean;
  readonly draftVerified: boolean;
  readonly outgoingVerified: boolean;
  readonly closed: boolean;
  readonly gateReleased: boolean;
}

export interface OutgoingMessageBaseline {
  readonly fixedOutgoingCount: number;
  readonly anchor: {
    readonly messageId: string;
    readonly occurrenceOrdinal: number;
  } | null;
}

export interface AcceptanceState {
  readonly version: 1;
  readonly binding: ReleaseBinding;
  readonly bindingSha256: string;
  readonly stages: Partial<Record<AcceptanceStage, AcceptanceReceipt>>;
}

export interface AcceptanceRepository {
  load(): Promise<AcceptanceState | null>;
  save(state: AcceptanceState): Promise<void>;
  withExclusive?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface AcceptanceDriver extends DispatcherOwner {
  readonly listTools: () => Promise<string[]>;
  readonly locateFixedTarget: (
    target: "file-transfer" | "example-contact",
    expectedMessage: string | null,
  ) => Promise<{ unique: boolean; outgoingBaseline: OutgoingMessageBaseline }>;
  readonly readLatestDirection: () => Promise<"incoming" | "outgoing">;
  readonly readComposer: () => Promise<string>;
  readonly replaceComposerWithFixedMessage: (message: string) => Promise<void>;
  readonly clearComposer: () => Promise<void>;
  readonly submitOnce: () => Promise<void>;
  readonly readOutgoingFixedMessageAfterBaseline: (
    baseline: OutgoingMessageBaseline,
    expectedMessage: string,
  ) => Promise<boolean>;
}

export interface SupervisedAcceptanceServiceOptions {
  readonly repository: AcceptanceRepository;
  readonly admission: SingleDispatcherAdmission<AcceptanceDriver>;
}

export class InMemoryAcceptanceRepository implements AcceptanceRepository {
  private state: AcceptanceState | null = null;
  private tail: Promise<void> = Promise.resolve();

  public load(): Promise<AcceptanceState | null> {
    return Promise.resolve(this.state === null ? null : structuredClone(this.state));
  }

  public save(state: AcceptanceState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }

  public withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class FileAcceptanceRepository implements AcceptanceRepository {
  private readonly runtimeRoot: string;
  private readonly stateDirectory: string;
  private readonly statePath: string;

  public constructor(runtimeRoot: string) {
    if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot) ||
        runtimeRoot.includes("\0") || path.basename(runtimeRoot) !== "runtime-v2") {
      throw new Error("ACCEPTANCE_STATE_ROOT_INVALID");
    }
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.stateDirectory = path.join(this.runtimeRoot, "state");
    this.statePath = path.join(this.stateDirectory, "supervised-acceptance.json");
  }

  public async load(): Promise<AcceptanceState | null> {
    await assertOwnedDirectory(this.runtimeRoot, 0o700);
    try {
      await assertOwnedDirectory(this.stateDirectory, 0o700);
      await assertOwnedRegularFile(this.statePath, 0o600);
      return decodeState(JSON.parse(await readFile(this.statePath, "utf8")) as unknown);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  public async save(state: AcceptanceState): Promise<void> {
    const validated = decodeState(JSON.parse(JSON.stringify(state)) as unknown);
    await assertOwnedDirectory(this.runtimeRoot, 0o700);
    try {
      await mkdir(this.stateDirectory, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    await assertOwnedDirectory(this.stateDirectory, 0o700);
    try {
      await assertOwnedRegularFile(this.statePath, 0o600);
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const temporaryPath = path.join(
      this.stateDirectory,
      `.supervised-acceptance.${randomUUID()}.tmp`,
    );
    const temporary = await open(temporaryPath, "wx", 0o600);
    let temporaryOpen = true;
    try {
      await temporary.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
      await temporary.sync();
      await temporary.close();
      temporaryOpen = false;
      await rename(temporaryPath, this.statePath);
      const directory = await open(this.stateDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await assertOwnedRegularFile(this.statePath, 0o600);
    } finally {
      if (temporaryOpen) await temporary.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  public async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    await assertOwnedDirectory(this.runtimeRoot, 0o700);
    const lease = await acquireKernelLease({
      dataRoot: this.runtimeRoot,
      purpose: "encrypted-store-global",
    });
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await lease.runExclusive(operation);
    } catch (error: unknown) {
      operationError = error;
    }
    let closeError: unknown;
    try { await lease.close(); } catch (error: unknown) { closeError = error; }
    if (operationError !== undefined) throw asError(operationError);
    if (closeError !== undefined) throw asError(closeError);
    return result as T;
  }
}

export class SupervisedAcceptanceService {
  public constructor(private readonly options: SupervisedAcceptanceServiceOptions) {}

  public async runA(binding: ReleaseBinding): Promise<AcceptanceReceipt> {
    return this.exclusive(() => this.runAExclusive(binding));
  }

  private async runAExclusive(binding: ReleaseBinding): Promise<AcceptanceReceipt> {
    const context = await this.begin(binding, "A");
    if (context.existing !== null) return context.existing;
    if (context.recovery !== null) return this.recoverSubmitted(context.state, "A", context.recovery);
    return this.execute(context.state, "A", async (driver, counters) => {
      assertExactTools(await driver.listTools());
      const message = acceptanceMessage("A", context.state.bindingSha256);
      await assertUniqueTarget(driver, "file-transfer", message);
      await prepareAndSubmit(driver, counters, "file-transfer", message);
      return {};
    });
  }

  public async runB0(binding: ReleaseBinding): Promise<AcceptanceReceipt> {
    return this.exclusive(() => this.runB0Exclusive(binding));
  }

  private async runB0Exclusive(binding: ReleaseBinding): Promise<AcceptanceReceipt> {
    const context = await this.begin(binding, "B0");
    if (context.existing !== null) return context.existing;
    if (context.recovery !== null) throw new Error("ACCEPTANCE_STATE_INVALID");
    return this.execute(context.state, "B0", async (driver, counters) => {
      await assertUniqueTarget(driver, "example-contact", null);
      const latestDirection = await driver.readLatestDirection();
      counters.composerEmpty = (await driver.readComposer()) === "";
      if (!counters.composerEmpty) throw new Error("ACCEPTANCE_COMPOSER_NOT_EMPTY");
      return { latestDirection };
    });
  }

  public async runB1(
    binding: ReleaseBinding,
    decision: "approve" | "abort",
  ): Promise<AcceptanceReceipt> {
    return this.exclusive(() => this.runB1Exclusive(binding, decision));
  }

  private async runB1Exclusive(
    binding: ReleaseBinding,
    decision: "approve" | "abort",
  ): Promise<AcceptanceReceipt> {
    if (decision !== "approve" && decision !== "abort") {
      throw new Error("ACCEPTANCE_DECISION_INVALID");
    }
    const context = await this.begin(binding, "B1");
    if (context.existing !== null) return context.existing;
    if (context.recovery !== null) return this.recoverSubmitted(context.state, "B1", context.recovery);
    return this.execute(context.state, "B1", async (driver, counters) => {
      const message = acceptanceMessage("B1", context.state.bindingSha256);
      await assertUniqueTarget(driver, "example-contact", message);
      if (decision === "abort") throw new AcceptanceAbortError();
      await prepareAndSubmit(driver, counters, "example-contact", message);
      return {};
    });
  }

  private async begin(
    binding: ReleaseBinding,
    stage: AcceptanceStage,
  ): Promise<{
    state: AcceptanceState;
    existing: AcceptanceReceipt | null;
    recovery: AcceptanceReceipt | null;
  }> {
    const normalizedBinding = validateBinding(binding);
    const bindingSha256 = hashReleaseBinding(normalizedBinding);
    const loaded = await this.options.repository.load();
    if (loaded === null) {
      if (stage !== "A") throw new Error("ACCEPTANCE_STAGE_ORDER_INVALID");
      return {
        state: { version: 1, binding: normalizedBinding, bindingSha256, stages: {} },
        existing: null,
        recovery: null,
      };
    }
    if (loaded.bindingSha256 !== bindingSha256 ||
        hashReleaseBinding(validateBinding(loaded.binding)) !== bindingSha256) {
      if (stage !== "A") throw new Error("ACCEPTANCE_BINDING_MISMATCH");
      return {
        state: { version: 1, binding: normalizedBinding, bindingSha256, stages: {} },
        existing: null,
        recovery: null,
      };
    }
    const existing = loaded.stages[stage] ?? null;
    if (existing?.status === "verified") return { state: loaded, existing, recovery: null };
    if (existing?.status === "submit-started" || existing?.status === "submitted-uncertain") {
      return { state: loaded, existing: null, recovery: existing };
    }
    const preSubmitRetryLimit = stage === "B0" ? 3 : 2;
    if ((existing?.invocationCount ?? 0) >= preSubmitRetryLimit) {
      throw new Error("ACCEPTANCE_RETRY_LIMIT_EXHAUSTED");
    }
    if (stage === "B0" && loaded.stages.A?.status !== "verified") {
      throw new Error("ACCEPTANCE_STAGE_ORDER_INVALID");
    }
    if (stage === "B1" &&
        (loaded.stages.A?.status !== "verified" || loaded.stages.B0?.status !== "verified")) {
      throw new Error("ACCEPTANCE_STAGE_ORDER_INVALID");
    }
    return { state: loaded, existing: null, recovery: null };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.repository.withExclusive?.(operation) ?? operation();
  }

  private async recoverSubmitted(
    state: AcceptanceState,
    stage: "A" | "B1",
    previous: AcceptanceReceipt,
  ): Promise<AcceptanceReceipt> {
    const invocationCount = previous.invocationCount + 1;
    if (invocationCount > 3) throw new Error("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    const baseline = previous.outgoingBaseline;
    if (baseline === null) throw new Error("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    const message = acceptanceMessage(stage, state.bindingSha256);
    if (previous.messageSha256 !== sha256(message)) {
      throw new Error("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    }
    await this.options.repository.save({
      ...state,
      stages: { ...state.stages, [stage]: { ...previous, invocationCount } },
    });
    const session = await this.options.admission.admit("acceptance");
    let outgoingVerified = false;
    let operationError: unknown;
    let closed = false;
    let gateReleased = false;
    try {
      await assertUniqueTarget(
        session.owner,
        stage === "A" ? "file-transfer" : "example-contact",
        message,
      );
      outgoingVerified = await session.owner.readOutgoingFixedMessageAfterBaseline(
        baseline,
        message,
      );
    } catch (error: unknown) {
      operationError = error;
    }
    try {
      const closeReceipt = await session.close();
      closed = closeReceipt.closed;
      gateReleased = closeReceipt.gateReleased;
    } catch (error: unknown) {
      operationError = combineOperationErrors(
        operationError,
        error,
        "ACCEPTANCE_RECOVERY_CLEANUP_FAILED",
      );
    }
    const receipt: AcceptanceReceipt = Object.freeze({
      ...previous,
      status: outgoingVerified && operationError === undefined && gateReleased
        ? "verified"
        : "submitted-uncertain",
      invocationCount,
      outgoingVerified,
      closed,
      gateReleased,
    });
    await this.options.repository.save({
      ...state,
      stages: { ...state.stages, [stage]: receipt },
    });
    if (receipt.status !== "verified") throw new Error("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    return receipt;
  }

  private async execute(
    state: AcceptanceState,
    stage: AcceptanceStage,
    operation: (
      driver: AcceptanceDriver,
      counters: MutableCounters,
    ) => Promise<{ latestDirection?: "incoming" | "outgoing" }>,
  ): Promise<AcceptanceReceipt> {
    const previous = state.stages[stage];
    const target = stage === "A" ? "file-transfer" : "example-contact";
    const message = acceptanceMessage(stage, state.bindingSha256);
    const messageSha256 = message === null ? null : sha256(message);
    const counters: MutableCounters = {
      invocationCount: (previous?.invocationCount ?? 0) + 1,
      replaceCount: 0,
      submitCount: 0,
      outgoingBaseline: null,
      composerEmpty: false,
      draftVerified: false,
      outgoingVerified: false,
      beforeSubmit: async () => {
        const started: AcceptanceReceipt = Object.freeze({
          stage,
          status: "submit-started",
          bindingSha256: state.bindingSha256,
          target,
          messageSha256,
          invocationCount: counters.invocationCount,
          replaceCount: counters.replaceCount,
          submitCount: 0,
          outgoingBaseline: counters.outgoingBaseline,
          composerEmpty: counters.composerEmpty,
          draftVerified: counters.draftVerified,
          outgoingVerified: false,
          closed: false,
          gateReleased: false,
        });
        await this.options.repository.save({
          ...state,
          stages: { ...state.stages, [stage]: started },
        });
      },
    };
    await this.options.repository.save({
      ...state,
      stages: {
        ...state.stages,
        [stage]: Object.freeze({
          stage,
          status: "invocation-started" as const,
          bindingSha256: state.bindingSha256,
          target,
          messageSha256,
          invocationCount: counters.invocationCount,
          replaceCount: 0,
          submitCount: 0,
          outgoingBaseline: null,
          composerEmpty: false,
          draftVerified: false,
          outgoingVerified: false,
          closed: false,
          gateReleased: false,
        }),
      },
    });
    let session: DispatcherSession<AcceptanceDriver> | null = null;
    let result: { latestDirection?: "incoming" | "outgoing" } = {};
    let operationError: unknown;
    try {
      session = await this.options.admission.admit("acceptance");
      result = await operation(session.owner, counters);
    } catch (error: unknown) {
      operationError = error;
    }

    if (operationError !== undefined && session !== null &&
        counters.replaceCount === 1 && counters.submitCount === 0) {
      try {
        await session.owner.clearComposer();
        counters.composerEmpty = (await session.owner.readComposer()) === "";
        if (!counters.composerEmpty) throw new Error("ACCEPTANCE_DRAFT_CLEAR_UNPROVEN");
      } catch (error: unknown) {
        operationError = combineOperationErrors(
          operationError,
          error,
          "ACCEPTANCE_DRAFT_CLEANUP_FAILED",
        );
      }
    }

    let closed = false;
    let gateReleased = false;
    let closeError: unknown;
    if (session !== null) {
      try {
        const closeReceipt = await session.close();
        closed = closeReceipt.closed;
        gateReleased = closeReceipt.gateReleased;
      } catch (error: unknown) {
        closeError = error;
      }
    }

    const submitted = counters.submitCount > 0;
    const status: AcceptanceReceipt["status"] =
      submitted && (operationError !== undefined || closeError !== undefined ||
        !counters.outgoingVerified || !gateReleased)
        ? "submitted-uncertain"
        : operationError === undefined && closeError === undefined && gateReleased
          ? "verified"
          : "failed";
    const receipt: AcceptanceReceipt = Object.freeze({
      stage,
      status,
      bindingSha256: state.bindingSha256,
      target,
      messageSha256,
      invocationCount: counters.invocationCount,
      replaceCount: counters.replaceCount,
      submitCount: counters.submitCount,
      outgoingBaseline: counters.outgoingBaseline,
      ...(result.latestDirection === undefined ? {} : { latestDirection: result.latestDirection }),
      composerEmpty: counters.composerEmpty,
      draftVerified: counters.draftVerified,
      outgoingVerified: counters.outgoingVerified,
      closed,
      gateReleased,
    });
    await this.options.repository.save({
      ...state,
      stages: { ...state.stages, [stage]: receipt },
    });
    if (closeError !== undefined) {
      throw combineOperationErrors(
        operationError,
        closeError,
        "ACCEPTANCE_OPERATION_CLEANUP_FAILED",
      );
    }
    if (status === "submitted-uncertain") throw new Error("ACCEPTANCE_SUBMIT_RESULT_UNCERTAIN");
    if (operationError instanceof AcceptanceAbortError) return receipt;
    if (operationError !== undefined) throw asError(operationError);
    return receipt;
  }
}

interface MutableCounters {
  invocationCount: number;
  replaceCount: number;
  submitCount: number;
  outgoingBaseline: OutgoingMessageBaseline | null;
  composerEmpty: boolean;
  draftVerified: boolean;
  outgoingVerified: boolean;
  beforeSubmit: () => Promise<void>;
}

async function prepareAndSubmit(
  driver: AcceptanceDriver,
  counters: MutableCounters,
  target: "file-transfer" | "example-contact",
  message: string,
): Promise<void> {
  counters.composerEmpty = (await driver.readComposer()) === "";
  if (!counters.composerEmpty) throw new Error("ACCEPTANCE_COMPOSER_NOT_EMPTY");
  await driver.replaceComposerWithFixedMessage(message);
  counters.replaceCount = 1;
  counters.draftVerified = (await driver.readComposer()) === message;
  if (!counters.draftVerified) throw new Error("ACCEPTANCE_DRAFT_MISMATCH");
  counters.outgoingBaseline = await assertUniqueTarget(driver, target, message);
  await counters.beforeSubmit();
  counters.submitCount = 1;
  await driver.submitOnce();
  counters.outgoingVerified = await driver.readOutgoingFixedMessageAfterBaseline(
    counters.outgoingBaseline,
    message,
  );
  if (!counters.outgoingVerified) throw new Error("ACCEPTANCE_OUTGOING_MISMATCH");
}

async function assertUniqueTarget(
  driver: AcceptanceDriver,
  target: "file-transfer" | "example-contact",
  expectedMessage: string | null,
): Promise<OutgoingMessageBaseline> {
  const located = await driver.locateFixedTarget(target, expectedMessage);
  if (located.unique !== true) {
    throw new Error("ACCEPTANCE_TARGET_NOT_UNIQUE");
  }
  return validateOutgoingBaseline(located.outgoingBaseline);
}

function assertExactTools(actual: string[]): void {
  if ([...actual].sort().join("\0") !== [...expectedTools].sort().join("\0")) {
    throw new Error("ACCEPTANCE_TOOL_INVENTORY_MISMATCH");
  }
}

function validateBinding(binding: ReleaseBinding): ReleaseBinding {
  if (!isPlainRecord(binding) || !hasExactKeys(binding, [
    "payloadManifestSha256",
    "nativeSha256",
    "effectiveConfigSha256",
  ])) {
    throw new Error("ACCEPTANCE_RELEASE_BINDING_INVALID");
  }
  const values = [
    binding?.payloadManifestSha256,
    binding?.nativeSha256,
    binding?.effectiveConfigSha256,
  ];
  if (!values.every((value) => /^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("ACCEPTANCE_RELEASE_BINDING_INVALID");
  }
  return Object.freeze({
    payloadManifestSha256: binding.payloadManifestSha256,
    nativeSha256: binding.nativeSha256,
    effectiveConfigSha256: binding.effectiveConfigSha256,
  });
}

function validateOutgoingBaseline(value: unknown): OutgoingMessageBaseline {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["fixedOutgoingCount", "anchor"]) ||
      !isBoundedCount(value["fixedOutgoingCount"], 0, 10_000)) {
    throw new Error("ACCEPTANCE_OUTGOING_BASELINE_INVALID");
  }
  const anchor = value["anchor"];
  if (anchor !== null &&
      (!isPlainRecord(anchor) || !hasExactKeys(anchor, ["messageId", "occurrenceOrdinal"]) ||
        typeof anchor["messageId"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(anchor["messageId"]) ||
        !isBoundedCount(anchor["occurrenceOrdinal"], 1, 10_000))) {
    throw new Error("ACCEPTANCE_OUTGOING_BASELINE_INVALID");
  }
  return Object.freeze({
    fixedOutgoingCount: value["fixedOutgoingCount"],
    anchor: anchor === null ? null : Object.freeze({
      messageId: anchor["messageId"] as string,
      occurrenceOrdinal: anchor["occurrenceOrdinal"] as number,
    }),
  });
}

function decodeState(value: unknown): AcceptanceState {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "version", "binding", "bindingSha256", "stages",
  ]) || value["version"] !== 1 ||
      !isPlainRecord(value["binding"]) || typeof value["bindingSha256"] !== "string" ||
      !isPlainRecord(value["stages"])) {
    throw new Error("ACCEPTANCE_STATE_INVALID");
  }
  const binding = validateBinding(value["binding"] as unknown as ReleaseBinding);
  const bindingSha256 = hashReleaseBinding(binding);
  if (value["bindingSha256"] !== bindingSha256) throw new Error("ACCEPTANCE_STATE_INVALID");
  const rawStages = value["stages"];
  if (Object.keys(rawStages).some((key) => key !== "A" && key !== "B0" && key !== "B1")) {
    throw new Error("ACCEPTANCE_STATE_INVALID");
  }
  const stages: Partial<Record<AcceptanceStage, AcceptanceReceipt>> = {};
  for (const stage of ["A", "B0", "B1"] as const) {
    const raw = rawStages[stage];
    if (raw !== undefined) stages[stage] = decodeReceipt(raw, stage, bindingSha256);
  }
  return { version: 1, binding, bindingSha256, stages };
}

function decodeReceipt(
  value: unknown,
  stage: AcceptanceStage,
  bindingSha256: string,
): AcceptanceReceipt {
  if (!isPlainRecord(value)) throw new Error("ACCEPTANCE_STATE_INVALID");
  const hasOutgoingBaseline = Object.hasOwn(value, "outgoingBaseline");
  if (!hasExactKeys(value, [
    "stage", "status", "bindingSha256", "target", "messageSha256", "invocationCount",
    "replaceCount", ...(hasOutgoingBaseline ? ["outgoingBaseline"] : []),
    "submitCount", "composerEmpty", "draftVerified", "outgoingVerified", "closed",
    "gateReleased", ...(value["latestDirection"] === undefined ? [] : ["latestDirection"]),
  ]) || value["stage"] !== stage ||
      !["invocation-started", "submit-started", "verified", "failed", "submitted-uncertain"].includes(
        String(value["status"]),
      ) ||
      value["bindingSha256"] !== bindingSha256 ||
      value["target"] !== (stage === "A" ? "file-transfer" : "example-contact") ||
      !isExpectedMessageSha256(value["messageSha256"], stage, bindingSha256) ||
      (!isBoundedCount(value["invocationCount"], 1, stage === "B0" ? 3 : 2) &&
        !isThirdReadbackReceipt(value, stage)) ||
      !isBoundedCount(value["replaceCount"], 0, 1) ||
      !isBoundedCount(value["submitCount"], 0, 1) ||
      typeof value["composerEmpty"] !== "boolean" ||
      typeof value["draftVerified"] !== "boolean" ||
      typeof value["outgoingVerified"] !== "boolean" ||
      typeof value["closed"] !== "boolean" || typeof value["gateReleased"] !== "boolean" ||
      (value["latestDirection"] !== undefined && value["latestDirection"] !== "incoming" &&
        value["latestDirection"] !== "outgoing")) {
    throw new Error("ACCEPTANCE_STATE_INVALID");
  }
  let outgoingBaseline: OutgoingMessageBaseline | null = null;
  if (hasOutgoingBaseline && value["outgoingBaseline"] !== null) {
    try {
      outgoingBaseline = validateOutgoingBaseline(value["outgoingBaseline"]);
    } catch {
      throw new Error("ACCEPTANCE_STATE_INVALID");
    }
  }
  if (stage === "B0" && outgoingBaseline !== null) {
    throw new Error("ACCEPTANCE_STATE_INVALID");
  }
  if (hasOutgoingBaseline && stage !== "B0" &&
      ["submit-started", "submitted-uncertain", "verified"].includes(String(value["status"])) &&
      outgoingBaseline === null) {
    throw new Error("ACCEPTANCE_STATE_INVALID");
  }
  if (value["outgoingVerified"] === true && outgoingBaseline === null && hasOutgoingBaseline) {
    throw new Error("ACCEPTANCE_STATE_INVALID");
  }
  return Object.freeze({
    ...(structuredClone(value) as unknown as Omit<AcceptanceReceipt, "outgoingBaseline">),
    outgoingBaseline,
  });
}

function isThirdReadbackReceipt(
  value: Record<string, unknown>,
  stage: AcceptanceStage,
): boolean {
  if (value["invocationCount"] !== 3 || stage === "B0" ||
      !["submit-started", "submitted-uncertain", "verified"].includes(String(value["status"])) ||
      value["replaceCount"] !== 1 || value["composerEmpty"] !== true ||
      value["draftVerified"] !== true) {
    return false;
  }
  return value["status"] !== "verified" ||
    (value["outgoingVerified"] === true && value["closed"] === true &&
      value["gateReleased"] === true);
}

function isBoundedCount(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

async function assertOwnedDirectory(candidate: string, expectedMode: number): Promise<void> {
  const status = await lstat(candidate);
  if (!status.isDirectory() || status.isSymbolicLink() || !isCurrentOwner(status.uid) ||
      (Number(status.mode) & 0o777) !== expectedMode) {
    throw new Error("ACCEPTANCE_STATE_PATH_INVALID");
  }
}

async function assertOwnedRegularFile(candidate: string, expectedMode: number): Promise<void> {
  const status = await lstat(candidate);
  if (!status.isFile() || status.isSymbolicLink() || !isCurrentOwner(status.uid) ||
      (Number(status.mode) & 0o777) !== expectedMode) {
    throw new Error("ACCEPTANCE_STATE_PATH_INVALID");
  }
}

function isCurrentOwner(uid: number): boolean {
  return typeof process.getuid === "function" && process.getuid() === uid;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.every((key): key is string => typeof key === "string") &&
    actual.length === expected.length &&
    [...actual].sort().every((key, index) => key === [...expected].sort()[index]);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function hashReleaseBinding(binding: ReleaseBinding): string {
  const normalized = validateBinding(binding);
  return createHash("sha256").update(JSON.stringify({
    effectiveConfigSha256: normalized.effectiveConfigSha256,
    nativeSha256: normalized.nativeSha256,
    payloadManifestSha256: normalized.payloadManifestSha256,
  })).digest("hex");
}

function acceptanceMessage(stage: "A" | "B1", bindingSha256: string): string;
function acceptanceMessage(stage: "B0", bindingSha256: string): null;
function acceptanceMessage(stage: AcceptanceStage, bindingSha256: string): string | null;
function acceptanceMessage(
  stage: AcceptanceStage,
  bindingSha256: string,
): string | null {
  if (stage === "B0") return null;
  if (stage === "B1") return `测试信息 R-${bindingSha256.slice(0, 12)}`;
  return `测试信息 A-${bindingSha256.slice(0, 12)}`;
}

function isExpectedMessageSha256(
  value: unknown,
  stage: AcceptanceStage,
  bindingSha256: string,
): boolean {
  const expected = acceptanceMessage(stage, bindingSha256);
  if (expected === null) return value === null;
  if (value === sha256(expected)) return true;
  return (stage === "A" || stage === "B1") && value === sha256(FIXED_ACCEPTANCE_MESSAGE);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class AcceptanceAbortError extends Error {
  public constructor() { super("ACCEPTANCE_ABORTED"); }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("ACCEPTANCE_OPERATION_FAILED", { cause: error });
}

function combineOperationErrors(
  primary: unknown,
  next: unknown,
  message: string,
): Error {
  if (primary === undefined) return asError(next);
  const primaryErrors = primary instanceof AggregateError
    ? primary.errors.map(asError)
    : [asError(primary)];
  const nextErrors = next instanceof AggregateError
    ? next.errors.map(asError)
    : [asError(next)];
  return new AggregateError([...primaryErrors, ...nextErrors], message);
}
