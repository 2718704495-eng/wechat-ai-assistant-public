import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContactDirectory } from "../../src/contacts/contact-directory.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import {
  assertWechatIdentityEnrollmentRepository,
  WechatIdentityEnrollmentRepository,
} from "../../src/storage/wechat-identity-enrollment-repository.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

function featureSample(length: number, byte: number): string {
  const sample = Buffer.alloc(length, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

describe("WechatIdentityEnrollmentRepository", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps repository provenance on exact unmodified constructor instances only", async () => {
    class OverriddenEnrollments extends WechatIdentityEnrollmentRepository {
      public override require(): Promise<never> {
        return Promise.reject(new Error("FAKE_ENROLLMENT_REQUIRE"));
      }
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-provenance-"));
    roots.push(root);
    const store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
    const repository = new WechatIdentityEnrollmentRepository(store);
    const jsonCopy: unknown = JSON.parse(JSON.stringify(repository));
    const untrusted: readonly unknown[] = [
      {},
      Object.create(WechatIdentityEnrollmentRepository.prototype),
      { ...repository },
      structuredClone(repository),
      jsonCopy,
      new OverriddenEnrollments(store),
    ];

    expect(() => assertWechatIdentityEnrollmentRepository(repository)).not.toThrow();
    for (const candidate of untrusted) {
      expect(() => assertWechatIdentityEnrollmentRepository(candidate))
        .toThrowError("WECHAT_IDENTITY_ENROLLMENT_REPOSITORY_PROVENANCE_REQUIRED");
    }

    Object.defineProperty(repository, "requireContact", {
      configurable: true,
      value: () => Promise.reject(new Error("FAKE_ENROLLMENT_REQUIRE_CONTACT")),
    });
    expect(() => assertWechatIdentityEnrollmentRepository(repository))
      .toThrowError("WECHAT_IDENTITY_ENROLLMENT_REPOSITORY_PROVENANCE_REQUIRED");
  });

  it("persists an immutable supervised multi-frame enrollment encrypted across restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const key = randomBytes(32);
    const sample = (byte: number) => featureSample(64, byte);
    const record = {
      version: 1 as const,
      conversationId: "example-contact" as const,
      visibleName: "示例联系人" as const,
      fingerprintVersion: "vision-featureprint-v1" as const,
      referenceSamples: [sample(1), sample(2), sample(3)],
      enrolledAt: "2026-08-23T14:00:00.000Z",
    };
    const first = new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    );
    await first.enrollSupervised(record);

    const restarted = new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    );
    await expect(restarted.require("example-contact")).resolves.toEqual(record);
    await expect(restarted.enrollSupervised({ ...record, referenceSamples: [sample(4), sample(5), sample(6)] }))
      .rejects.toThrow("WECHAT_IDENTITY_ENROLLMENT_IMMUTABLE");
    expect(await readFile(path.join(root, "profiles/wechat-identity-enrollment.enc"), "utf8"))
      .not.toContain(sample(1));
  });

  it("persists an immutable v2 enrollment bound to a contact ID and display name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-v2-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const key = randomBytes(32);
    const record = {
      version: 2 as const,
      contactId: "contact-0123456789abcdef0123456789abcdef" as const,
      displayName: "我",
      fingerprintVersion: "vision-featureprint-v1" as const,
      referenceSamples: [featureSample(64, 1), featureSample(64, 2), featureSample(64, 3)],
      enrolledAt: "2026-08-31T03:00:00.000Z",
    };
    const first = new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    );
    await first.enrollSupervised(record);

    const restarted = new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    );
    await expect(restarted.requireContact(record.contactId)).resolves.toEqual(record);
    await expect(restarted.enrollSupervised({ ...record, displayName: "伪造" }))
      .rejects.toThrow("WECHAT_IDENTITY_ENROLLMENT_IMMUTABLE");
  });

  it("migrates a validated legacy Example Contact enrollment to v2 and seeds the registry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-migration-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
    const enrollments = new WechatIdentityEnrollmentRepository(store);
    const fileTransfer = {
      version: 1 as const,
      conversationId: "file-transfer" as const,
      visibleName: "文件传输助手" as const,
      fingerprintVersion: "vision-featureprint-v1" as const,
      referenceSamples: [featureSample(64, 4), featureSample(64, 5), featureSample(64, 6)],
      enrolledAt: "2026-08-23T14:00:00.000Z",
    };
    await enrollments.enrollSupervised(fileTransfer);
    await enrollments.enrollSupervised({
      version: 1,
      conversationId: "example-contact",
      visibleName: "示例联系人",
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: [featureSample(64, 1), featureSample(64, 2), featureSample(64, 3)],
      enrolledAt: "2026-08-23T14:00:00.000Z",
    });
    const registry = new ContactRegistryRepository(store);
    const directory = new ContactDirectory(registry, enrollments);

    const target = await directory.requireTextTarget("example-contact", 1);

    expect(target).toMatchObject({
      contactId: "example-contact",
      displayName: "示例联系人",
      enrollment: { version: 2, contactId: "example-contact", displayName: "示例联系人" },
    });
    await expect(enrollments.require("file-transfer")).resolves.toEqual(fileTransfer);
    await expect(registry.get("example-contact")).resolves.toMatchObject({
      lifecycle: "active",
      scheduledCareEnabled: true,
      scheduledCareSlots: ["06:30", "22:00"],
    });
    await expect(registry.list()).resolves.toHaveLength(1);
  });

  it("keeps concurrent v2 enrollments for distinct contact IDs from separate instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-distinct-race-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const key = randomBytes(32);
    const first = {
      version: 2 as const,
      contactId: "contact-11111111111111111111111111111111" as const,
      displayName: "甲",
      fingerprintVersion: "vision-featureprint-v1" as const,
      referenceSamples: [featureSample(64, 1), featureSample(64, 2), featureSample(64, 3)],
      enrolledAt: "2026-08-31T03:00:00.000Z",
    };
    const second = {
      version: 2 as const,
      contactId: "contact-22222222222222222222222222222222" as const,
      displayName: "乙",
      fingerprintVersion: "vision-featureprint-v1" as const,
      referenceSamples: [featureSample(64, 4), featureSample(64, 5), featureSample(64, 6)],
      enrolledAt: "2026-08-31T03:00:00.000Z",
    };
    const repositories = [0, 1].map(() => new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    ));

    await Promise.all([
      repositories[0]?.enrollSupervised(first),
      repositories[1]?.enrollSupervised(second),
    ]);

    await expect(repositories[0]?.requireContact(first.contactId)).resolves.toEqual(first);
    await expect(repositories[1]?.requireContact(second.contactId)).resolves.toEqual(second);
  });

  it("does not lose a concurrent v2 enrollment while migrating Example Contact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-migration-race-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const key = randomBytes(32);
    const store = new EncryptedStore(root, new FixedKeyProvider(key));
    const legacyRepository = new WechatIdentityEnrollmentRepository(store);
    await legacyRepository.enrollSupervised({
      version: 1,
      conversationId: "example-contact",
      visibleName: "示例联系人",
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: [featureSample(64, 1), featureSample(64, 2), featureSample(64, 3)],
      enrolledAt: "2026-08-23T14:00:00.000Z",
    });
    const newContact = {
      version: 2 as const,
      contactId: "contact-33333333333333333333333333333333" as const,
      displayName: "新增",
      fingerprintVersion: "vision-featureprint-v1" as const,
      referenceSamples: [featureSample(64, 4), featureSample(64, 5), featureSample(64, 6)],
      enrolledAt: "2026-08-31T03:00:00.000Z",
    };
    const registry = new ContactRegistryRepository(store);
    const migrationRepository = new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    );
    const enrollmentRepository = new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    );

    await Promise.all([
      migrationRepository.migrateLegacyExampleContact(registry),
      enrollmentRepository.enrollSupervised(newContact),
    ]);

    await expect(migrationRepository.requireContact("example-contact")).resolves.toMatchObject({ version: 2 });
    await expect(enrollmentRepository.requireContact(newContact.contactId)).resolves.toEqual(newContact);
  });

  it("preserves a legacy enrollment when an existing registry binding conflicts with migration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-migration-conflict-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
    const enrollments = new WechatIdentityEnrollmentRepository(store);
    await enrollments.enrollSupervised({
      version: 1,
      conversationId: "example-contact",
      visibleName: "示例联系人",
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: [featureSample(64, 1), featureSample(64, 2), featureSample(64, 3)],
      enrolledAt: "2026-08-23T14:00:00.000Z",
    });
    const registry = new ContactRegistryRepository(store);
    await registry.seedExampleContactFromConfirmedIdentityBinding({
      identityBinding: {
        fingerprintVersion: "vision-featureprint-v1",
        enrollmentFingerprint: "0".repeat(64),
        leftPaneProofHash: "1".repeat(64),
        headerProofHash: "2".repeat(64),
        confidence: 1,
        confirmedAt: "2026-08-23T14:00:00.000Z",
      },
      now: new Date("2026-08-23T14:00:00.000Z"),
    });

    await expect(enrollments.migrateLegacyExampleContact(registry))
      .rejects.toThrow("WECHAT_IDENTITY_ENROLLMENT_MIGRATION_CONFLICT");
    await expect(enrollments.require("example-contact")).resolves.toMatchObject({ version: 1 });
  });

  it("rejects malformed or inconsistent feature-print samples and has a code-fixed threshold", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-shape-"));
    roots.push(root);
    const repository = new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(randomBytes(32))),
    );
    await expect(repository.enrollSupervised({
      version: 1,
      conversationId: "example-contact",
      visibleName: "示例联系人",
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: [
        featureSample(64, 1),
        featureSample(32, 2),
        "not-base64!",
      ],
      enrolledAt: "2026-08-23T14:00:00.000Z",
    })).rejects.toThrow("WECHAT_IDENTITY_ENROLLMENT_SAMPLE_INVALID");
    expect(WechatIdentityEnrollmentRepository.maximumDistance).toBeLessThanOrEqual(0.2);
  });

  it("uses a cross-instance exclusive enrollment claim so different samples have one winner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-race-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const key = randomBytes(32);
    const repositories = [0, 1].map(() => new WechatIdentityEnrollmentRepository(
      new EncryptedStore(root, new FixedKeyProvider(key)),
    ));
    const enrollments = repositories.map((repository, index) => repository.enrollSupervised({
      version: 1,
      conversationId: "example-contact",
      visibleName: "示例联系人",
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: [1, 2, 3].map((offset) =>
        featureSample(64, index + offset)
      ),
      enrolledAt: "2026-08-23T14:00:00.000Z",
    }));

    const results = await Promise.allSettled(enrollments);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("revalidates semantic sample shape when reading an authenticated but malformed record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-enrollment-corrupt-"));
    roots.push(root);
    await initializeTestKernelLockCatalog(root);
    const store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
    await store.write("profiles/wechat-identity-enrollment.enc", {
      version: 1,
      enrollments: [{
        version: 1,
        conversationId: "example-contact",
        visibleName: "示例联系人",
        fingerprintVersion: "vision-featureprint-v1",
        referenceSamples: [
          featureSample(64, 1),
          featureSample(32, 2),
          featureSample(64, 3),
        ],
        enrolledAt: "2026-08-23T14:00:00.000Z",
      }],
    });

    await expect(new WechatIdentityEnrollmentRepository(store).require("example-contact"))
      .rejects.toThrow("WECHAT_IDENTITY_ENROLLMENT_SAMPLE_INVALID");
  });
});
