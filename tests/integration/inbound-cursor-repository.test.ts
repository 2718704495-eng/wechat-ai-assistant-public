import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InboundCursorRepository } from "../../src/storage/inbound-cursor-repository.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

const contactId = "contact-0123456789abcdef0123456789abcdef" as const;

describe("InboundCursorRepository", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses a hashed encrypted path and never persists message or session plaintext", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inbound-cursor-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const repository = new InboundCursorRepository(
      new EncryptedStore(root, new FixedKeyProvider(randomBytes(32))),
    );
    await repository.establishBaseline({
      contactId,
      contactRevision: 3,
      sourceEpoch: "epoch-1",
      sessionId: "SESSION-PLAINTEXT-SENTINEL",
      baselineHashes: [createHash("sha256").update("MESSAGE-TEXT-SENTINEL").digest("hex")],
      proofIds: [],
    });

    const file = path.join(root, "state", "inbound", `${createHash("sha256").update(contactId).digest("hex")}.enc`);
    const envelope = await readFile(file, "utf8");
    expect(envelope).not.toContain(contactId);
    expect(envelope).not.toContain("MESSAGE-TEXT-SENTINEL");
    expect(envelope).not.toContain("SESSION-PLAINTEXT-SENTINEL");
  });

  it("round-trips across instances, returns deep copies, and rejects stale identity commits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inbound-cursor-restart-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const key = randomBytes(32);
    const first = new InboundCursorRepository(new EncryptedStore(root, new FixedKeyProvider(key)));
    const baseline = await first.establishBaseline({
      contactId, contactRevision: 3, sourceEpoch: "epoch-1", sessionId: "session-1",
      baselineHashes: ["a".repeat(64)], proofIds: ["b".repeat(64)],
    });
    expect(Object.isFrozen(baseline)).toBe(true);
    expect(Object.isFrozen(baseline.baselineHashes)).toBe(true);

    const restarted = new InboundCursorRepository(new EncryptedStore(root, new FixedKeyProvider(key)));
    await expect(restarted.read(contactId)).resolves.toMatchObject({
      baselineHashes: ["a".repeat(64)], consumedProofIds: ["b".repeat(64)], nextSequence: 1,
    });
    await expect(restarted.commitDelivered({
      contactId, contactRevision: 4, sourceEpoch: "epoch-1", sessionId: "session-1",
      expectedSequence: 1, baselineHashes: ["d".repeat(64)], proofId: null,
    })).rejects.toThrow("INBOUND_CURSOR_IDENTITY_MISMATCH");
  });

  it("commits proof and sequence only through a compare-and-set delivery commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inbound-cursor-cas-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const repository = new InboundCursorRepository(
      new EncryptedStore(root, new FixedKeyProvider(randomBytes(32))),
    );
    await repository.establishBaseline({
      contactId, contactRevision: 1, sourceEpoch: "epoch-1", sessionId: "session-1",
      baselineHashes: [], proofIds: [],
    });
    await repository.commitDelivered({
      contactId, contactRevision: 1, sourceEpoch: "epoch-1", sessionId: "session-1",
      expectedSequence: 1, baselineHashes: ["a".repeat(64)], proofId: "b".repeat(64),
    });
    await expect(repository.commitDelivered({
      contactId, contactRevision: 1, sourceEpoch: "epoch-1", sessionId: "session-1",
      expectedSequence: 1, baselineHashes: [], proofId: null,
    })).rejects.toThrow("INBOUND_CURSOR_SEQUENCE_MISMATCH");
    await expect(repository.read(contactId)).resolves.toMatchObject({
      nextSequence: 2, consumedProofIds: ["b".repeat(64)],
    });
  });

  it("can learn baseline proof without consuming an event sequence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inbound-cursor-refresh-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const repository = new InboundCursorRepository(
      new EncryptedStore(root, new FixedKeyProvider(randomBytes(32))),
    );
    await repository.establishBaseline({
      contactId, contactRevision: 1, sourceEpoch: "epoch-1", sessionId: "session-1",
      baselineHashes: ["a".repeat(64)], proofIds: [],
    });
    await repository.refreshBaseline({
      contactId, contactRevision: 1, sourceEpoch: "epoch-1", sessionId: "session-1",
      expectedSequence: 1, baselineHashes: ["a".repeat(64)], proofIds: ["b".repeat(64)],
    });
    await expect(repository.read(contactId)).resolves.toMatchObject({
      nextSequence: 1, consumedProofIds: ["b".repeat(64)],
    });
  });

});
