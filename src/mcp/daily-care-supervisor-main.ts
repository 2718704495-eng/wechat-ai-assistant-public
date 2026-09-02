import type { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import {
  createDailyCareProductionService,
  type DailyCareProductionRuntime,
} from "./daily-care-bootstrap.js";
import {
  connectDailyCareProductionMcpStdio,
  type DailyCareMcpLifecycle,
} from "./daily-care-mcp-server.js";
import type { DailyCareProductionRuntimeDependencies } from "./daily-care-session.js";

interface DailyCareServerHandle {
  server: { onclose?: () => void };
  close(): Promise<void>;
}

export interface StartDailyCareSupervisorOptions {
  environment?: Record<string, string | undefined>;
  input?: Pick<EventEmitter, "once">;
  signals?: Pick<EventEmitter, "once">;
  createRuntime?: (
    environment: Record<string, string | undefined>,
  ) => Promise<DailyCareProductionRuntime>;
  connect?: (
    runtime: DailyCareProductionRuntimeDependencies,
    lifecycle: DailyCareMcpLifecycle,
  ) => Promise<DailyCareServerHandle>;
  reportFailure?: () => void;
}

export async function startDailyCareSupervisor(
  options: StartDailyCareSupervisorOptions = {},
): Promise<{ close(): Promise<void> }> {
  const environment = options.environment ?? process.env;
  const input = options.input ?? process.stdin;
  const signals = options.signals ?? process;
  const createRuntime = options.createRuntime ?? createDailyCareProductionService;
  const connect = options.connect ?? connectDailyCareProductionMcpStdio;
  const reportFailure = options.reportFailure ?? defaultReportFailure;
  const runtime = await createRuntime(environment);
  let server: DailyCareServerHandle | null = null;
  let shutdown: Promise<void> | null = null;
  const closeAll = (): Promise<void> => {
    if (shutdown !== null) return shutdown;
    shutdown = (async () => {
      const errors: Error[] = [];
      try {
        await server?.close();
      } catch (error: unknown) {
        errors.push(asError(error));
      }
      try {
        await runtime.close();
      } catch (error: unknown) {
        errors.push(asError(error));
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "DAILY_CARE_SUPERVISOR_CLOSE_FAILED");
      }
    })();
    return shutdown;
  };
  try {
    server = await connect(runtime.dependencies, { onCloseRequested: closeAll });
    server.server.onclose = () => { void runtime.close().catch(reportFailure); };
    input.once("end", () => { void closeAll().catch(reportFailure); });
    signals.once("SIGINT", () => { void closeAll().catch(reportFailure); });
    signals.once("SIGTERM", () => { void closeAll().catch(reportFailure); });
    return { close: closeAll };
  } catch (error: unknown) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

function defaultReportFailure(): void {
  process.exitCode = 1;
  process.stderr.write("DAILY_CARE_SUPERVISOR_FAILED\n");
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("DAILY_CARE_SUPERVISOR_UNKNOWN_FAILURE", { cause: error });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startDailyCareSupervisor().catch(() => {
    defaultReportFailure();
  });
}
