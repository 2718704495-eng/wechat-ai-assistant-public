import type { MemoryEntry } from "./schema.js";

const sourceRank: Record<MemoryEntry["sourceType"], number> = {
  "user-correction": 6,
  "wechat-message": 5,
  "user-onboarding": 4,
  "external-source": 3,
  "derived-statistic": 2,
};

export function resolveActiveEntries(
  entries: MemoryEntry[],
  now: Date,
): MemoryEntry[] {
  const currentEntries = entries.filter(
    (entry) => entry.status === "active" && hasNotExpired(entry, now),
  );
  const uniqueEntries = selectDuplicateWinners(currentEntries);
  const supersededIds = new Set(
    uniqueEntries.flatMap((entry) => entry.supersedes),
  );

  return uniqueEntries
    .filter((entry) => !supersededIds.has(entry.id))
    .sort(compareEntries);
}

function hasNotExpired(entry: MemoryEntry, now: Date): boolean {
  if (entry.expiresAt === undefined) return true;

  const expiresAt = Date.parse(entry.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function selectDuplicateWinners(entries: MemoryEntry[]): MemoryEntry[] {
  const winners = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    const currentWinner = winners.get(entry.id);
    if (currentWinner === undefined || compareEntries(entry, currentWinner) < 0) {
      winners.set(entry.id, entry);
    }
  }
  return [...winners.values()];
}

function compareEntries(left: MemoryEntry, right: MemoryEntry): number {
  const rankDifference = sourceRank[right.sourceType] - sourceRank[left.sourceType];
  if (rankDifference !== 0) return rankDifference;

  const observedAtDifference = compareDescending(
    left.observedAt ?? "",
    right.observedAt ?? "",
  );
  if (observedAtDifference !== 0) return observedAtDifference;

  const idDifference = left.id.localeCompare(right.id);
  if (idDifference !== 0) return idDifference;

  return duplicateTieBreaker(left).localeCompare(duplicateTieBreaker(right));
}

function compareDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

function duplicateTieBreaker(entry: MemoryEntry): string {
  return [
    entry.kind,
    entry.subject,
    entry.summary,
    entry.sourceType,
    [...entry.sourceMessageIds].sort().join("\u0000"),
    entry.validFrom ?? "",
    entry.expiresAt ?? "",
    entry.confidence,
    entry.sensitivity,
    [...entry.supersedes].sort().join("\u0000"),
  ].join("\u0001");
}
