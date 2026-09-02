import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { LiveOwnerKind } from "./live-operation-coordinator.js";
import type { LiveWechatRuntimeDependencies } from "./live-server.js";
import {
  createLiveSupervisorSession,
  liveSupervisorCommandSchema,
  type LiveSupervisorSession,
} from "./live-supervisor-session.js";

const maximumRequestBytes = 8_192;

type BridgeErrorCode =
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "LIVE_BRIDGE_BUSY"
  | "LIVE_BRIDGE_CLOSE_FAILED"
  | "LIVE_BRIDGE_OPERATION_FAILED"
  | "LIVE_BRIDGE_STARTUP_FAILED"
  | "LIVE_BRIDGE_STDIN_ONLY"
  | "REQUEST_TOO_LARGE";

export interface LiveCliBridgeRuntime {
  dependencies: LiveWechatRuntimeDependencies;
  close(): Promise<void>;
}

export interface LiveCliBridgeProcessOptions {
  arguments: readonly string[];
  createRuntime(options: { ownerKind: LiveOwnerKind }): Promise<LiveCliBridgeRuntime>;
  input: Readable;
  output: Writable;
  signals: Pick<NodeJS.EventEmitter, "on" | "off">;
}

export async function runLiveCliBridgeProcess(
  options: LiveCliBridgeProcessOptions,
): Promise<number> {
  if (options.arguments.length > 0) {
    await writeResponse(options.output, failure("LIVE_BRIDGE_STDIN_ONLY"));
    return 1;
  }

  let runtime: LiveCliBridgeRuntime | null = null;
  let session: LiveSupervisorSession | null = null;
  let closePromise: Promise<void> | null = null;
  let shutdownRequested = options.input.readableEnded || options.input.destroyed;
  let phase: "bootstrapping" | "serving" | "closing" = "bootstrapping";
  let exitCode = 0;

  const closeRuntime = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    const assignedRuntime = runtime;
    if (assignedRuntime === null) {
      return Promise.reject(new Error("LIVE_BRIDGE_RUNTIME_NOT_READY"));
    }
    session?.close();
    try {
      closePromise = assignedRuntime.close();
    } catch (error: unknown) {
      closePromise = Promise.reject(asError(error));
    }
    return closePromise;
  };
  const requestShutdown = (): void => {
    shutdownRequested = true;
    session?.close();
    options.input.destroy();
    if (runtime !== null) void closeRuntime().catch(() => undefined);
  };
  const requestBootstrapEofShutdown = (): void => {
    if (phase === "bootstrapping") shutdownRequested = true;
  };

  options.signals.on("SIGINT", requestShutdown);
  options.signals.on("SIGTERM", requestShutdown);
  options.input.on("end", requestBootstrapEofShutdown);
  const inputLines = createInterface({ input: options.input, crlfDelay: Infinity });
  const inputIterator = inputLines[Symbol.asyncIterator]();
  if (options.input.readableEnded || options.input.destroyed) shutdownRequested = true;

  try {
    try {
      runtime = await options.createRuntime({ ownerKind: "cli" });
      session = createLiveSupervisorSession(runtime.dependencies);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } catch (error: unknown) {
      const code = error instanceof Error && error.message === "LIVE_RUNTIME_BUSY"
        ? "LIVE_BRIDGE_BUSY"
        : "LIVE_BRIDGE_STARTUP_FAILED";
      await writeResponse(options.output, failure(code));
      exitCode = 1;
    }

    if (options.input.readableEnded || options.input.destroyed) shutdownRequested = true;

    if (runtime !== null && shutdownRequested) {
      phase = "closing";
      await closeRuntime();
    } else if (runtime !== null && session !== null) {
      phase = "serving";
      await writeResponse(options.output, {
        ok: true,
        type: "ready",
        protocolVersion: 2,
        active: true,
      });
      while (true) {
        const nextLine = await inputIterator.next();
        if (nextLine.done) break;
        const line = nextLine.value;
        if (shutdownRequested) break;
        if (Buffer.byteLength(line, "utf8") > maximumRequestBytes) {
          await writeResponse(options.output, failure("REQUEST_TOO_LARGE"));
          continue;
        }
        const parsed = parseCommand(line);
        if (!parsed.ok) {
          await writeResponse(options.output, parsed.response);
          continue;
        }
        if (parsed.command.op === "close") {
          try {
            session.close();
            await closeRuntime();
            await writeResponse(options.output, success({ closed: true }));
          } catch {
            exitCode = 1;
            await writeResponse(options.output, failure("LIVE_BRIDGE_CLOSE_FAILED"));
          }
          break;
        }
        try {
          const result = await session.execute(parsed.command);
          await writeResponse(options.output, success(result));
        } catch {
          await writeResponse(options.output, failure("LIVE_BRIDGE_OPERATION_FAILED"));
        }
        if (shutdownRequested) break;
      }
    }
  } catch {
    exitCode = 1;
  } finally {
    phase = "closing";
    session?.close();
    try {
      if (runtime !== null) await closeRuntime();
    } catch {
      exitCode = 1;
    } finally {
      inputLines.close();
      options.signals.off("SIGINT", requestShutdown);
      options.signals.off("SIGTERM", requestShutdown);
      options.input.off("end", requestBootstrapEofShutdown);
    }
  }
  return exitCode;
}

function parseCommand(line: string):
  | { ok: true; command: ReturnType<typeof liveSupervisorCommandSchema.parse> }
  | { ok: false; response: { ok: false; error: BridgeErrorCode } } {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return { ok: false, response: failure("INVALID_JSON") };
  }
  const parsed = liveSupervisorCommandSchema.safeParse(value);
  return parsed.success
    ? { ok: true, command: parsed.data }
    : { ok: false, response: failure("INVALID_REQUEST") };
}

function success(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result: result ?? null };
}

function failure(error: BridgeErrorCode): { ok: false; error: BridgeErrorCode } {
  return { ok: false, error };
}

async function writeResponse(output: Writable, response: unknown): Promise<void> {
  const serialized = `${JSON.stringify(response)}\n`;
  if (!output.write(serialized, "utf8")) await once(output, "drain");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("UNKNOWN_ERROR", { cause: error });
}
