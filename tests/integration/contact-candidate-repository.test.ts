import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContactCandidateRepository } from "../../src/storage/contact-candidate-repository.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

describe("ContactCandidateRepository", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function repository(now = new Date("2026-08-31T04:00:00.000Z")) {
    const root = await mkdtemp(path.join(os.tmpdir(), "contact-candidate-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    return {
      root,
      repo: new ContactCandidateRepository(
        new EncryptedStore(root, new FixedKeyProvider(randomBytes(32))),
        () => now,
      ),
    };
  }

  it("observes identical evidence idempotently but separates same-name different evidence", async () => {
    const { repo } = await repository();
    const input = { displayName: " 我 ", previewHash: "a".repeat(64), windowRevision: "b".repeat(64), now: new Date("2026-08-31T04:00:00.000Z") };
    const first = await repo.observe(input);
    const again = await repo.observe(input);
    const changed = await repo.observe({ ...input, previewHash: "c".repeat(64) });
    expect(again).toEqual(first);
    expect(changed.candidateId).not.toBe(first.candidateId);
    expect(changed.proposedContactId).not.toBe(first.proposedContactId);
  });

  it("prunes after 24 hours, validates revision, consumes once, and stays encrypted", async () => {
    let current = new Date("2026-08-31T04:00:00.000Z");
    const { root, repo } = await repository(current);
    const candidate = await repo.observe({ displayName: "我", previewHash: "a".repeat(64), windowRevision: "b".repeat(64), now: current });
    await expect(repo.consume(candidate.candidateId, "c".repeat(64), current)).rejects.toThrow("CONTACT_CANDIDATE_WINDOW_REVISION_MISMATCH");
    await expect(repo.consume(candidate.candidateId, candidate.windowRevision, current)).resolves.toEqual(candidate);
    await expect(repo.consume(candidate.candidateId, candidate.windowRevision, current)).rejects.toThrow("CONTACT_CANDIDATE_NOT_FOUND");
    const envelope = await readFile(path.join(root, "state", "contact-candidates.enc"), "utf8");
    expect(envelope).not.toContain("我");

    const later = await repo.observe({ displayName: "过期候选", previewHash: "d".repeat(64), windowRevision: "e".repeat(64), now: current });
    current = new Date(later.expiresAt);
    await expect(repo.listFresh(new Date(current.getTime() + 1))).resolves.toEqual([]);
    await expect(repo.consume(later.candidateId, later.windowRevision, new Date(current.getTime() + 1)))
      .rejects.toThrow("CONTACT_CANDIDATE_NOT_FOUND");
  });

  it("keeps a consumed tombstone so identical observe cannot resurrect or race consume", async () => {
    const { repo } = await repository();
    const input = {
      displayName: "我",
      previewHash: "a".repeat(64),
      windowRevision: "b".repeat(64),
      now: new Date("2026-08-31T04:00:00.000Z"),
    };
    const candidate = await repo.observe(input);
    const results = await Promise.allSettled([
      repo.consume(candidate.candidateId, candidate.windowRevision, input.now),
      repo.consume(candidate.candidateId, candidate.windowRevision, input.now),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    await expect(repo.observe(input)).rejects.toThrow("CONTACT_CANDIDATE_ALREADY_CONSUMED");
    await expect(repo.listFresh(input.now)).resolves.toEqual([]);
  });

  it("never capacity-evicts any unexpired consumed tombstone", async () => {
    const { repo } = await repository();
    const now = new Date("2026-08-31T04:00:00.000Z");
    let firstInput: Parameters<ContactCandidateRepository["observe"]>[0] | undefined;
    for (let index = 0; index < 513; index += 1) {
      const input = {
        displayName: `候选人-${index}`,
        previewHash: index.toString(16).padStart(64, "0"),
        windowRevision: "b".repeat(64),
        now,
      };
      firstInput ??= input;
      const candidate = await repo.observe(input);
      await repo.consume(candidate.candidateId, candidate.windowRevision, now);
    }
    if (firstInput === undefined) throw new Error("TEST_FIXTURE_INVALID");

    await expect(repo.observe(firstInput)).rejects.toThrow("CONTACT_CANDIDATE_ALREADY_CONSUMED");
  }, 30_000);

  it("removes an expired consumed tombstone and permits the same evidence again", async () => {
    const { repo } = await repository();
    const now = new Date("2026-08-31T04:00:00.000Z");
    const input = {
      displayName: "可再观测",
      previewHash: "a".repeat(64),
      windowRevision: "b".repeat(64),
      now,
    };
    const candidate = await repo.observe(input);
    await repo.consume(candidate.candidateId, candidate.windowRevision, now);
    const afterTtl = new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 1);

    await expect(repo.observe({ ...input, now: afterTtl })).resolves.toMatchObject({
      candidateId: candidate.candidateId,
    });
  });
});
