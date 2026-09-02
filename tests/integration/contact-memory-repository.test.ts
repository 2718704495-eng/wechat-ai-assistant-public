import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  contactRecordSchema,
  EXAMPLE_CONTACT_CONTACT_ID,
  type ContactId,
  type ContactRecord,
} from "../../src/contacts/contact-schema.js";
import { ContactMemoryRepository, type ContactMemoryRegistry } from "../../src/memory/contact-memory-repository.js";
import {
  memoryBundleSchema,
  memoryDocumentSchema,
  memoryDocumentNames,
  type MemoryBundle,
} from "../../src/memory/schema.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { contactMemoryPath } from "../../src/storage/memory-repository.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}

  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

const firstId = `contact-${"a".repeat(32)}`;
const secondId = `contact-${"b".repeat(32)}`;

function namespaceFor(contactId: ContactId): string {
  return `contact-${createHash("sha256").update(contactId).digest("hex")}`;
}

function bundle(profileSummary: string, messageId = "same-message-id"): MemoryBundle {
  return memoryBundleSchema.parse({
    version: 2,
    documents: Object.fromEntries(memoryDocumentNames.map((name) => [name, {
      name,
      bundleId: "c".repeat(64),
      generatedAt: "2026-08-31T00:00:00.000Z",
      entries: name === "01-user-voice"
        ? [{
            id: "voice",
            kind: "style-example",
            subject: "user",
            summary: "全局语气",
            sourceType: "wechat-message",
            sourceMessageIds: [messageId],
            confidence: "high",
            sensitivity: "normal",
            status: "active",
          }]
        : name === "02-contact-profile"
          ? [{
              id: "profile",
              kind: "fact",
              subject: "contact",
              summary: profileSummary,
              sourceType: "wechat-message",
              sourceMessageIds: [messageId],
              confidence: "high",
              sensitivity: "normal",
              status: "active",
            }]
          : [],
      metadata: name === "00-memory-index"
        ? { totalMessages: 1, startAt: "2026-08-30T00:00:00.000Z", endAt: "2026-08-30T00:00:00.000Z" }
        : {},
    }])),
  });
}

describe("ContactMemoryRepository", () => {
  let rootDir: string;
  let store: EncryptedStore;
  let contacts: Map<ContactId, ContactRecord>;
  let registry: ContactMemoryRegistry;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "chat-assistant-contact-memory-"));
    store = new EncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32)));
    contacts = new Map([[firstId, record(firstId)], [secondId, record(secondId)]]);
    registry = { get: (contactId) => Promise.resolve(contacts.get(contactId) ?? null) };
    await store.write("profiles/memory/01-user-voice.enc", bundle("unused").documents["01-user-voice"]);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function memoriesFor(contactId: ContactId): ContactMemoryRepository {
    const contact = contacts.get(contactId);
    if (contact === undefined) throw new Error("missing fixture contact");
    return new ContactMemoryRepository(store, registry, contact);
  }

  it("cannot read another contact namespace", async () => {
    await memoriesFor(firstId).replaceBundle(bundle("first private profile"));

    await expect(memoriesFor(secondId).readBundle()).rejects.toThrowError("MEMORY_INCOMPLETE");
  });

  it("isolates identical message ids and returns a deep copy", async () => {
    const first = memoriesFor(firstId);
    const second = memoriesFor(secondId);
    await first.replaceBundle(bundle("first private profile", "same-message-id"));
    await second.replaceBundle(bundle("second private profile", "same-message-id"));

    const firstRead = await first.readBundle();
    firstRead.documents["02-contact-profile"].entries[0]!.summary = "mutated";

    await expect(first.readBundle()).resolves.toMatchObject({
      documents: { "02-contact-profile": { entries: [{ summary: "first private profile" }] } },
    });
    await expect(second.readBundle()).resolves.toMatchObject({
      documents: { "02-contact-profile": { entries: [{ summary: "second private profile" }] } },
    });
  });

  it("writes encrypted contact documents at the contact hash path", async () => {
    await memoriesFor(firstId).replaceBundle(bundle("first private profile"));
    const contactHash = createHash("sha256").update(firstId).digest("hex");
    const encrypted = await readFile(
      path.join(rootDir, "profiles", "contacts", contactHash, "memory", "02-contact-profile.enc"),
      "utf8",
    );

    expect(encrypted).not.toContain("first private profile");
  });

  it("fails closed for a stale revision, paused contact, and mismatched namespace", async () => {
    const stale = memoriesFor(firstId);
    contacts.set(firstId, record(firstId, { revision: 2 }));
    await expect(stale.readBundle()).rejects.toThrowError("CONTACT_REVISION_MISMATCH");

    const paused = record(firstId, { lifecycle: "paused" });
    contacts.set(firstId, paused);
    await expect(new ContactMemoryRepository(store, registry, paused).readBundle())
      .rejects.toThrowError("CONTACT_NOT_ACTIVE");

    const wrongNamespace = record(firstId, { memoryNamespace: namespaceFor(secondId) });
    contacts.set(firstId, wrongNamespace);
    await expect(new ContactMemoryRepository(store, registry, record(firstId)).readBundle())
      .rejects.toThrowError("CONTACT_MEMORY_NAMESPACE_MISMATCH");
  });

  it("migrates authenticated legacy ciphertext to a contact-bound v2 bundle", async () => {
    const legacyContact = record(EXAMPLE_CONTACT_CONTACT_ID);
    contacts.set(EXAMPLE_CONTACT_CONTACT_ID, legacyContact);
    for (const [name, document] of Object.entries(legacyDocuments("legacy private profile"))) {
      await store.write(`profiles/memory/${name}.enc`, document);
    }
    const oldCiphertext = await readFile(
      path.join(rootDir, "profiles", "memory", "02-example-contact-profile.enc"),
      "utf8",
    );
    expect(oldCiphertext).not.toContain("legacy private profile");

    const migrated = await new ContactMemoryRepository(store, registry, legacyContact).readBundle();

    expect(migrated.version).toBe(2);
    expect(migrated.documents["02-contact-profile"]).toMatchObject({
      name: "02-contact-profile",
      entries: [{ subject: "contact", summary: "legacy private profile" }],
    });
    await expect(store.read(
      contactMemoryPath(EXAMPLE_CONTACT_CONTACT_ID, "02-contact-profile"),
      memoryDocumentSchema,
    )).resolves.toMatchObject({ name: "02-contact-profile" });
  });

  it("fails closed for a partial legacy migration and does not overwrite it on retry", async () => {
    const legacyContact = record(EXAMPLE_CONTACT_CONTACT_ID);
    contacts.set(EXAMPLE_CONTACT_CONTACT_ID, legacyContact);
    for (const [name, document] of Object.entries(legacyDocuments("legacy private profile"))) {
      await store.write(`profiles/memory/${name}.enc`, document);
    }
    await store.write(
      contactMemoryPath(EXAMPLE_CONTACT_CONTACT_ID, "02-contact-profile"),
      bundle("conflicting new profile").documents["02-contact-profile"],
    );
    const repository = new ContactMemoryRepository(store, registry, legacyContact);

    await expect(repository.readBundle()).rejects.toThrowError("MEMORY_MIGRATION_INCOMPLETE");
    await expect(repository.readBundle()).rejects.toThrowError("MEMORY_MIGRATION_INCOMPLETE");
  });
});

function legacyDocuments(profileSummary: string): Record<string, unknown> {
  const legacyNames = [
    "00-memory-index", "01-user-voice", "02-example-contact-profile", "03-relationship-timeline",
    "04-interaction-patterns", "05-contact-timing", "06-topic-playbook", "07-research-policy",
    "08-live-context", "09-care-playbook",
  ];
  return Object.fromEntries(legacyNames.map((name) => [name, {
    name,
    bundleId: "d".repeat(64),
    generatedAt: "2026-08-31T00:00:00.000Z",
    entries: name === "01-user-voice" ? [{
      id: "legacy-voice", kind: "style-example", subject: "user", summary: "全局语气",
      sourceType: "wechat-message", sourceMessageIds: ["same-message-id"], confidence: "high",
      sensitivity: "normal", status: "active",
    }] : name === "02-example-contact-profile" ? [{
      id: "legacy-profile", kind: "fact", subject: "example-contact", summary: profileSummary,
      sourceType: "wechat-message", sourceMessageIds: ["same-message-id"], confidence: "high",
      sensitivity: "normal", status: "active",
    }] : [],
    metadata: name === "00-memory-index"
      ? { totalMessages: 1, startAt: "2026-08-30T00:00:00.000Z", endAt: "2026-08-30T00:00:00.000Z" }
      : {},
  }]));
}

function record(contactId: ContactId, overrides: Partial<ContactRecord> = {}): ContactRecord {
  return contactRecordSchema.parse({
    version: 1,
    contactId,
    displayName: "联系人",
    lifecycle: "active",
    autoReplyEnabled: true,
    scheduledCareEnabled: false,
    scheduledCareSlots: [],
    styleOverride: { salutation: null, tone: null, preferredLength: null, emojiPolicy: null, bannedTopics: [] },
    memoryNamespace: namespaceFor(contactId),
    identityBinding: {
      fingerprintVersion: "vision-featureprint-v1",
      enrollmentFingerprint: "a".repeat(64),
      leftPaneProofHash: "b".repeat(64),
      headerProofHash: "c".repeat(64),
      confidence: 0.98,
      confirmedAt: "2026-08-31T00:00:00.000Z",
    },
    revision: 1,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  });
}
