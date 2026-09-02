import { once } from "node:events";

import { installCleanRuntimeV2 } from "../../scripts/runtime-v2-clean-install.mjs";

const [sourceRoot, runtimeRoot, candidateRoot] = process.argv.slice(2);

if ([sourceRoot, runtimeRoot, candidateRoot].some((value) =>
  typeof value !== "string" || value.length === 0)) {
  throw new Error("ROUND15_CRASH_WORKER_ARGUMENT_INVALID");
}

await installCleanRuntimeV2({ sourceRoot, runtimeRoot, candidateRoot }, {
  beforeMutation: async (stage, context) => {
    if (stage !== "container-close-source-file" || context?.phase !== "copy") return;
    process.stdout.write("CONTAINER_POPULATING\n");
    process.stdin.resume();
    await once(process.stdin, "end");
    throw new Error("ROUND15_CRASH_WORKER_STDIN_CLOSED");
  },
});
