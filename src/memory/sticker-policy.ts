import {
  ValidatedStickerCatalog,
  type StickerCatalogEntry,
} from "../storage/memory-repository.js";

export { ValidatedStickerCatalog };
export type { StickerCatalogEntry };

export type StickerCandidate = StickerCatalogEntry & {
  requiresLiveVisualVerification: true;
};

export interface SelectStickerInput {
  desiredTags: string[];
  catalog: ValidatedStickerCatalog;
  lastUsedStickerId: string | null;
  recentStickerIds?: readonly string[];
  now: Date;
}

const maximumCatalogVerificationAgeMilliseconds = 24 * 60 * 60 * 1000;

export function selectSticker(input: SelectStickerInput): StickerCandidate | null {
  if (!ValidatedStickerCatalog.hasRepositoryProvenance(input.catalog)) {
    return null;
  }

  const now = input.now.getTime();
  if (!Number.isFinite(now)) return null;

  const recentIds = new Set(input.recentStickerIds ?? []);
  if (input.lastUsedStickerId !== null) recentIds.add(input.lastUsedStickerId);

  const selected = input.catalog.entries
    .filter((entry) => entry.liveVerifiable)
    .filter((entry) => isFreshVerification(entry.verifiedAt, now))
    .filter((entry) => !recentIds.has(entry.id))
    .map((entry) => ({
      entry,
      score: entry.tags.filter((tag) => input.desiredTags.includes(tag)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.id.localeCompare(right.entry.id),
    )[0]?.entry;

  return selected === undefined
    ? null
    : { ...selected, requiresLiveVisualVerification: true };
}

function isFreshVerification(verifiedAt: string, now: number): boolean {
  const verified = Date.parse(verifiedAt);
  const age = now - verified;
  return (
    Number.isFinite(verified) &&
    age >= 0 &&
    age <= maximumCatalogVerificationAgeMilliseconds
  );
}
