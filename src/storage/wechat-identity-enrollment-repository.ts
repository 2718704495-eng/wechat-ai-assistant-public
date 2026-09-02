import { createHash } from "node:crypto";

import { z } from "zod";

import {
  EXAMPLE_CONTACT_CONTACT_ID,
  contactIdSchema,
  type ContactId,
} from "../contacts/contact-schema.js";
import {
  assertContactRegistryRepository,
  ContactRegistryRepository,
} from "../contacts/contact-registry-repository.js";
import type { EncryptedStore } from "./encrypted-store.js";

const legacyEnrollmentSchema = z.object({
  version: z.literal(1),
  conversationId: z.enum(["example-contact", "file-transfer"]),
  visibleName: z.enum(["示例联系人", "文件传输助手"]),
  fingerprintVersion: z.literal("vision-featureprint-v1"),
  referenceSamples: z.array(z.string().min(4).max(32_768)).min(3).max(5),
  enrolledAt: z.string().datetime(),
}).strict();

const contactEnrollmentSchema = z.object({
  version: z.literal(2),
  contactId: contactIdSchema,
  displayName: z.string().trim().min(1).max(64),
  fingerprintVersion: z.literal("vision-featureprint-v1"),
  referenceSamples: z.array(z.string().min(4).max(32_768)).min(3).max(5),
  enrolledAt: z.string().datetime(),
}).strict();

const enrollmentSchema = z.discriminatedUnion("version", [
  legacyEnrollmentSchema,
  contactEnrollmentSchema,
]);

const enrollmentStateSchema = z.object({
  version: z.literal(1),
  enrollments: z.array(enrollmentSchema),
}).strict();

export type LegacyWechatIdentityEnrollment = Readonly<z.infer<typeof legacyEnrollmentSchema>>;
export type WechatContactIdentityEnrollment = Readonly<z.infer<typeof contactEnrollmentSchema>>;
export type WechatIdentityEnrollment = Readonly<z.infer<typeof enrollmentSchema>>;

type LegacyExampleContactMigration =
  | { readonly kind: "already-migrated"; readonly enrollment: WechatContactIdentityEnrollment }
  | {
    readonly kind: "legacy";
    readonly legacy: LegacyWechatIdentityEnrollment;
    readonly enrollment: WechatContactIdentityEnrollment;
    readonly identityBinding: {
      readonly fingerprintVersion: "vision-featureprint-v1";
      readonly enrollmentFingerprint: string;
      readonly leftPaneProofHash: string;
      readonly headerProofHash: string;
      readonly confidence: 1;
      readonly confirmedAt: string;
    };
    readonly migrationDate: Date;
  };

const ENROLLMENT_PATH = "profiles/wechat-identity-enrollment.enc";
const ENROLLMENT_STATE_LOCK_PATH = "state/wechat-identity-enrollment.lock";
const enrollmentRepositoryProvenance = new WeakSet<WechatIdentityEnrollmentRepository>();

export class WechatIdentityEnrollmentRepository {
  public static readonly maximumDistance = 0.18;

  readonly #store: EncryptedStore;

  public constructor(store: EncryptedStore) {
    this.#store = store;
    if (new.target === WechatIdentityEnrollmentRepository) {
      enrollmentRepositoryProvenance.add(this);
    }
  }

  public enrollSupervised(input: WechatIdentityEnrollment): Promise<void> {
    return Promise.resolve().then(async () => {
      const enrollment = enrollmentSchema.parse(input);
      assertEnrollment(enrollment);
      await this.#withStateTransaction(async (state) => {
        const existing = findEnrollment(state.enrollments, enrollmentKey(enrollment));
        if (existing !== undefined) {
          if (JSON.stringify(existing) === JSON.stringify(enrollment)) return;
          throw new Error("WECHAT_IDENTITY_ENROLLMENT_IMMUTABLE");
        }
        const claimed = await this.#store.createExclusiveMarker(
          `profiles/wechat-identity-enrollment-${enrollmentKey(enrollment)}.claim`,
        );
        if (!claimed) {
          const winner = findEnrollment((await this.#readState()).enrollments, enrollmentKey(enrollment));
          if (winner !== undefined && JSON.stringify(winner) === JSON.stringify(enrollment)) return;
          throw new Error(winner === undefined
            ? "WECHAT_IDENTITY_ENROLLMENT_IN_PROGRESS"
            : "WECHAT_IDENTITY_ENROLLMENT_IMMUTABLE");
        }
        state.enrollments.push(enrollment);
        await this.#store.write(ENROLLMENT_PATH, state);
      });
    });
  }

  public require(id: string): Promise<WechatIdentityEnrollment> {
    return this.#withStateTransaction((state) => {
      const enrollment = findEnrollment(state.enrollments, id);
      if (enrollment === undefined) throw new Error("WECHAT_IDENTITY_ENROLLMENT_REQUIRED");
      assertEnrollment(enrollment);
      return Promise.resolve(freezeEnrollment(enrollment));
    });
  }

  public requireContact(contactId: ContactId): Promise<WechatContactIdentityEnrollment> {
    const parsedContactId = contactIdSchema.parse(contactId);
    return this.#withStateTransaction((state) => {
      const enrollment = findEnrollment(state.enrollments, parsedContactId);
      if (enrollment === undefined || enrollment.version !== 2) {
        throw new Error("WECHAT_IDENTITY_ENROLLMENT_REQUIRED");
      }
      assertEnrollment(enrollment);
      return Promise.resolve(freezeEnrollment(enrollment) as WechatContactIdentityEnrollment);
    });
  }

  public migrateLegacyExampleContact(
    registry: ContactRegistryRepository,
  ): Promise<WechatContactIdentityEnrollment> {
    assertContactRegistryRepository(registry);
    return this.#prepareLegacyExampleContactMigration().then(async (migration) => {
      if (migration.kind === "already-migrated") return migration.enrollment;
      assertContactRegistryRepository(registry);
      const seeded = await ContactRegistryRepository.prototype
        .seedExampleContactFromConfirmedIdentityBinding.call(registry, {
          identityBinding: migration.identityBinding,
          now: migration.migrationDate,
        });
      if (seeded.contactId !== EXAMPLE_CONTACT_CONTACT_ID ||
          seeded.displayName !== migration.enrollment.displayName ||
          seeded.identityBinding.enrollmentFingerprint !==
            migration.identityBinding.enrollmentFingerprint) {
        throw new Error("WECHAT_IDENTITY_ENROLLMENT_MIGRATION_CONFLICT");
      }
      return this.#withStateTransaction(async (state) => {
        const current = findEnrollment(state.enrollments, EXAMPLE_CONTACT_CONTACT_ID);
        if (current?.version === 2) {
          if (JSON.stringify(current) !== JSON.stringify(migration.enrollment)) {
            throw new Error("WECHAT_IDENTITY_ENROLLMENT_MIGRATION_CONFLICT");
          }
          return freezeEnrollment(current) as WechatContactIdentityEnrollment;
        }
        if (current === undefined || !isLegacyExampleContact(current) ||
            JSON.stringify(current) !== JSON.stringify(migration.legacy)) {
          throw new Error("WECHAT_IDENTITY_ENROLLMENT_MIGRATION_RETRY_REQUIRED");
        }
        state.enrollments = state.enrollments.map((candidate) =>
          isLegacyExampleContact(candidate) ? migration.enrollment : candidate
        );
        await this.#store.write(ENROLLMENT_PATH, state);
        return freezeEnrollment(migration.enrollment) as WechatContactIdentityEnrollment;
      });
    });
  }

  async #readState(): Promise<z.infer<typeof enrollmentStateSchema>> {
    return (await this.#store.read(ENROLLMENT_PATH, enrollmentStateSchema)) ?? {
      version: 1,
      enrollments: [],
    };
  }

  #withStateTransaction<T>(
    operation: (state: z.infer<typeof enrollmentStateSchema>) => Promise<T>,
  ): Promise<T> {
    return this.#store.runExclusiveTransaction(ENROLLMENT_STATE_LOCK_PATH, async () =>
      operation(await this.#readState())
    );
  }

  #prepareLegacyExampleContactMigration(): Promise<LegacyExampleContactMigration> {
    return this.#withStateTransaction<LegacyExampleContactMigration>((state) => {
      const existing = findEnrollment(state.enrollments, EXAMPLE_CONTACT_CONTACT_ID);
      if (existing?.version === 2) {
        assertEnrollment(existing);
        return Promise.resolve({
          kind: "already-migrated" as const,
          enrollment: freezeEnrollment(existing) as WechatContactIdentityEnrollment,
        });
      }
      if (existing === undefined || !isLegacyExampleContact(existing)) {
        throw new Error("WECHAT_IDENTITY_ENROLLMENT_REQUIRED");
      }
      assertEnrollment(existing);
      const enrollment = contactEnrollmentSchema.parse({
        version: 2,
        contactId: EXAMPLE_CONTACT_CONTACT_ID,
        displayName: existing.visibleName,
        fingerprintVersion: existing.fingerprintVersion,
        referenceSamples: existing.referenceSamples,
        enrolledAt: existing.enrolledAt,
      });
      const migrationDate = new Date(existing.enrolledAt);
      if (!Number.isFinite(migrationDate.getTime())) {
        throw new Error("WECHAT_IDENTITY_ENROLLMENT_INVALID");
      }
      const enrollmentFingerprint = wechatIdentityEnrollmentFingerprint(enrollment);
      const legacyFingerprint = wechatIdentityEnrollmentFingerprint(existing);
      return Promise.resolve({
        kind: "legacy",
        legacy: freezeEnrollment(existing) as LegacyWechatIdentityEnrollment,
        enrollment: freezeEnrollment(enrollment) as WechatContactIdentityEnrollment,
        identityBinding: {
          fingerprintVersion: enrollment.fingerprintVersion,
          enrollmentFingerprint,
          leftPaneProofHash: proofHash("wechat-legacy-example-contact-left-pane-v1", legacyFingerprint),
          headerProofHash: proofHash("wechat-legacy-example-contact-header-v1", legacyFingerprint),
          confidence: 1,
          confirmedAt: existing.enrolledAt,
        },
        migrationDate,
      });
    });
  }
}

export function assertWechatIdentityEnrollmentRepository(
  repository: unknown,
): asserts repository is WechatIdentityEnrollmentRepository {
  if (
    typeof repository !== "object" ||
    repository === null ||
    !enrollmentRepositoryProvenance.has(repository as WechatIdentityEnrollmentRepository) ||
    Object.getPrototypeOf(repository) !== WechatIdentityEnrollmentRepository.prototype ||
    hasOwnPrototypeMethod(repository, WechatIdentityEnrollmentRepository.prototype)
  ) {
    throw new Error("WECHAT_IDENTITY_ENROLLMENT_REPOSITORY_PROVENANCE_REQUIRED");
  }
}

export function wechatIdentityEnrollmentFingerprint(
  enrollment: WechatIdentityEnrollment,
): string {
  return createHash("sha256")
    .update([
      enrollment.version,
      ...(enrollment.version === 1
        ? [enrollment.conversationId, enrollment.visibleName]
        : [enrollment.contactId, enrollment.displayName]),
      enrollment.fingerprintVersion,
      WechatIdentityEnrollmentRepository.maximumDistance.toString(),
      ...enrollment.referenceSamples,
    ].join("\0"))
    .digest("hex");
}

function enrollmentKey(enrollment: WechatIdentityEnrollment): string {
  return enrollment.version === 1 ? enrollment.conversationId : enrollment.contactId;
}

function findEnrollment(
  enrollments: readonly WechatIdentityEnrollment[],
  key: string,
): WechatIdentityEnrollment | undefined {
  const matches = enrollments.filter((candidate) => enrollmentKey(candidate) === key);
  if (matches.length > 1) throw new Error("WECHAT_IDENTITY_ENROLLMENT_AMBIGUOUS");
  return matches[0];
}

function assertEnrollment(enrollment: WechatIdentityEnrollment): void {
  assertSamples(enrollment.referenceSamples);
  if (enrollment.version === 1) assertLegacyEnrollmentTarget(enrollment);
}

function isLegacyExampleContact(
  enrollment: WechatIdentityEnrollment,
): enrollment is LegacyWechatIdentityEnrollment {
  return enrollment.version === 1 && enrollment.conversationId === EXAMPLE_CONTACT_CONTACT_ID;
}

function assertSamples(samples: readonly string[]): void {
  const decoded = samples.map((sample) => {
    const bytes = Buffer.from(sample, "base64");
    if (bytes.length < 32 || bytes.length > 24_576 ||
        bytes.subarray(0, 8).toString("ascii") !== "bplist00" ||
        bytes.toString("base64") !== sample) {
      throw new Error("WECHAT_IDENTITY_ENROLLMENT_SAMPLE_INVALID");
    }
    return bytes;
  });
  if (new Set(decoded.map(({ length }) => length)).size !== 1) {
    throw new Error("WECHAT_IDENTITY_ENROLLMENT_SAMPLE_INVALID");
  }
}

function assertLegacyEnrollmentTarget(enrollment: LegacyWechatIdentityEnrollment): void {
  if ((enrollment.conversationId === "example-contact" && enrollment.visibleName !== "示例联系人") ||
      (enrollment.conversationId === "file-transfer" && enrollment.visibleName !== "文件传输助手")) {
    throw new Error("WECHAT_IDENTITY_ENROLLMENT_TARGET_INVALID");
  }
}

function proofHash(prefix: string, fingerprint: string): string {
  return createHash("sha256").update(`${prefix}\0${fingerprint}`).digest("hex");
}

function freezeEnrollment(enrollment: WechatIdentityEnrollment): WechatIdentityEnrollment {
  const copied = structuredClone(enrollment);
  Object.freeze(copied.referenceSamples);
  return Object.freeze(copied);
}

function hasOwnPrototypeMethod(instance: object, prototype: object): boolean {
  return Reflect.ownKeys(prototype).some((key) =>
    key !== "constructor" && Object.hasOwn(instance, key)
  );
}
