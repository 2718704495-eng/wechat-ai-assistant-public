import { createHash } from "node:crypto";

import { z } from "zod";

import { contactIdSchema, type ContactId } from "../contacts/contact-schema.js";
import {
  memoryBundleSchema,
  memoryDocumentNames,
  memoryDocumentSchema,
  type MemoryBundle,
  type MemoryDocument,
  type MemoryDocumentName,
} from "../memory/schema.js";
import type { EncryptedStore } from "./encrypted-store.js";

type MemoryHealthReason =
  | "OK"
  | "MEMORY_INCOMPLETE"
  | "SOURCE_HASH_MISMATCH"
  | "MEMORY_GENERATION_MISMATCH"
  | "MEMORY_CORRUPT";

const contentDocumentNames = memoryDocumentNames.filter(
  (name) => name !== "00-memory-index",
);

export interface StickerCatalogEntry {
  id: string;
  family: "yellow-character" | "white-cat" | "cat-ok";
  tags: readonly string[];
  visualFingerprint: string;
  favoriteTab: "heart";
  locator: { readonly row: number; readonly column: number };
  liveVerifiable: boolean;
  verifiedAt: string;
}

const stickerCatalogProvenance = Symbol("memory-repository-sticker-catalog");
const stickerEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    family: z.enum(["yellow-character", "white-cat", "cat-ok"]),
    tags: z.array(z.string().trim().min(1)),
    visualFingerprint: z.string().trim().min(1),
    favoriteTab: z.literal("heart"),
    locator: z.object({
      row: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
    }),
    liveVerifiable: z.boolean(),
    verifiedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const stickerCatalogSchema = z.array(stickerEntrySchema);

export class ValidatedStickerCatalog {
  readonly #entries: readonly StickerCatalogEntry[];
  public readonly sourceDocument = "01-user-voice" as const;

  public constructor(
    provenance: symbol,
    entries: readonly StickerCatalogEntry[],
  ) {
    if (provenance !== stickerCatalogProvenance) {
      throw new Error("STICKER_CATALOG_PROVENANCE_REQUIRED");
    }
    this.#entries = entries;
    Object.freeze(this);
  }

  public static hasRepositoryProvenance(
    value: unknown,
  ): value is ValidatedStickerCatalog {
    return typeof value === "object" && value !== null && #entries in value;
  }

  public get entries(): readonly StickerCatalogEntry[] {
    return this.#entries;
  }
}

export function globalMemoryPath(name: MemoryDocumentName): string {
  return `profiles/memory/${name}.enc`;
}

export function contactMemoryPath(contactId: ContactId, name: MemoryDocumentName): string {
  const parsedContactId = contactIdSchema.parse(contactId);
  const contactHash = createHash("sha256").update(parsedContactId).digest("hex");
  return `profiles/contacts/${contactHash}/memory/${name}.enc`;
}

export class MemoryRepository {
  public constructor(private readonly store: EncryptedStore) {}

  public async replaceBundle(bundle: MemoryBundle): Promise<void> {
    const validated = memoryBundleSchema.parse(bundle);
    const bundleId = validated.documents["00-memory-index"].bundleId;
    if (memoryDocumentNames.some((name) => validated.documents[name].bundleId !== bundleId)) {
      throw new Error("MEMORY_GENERATION_MISMATCH");
    }
    await Promise.all(
      contentDocumentNames.map((name) => this.store.write(globalMemoryPath(name), validated.documents[name])),
    );
    await this.store.write(
      globalMemoryPath("00-memory-index"),
      validated.documents["00-memory-index"],
    );
  }

  public readDocument(name: MemoryDocumentName): Promise<MemoryDocument | null> {
    return this.store.read(globalMemoryPath(name), memoryDocumentSchema);
  }

  public async readStickerCatalog(): Promise<ValidatedStickerCatalog | null> {
    const bundle = await this.readBundle();
    const userVoice = bundle.documents["01-user-voice"];

    const parsed = stickerCatalogSchema.safeParse(
      userVoice.metadata.stickerCatalog,
    );
    if (!parsed.success) return null;

    const frozenEntries = parsed.data.map((entry) =>
      Object.freeze({
        ...entry,
        tags: Object.freeze([...entry.tags]),
        locator: Object.freeze({ ...entry.locator }),
      }),
    );
    return new ValidatedStickerCatalog(
      stickerCatalogProvenance,
      Object.freeze(frozenEntries),
    );
  }

  public async readBundle(): Promise<MemoryBundle> {
    const index = await this.readDocument("00-memory-index");
    if (index === null) {
      throw new Error("MEMORY_INCOMPLETE");
    }

    const pairs = await Promise.all(
      memoryDocumentNames.map(async (name) =>
        [name, name === "00-memory-index" ? index : await this.readDocument(name)] as const,
      ),
    );
    if (pairs.some(([, document]) => document === null)) {
      throw new Error("MEMORY_INCOMPLETE");
    }
    if (pairs.some(([, document]) => document?.bundleId !== index.bundleId)) {
      throw new Error("MEMORY_GENERATION_MISMATCH");
    }

    return memoryBundleSchema.parse({
      version: 2,
      documents: Object.fromEntries(pairs),
    });
  }

  public async health(expectedSourceHash?: string): Promise<{
    healthy: boolean;
    reason: MemoryHealthReason;
  }> {
    try {
      const bundle = await this.readBundle();
      const sourceHash = bundle.documents["00-memory-index"].metadata.sourceHash;
      const actualSourceHash = typeof sourceHash === "string" ? sourceHash : "";
      if (expectedSourceHash !== undefined && actualSourceHash !== expectedSourceHash) {
        return { healthy: false, reason: "SOURCE_HASH_MISMATCH" };
      }
      return { healthy: true, reason: "OK" };
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "MEMORY_INCOMPLETE") {
        return { healthy: false, reason: "MEMORY_INCOMPLETE" };
      }
      if (error instanceof Error && error.message === "MEMORY_GENERATION_MISMATCH") {
        return { healthy: false, reason: "MEMORY_GENERATION_MISMATCH" };
      }
      return { healthy: false, reason: "MEMORY_CORRUPT" };
    }
  }
}

export function hashMessageSource(ids: string[]): string {
  return createHash("sha256").update([...ids].sort().join("\0")).digest("hex");
}
