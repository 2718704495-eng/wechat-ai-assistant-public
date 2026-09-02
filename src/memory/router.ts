import { z } from "zod";

import { resolveActiveEntries } from "./conflict-resolver.js";
import { defaultStyleRules } from "./default-rules.js";
import type {
  LiveMemoryResult,
  MemoryBundle,
  MemoryDocumentName,
  MemoryScenario,
} from "./schema.js";

const defaultMaximumEntries = 24;
const isoDateTimeSchema = z.iso.datetime({ offset: true });

const routeMap: Record<MemoryScenario, readonly MemoryDocumentName[]> = {
  "ordinary-reply": ["01-user-voice", "04-interaction-patterns", "08-live-context"],
  care: [
    "01-user-voice",
    "02-contact-profile",
    "05-contact-timing",
    "08-live-context",
    "09-care-playbook",
  ],
  "proactive-share": [
    "01-user-voice",
    "04-interaction-patterns",
    "05-contact-timing",
    "06-topic-playbook",
    "08-live-context",
    "09-care-playbook",
  ],
  weather: [
    "01-user-voice",
    "02-contact-profile",
    "05-contact-timing",
    "07-research-policy",
    "08-live-context",
    "09-care-playbook",
  ],
  place: [
    "01-user-voice",
    "02-contact-profile",
    "06-topic-playbook",
    "07-research-policy",
    "08-live-context",
  ],
  game: [
    "01-user-voice",
    "02-contact-profile",
    "06-topic-playbook",
    "07-research-policy",
    "08-live-context",
  ],
  "shared-memory": [
    "01-user-voice",
    "03-relationship-timeline",
    "04-interaction-patterns",
    "08-live-context",
  ],
  "high-risk": ["03-relationship-timeline", "08-live-context"],
};

const researchScenarios = new Set<MemoryScenario>(["weather", "place", "game"]);

export interface RouteMemoryInput {
  bundle: MemoryBundle;
  scenario: MemoryScenario;
  now: Date;
  maxEntries?: number;
}

export function routeDocumentNames(scenario: MemoryScenario): MemoryDocumentName[] {
  return [...routeMap[scenario]];
}

export function routeMemory({
  bundle,
  scenario,
  now,
  maxEntries,
}: RouteMemoryInput): LiveMemoryResult {
  const coverage = coverageFromIndex(bundle);
  if (coverage === null) {
    return {
      healthy: false,
      scenario,
      coverage: { totalMessages: 0, startAt: null, endAt: null },
      entries: [],
      hardRules: [...defaultStyleRules],
      requiresExternalResearch: researchScenarios.has(scenario),
      allowGeneration: false,
      reason: "MEMORY_INDEX_METADATA_INVALID",
    };
  }

  const resolvedEntries = resolveActiveEntries(
    routeDocumentNames(scenario).flatMap(
      (documentName) => bundle.documents[documentName].entries,
    ),
    now,
  );
  const entries = resolvedEntries.slice(0, boundedMaximumEntries(maxEntries));

  return {
    healthy: true,
    scenario,
    coverage,
    entries,
    hardRules: hardRules(resolvedEntries),
    requiresExternalResearch: researchScenarios.has(scenario),
    allowGeneration: scenario !== "high-risk",
    reason:
      scenario === "high-risk"
        ? "HIGH_RISK_GENERATION_BLOCKED"
        : `MEMORY_ROUTED:${scenario}`,
  };
}

function coverageFromIndex(bundle: MemoryBundle): LiveMemoryResult["coverage"] | null {
  const metadata = bundle.documents["00-memory-index"].metadata;
  const totalMessages = metadata.totalMessages;
  const startAt = metadata.startAt;
  const endAt = metadata.endAt;
  if (
    typeof totalMessages !== "number" ||
    !Number.isInteger(totalMessages) ||
    totalMessages < 0 ||
    !isNullableString(startAt) ||
    !isNullableString(endAt)
  ) {
    return null;
  }

  if (totalMessages === 0) {
    return startAt === null && endAt === null
      ? { totalMessages, startAt, endAt }
      : null;
  }

  if (typeof startAt !== "string" || typeof endAt !== "string") {
    return null;
  }

  const startTimestamp = isoTimestamp(startAt);
  const endTimestamp = isoTimestamp(endAt);
  if (
    startTimestamp === null ||
    endTimestamp === null ||
    startTimestamp > endTimestamp
  ) {
    return null;
  }

  return { totalMessages, startAt, endAt };
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isoTimestamp(value: string): number | null {
  if (!isoDateTimeSchema.safeParse(value).success) return null;

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function boundedMaximumEntries(maxEntries: number | undefined): number {
  if (maxEntries === undefined || !Number.isFinite(maxEntries)) {
    return defaultMaximumEntries;
  }
  return Math.min(defaultMaximumEntries, Math.max(0, Math.floor(maxEntries)));
}

function hardRules(entries: LiveMemoryResult["entries"]): string[] {
  const corrections = entries
    .filter(
      (entry) => entry.kind === "style-rule" && entry.sourceType === "user-correction",
    )
    .map((entry) => entry.summary);
  return [...new Set([...defaultStyleRules, ...corrections])];
}
