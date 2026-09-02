import { fileURLToPath } from "node:url";

import { runRuntimeActivationCli } from "./runtime-activation-cli.js";
import { createProductionRuntimeActivationService } from "./runtime-activation-production.js";

export async function runRuntimeActivationMain(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const service = await createProductionRuntimeActivationService();
  await runRuntimeActivationCli({
    argv,
    input: process.stdin,
    output: process.stdout,
    service,
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runRuntimeActivationMain().catch(() => {
    process.exitCode = 1;
    process.stderr.write("CHAT_ASSISTANT_ACTIVATION_FAILED\n");
  });
}
