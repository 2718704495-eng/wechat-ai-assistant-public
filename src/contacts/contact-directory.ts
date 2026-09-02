import { createHash } from "node:crypto";

import {
  EXAMPLE_CONTACT_CONTACT_ID,
  contactIdSchema,
  type ContactId,
  type ContactRecord,
} from "./contact-schema.js";
import {
  assertContactRegistryRepository,
  ContactRegistryRepository,
} from "./contact-registry-repository.js";
import {
  assertWechatIdentityEnrollmentRepository,
  WechatIdentityEnrollmentRepository,
  wechatIdentityEnrollmentFingerprint,
  type WechatContactIdentityEnrollment,
} from "../storage/wechat-identity-enrollment-repository.js";

export interface AuthorizedWechatTarget {
  readonly contactId: ContactId;
  readonly displayName: string;
  readonly revision: number;
  readonly enrollment: WechatContactIdentityEnrollment;
  readonly enrollmentFingerprint: string;
  readonly bindingHash: string;
}

const directoryProvenance = new WeakSet<ContactDirectory>();
const targetProvenance = new WeakSet<object>();

export function assertAuthorizedWechatTarget(
  target: unknown,
): asserts target is AuthorizedWechatTarget {
  if (typeof target !== "object" || target === null || !targetProvenance.has(target)) {
    throw new Error("WECHAT_TARGET_PROVENANCE_REQUIRED");
  }
}

export function assertContactDirectory(
  directory: unknown,
): asserts directory is ContactDirectory {
  if (
    typeof directory !== "object" ||
    directory === null ||
    !directoryProvenance.has(directory as ContactDirectory)
  ) {
    throw new Error("CONTACT_DIRECTORY_PROVENANCE_REQUIRED");
  }
}

export class ContactDirectory {
  readonly #registry: ContactRegistryRepository;
  readonly #enrollments: WechatIdentityEnrollmentRepository;

  public constructor(
    registry: ContactRegistryRepository,
    enrollments: WechatIdentityEnrollmentRepository,
  ) {
    assertContactRegistryRepository(registry);
    assertWechatIdentityEnrollmentRepository(enrollments);
    this.#registry = registry;
    this.#enrollments = enrollments;
    directoryProvenance.add(this);
  }

  public requireActiveAutoReplyTarget(contactId: ContactId): Promise<AuthorizedWechatTarget> {
    return this.#requireTarget(contactId, undefined, true);
  }

  public requireTextTarget(
    contactId: ContactId,
    expectedRevision: number,
  ): Promise<AuthorizedWechatTarget> {
    return this.#requireTarget(contactId, expectedRevision, false);
  }

  public async listActiveAutoReplyTargets(): Promise<readonly AuthorizedWechatTarget[]> {
    this.#assertDependencyProvenance();
    await this.#migrateLegacyExampleContactIfPresent();
    const contacts = await this.#listContacts();
    const candidates = contacts.filter((contact) =>
      contact.lifecycle === "active" && contact.autoReplyEnabled
    );
    return Object.freeze(await Promise.all(
      candidates.map((contact) => this.#requireTarget(contact.contactId, undefined, true)),
    ));
  }

  async #requireTarget(
    contactId: ContactId,
    expectedRevision: number | undefined,
    requireAutoReply: boolean,
  ): Promise<AuthorizedWechatTarget> {
    this.#assertDependencyProvenance();
    const parsedContactId = contactIdSchema.parse(contactId);
    if (parsedContactId === EXAMPLE_CONTACT_CONTACT_ID) {
      await this.#migrateLegacyExampleContactIfPresent();
    }
    const contact = await this.#getContact(parsedContactId);
    if (contact === null) throw new Error("CONTACT_NOT_FOUND");
    if (contact.lifecycle !== "active") throw new Error("CONTACT_NOT_ACTIVE");
    if (requireAutoReply && !contact.autoReplyEnabled) {
      throw new Error("CONTACT_AUTO_REPLY_DISABLED");
    }
    if (expectedRevision !== undefined && contact.revision !== expectedRevision) {
      throw new Error("CONTACT_REVISION_MISMATCH");
    }
    await this.#assertDisplayNameUnambiguous(contact);
    const enrollment = await this.#requireEnrollment(parsedContactId);
    if (enrollment.displayName.normalize("NFC") !== contact.displayName.normalize("NFC")) {
      throw new Error("CONTACT_ENROLLMENT_DISPLAY_NAME_MISMATCH");
    }
    const enrollmentFingerprint = wechatIdentityEnrollmentFingerprint(enrollment);
    if (contact.identityBinding.enrollmentFingerprint !== enrollmentFingerprint) {
      throw new Error("CONTACT_IDENTITY_BINDING_MISMATCH");
    }
    this.#assertDependencyProvenance();
    const target: AuthorizedWechatTarget = Object.freeze({
      contactId: contact.contactId,
      displayName: contact.displayName,
      revision: contact.revision,
      enrollment,
      enrollmentFingerprint,
      bindingHash: bindingHash(contact, enrollmentFingerprint),
    });
    targetProvenance.add(target);
    return target;
  }

  async #assertDisplayNameUnambiguous(contact: ContactRecord): Promise<void> {
    const normalizedName = contact.displayName.normalize("NFC");
    const duplicate = (await this.#listContacts()).some((candidate) =>
      candidate.contactId !== contact.contactId &&
      candidate.lifecycle !== "deleted" &&
      candidate.displayName.normalize("NFC") === normalizedName
    );
    if (duplicate) throw new Error("CONTACT_DISPLAY_NAME_AMBIGUOUS");
  }

  async #migrateLegacyExampleContactIfPresent(): Promise<void> {
    this.#assertDependencyProvenance();
    await WechatIdentityEnrollmentRepository.prototype.migrateLegacyExampleContact
      .call(this.#enrollments, this.#registry).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "WECHAT_IDENTITY_ENROLLMENT_REQUIRED") {
        throw error;
      }
    });
  }

  #assertDependencyProvenance(): void {
    assertContactRegistryRepository(this.#registry);
    assertWechatIdentityEnrollmentRepository(this.#enrollments);
  }

  #listContacts(): Promise<readonly ContactRecord[]> {
    this.#assertDependencyProvenance();
    return ContactRegistryRepository.prototype.list.call(this.#registry);
  }

  #getContact(contactId: ContactId): Promise<ContactRecord | null> {
    this.#assertDependencyProvenance();
    return ContactRegistryRepository.prototype.get.call(this.#registry, contactId);
  }

  #requireEnrollment(contactId: ContactId): Promise<WechatContactIdentityEnrollment> {
    this.#assertDependencyProvenance();
    return WechatIdentityEnrollmentRepository.prototype.requireContact
      .call(this.#enrollments, contactId);
  }
}

function bindingHash(contact: ContactRecord, enrollmentFingerprint: string): string {
  return createHash("sha256").update([
    "wechat-contact-binding-v1",
    contact.contactId,
    String(contact.revision),
    contact.displayName.normalize("NFC"),
    enrollmentFingerprint,
  ].join("\0")).digest("hex");
}
