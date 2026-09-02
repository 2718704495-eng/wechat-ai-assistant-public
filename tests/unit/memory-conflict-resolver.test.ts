import { describe, expect, it } from "vitest";

import { resolveActiveEntries } from "../../src/memory/conflict-resolver.js";
import type { MemoryEntry } from "../../src/memory/schema.js";

const now = new Date("2026-08-19T00:00:00.000Z");

function entry(
  id: string,
  kind: MemoryEntry["kind"],
  sourceType: MemoryEntry["sourceType"],
  confidence: MemoryEntry["confidence"],
  status: MemoryEntry["status"],
  overrides: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    id,
    kind,
    subject: "user",
    summary: `${id} summary`,
    sourceType,
    sourceMessageIds: sourceType === "wechat-message" ? [`message:${id}`] : [],
    observedAt: "2026-08-18T00:00:00.000Z",
    confidence,
    sensitivity: "normal",
    status,
    supersedes: [],
    ...overrides,
  };
}

describe("resolveActiveEntries", () => {
  it("prefers a current user correction and excludes expired or uncertain entries", () => {
    const resolved = resolveActiveEntries(
      [
        entry("history", "interaction-pattern", "wechat-message", "high", "active"),
        {
          ...entry("correction", "style-rule", "user-correction", "high", "active"),
          supersedes: ["history"],
        },
        {
          ...entry("old", "open-loop", "wechat-message", "high", "active"),
          expiresAt: "2026-08-18T00:00:00.000Z",
        },
        entry("uncertain", "fact", "user-onboarding", "medium", "needs-confirmation"),
      ],
      now,
    );

    expect(resolved.map(({ id }) => id)).toEqual(["correction"]);
  });

  it("does not let an expired correction supersede a current entry", () => {
    const resolved = resolveActiveEntries(
      [
        entry("history", "style-rule", "wechat-message", "high", "active"),
        {
          ...entry("expired-correction", "style-rule", "user-correction", "high", "active"),
          expiresAt: "2026-08-18T00:00:00.000Z",
          supersedes: ["history"],
        },
      ],
      now,
    );

    expect(resolved.map(({ id }) => id)).toEqual(["history"]);
  });

  it("keeps one deterministic winner for duplicated entry IDs", () => {
    const historical = entry("same-id", "style-rule", "wechat-message", "high", "active");
    const correction = entry("same-id", "style-rule", "user-correction", "high", "active");

    expect(resolveActiveEntries([historical, correction], now)).toEqual([correction]);
    expect(resolveActiveEntries([correction, historical], now)).toEqual([correction]);
  });

  it("sorts otherwise independent entries by source, recency, then ID", () => {
    const resolved = resolveActiveEntries(
      [
        entry("z", "fact", "user-onboarding", "high", "active"),
        entry("a", "fact", "user-onboarding", "high", "active"),
        entry("newer", "fact", "wechat-message", "high", "active", {
          observedAt: "2026-08-18T02:00:00.000Z",
        }),
        entry("older", "fact", "wechat-message", "high", "active"),
      ],
      now,
    );

    expect(resolved.map(({ id }) => id)).toEqual(["newer", "older", "a", "z"]);
  });
});
