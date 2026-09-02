import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertAuthorizedWechatTarget,
  ContactDirectory,
} from "../../src/contacts/contact-directory.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { WechatIdentityEnrollmentRepository } from "../../src/storage/wechat-identity-enrollment-repository.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

const now = new Date("2026-08-31T03:00:00.000Z");

function featureSample(byte: number): string {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

function enrollmentFingerprint(
  contactId: string,
  displayName: string,
  samples: readonly string[],
): string {
  return createHash("sha256").update([
    "2",
    contactId,
    displayName,
    "vision-featureprint-v1",
    "0.18",
    ...samples,
  ].join("\0")).digest("hex");
}

function binding(fingerprint: string) {
  return {
    fingerprintVersion: "vision-featureprint-v1" as const,
    enrollmentFingerprint: fingerprint,
    leftPaneProofHash: "a".repeat(64),
    headerProofHash: "b".repeat(64),
    confidence: 0.99,
    confirmedAt: now.toISOString(),
  };
}

describe("ContactDirectory", () => {
  let root: string;
  let store: EncryptedStore;
  let registry: ContactRegistryRepository;
  let enrollments: WechatIdentityEnrollmentRepository;
  let directory: ContactDirectory;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "contact-directory-"));
    await initializeTestKernelLockCatalog(root);
    store = new EncryptedStore(root, new FixedKeyProvider(randomBytes(32)));
    registry = new ContactRegistryRepository(store);
    enrollments = new WechatIdentityEnrollmentRepository(store);
    directory = new ContactDirectory(registry, enrollments);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedActiveContact(input: {
    contactId: `contact-${string}`;
    displayName: string;
    revision?: number;
    bindingFingerprint?: string;
  }) {
    const samples = [featureSample(1), featureSample(2), featureSample(3)];
    const fingerprint = enrollmentFingerprint(input.contactId, input.displayName, samples);
    await enrollments.enrollSupervised({
      version: 2,
      contactId: input.contactId,
      displayName: input.displayName,
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: samples,
      enrolledAt: now.toISOString(),
    });
    let contact = await registry.createConfirmed({
      contactId: input.contactId,
      displayName: input.displayName,
      identityBinding: binding(input.bindingFingerprint ?? fingerprint),
      now,
    });
    while (contact.revision < (input.revision ?? 1)) {
      contact = await registry.update(contact.contactId, contact.revision, {}, now);
    }
    return contact;
  }

  it("rejects plain structural repository dependencies before registering a directory", () => {
    const fakeRegistry = {
      get: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
    } as unknown as ContactRegistryRepository;
    const fakeEnrollments = {
      migrateLegacyExampleContact: () => Promise.reject(new Error("NOT_ENROLLED")),
      requireContact: () => Promise.reject(new Error("NOT_ENROLLED")),
    } as unknown as WechatIdentityEnrollmentRepository;

    expect(() => new ContactDirectory(fakeRegistry, enrollments))
      .toThrowError("CONTACT_REGISTRY_REPOSITORY_PROVENANCE_REQUIRED");
    expect(() => new ContactDirectory(registry, fakeEnrollments))
      .toThrowError("WECHAT_IDENTITY_ENROLLMENT_REPOSITORY_PROVENANCE_REQUIRED");
  });

  it("rejects prototype-only repository dependencies", () => {
    const prototypeRegistry = Object.create(
      ContactRegistryRepository.prototype,
    ) as ContactRegistryRepository;
    const prototypeEnrollments = Object.create(
      WechatIdentityEnrollmentRepository.prototype,
    ) as WechatIdentityEnrollmentRepository;

    expect(() => new ContactDirectory(prototypeRegistry, enrollments))
      .toThrowError("CONTACT_REGISTRY_REPOSITORY_PROVENANCE_REQUIRED");
    expect(() => new ContactDirectory(registry, prototypeEnrollments))
      .toThrowError("WECHAT_IDENTITY_ENROLLMENT_REPOSITORY_PROVENANCE_REQUIRED");
  });

  it("rejects repository subclasses that override authorization operations", () => {
    class OverriddenRegistry extends ContactRegistryRepository {
      public override list(): Promise<never> {
        return Promise.reject(new Error("FAKE_REGISTRY_LIST"));
      }
    }
    class OverriddenEnrollments extends WechatIdentityEnrollmentRepository {
      public override requireContact(): Promise<never> {
        return Promise.reject(new Error("FAKE_ENROLLMENT_REQUIRE_CONTACT"));
      }
    }

    expect(() => new ContactDirectory(new OverriddenRegistry(store), enrollments))
      .toThrowError("CONTACT_REGISTRY_REPOSITORY_PROVENANCE_REQUIRED");
    expect(() => new ContactDirectory(registry, new OverriddenEnrollments(store)))
      .toThrowError("WECHAT_IDENTITY_ENROLLMENT_REPOSITORY_PROVENANCE_REQUIRED");
  });

  it("rejects real repository instances with own-method overrides", () => {
    Object.defineProperty(registry, "get", {
      configurable: true,
      value: () => Promise.resolve(null),
    });
    expect(() => new ContactDirectory(registry, enrollments))
      .toThrowError("CONTACT_REGISTRY_REPOSITORY_PROVENANCE_REQUIRED");
    delete (registry as unknown as Record<string, unknown>).get;

    Object.defineProperty(enrollments, "requireContact", {
      configurable: true,
      value: () => Promise.reject(new Error("FAKE_ENROLLMENT_REQUIRE_CONTACT")),
    });
    expect(() => new ContactDirectory(registry, enrollments))
      .toThrowError("WECHAT_IDENTITY_ENROLLMENT_REPOSITORY_PROVENANCE_REQUIRED");
  });

  it("rechecks repository provenance before using an existing directory", async () => {
    const contactId = "contact-abababababababababababababababab" as const;
    await seedActiveContact({ contactId, displayName: "运行时覆写" });

    Object.defineProperty(registry, "get", {
      configurable: true,
      value: () => Promise.resolve(null),
    });
    await expect(directory.requireActiveAutoReplyTarget(contactId))
      .rejects.toThrowError("CONTACT_REGISTRY_REPOSITORY_PROVENANCE_REQUIRED");
    delete (registry as unknown as Record<string, unknown>).get;

    const enrollment = await enrollments.requireContact(contactId);
    Object.defineProperty(enrollments, "requireContact", {
      configurable: true,
      value: () => Promise.resolve(enrollment),
    });
    await expect(directory.requireActiveAutoReplyTarget(contactId))
      .rejects.toThrowError("WECHAT_IDENTITY_ENROLLMENT_REPOSITORY_PROVENANCE_REQUIRED");
  });

  it("returns a revision-bound target with the canonical binding hash", async () => {
    const contactId = "contact-0123456789abcdef0123456789abcdef" as const;
    const contact = await seedActiveContact({ contactId, displayName: "我", revision: 3 });
    const samples = [featureSample(1), featureSample(2), featureSample(3)];
    const fingerprint = enrollmentFingerprint(contactId, "我", samples);

    const target = await directory.requireTextTarget(contactId, 3);

    expect(target).toMatchObject({ contactId, displayName: "我", revision: 3 });
    expect(target.enrollmentFingerprint).toBe(fingerprint);
    expect(target.bindingHash).toBe(createHash("sha256").update([
      "wechat-contact-binding-v1",
      contact.contactId,
      "3",
      "我",
      fingerprint,
    ].join("\0")).digest("hex"));
    expect(() => assertAuthorizedWechatTarget(target)).not.toThrow();
  });

  it("does not transfer target provenance through structural copies or serialization", async () => {
    const contactId = "contact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    await seedActiveContact({ contactId, displayName: "本地签发" });
    const target = await directory.requireActiveAutoReplyTarget(contactId);
    const jsonCopy: unknown = JSON.parse(JSON.stringify(target));
    const copies: ReadonlyArray<readonly [string, unknown]> = [
      ["plain structural object", {
        contactId: target.contactId,
        displayName: target.displayName,
        revision: target.revision,
        enrollment: target.enrollment,
        enrollmentFingerprint: target.enrollmentFingerprint,
        bindingHash: target.bindingHash,
      }],
      ["spread", { ...target }],
      ["structured clone", structuredClone(target)],
      ["JSON round-trip", jsonCopy],
    ];

    for (const [, copy] of copies) {
      expect(() => assertAuthorizedWechatTarget(copy))
        .toThrowError("WECHAT_TARGET_PROVENANCE_REQUIRED");
    }
  });

  it.each(["paused", "deleted"] as const)("rejects a %s contact", async (lifecycle) => {
    const contactId = lifecycle === "paused"
      ? "contact-11111111111111111111111111111111" as const
      : "contact-22222222222222222222222222222222" as const;
    const contact = await seedActiveContact({ contactId, displayName: lifecycle });
    await registry.update(contactId, contact.revision, { lifecycle }, now);

    await expect(directory.requireActiveAutoReplyTarget(contactId))
      .rejects.toThrowError("CONTACT_NOT_ACTIVE");
  });

  it("permits an active revision-bound text target when automatic replies are disabled", async () => {
    const contactId = "contact-33333333333333333333333333333333" as const;
    const contact = await seedActiveContact({ contactId, displayName: "手动" });
    const updated = await registry.update(contactId, contact.revision, { autoReplyEnabled: false }, now);

    await expect(directory.requireTextTarget(contactId, updated.revision)).resolves.toMatchObject({
      contactId,
      revision: updated.revision,
    });
    await expect(directory.requireActiveAutoReplyTarget(contactId))
      .rejects.toThrowError("CONTACT_AUTO_REPLY_DISABLED");
  });

  it("rejects an old revision before a text target can be used", async () => {
    const contactId = "contact-44444444444444444444444444444444" as const;
    const contact = await seedActiveContact({ contactId, displayName: "修订" });
    const updated = await registry.update(contactId, contact.revision, {}, now);

    await expect(directory.requireTextTarget(contactId, contact.revision))
      .rejects.toThrowError("CONTACT_REVISION_MISMATCH");
    await expect(directory.requireTextTarget(contactId, updated.revision)).resolves.toBeDefined();
  });

  it("rejects a forged enrollment display name and a drifted binding fingerprint", async () => {
    const displayMismatchId = "contact-55555555555555555555555555555555" as const;
    const mismatchSamples = [featureSample(5), featureSample(6), featureSample(7)];
    const mismatchFingerprint = enrollmentFingerprint(displayMismatchId, "伪造", mismatchSamples);
    await enrollments.enrollSupervised({
      version: 2,
      contactId: displayMismatchId,
      displayName: "伪造",
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: mismatchSamples,
      enrolledAt: now.toISOString(),
    });
    await registry.createConfirmed({
      contactId: displayMismatchId,
      displayName: "我",
      identityBinding: binding(mismatchFingerprint),
      now,
    });

    const driftedId = "contact-66666666666666666666666666666666" as const;
    await seedActiveContact({
      contactId: driftedId,
      displayName: "漂移",
      bindingFingerprint: "0".repeat(64),
    });

    await expect(directory.requireTextTarget(displayMismatchId, 1))
      .rejects.toThrowError("CONTACT_ENROLLMENT_DISPLAY_NAME_MISMATCH");
    await expect(directory.requireTextTarget(driftedId, 1))
      .rejects.toThrowError("CONTACT_IDENTITY_BINDING_MISMATCH");
  });

  it("rejects same-name contacts as ambiguous before issuing either target", async () => {
    const first = "contact-77777777777777777777777777777777" as const;
    const second = "contact-88888888888888888888888888888888" as const;
    await seedActiveContact({ contactId: first, displayName: "同名" });
    await seedActiveContact({ contactId: second, displayName: "同名" });

    await expect(directory.listActiveAutoReplyTargets())
      .rejects.toThrowError("CONTACT_DISPLAY_NAME_AMBIGUOUS");
    await expect(directory.requireTextTarget(first, 1))
      .rejects.toThrowError("CONTACT_DISPLAY_NAME_AMBIGUOUS");
  });

  it("migrates a legacy-only Example Contact enrollment before listing automatic reply targets", async () => {
    await enrollments.enrollSupervised({
      version: 1,
      conversationId: "example-contact",
      visibleName: "示例联系人",
      fingerprintVersion: "vision-featureprint-v1",
      referenceSamples: [featureSample(1), featureSample(2), featureSample(3)],
      enrolledAt: now.toISOString(),
    });

    await expect(directory.listActiveAutoReplyTargets()).resolves.toMatchObject([{
      contactId: "example-contact",
      displayName: "示例联系人",
      enrollment: { version: 2, contactId: "example-contact" },
    }]);
  });

  it("returns deep-frozen targets and a frozen automatic reply target list", async () => {
    const contactId = "contact-99999999999999999999999999999999" as const;
    await seedActiveContact({ contactId, displayName: "不可变" });

    const targets = await directory.listActiveAutoReplyTargets();
    const target = targets[0];
    if (target === undefined) throw new Error("TARGET_MISSING");
    const samples = target.enrollment.referenceSamples;
    const originalSample = target.enrollment.referenceSamples[0];
    const originalFingerprint = target.enrollmentFingerprint;
    const originalBindingHash = target.bindingHash;

    expect(Object.isFrozen(targets)).toBe(true);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.enrollment)).toBe(true);
    expect(Object.isFrozen(target.enrollment.referenceSamples)).toBe(true);
    expect(() => { samples[0] = "altered"; }).toThrow(TypeError);
    expect(() => { (targets as unknown as unknown[]).push(target); }).toThrow(TypeError);
    expect(target.enrollment.referenceSamples[0]).toBe(originalSample);
    expect(target.enrollmentFingerprint).toBe(originalFingerprint);
    expect(target.bindingHash).toBe(originalBindingHash);
  });
});
