import { installValidatedCandidate } from "../../scripts/release-manager.mjs";
import { validatePayloadManifest } from "../../scripts/release-payload.mjs";

let serialized = "";
for await (const chunk of process.stdin) serialized += chunk;
const options = JSON.parse(serialized);
const { crashPhase, now, ...transaction } = options;

await installValidatedCandidate({
  ...transaction,
  now: () => new Date(now),
  validateRelease: (releaseRoot) => validatePayloadManifest({ payloadRoot: releaseRoot }),
  hook: async (phase) => {
    if (phase !== crashPhase) return;
    process.stdout.write(`${JSON.stringify({ phase })}\n`);
    await new Promise(() => undefined);
  },
});
