import { createLiveProductionRuntime } from "./live-bootstrap.js";
import type { LiveWechatRuntimeDependencies } from "./live-server.js";

interface CoordinatedMcpServer {
  server: { onclose?: () => void };
  close(): Promise<void>;
}

export interface CoordinatedMcpLifecycle {
  requestShutdown(): void;
}

export async function runCoordinatedWechatMcpMain(
  connect: (
    dependencies: LiveWechatRuntimeDependencies,
    lifecycle: CoordinatedMcpLifecycle,
  ) => Promise<CoordinatedMcpServer>,
): Promise<void> {
  const runtime = await createLiveProductionRuntime({ ownerKind: "mcp" });
  let server: CoordinatedMcpServer | null = null;
  let shutdownRequested = false;
  let serverCloseStarted = false;
  let serverClosePromise: Promise<void> | null = null;
  let runtimeClosePromise: Promise<void> | null = null;
  let shutdownErrorReported = false;

  const closeRuntime = (): Promise<void> => {
    if (runtimeClosePromise !== null) return runtimeClosePromise;
    try {
      runtimeClosePromise = runtime.close();
    } catch (error: unknown) {
      runtimeClosePromise = Promise.reject(asError(error));
    }
    return runtimeClosePromise;
  };

  const closeAssignedServerThenRuntime = (): Promise<void> => {
    if (serverClosePromise !== null) return serverClosePromise;
    const assignedServer = server;
    if (assignedServer === null) return closeRuntime();

    serverCloseStarted = true;
    let closingServer: Promise<void>;
    try {
      closingServer = assignedServer.close();
    } catch (error: unknown) {
      closingServer = Promise.reject(asError(error));
    }
    serverClosePromise = closingServer.then(
      () => closeRuntime(),
      async (error: unknown) => {
        try {
          await closeRuntime();
        } catch (cleanupError: unknown) {
          throw new AggregateError([error, cleanupError], "LIVE_MCP_SHUTDOWN_FAILED");
        }
        throw error;
      },
    );
    return serverClosePromise;
  };

  const reportShutdownError = (error: unknown): void => {
    if (shutdownErrorReported) return;
    shutdownErrorReported = true;
    process.exitCode = 1;
    const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    process.stderr.write(`LIVE_RUNTIME_SHUTDOWN_FAILED: ${reason}\n`);
  };

  const requestShutdown = (): void => {
    shutdownRequested = true;
    const closing = server === null ? closeRuntime() : closeAssignedServerThenRuntime();
    void closing.catch(reportShutdownError);
  };

  const handleTransportClose = (): void => {
    shutdownRequested = true;
    if (serverCloseStarted) return;
    void closeRuntime().catch(reportShutdownError);
  };

  process.stdin.on("end", requestShutdown);
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);

  try {
    server = await connect(runtime.dependencies, { requestShutdown });
    server.server.onclose = handleTransportClose;
    if (shutdownRequested) {
      await closeAssignedServerThenRuntime();
    }
  } catch (error: unknown) {
    try {
      await closeRuntime();
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], "LIVE_MCP_STARTUP_CLEANUP_FAILED");
    }
    throw error;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("UNKNOWN_ERROR", { cause: error });
}
