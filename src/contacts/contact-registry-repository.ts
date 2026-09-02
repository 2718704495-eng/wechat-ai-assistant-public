import { createHash } from "node:crypto";

import { z } from "zod";

import {
  contactIdSchema,
  contactIdentityBindingSchema,
  contactRecordSchema,
  contactStyleOverrideSchema,
  EXAMPLE_CONTACT_CONTACT_ID,
  type ContactId,
  type ContactPatch,
  type ContactRecord,
  type CreateConfirmedContact,
} from "./contact-schema.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";

const CONTACT_REGISTRY_PATH = "profiles/contacts.enc";
const CONTACT_REGISTRY_LOCK_PATH = "state/contacts.lock";

const contactRegistrySchema = z.object({
  version: z.literal(1),
  contacts: z.array(contactRecordSchema),
}).strict();

const contactPatchSchema = z.object({
  lifecycle: z.enum(["active", "paused", "deleted"]).optional(),
  autoReplyEnabled: z.boolean().optional(),
  scheduledCareEnabled: z.boolean().optional(),
  scheduledCareSlots: z.array(z.enum(["06:30", "22:00"])).max(2).optional(),
  styleOverride: contactStyleOverrideSchema.optional(),
}).strict();

const displayNameSchema = z.string().trim().min(1).max(64);

type ContactRegistry = z.infer<typeof contactRegistrySchema>;

const contactRegistryRepositoryProvenance = new WeakSet<ContactRegistryRepository>();

export interface SeedExampleContactFromConfirmedIdentityBinding {
  readonly identityBinding: z.input<typeof contactIdentityBindingSchema>;
  readonly now: Date;
}

export class ContactRegistryRepository {
  readonly #store: EncryptedStore;

  public constructor(store: EncryptedStore) {
    this.#store = store;
    if (new.target === ContactRegistryRepository) {
      contactRegistryRepositoryProvenance.add(this);
    }
  }

  public async list(): Promise<readonly ContactRecord[]> {
    const registry = await this.#readRegistry();
    return registry.contacts.map(copyRecord);
  }

  public async get(contactId: ContactId): Promise<ContactRecord | null> {
    const parsedContactId = contactIdSchema.parse(contactId);
    const registry = await this.#readRegistry();
    const record = registry.contacts.find((candidate) => candidate.contactId === parsedContactId);
    return record === undefined ? null : copyRecord(record);
  }

  public async createConfirmed(input: CreateConfirmedContact): Promise<ContactRecord> {
    const contactId = contactIdSchema.parse(input.contactId);
    const displayName = displayNameSchema.parse(input.displayName);
    const identityBinding = contactIdentityBindingSchema.parse(input.identityBinding);
    const timestamp = timestampFrom(input.now);

    return this.#store.runExclusiveTransaction(CONTACT_REGISTRY_LOCK_PATH, async () => {
      const registry = await this.#readRegistry();
      if (registry.contacts.some((candidate) => candidate.contactId === contactId)) {
        throw new Error("CONTACT_ALREADY_EXISTS");
      }
      const record = contactRecordSchema.parse({
        version: 1,
        contactId,
        displayName,
        lifecycle: "active",
        autoReplyEnabled: true,
        scheduledCareEnabled: false,
        scheduledCareSlots: [],
        styleOverride: emptyStyleOverride(),
        memoryNamespace: memoryNamespaceFor(contactId),
        identityBinding,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      registry.contacts.push(record);
      await this.#writeRegistry(registry);
      return copyRecord(record);
    });
  }

  public async update(
    contactId: ContactId,
    expectedRevision: number,
    patch: ContactPatch,
    now: Date,
  ): Promise<ContactRecord> {
    const parsedContactId = contactIdSchema.parse(contactId);
    const parsedPatch = contactPatchSchema.parse(patch);
    const timestamp = timestampFrom(now);

    return this.#store.runExclusiveTransaction(CONTACT_REGISTRY_LOCK_PATH, async () => {
      const registry = await this.#readRegistry();
      const index = registry.contacts.findIndex((candidate) => candidate.contactId === parsedContactId);
      if (index === -1) throw new Error("CONTACT_NOT_FOUND");
      const existing = registry.contacts[index];
      if (existing === undefined) throw new Error("CONTACT_NOT_FOUND");
      if (existing.revision !== expectedRevision) {
        throw new Error("CONTACT_REVISION_MISMATCH");
      }
      const updated = contactRecordSchema.parse({
        ...existing,
        ...parsedPatch,
        revision: existing.revision + 1,
        updatedAt: timestamp,
      });
      registry.contacts[index] = updated;
      await this.#writeRegistry(registry);
      return copyRecord(updated);
    });
  }

  public delete(contactId: ContactId, expectedRevision: number, now: Date): Promise<ContactRecord> {
    return this.update(contactId, expectedRevision, { lifecycle: "deleted" }, now);
  }

  public async seedExampleContactFromConfirmedIdentityBinding(
    input: SeedExampleContactFromConfirmedIdentityBinding,
  ): Promise<ContactRecord> {
    const identityBinding = contactIdentityBindingSchema.parse(input.identityBinding);
    const timestamp = timestampFrom(input.now);

    return this.#store.runExclusiveTransaction(CONTACT_REGISTRY_LOCK_PATH, async () => {
      const registry = await this.#readRegistry();
      const existing = registry.contacts.find((candidate) =>
        candidate.contactId === EXAMPLE_CONTACT_CONTACT_ID
      );
      if (existing !== undefined) return copyRecord(existing);
      const record = contactRecordSchema.parse({
        version: 1,
        contactId: EXAMPLE_CONTACT_CONTACT_ID,
        displayName: "示例联系人",
        lifecycle: "active",
        autoReplyEnabled: true,
        scheduledCareEnabled: true,
        scheduledCareSlots: ["06:30", "22:00"],
        styleOverride: emptyStyleOverride(),
        memoryNamespace: memoryNamespaceFor(EXAMPLE_CONTACT_CONTACT_ID),
        identityBinding,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      registry.contacts.push(record);
      await this.#writeRegistry(registry);
      return copyRecord(record);
    });
  }

  async #readRegistry(): Promise<ContactRegistry> {
    return (await this.#store.read(CONTACT_REGISTRY_PATH, contactRegistrySchema)) ?? {
      version: 1,
      contacts: [],
    };
  }

  #writeRegistry(registry: ContactRegistry): Promise<void> {
    return this.#store.write(CONTACT_REGISTRY_PATH, contactRegistrySchema.parse(registry));
  }
}

export function assertContactRegistryRepository(
  repository: unknown,
): asserts repository is ContactRegistryRepository {
  if (
    typeof repository !== "object" ||
    repository === null ||
    !contactRegistryRepositoryProvenance.has(repository as ContactRegistryRepository) ||
    Object.getPrototypeOf(repository) !== ContactRegistryRepository.prototype ||
    hasOwnPrototypeMethod(repository, ContactRegistryRepository.prototype)
  ) {
    throw new Error("CONTACT_REGISTRY_REPOSITORY_PROVENANCE_REQUIRED");
  }
}

function emptyStyleOverride() {
  return {
    salutation: null,
    tone: null,
    preferredLength: null,
    emojiPolicy: null,
    bannedTopics: [],
  };
}

function memoryNamespaceFor(contactId: ContactId): string {
  return `contact-${createHash("sha256").update(contactId).digest("hex")}`;
}

function timestampFrom(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("CONTACT_TIMESTAMP_INVALID");
  return now.toISOString();
}

function copyRecord(record: ContactRecord): ContactRecord {
  return structuredClone(record);
}

function hasOwnPrototypeMethod(instance: object, prototype: object): boolean {
  return Reflect.ownKeys(prototype).some((key) =>
    key !== "constructor" && Object.hasOwn(instance, key)
  );
}
