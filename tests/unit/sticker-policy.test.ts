import { describe, expect, it } from "vitest";

import {
  selectSticker,
  ValidatedStickerCatalog,
  type StickerCatalogEntry,
} from "../../src/memory/sticker-policy.js";

function sticker(id: string): StickerCatalogEntry {
  return {
    id,
    family: "cat-ok",
    tags: ["回应", "OK"],
    visualFingerprint: `fingerprint:${id}`,
    favoriteTab: "heart",
    locator: { row: 1, column: 1 },
    liveVerifiable: true,
    verifiedAt: "2026-08-19T00:00:00.000Z",
  };
}

describe("selectSticker provenance", () => {
  it("rejects a forged catalog shape", () => {
    expect(
      selectSticker({
        desiredTags: ["回应"],
        catalog: {
          sourceDocument: "01-user-voice",
          entries: [sticker("external")],
        } as unknown as ValidatedStickerCatalog,
        lastUsedStickerId: null,
        now: new Date("2026-08-19T12:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("does not let an external caller construct a catalog capability", () => {
    expect(() =>
      Reflect.construct(ValidatedStickerCatalog, [
        Symbol("external"),
        [sticker("external")],
      ]),
    ).toThrow("STICKER_CATALOG_PROVENANCE_REQUIRED");
  });
});
