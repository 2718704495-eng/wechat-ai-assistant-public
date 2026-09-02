import { describe, expect, it } from "vitest";

import { defaultStyleRules } from "../../src/memory/default-rules.js";
import { routeDocumentNames, routeMemory } from "../../src/memory/router.js";
import {
  memoryBundleSchema,
  memoryDocumentNames,
  type MemoryBundle,
  type MemoryEntry,
  type MemoryScenario,
} from "../../src/memory/schema.js";

const now = new Date("2026-08-19T00:00:00.000Z");

function entry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    kind: "fact",
    subject: "user",
    summary: `${id} summary`,
    sourceType: "user-onboarding",
    sourceMessageIds: [],
    observedAt: "2026-08-18T00:00:00.000Z",
    confidence: "high",
    sensitivity: "normal",
    status: "active",
    supersedes: [],
    ...overrides,
  };
}

function bundle(
  entriesByDocument: Partial<Record<string, MemoryEntry[]>> = {},
  indexMetadata: Record<string, unknown> = {},
): MemoryBundle {
  return memoryBundleSchema.parse({
    version: 2,
    documents: Object.fromEntries(
      memoryDocumentNames.map((name) => [
        name,
        {
          name,
          bundleId: "a".repeat(64),
          generatedAt: "2026-08-19T00:00:00.000Z",
          entries: entriesByDocument[name] ?? [],
          metadata:
            name === "00-memory-index"
              ? {
                  totalMessages: 1223,
                  startAt: "2025-11-02T00:00:00.000Z",
                  endAt: "2026-08-18T00:00:00.000Z",
                  ...indexMetadata,
                }
              : {},
        },
      ]),
    ),
  });
}

describe("routeDocumentNames", () => {
  it.each([
    ["ordinary-reply", ["01-user-voice", "04-interaction-patterns", "08-live-context"]],
    ["care", ["01-user-voice", "02-contact-profile", "05-contact-timing", "08-live-context", "09-care-playbook"]],
    ["proactive-share", ["01-user-voice", "04-interaction-patterns", "05-contact-timing", "06-topic-playbook", "08-live-context", "09-care-playbook"]],
    ["weather", ["01-user-voice", "02-contact-profile", "05-contact-timing", "07-research-policy", "08-live-context", "09-care-playbook"]],
    ["place", ["01-user-voice", "02-contact-profile", "06-topic-playbook", "07-research-policy", "08-live-context"]],
    ["game", ["01-user-voice", "02-contact-profile", "06-topic-playbook", "07-research-policy", "08-live-context"]],
    ["shared-memory", ["01-user-voice", "03-relationship-timeline", "04-interaction-patterns", "08-live-context"]],
    ["high-risk", ["03-relationship-timeline", "08-live-context"]],
  ] as const)("routes %s to the minimum document set", (scenario, expected) => {
    expect(routeDocumentNames(scenario)).toEqual(expected);
  });

  it("returns a fresh route list that callers cannot mutate", () => {
    const route = routeDocumentNames("ordinary-reply");
    route.pop();

    expect(routeDocumentNames("ordinary-reply")).toEqual([
      "01-user-voice",
      "04-interaction-patterns",
      "08-live-context",
    ]);
  });
});

describe("routeMemory", () => {
  it.each([
    [
      "non-ISO timestamps",
      {
        totalMessages: 1,
        startAt: "yesterday",
        endAt: "tomorrow",
      },
    ],
    [
      "an impossible calendar timestamp",
      {
        totalMessages: 1,
        startAt: "2026-02-30T00:00:00.000Z",
        endAt: "2026-03-01T00:00:00.000Z",
      },
    ],
    [
      "a negative message count",
      {
        totalMessages: -1,
        startAt: null,
        endAt: null,
      },
    ],
    [
      "a fractional message count",
      {
        totalMessages: 1.5,
        startAt: "2026-08-18T00:00:00.000Z",
        endAt: "2026-08-18T00:00:00.000Z",
      },
    ],
    [
      "timestamps for an empty coverage",
      {
        totalMessages: 0,
        startAt: "2026-08-18T00:00:00.000Z",
        endAt: "2026-08-18T00:00:00.000Z",
      },
    ],
    [
      "a missing range for non-empty coverage",
      {
        totalMessages: 1,
        startAt: null,
        endAt: null,
      },
    ],
    [
      "a mixed null and timestamp range",
      {
        totalMessages: 1,
        startAt: null,
        endAt: "2026-08-18T00:00:00.000Z",
      },
    ],
    [
      "an inverted time range",
      {
        totalMessages: 1,
        startAt: "2026-08-19T00:00:00.000Z",
        endAt: "2026-08-18T00:00:00.000Z",
      },
    ],
  ])("fails closed for coverage with %s", (_description, indexMetadata) => {
    const result = routeMemory({
      bundle: bundle({}, indexMetadata),
      scenario: "ordinary-reply",
      now,
    });

    expect(result).toMatchObject({
      healthy: false,
      allowGeneration: false,
      entries: [],
      reason: "MEMORY_INDEX_METADATA_INVALID",
    });
  });

  it("accepts empty coverage only when both endpoints are null", () => {
    const result = routeMemory({
      bundle: bundle({}, { totalMessages: 0, startAt: null, endAt: null }),
      scenario: "ordinary-reply",
      now,
    });

    expect(result).toMatchObject({
      healthy: true,
      allowGeneration: true,
      coverage: { totalMessages: 0, startAt: null, endAt: null },
    });
  });

  it("accepts ordered ISO timestamps with UTC offsets", () => {
    const result = routeMemory({
      bundle: bundle({}, {
        totalMessages: 1,
        startAt: "2026-08-19T08:00:00.000+08:00",
        endAt: "2026-08-19T00:30:00.000Z",
      }),
      scenario: "ordinary-reply",
      now,
    });

    expect(result).toMatchObject({
      healthy: true,
      allowGeneration: true,
      coverage: {
        totalMessages: 1,
        startAt: "2026-08-19T08:00:00.000+08:00",
        endAt: "2026-08-19T00:30:00.000Z",
      },
    });
  });

  it("returns resolved routed entries with index coverage and hard rules", () => {
    const result = routeMemory({
      bundle: bundle({
        "01-user-voice": [
          entry("historical-style", { sourceType: "wechat-message", sourceMessageIds: ["message:1"] }),
          entry("current-style", {
            kind: "style-rule",
            summary: "禁止使用某个旧说法",
            sourceType: "user-correction",
            supersedes: ["historical-style"],
          }),
        ],
        "04-interaction-patterns": [
          entry("expired", { expiresAt: "2026-08-18T00:00:00.000Z" }),
        ],
        "08-live-context": [entry("live")],
        "02-contact-profile": [entry("not-routed", { subject: "contact" })],
      }),
      scenario: "ordinary-reply",
      now,
    });

    expect(result).toMatchObject({
      healthy: true,
      scenario: "ordinary-reply",
      coverage: {
        totalMessages: 1223,
        startAt: "2025-11-02T00:00:00.000Z",
        endAt: "2026-08-18T00:00:00.000Z",
      },
      requiresExternalResearch: false,
      allowGeneration: true,
    });
    expect(result.entries.map(({ id }) => id)).toEqual(["current-style", "live"]);
    expect(result.hardRules).toEqual(
      expect.arrayContaining([
        ...defaultStyleRules,
        "禁止使用某个旧说法",
      ]),
    );
    expect(result).not.toHaveProperty("messages");
  });

  it("caps requested entries at 24 even when the caller requests more", () => {
    const result = routeMemory({
      bundle: bundle({
        "01-user-voice": Array.from({ length: 30 }, (_, index) => entry(`voice-${index}`)),
      }),
      scenario: "ordinary-reply",
      now,
      maxEntries: 99,
    });

    expect(result.entries).toHaveLength(24);
  });

  it("keeps current correction hard rules when the entry limit is zero", () => {
    const result = routeMemory({
      bundle: bundle({
        "01-user-voice": [
          entry("current-style", {
            kind: "style-rule",
            summary: "禁止使用某个旧说法",
            sourceType: "user-correction",
          }),
        ],
      }),
      scenario: "ordinary-reply",
      now,
      maxEntries: 0,
    });

    expect(result.entries).toEqual([]);
    expect(result.hardRules).toContain("禁止使用某个旧说法");
  });

  it.each(["weather", "place", "game"] as const)(
    "requires external research for %s",
    (scenario) => {
      expect(routeMemory({ bundle: bundle(), scenario, now }).requiresExternalResearch).toBe(true);
    },
  );

  it("blocks automatic generation for high-risk routes", () => {
    const result = routeMemory({ bundle: bundle(), scenario: "high-risk", now });

    expect(result.allowGeneration).toBe(false);
  });

  it("keeps every supported scenario explicitly routable", () => {
    const scenarios: MemoryScenario[] = [
      "ordinary-reply",
      "care",
      "proactive-share",
      "weather",
      "place",
      "game",
      "shared-memory",
      "high-risk",
    ];

    expect(scenarios.map(routeDocumentNames)).toHaveLength(8);
  });
});
