import { createDailyCareTestRuntime } from "./daily-care-bootstrap.js";
import { connectDailyCareMcpStdio } from "./daily-care-mcp-server.js";

async function main(): Promise<void> {
  const runtime = await createDailyCareTestRuntime();
  let server: Awaited<ReturnType<typeof connectDailyCareMcpStdio>> | null = null;
  let shutdown: Promise<void> | null = null;
  const closeAll = (): Promise<void> => {
    if (shutdown !== null) return shutdown;
    shutdown = (async () => {
      await server?.close();
      await runtime.close();
    })();
    return shutdown;
  };
  try {
    server = await connectDailyCareMcpStdio(runtime.dependencies, {
      onCloseRequested: closeAll,
    });
    server.server.onclose = () => { void runtime.close().catch(reportFailure); };
    process.stdin.once("end", () => { void closeAll().catch(reportFailure); });
    process.once("SIGINT", () => { void closeAll().catch(reportFailure); });
    process.once("SIGTERM", () => { void closeAll().catch(reportFailure); });
  } catch (error: unknown) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

function reportFailure(): void {
  process.exitCode = 1;
  process.stderr.write("DAILY_CARE_TEST_SERVER_FAILED\n");
}

await main().catch(() => {
  reportFailure();
});
