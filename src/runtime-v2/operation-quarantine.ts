import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export interface OperationQuarantineRepository {
  assertClear(): Promise<void>;
  beginTerminalBarrier(input: OperationTerminalBarrierInput): Promise<void>;
  clearTerminalBarrier(input: OperationTerminalBarrierInput): Promise<void>;
  quarantine(input: OperationQuarantineInput): Promise<void>;
}

export interface OperationTerminalBarrierInput {
  readonly lane: "p0" | "p1";
  readonly cycleId: string;
  readonly releaseSha256: string;
  readonly draftPending: boolean;
  readonly submitUncertain: boolean;
}

export interface OperationQuarantineInput {
  readonly lane: "p0" | "p1";
  readonly reason: string;
  readonly cycleId: string;
  readonly releaseSha256: string;
  readonly draftPending: boolean;
  readonly submitUncertain: boolean;
  readonly outcomeCause: string;
}

export class InMemoryOperationQuarantineRepository implements OperationQuarantineRepository {
  private quarantined = false;
  private terminalBarrier: OperationTerminalBarrierInput | null = null;

  public assertClear(): Promise<void> {
    if (this.quarantined || this.terminalBarrier !== null) {
      return Promise.reject(new Error("FIXED_HEARTBEAT_DURABLE_QUARANTINE"));
    }
    return Promise.resolve();
  }

  public beginTerminalBarrier(input: OperationTerminalBarrierInput): Promise<void> {
    assertTerminalBarrierInput(input);
    if (this.terminalBarrier !== null) {
      return Promise.reject(new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_ACTIVE"));
    }
    this.terminalBarrier = { ...input };
    return Promise.resolve();
  }

  public clearTerminalBarrier(input: OperationTerminalBarrierInput): Promise<void> {
    assertTerminalBarrierInput(input);
    if (this.terminalBarrier === null ||
        JSON.stringify(this.terminalBarrier) !== JSON.stringify(input)) {
      return Promise.reject(new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID"));
    }
    this.terminalBarrier = null;
    return Promise.resolve();
  }

  public quarantine(input: OperationQuarantineInput): Promise<void> {
    assertQuarantineInput(input);
    this.quarantined = true;
    return Promise.resolve();
  }
}

export class FileOperationQuarantineRepository implements OperationQuarantineRepository {
  private readonly stateDirectory: string;
  private readonly quarantinePath: string;
  private readonly terminalBarrierPath: string;
  private readonly terminalBarrierClearPendingPath: string;
  private readonly syncDirectoryHook: (directory: string, stage: string) => Promise<void>;

  public constructor(dataRoot: string, options: {
    syncDirectory?: (directory: string, stage: string) => Promise<void>;
  } = {}) {
    if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot) || dataRoot.includes("\0")) {
      throw new Error("FIXED_HEARTBEAT_QUARANTINE_ROOT_INVALID");
    }
    this.stateDirectory = path.join(path.resolve(dataRoot), "state");
    this.quarantinePath = path.join(this.stateDirectory, "fixed-heartbeat-quarantine.json");
    this.terminalBarrierPath = path.join(
      this.stateDirectory,
      "fixed-heartbeat-terminal-barrier.json",
    );
    this.terminalBarrierClearPendingPath = path.join(
      this.stateDirectory,
      "fixed-heartbeat-terminal-barrier-clear-pending.json",
    );
    this.syncDirectoryHook = options.syncDirectory ??
      ((directory) => syncDirectory(directory));
  }

  public async assertClear(): Promise<void> {
    await this.assertNoRecord(this.terminalBarrierPath, decodeTerminalBarrierRecord);
    await this.assertNoRecord(this.quarantinePath, decodeQuarantineRecord);
    const receipt = await this.readClearRecordIfPresent(this.terminalBarrierClearPendingPath);
    if (receipt === null) return;
    if (receipt.phase !== "cleared") {
      throw new Error("FIXED_HEARTBEAT_DURABLE_QUARANTINE");
    }
  }

  public async beginTerminalBarrier(input: OperationTerminalBarrierInput): Promise<void> {
    assertTerminalBarrierInput(input);
    await this.ensureStateDirectory();
    await this.retireCompletedClearReceipt();
    const record = `${JSON.stringify({
      version: 1,
      ...input,
      recordedAt: new Date().toISOString(),
    })}\n`;
    const handle = await open(this.terminalBarrierPath, "wx", 0o600).catch((error) => {
      throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_ACTIVE", { cause: error });
    });
    try {
      await handle.writeFile(record);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectoryHook(this.stateDirectory, "barrier-created");
  }

  public async clearTerminalBarrier(input: OperationTerminalBarrierInput): Promise<void> {
    assertTerminalBarrierInput(input);
    await this.ensureStateDirectory();
    let pending = await this.readClearRecordIfPresent(this.terminalBarrierClearPendingPath);
    if (pending?.phase === "cleared") {
      if (!sameTerminalBarrier(pending.barrier, input)) {
        throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
      }
      return;
    }
    if (pending === null) {
      const identity = await readOwnedRecordIdentity(this.terminalBarrierPath,
        "FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
      const record = decodeTerminalBarrierRecord(
        JSON.parse(await readFile(this.terminalBarrierPath, "utf8")),
      );
      if (!sameTerminalBarrier(record, input)) {
        throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
      }
      pending = {
        version: 1,
        phase: "pending",
        barrier: { ...input },
        barrierDevice: String(identity.dev),
        barrierInode: String(identity.ino),
        recordedAt: new Date().toISOString(),
      };
      await writeDurableExclusiveRecord(
        this.terminalBarrierClearPendingPath,
        pending,
      );
      await this.syncDirectoryHook(this.stateDirectory, "barrier-clear-pending-created");
    } else if (pending.phase !== "pending" || !sameTerminalBarrier(pending.barrier, input)) {
      throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
    }

    try {
      const finalIdentity = await lstat(this.terminalBarrierPath);
      if (!finalIdentity.isFile() || finalIdentity.isSymbolicLink() ||
          String(finalIdentity.dev) !== pending.barrierDevice ||
          String(finalIdentity.ino) !== pending.barrierInode || finalIdentity.uid !== currentUid()) {
        throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
      }
      await unlink(this.terminalBarrierPath);
      await this.syncDirectoryHook(this.stateDirectory, "barrier-unlinked");
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    await rewriteDurableOwnedRecord(this.terminalBarrierClearPendingPath, {
      ...pending,
      phase: "cleared",
    });
  }

  public async quarantine(input: OperationQuarantineInput): Promise<void> {
    assertQuarantineInput(input);
    await this.ensureStateDirectory();
    const temporaryPath = path.join(this.stateDirectory, `.quarantine-${randomUUID()}.tmp`);
    const temporary = await open(temporaryPath, "wx", 0o600);
    try {
      await temporary.writeFile(`${JSON.stringify({
        version: 2,
        ...input,
        recordedAt: new Date().toISOString(),
      })}\n`);
      await temporary.sync();
      await temporary.close();
      await rename(temporaryPath, this.quarantinePath);
      await this.syncDirectoryHook(this.stateDirectory, "quarantine-created");
    } finally {
      await temporary.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async assertNoRecord(
    recordPath: string,
    decode: (value: unknown) => unknown,
  ): Promise<void> {
    try {
      await readOwnedRecordIdentity(recordPath, "FIXED_HEARTBEAT_QUARANTINE_INVALID");
      decode(JSON.parse(await readFile(recordPath, "utf8")));
      throw new Error("FIXED_HEARTBEAT_DURABLE_QUARANTINE");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }

  private async ensureStateDirectory(): Promise<void> {
    try {
      await mkdir(this.stateDirectory, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    const directoryIdentity = await lstat(this.stateDirectory);
    if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink() ||
        directoryIdentity.uid !== currentUid() || (directoryIdentity.mode & 0o777) !== 0o700) {
      throw new Error("FIXED_HEARTBEAT_QUARANTINE_PATH_INVALID");
    }
  }

  private async readClearRecordIfPresent(filePath: string): Promise<TerminalBarrierClearRecord | null> {
    try {
      await readOwnedRecordIdentity(filePath, "FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
      return decodeTerminalBarrierClearRecord(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async retireCompletedClearReceipt(): Promise<void> {
    const receipt = await this.readClearRecordIfPresent(this.terminalBarrierClearPendingPath);
    if (receipt === null) return;
    if (receipt.phase !== "cleared") {
      throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_ACTIVE");
    }
    await unlink(this.terminalBarrierClearPendingPath);
    await this.syncDirectoryHook(this.stateDirectory, "barrier-clear-pending-retired");
  }
}

interface TerminalBarrierClearRecord {
  readonly version: 1;
  readonly phase: "pending" | "cleared";
  readonly barrier: OperationTerminalBarrierInput;
  readonly barrierDevice: string;
  readonly barrierInode: string;
  readonly recordedAt: string;
}

function assertTerminalBarrierInput(input: OperationTerminalBarrierInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
      Reflect.ownKeys(input).sort().join(",") !==
        "cycleId,draftPending,lane,releaseSha256,submitUncertain" ||
      (input.lane !== "p0" && input.lane !== "p1") ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(input.cycleId) ||
      !/^[a-f0-9]{64}$/u.test(input.releaseSha256) ||
      typeof input.draftPending !== "boolean" || typeof input.submitUncertain !== "boolean") {
    throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INPUT_INVALID");
  }
}

function assertQuarantineInput(input: OperationQuarantineInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
      Reflect.ownKeys(input).sort().join(",") !==
        "cycleId,draftPending,lane,outcomeCause,reason,releaseSha256,submitUncertain" ||
      (input.lane !== "p0" && input.lane !== "p1") ||
      !/^[A-Z0-9_]{1,80}$/u.test(input.reason) ||
      !/^[A-Z0-9_]{1,80}$/u.test(input.outcomeCause) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(input.cycleId) ||
      !/^[a-f0-9]{64}$/u.test(input.releaseSha256) ||
      typeof input.draftPending !== "boolean" || typeof input.submitUncertain !== "boolean") {
    throw new Error("FIXED_HEARTBEAT_QUARANTINE_INPUT_INVALID");
  }
}

function decodeQuarantineRecord(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FIXED_HEARTBEAT_QUARANTINE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).sort().join(",") !==
      "cycleId,draftPending,lane,outcomeCause,reason,recordedAt,releaseSha256,submitUncertain,version" ||
      record.version !== 2 || typeof record.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new Error("FIXED_HEARTBEAT_QUARANTINE_INVALID");
  }
  assertQuarantineInput(record as unknown as OperationQuarantineInput);
}

function decodeTerminalBarrierRecord(value: unknown): OperationTerminalBarrierInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).sort().join(",") !==
      "cycleId,draftPending,lane,recordedAt,releaseSha256,submitUncertain,version" ||
      record.version !== 1 || typeof record.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
  }
  const input = {
    lane: record.lane,
    cycleId: record.cycleId,
    releaseSha256: record.releaseSha256,
    draftPending: record.draftPending,
    submitUncertain: record.submitUncertain,
  } as OperationTerminalBarrierInput;
  assertTerminalBarrierInput(input);
  return input;
}

function decodeTerminalBarrierClearRecord(value: unknown): TerminalBarrierClearRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).sort().join(",") !==
      "barrier,barrierDevice,barrierInode,phase,recordedAt,version" || record.version !== 1 ||
      (record.phase !== "pending" && record.phase !== "cleared") ||
      typeof record.barrierDevice !== "string" || !/^\d+$/u.test(record.barrierDevice) ||
      typeof record.barrierInode !== "string" || !/^\d+$/u.test(record.barrierInode) ||
      typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
  }
  const barrier = record.barrier as OperationTerminalBarrierInput;
  assertTerminalBarrierInput(barrier);
  return {
    version: 1,
    phase: record.phase,
    barrier,
    barrierDevice: record.barrierDevice,
    barrierInode: record.barrierInode,
    recordedAt: record.recordedAt,
  };
}

function sameTerminalBarrier(
  left: OperationTerminalBarrierInput,
  right: OperationTerminalBarrierInput,
): boolean {
  return left.lane === right.lane && left.cycleId === right.cycleId &&
    left.releaseSha256 === right.releaseSha256 && left.draftPending === right.draftPending &&
    left.submitUncertain === right.submitUncertain;
}

async function writeDurableExclusiveRecord(filePath: string, value: unknown): Promise<void> {
  const handle = await open(filePath, "wx", 0o600).catch((error) => {
    throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID", { cause: error });
  });
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function rewriteDurableOwnedRecord(filePath: string, value: unknown): Promise<void> {
  const before = await readOwnedRecordIdentity(
    filePath,
    "FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID",
  );
  const handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== currentUid()) {
      throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
    }
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== currentUid()) {
      throw new Error("FIXED_HEARTBEAT_TERMINAL_BARRIER_INVALID");
    }
  } finally {
    await handle.close();
  }
}

async function readOwnedRecordIdentity(filePath: string, code: string) {
  const identity = await lstat(filePath);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.uid !== currentUid() ||
      (identity.mode & 0o777) !== 0o600 || identity.nlink !== 1) {
    throw new Error(code);
  }
  return identity;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("FIXED_HEARTBEAT_QUARANTINE_OWNER_UNVERIFIED");
  }
  return process.getuid();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
