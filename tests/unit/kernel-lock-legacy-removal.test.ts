import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Round 6 runtime has no pathname lock recovery", () => {
  it("contains neither legacy recovery claims nor reusable lock-path unlink", async () => {
    const encryptedStore = await readFile("src/storage/encrypted-store.ts", "utf8");
    const liveCoordinator = await readFile("src/mcp/live-operation-coordinator.ts", "utf8");

    expect(encryptedStore).not.toContain("recoveryClaimPath");
    expect(encryptedStore).not.toContain("recoverStaleTransactionLock");
    expect(encryptedStore).not.toMatch(/unlink\((?:options\.)?lockPath\)/u);
    expect(liveCoordinator).not.toMatch(/unlink\(this\.lockPath\)/u);
    expect(liveCoordinator).not.toContain('open(lockPath, "wx", 0o600)');
  });
});
