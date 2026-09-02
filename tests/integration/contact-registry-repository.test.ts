import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXAMPLE_CONTACT_CONTACT_ID } from "../../src/contacts/contact-schema.js";
import {
  assertContactRegistryRepository,
  ContactRegistryRepository,
} from "../../src/contacts/contact-registry-repository.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

const contactId = "contact-0123456789abcdef0123456789abcdef" as const;
const now = new Date("2026-08-31T03:00:00.000+08:00");

function binding(name: string) {
  return {
    fingerprintVersion: "vision-featureprint-v1" as const,
    enrollmentFingerprint: "a".repeat(63) + name.length.toString(16),
    leftPaneProofHash: "b".repeat(64),
    headerProofHash: "c".repeat(64),
    confidence: 0.98,
    confirmedAt: now.toISOString(),
  };
}

describe("ContactRegistryRepository", () => {
  let root: string;
  let store: EncryptedStore;
  let repository: ContactRegistryRepository;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "contact-registry-"));
    await initializeTestKernelLockCatalog(root);
    store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
    repository = new ContactRegistryRepository(store);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps repository provenance on exact unmodified constructor instances only", () => {
    class OverriddenRegistry extends ContactRegistryRepository {
      public override list(): Promise<never> {
        return Promise.reject(new Error("FAKE_REGISTRY_LIST"));
      }
    }

    const jsonCopy: unknown = JSON.parse(JSON.stringify(repository));
    const untrusted: readonly unknown[] = [
      {},
      Object.create(ContactRegistryRepository.prototype),
      { ...repository },
      structuredClone(repository),
      jsonCopy,
      new OverriddenRegistry(store),
    ];

    expect(() => assertContactRegistryRepository(repository)).not.toThrow();
    for (const candidate of untrusted) {
      expect(() => assertContactRegistryRepository(candidate))
        .toThrowError("CONTACT_REGISTRY_REPOSITORY_PROVENANCE_REQUIRED");
    }

    Object.defineProperty(repository, "get", {
      configurable: true,
      value: () => Promise.resolve(null),
    });
    expect(() => assertContactRegistryRepository(repository))
      .toThrowError("CONTACT_REGISTRY_REPOSITORY_PROVENANCE_REQUIRED");
  });

  it("creates a confirmed contact with approved defaults", async () => {
    const created = await repository.createConfirmed({
      contactId,
      displayName: "我",
      identityBinding: binding("我"),
      now,
    });
    expect(created).toMatchObject({
      lifecycle: "active",
      autoReplyEnabled: true,
      scheduledCareEnabled: false,
      revision: 1,
    });
  });

  it("increments revision and invalidates stale updates", async () => {
    await repository.createConfirmed({
      contactId,
      displayName: "我",
      identityBinding: binding("我"),
      now,
    });
    const paused = await repository.update(contactId, 1, { lifecycle: "paused" }, now);
    expect(paused.revision).toBe(2);
    await expect(repository.update(contactId, 1, { lifecycle: "active" }, now))
      .rejects.toThrowError("CONTACT_REVISION_MISMATCH");
  });

  it("preserves tombstones, permits same display names, and encrypts the registry", async () => {
    const secondId = "contact-fedcba9876543210fedcba9876543210" as const;
    const created = await repository.createConfirmed({
      contactId,
      displayName: "同名",
      identityBinding: binding("甲"),
      now,
    });
    await repository.createConfirmed({
      contactId: secondId,
      displayName: "同名",
      identityBinding: binding("乙"),
      now,
    });
    await expect(repository.delete(contactId, created.revision, now)).resolves.toMatchObject({
      lifecycle: "deleted",
      revision: 2,
    });
    expect(await repository.list()).toHaveLength(2);
    expect((await repository.get(contactId))?.lifecycle).toBe("deleted");
    await expect(readFile(path.join(root, "profiles", "contacts.enc"), "utf8"))
      .resolves.not.toContain("同名");
  });

  it("seeds the fixed legacy contact only from an explicitly confirmed binding", async () => {
    const seeded = await repository.seedExampleContactFromConfirmedIdentityBinding({
      identityBinding: binding("示例联系人"),
      now,
    });
    expect(seeded).toMatchObject({
      contactId: EXAMPLE_CONTACT_CONTACT_ID,
      displayName: "示例联系人",
      lifecycle: "active",
      scheduledCareEnabled: true,
      scheduledCareSlots: ["06:30", "22:00"],
    });
  });
});
