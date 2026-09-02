import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  memoryBundleSchema,
  memoryDocumentNames,
  type MemoryBundle,
} from "../../src/memory/schema.js";
import {
  selectSticker,
  type StickerCatalogEntry,
} from "../../src/memory/sticker-policy.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import {
  hashMessageSource,
  MemoryRepository,
} from "../../src/storage/memory-repository.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}

  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

function makeBundle(
  sourceHash = "a".repeat(64),
  bundleId = "c".repeat(64),
  stickerCatalog?: unknown,
): MemoryBundle {
  return memoryBundleSchema.parse({
    version: 2,
    documents: Object.fromEntries(
      memoryDocumentNames.map((name) => [
        name,
        {
          name,
          bundleId,
          generatedAt: "2026-08-19T00:00:00.000Z",
          entries:
            name === "01-user-voice"
              ? [
                  {
                    id: "no-laughter",
                    kind: "style-rule",
                    subject: "user",
                    summary: "禁止使用哈哈",
                    sourceType: "user-onboarding",
                    confidence: "high",
                    sensitivity: "normal",
                    status: "active",
                  },
                ]
              : [],
          metadata:
            name === "00-memory-index"
              ? { sourceHash }
              : name === "01-user-voice" && stickerCatalog !== undefined
                ? { stickerCatalog }
                : {},
        },
      ]),
    ),
  });
}

function sticker(
  id: string,
  overrides: Partial<StickerCatalogEntry> = {},
): StickerCatalogEntry {
  return {
    id,
    family: "cat-ok",
    tags: ["回应", "OK"],
    visualFingerprint: `fingerprint:${id}`,
    favoriteTab: "heart",
    locator: { row: 1, column: 1 },
    liveVerifiable: true,
    verifiedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryRepository", () => {
  let rootDir: string;
  let store: EncryptedStore;
  let repository: MemoryRepository;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "chat-assistant-memory-"));
    store = new EncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32)));
    repository = new MemoryRepository(store);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("persists an encrypted complete bundle and reports a source hash mismatch", async () => {
    const bundle = makeBundle();

    await repository.replaceBundle(bundle);

    const files = await readdir(path.join(rootDir, "profiles", "memory"));
    expect(files.sort()).toEqual(memoryDocumentNames.map((name) => `${name}.enc`).sort());
    await expect(
      readFile(path.join(rootDir, "profiles", "memory", "01-user-voice.enc"), "utf8"),
    ).resolves.not.toContain("禁止使用哈哈");
    await expect(repository.readBundle()).resolves.toEqual(bundle);
    await expect(repository.health("b".repeat(64))).resolves.toEqual({
      healthy: false,
      reason: "SOURCE_HASH_MISMATCH",
    });
  });

  test("rejects a missing published document as an incomplete bundle", async () => {
    await repository.replaceBundle(makeBundle());
    await rm(path.join(rootDir, "profiles", "memory", "04-interaction-patterns.enc"));

    await expect(repository.readBundle()).rejects.toThrow("MEMORY_INCOMPLETE");
    await expect(repository.health()).resolves.toEqual({
      healthy: false,
      reason: "MEMORY_INCOMPLETE",
    });
  });

  test("rejects mixed document generations", async () => {
    await repository.replaceBundle(makeBundle("a".repeat(64), "c".repeat(64)));
    await store.write("profiles/memory/04-interaction-patterns.enc", {
      ...makeBundle("a".repeat(64), "d".repeat(64)).documents["04-interaction-patterns"],
    });

    await expect(repository.readBundle()).rejects.toThrow("MEMORY_GENERATION_MISMATCH");
    await expect(repository.health()).resolves.toEqual({
      healthy: false,
      reason: "MEMORY_GENERATION_MISMATCH",
    });
  });

  test("rejects a bundle whose documents do not share one generation", async () => {
    const bundle = makeBundle();
    bundle.documents["04-interaction-patterns"] = {
      ...bundle.documents["04-interaction-patterns"],
      bundleId: "d".repeat(64),
    };

    await expect(repository.replaceBundle(bundle)).rejects.toThrow("MEMORY_GENERATION_MISMATCH");
  });

  test("reports authentication failures as corrupt memory", async () => {
    await repository.replaceBundle(makeBundle());
    await writeFile(path.join(rootDir, "profiles", "memory", "04-interaction-patterns.enc"), "corrupt");

    await expect(repository.readBundle()).rejects.toThrow();
    await expect(repository.health()).resolves.toEqual({
      healthy: false,
      reason: "MEMORY_CORRUPT",
    });
  });

  test("derives the same source hash regardless of message id order", () => {
    expect(hashMessageSource(["wechat-2", "wechat-1"])).toBe(
      "08e2463eebf69ffdf5795c731135e453fd136c8bbb4f2649c102d25e9c056513",
    );
  });

  test("mints a selectable catalog only after an encrypted 01-user-voice read", async () => {
    const entry = sticker("cat-ok");
    await repository.replaceBundle(
      makeBundle("a".repeat(64), "c".repeat(64), [entry]),
    );

    const catalog = await repository.readStickerCatalog();
    expect(catalog).not.toBeNull();
    if (catalog === null) throw new Error("expected repository sticker catalog");
    expect(
      selectSticker({
        desiredTags: ["回应"],
        catalog,
        lastUsedStickerId: null,
        now: new Date("2026-08-19T12:00:00.000Z"),
      }),
    ).toEqual({ ...entry, requiresLiveVisualVerification: true });
    await expect(
      readFile(path.join(rootDir, "profiles", "memory", "01-user-voice.enc"), "utf8"),
    ).resolves.not.toContain(entry.visualFingerprint);
  });

  test("does not mint a sticker catalog from an incomplete bundle", async () => {
    await repository.replaceBundle(
      makeBundle("a".repeat(64), "c".repeat(64), [sticker("cat-ok")]),
    );
    await rm(path.join(rootDir, "profiles", "memory", "04-interaction-patterns.enc"));

    await expect(repository.readStickerCatalog()).rejects.toThrow(
      "MEMORY_INCOMPLETE",
    );
  });

  test("does not mint a sticker catalog from mixed document generations", async () => {
    await repository.replaceBundle(
      makeBundle("a".repeat(64), "c".repeat(64), [sticker("cat-ok")]),
    );
    await store.write("profiles/memory/04-interaction-patterns.enc", {
      ...makeBundle("a".repeat(64), "d".repeat(64)).documents["04-interaction-patterns"],
    });

    await expect(repository.readStickerCatalog()).rejects.toThrow(
      "MEMORY_GENERATION_MISMATCH",
    );
  });

  test.each([
    ["empty fingerprint", { visualFingerprint: "" }],
    ["negative row", { locator: { row: -1, column: 1 } }],
    ["fractional column", { locator: { row: 1, column: 1.5 } }],
    ["invalid verifiedAt", { verifiedAt: "not-a-date" }],
  ] as const)("does not mint a catalog containing %s", async (_description, overrides) => {
    await repository.replaceBundle(
      makeBundle("a".repeat(64), "c".repeat(64), [sticker("bad", overrides)]),
    );

    await expect(repository.readStickerCatalog()).resolves.toBeNull();
  });

  test.each([
    ["stale", "2026-08-18T00:00:00.000Z"],
    ["future", "2026-08-20T00:00:00.000Z"],
  ])("does not select a catalog entry with %s verification", async (_description, verifiedAt) => {
    await repository.replaceBundle(
      makeBundle("a".repeat(64), "c".repeat(64), [
        sticker("cat-ok", { verifiedAt }),
      ]),
    );
    const catalog = await repository.readStickerCatalog();
    if (catalog === null) throw new Error("expected structurally valid catalog");

    expect(
      selectSticker({
        desiredTags: ["回应"],
        catalog,
        lastUsedStickerId: null,
        now: new Date("2026-08-19T12:00:00.000Z"),
      }),
    ).toBeNull();
  });

  test("keeps live verification, recent-id avoidance, and semantic scoring", async () => {
    await repository.replaceBundle(
      makeBundle("a".repeat(64), "c".repeat(64), [
        sticker("recent", { tags: ["回应", "轻松"] }),
        sticker("weak", { tags: ["回应"] }),
        sticker("fresh", { tags: ["回应", "轻松"] }),
        sticker("not-live", {
          tags: ["回应", "轻松", "OK"],
          liveVerifiable: false,
        }),
      ]),
    );
    const catalog = await repository.readStickerCatalog();
    if (catalog === null) throw new Error("expected repository sticker catalog");

    expect(
      selectSticker({
        desiredTags: ["回应", "轻松", "OK"],
        catalog,
        lastUsedStickerId: "recent",
        now: new Date("2026-08-19T12:00:00.000Z"),
      }),
    ).toMatchObject({
      id: "fresh",
      requiresLiveVisualVerification: true,
    });
  });
});
