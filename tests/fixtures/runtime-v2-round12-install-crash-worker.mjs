import { once } from "node:events";

import { installCleanRuntimeV2 } from "../../scripts/runtime-v2-clean-install.mjs";

const [sourceRoot, runtimeRoot, candidateRoot] = process.argv.slice(2);

if ([sourceRoot, runtimeRoot, candidateRoot].some((value) =>
  typeof value !== "string" || value.length === 0)) {
  throw new Error("ROUND12_CRASH_WORKER_ARGUMENT_INVALID");
}

await installCleanRuntimeV2({ sourceRoot, runtimeRoot, candidateRoot }, {
  beforeMutation: async (stage) => {
    if (stage !== "before-current-symlink") return;
    process.stdout.write("READY_TO_KILL\n");
    process.stdin.resume();
    await once(process.stdin, "end");
    throw new Error("ROUND12_CRASH_WORKER_STDIN_CLOSED");
  },
});
