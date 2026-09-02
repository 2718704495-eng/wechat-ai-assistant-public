import type { ContactRecord } from "../contacts/contact-schema.js";
import { EXAMPLE_CONTACT_CONTACT_ID } from "../contacts/contact-schema.js";
import { contactMemoryPath, globalMemoryPath } from "../storage/memory-repository.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";
import {
  legacyMemoryDocumentNames,
  legacyMemoryDocumentSchema,
  memoryBundleSchema,
  memoryDocumentNames,
  memoryDocumentSchema,
  type MemoryBundle,
  type MemoryDocument,
  type MemoryDocumentName,
} from "./schema.js";

const globalVoiceDocumentName = "01-user-voice" as const;
const legacyProfileDocumentName = "02-example-contact-profile" as const;
const contactProfileDocumentName = "02-contact-profile" as const;
const contactDocumentNames = memoryDocumentNames.filter((name) => name !== globalVoiceDocumentName);

export interface ContactMemoryRegistry {
  get(contactId: ContactRecord["contactId"]): Promise<ContactRecord | null>;
}

export type ContactMemoryBinding = Pick<ContactRecord, "contactId" | "revision" | "memoryNamespace">;

export class ContactMemoryRepository {
  public constructor(
    private readonly store: EncryptedStore,
    private readonly registry: ContactMemoryRegistry,
    private readonly binding: ContactMemoryBinding,
  ) {}

  public async replaceBundle(bundle: MemoryBundle): Promise<void> {
    const contact = await this.requireActiveContact();
    const validated = memoryBundleSchema.parse(bundle);
    if (validated.version !== 2) throw new Error("MEMORY_MIGRATION_REQUIRED");
    const index = validated.documents["00-memory-index"];
    if (contactDocumentNames.some((name) => validated.documents[name].bundleId !== index.bundleId)) {
      throw new Error("MEMORY_GENERATION_MISMATCH");
    }
    if (await this.readGlobalVoice() === null) throw new Error("MEMORY_INCOMPLETE");
    await Promise.all(contactDocumentNames.filter((name) => name !== "00-memory-index").map((name) =>
      this.store.write(contactMemoryPath(contact.contactId, name), validated.documents[name])
    ));
    await this.store.write(contactMemoryPath(contact.contactId, "00-memory-index"), index);
  }

  public async readBundle(): Promise<MemoryBundle> {
    const contact = await this.requireActiveContact();
    const index = await this.readContactDocument(contact, "00-memory-index");
    if (index === null) {
      await this.migrateLegacyBundle(contact);
      return this.readCurrentBundle(contact);
    }
    return this.readCurrentBundle(contact, index);
  }

  private async readCurrentBundle(contact: ContactRecord, knownIndex?: MemoryDocument): Promise<MemoryBundle> {
    const index = knownIndex ?? await this.readContactDocument(contact, "00-memory-index");
    const globalVoice = await this.readGlobalVoice();
    if (index === null || globalVoice === null) throw new Error("MEMORY_INCOMPLETE");
    const pairs = await Promise.all(memoryDocumentNames.map(async (name) => [
      name,
      name === globalVoiceDocumentName ? globalVoice
        : name === "00-memory-index" ? index : await this.readContactDocument(contact, name),
    ] as const));
    if (pairs.some(([, document]) => document === null)) throw new Error("MEMORY_INCOMPLETE");
    if (pairs.some(([name, document]) => name !== globalVoiceDocumentName && document?.bundleId !== index.bundleId)) {
      throw new Error("MEMORY_GENERATION_MISMATCH");
    }
    return memoryBundleSchema.parse({ version: 2, documents: Object.fromEntries(pairs) });
  }

  private async migrateLegacyBundle(contact: ContactRecord): Promise<void> {
    if (contact.contactId !== EXAMPLE_CONTACT_CONTACT_ID) throw new Error("MEMORY_INCOMPLETE");
    if (await this.hasPartialTarget(contact)) throw new Error("MEMORY_MIGRATION_INCOMPLETE");
    const legacyPairs = await Promise.all(legacyMemoryDocumentNames.map(async (name) => [
      name, await this.store.read(`profiles/memory/${name}.enc`, legacyMemoryDocumentSchema),
    ] as const));
    if (legacyPairs.some(([, document]) => document === null)) throw new Error("MEMORY_INCOMPLETE");
    const legacyIndex = legacyPairs.find(([name]) => name === "00-memory-index")?.[1];
    if (legacyIndex === null || legacyIndex === undefined) throw new Error("MEMORY_INCOMPLETE");
    if (legacyPairs.some(([, document]) => document?.bundleId !== legacyIndex.bundleId)) {
      throw new Error("MEMORY_GENERATION_MISMATCH");
    }
    const migrated = new Map<MemoryDocumentName, MemoryDocument>();
    for (const [legacyName, legacyDocument] of legacyPairs) {
      if (legacyDocument === null) throw new Error("MEMORY_INCOMPLETE");
      const name = legacyName === legacyProfileDocumentName
        ? contactProfileDocumentName
        : legacyName;
      migrated.set(name, memoryDocumentSchema.parse({
        ...legacyDocument,
        name,
        entries: legacyDocument.entries.map((entry) => ({
          ...entry,
          subject: entry.subject === "example-contact" ? "contact" : entry.subject,
        })),
      }));
    }
    await Promise.all(contactDocumentNames.filter((name) => name !== "00-memory-index").map((name) =>
      this.store.write(contactMemoryPath(contact.contactId, name), migrated.get(name))
    ));
    const index = migrated.get("00-memory-index");
    if (index === undefined) throw new Error("MEMORY_INCOMPLETE");
    await this.store.write(contactMemoryPath(contact.contactId, "00-memory-index"), index);
    await this.readCurrentBundle(contact);
  }

  private async hasPartialTarget(contact: ContactRecord): Promise<boolean> {
    const documents = await Promise.all(contactDocumentNames.map((name) => this.readContactDocument(contact, name)));
    return documents.some((document) => document !== null);
  }

  private async requireActiveContact(): Promise<ContactRecord> {
    const contact = await this.registry.get(this.binding.contactId);
    if (contact === null) throw new Error("CONTACT_NOT_FOUND");
    if (contact.lifecycle !== "active") throw new Error("CONTACT_NOT_ACTIVE");
    if (contact.revision !== this.binding.revision) throw new Error("CONTACT_REVISION_MISMATCH");
    if (contact.memoryNamespace !== this.binding.memoryNamespace) {
      throw new Error("CONTACT_MEMORY_NAMESPACE_MISMATCH");
    }
    return contact;
  }

  private readGlobalVoice(): Promise<MemoryDocument | null> {
    return this.store.read(globalMemoryPath(globalVoiceDocumentName), memoryDocumentSchema);
  }

  private readContactDocument(
    contact: ContactRecord,
    name: Exclude<MemoryDocumentName, typeof globalVoiceDocumentName>,
  ): Promise<MemoryDocument | null> {
    return this.store.read(contactMemoryPath(contact.contactId, name), memoryDocumentSchema);
  }
}
