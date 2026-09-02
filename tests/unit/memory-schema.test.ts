import { describe, expect, expectTypeOf, it } from "vitest";

import { defaultStyleRules } from "../../src/memory/default-rules.js";
import {
  legacyMemoryDocumentSchema,
  memoryBundleSchema,
  memoryDocumentNames,
  memoryEntrySchema,
} from "../../src/memory/schema.js";
import type { MemoryScenario } from "../../src/domain/types.js";

function currentDocuments(): Record<string, {
  name: string;
  bundleId: string;
  generatedAt: string;
  entries: unknown[];
}> {
  return Object.fromEntries(
    memoryDocumentNames.map((name) => [
      name,
      {
        name,
        bundleId: "a".repeat(64),
        generatedAt: "2026-08-19T00:00:00.000Z",
        entries: [],
      },
    ]),
  );
}

describe("memory schema", () => {
  it("requires provenance and never accepts a derived value as a fact", () => {
    expect(() =>
      memoryEntrySchema.parse({
        id: "shift-1",
        kind: "inference",
        subject: "contact",
        summary: "本月可能是白班",
        sourceType: "derived-statistic",
        sourceMessageIds: ["m-1"],
        observedAt: "2026-08-19T00:00:00.000Z",
        expiresAt: "2026-09-01T00:00:00.000Z",
        confidence: "low",
        sensitivity: "normal",
        status: "active",
      }),
    ).not.toThrow();

    expect(() =>
      memoryEntrySchema.parse({
        id: "bad-derived-fact",
        kind: "fact",
        subject: "contact",
        summary: "本月是白班",
        sourceType: "derived-statistic",
        sourceMessageIds: [],
        confidence: "high",
        sensitivity: "normal",
        status: "active",
      }),
    ).toThrow("DERIVED_VALUE_MUST_BE_INFERENCE");

    expect(() =>
      memoryEntrySchema.parse({
        id: "missing-message-source",
        kind: "fact",
        subject: "contact",
        summary: "她说今天加班",
        sourceType: "wechat-message",
        sourceMessageIds: [],
        confidence: "high",
        sensitivity: "normal",
        status: "active",
      }),
    ).toThrow("MESSAGE_SOURCE_REQUIRED");
  });

  it("defines and requires every encrypted document from 00 through 09", () => {
    expect(memoryDocumentNames).toEqual([
      "00-memory-index",
      "01-user-voice",
      "02-contact-profile",
      "03-relationship-timeline",
      "04-interaction-patterns",
      "05-contact-timing",
      "06-topic-playbook",
      "07-research-policy",
      "08-live-context",
      "09-care-playbook",
    ]);
    expect(memoryBundleSchema.safeParse({ version: 1, documents: {} }).success).toBe(false);
  });

  it("rejects a bundle whose record key does not match its document name", () => {
    const documents = currentDocuments();
    documents["01-user-voice"] = {
      ...documents["01-user-voice"]!,
      name: "02-contact-profile",
    };

    expect(memoryBundleSchema.safeParse({ version: 2, documents }).success).toBe(false);
  });

  it.each(["user", "relationship", "runtime"] as const)(
    "rejects a v2 contact profile whose entry subject is %s",
    (subject) => {
      const documents = currentDocuments();
      documents["02-contact-profile"] = {
        ...documents["02-contact-profile"]!,
        entries: [{
          id: `wrong-profile-subject:${subject}`,
          kind: "fact",
          subject,
          summary: "联系人资料不得归属其他 subject",
          sourceType: "user-onboarding",
          sourceMessageIds: [],
          confidence: "high",
          sensitivity: "normal",
          status: "active",
          supersedes: [],
        }],
      };

      expect(memoryBundleSchema.safeParse({ version: 2, documents }).success).toBe(false);
    },
  );

  it("accepts the legacy profile name and example-contact subject only through the legacy schema", () => {
    const legacyProfile = {
      name: "02-example-contact-profile",
      bundleId: "a".repeat(64),
      generatedAt: "2026-08-19T00:00:00.000Z",
      entries: [{
        id: "legacy-profile",
        kind: "fact",
        subject: "example-contact",
        summary: "旧联系人资料",
        sourceType: "user-onboarding",
        sourceMessageIds: [],
        confidence: "high",
        sensitivity: "normal",
        status: "active",
        supersedes: [],
      }],
    };
    const documents = currentDocuments();
    documents["02-contact-profile"] = {
      ...legacyProfile,
      name: "02-contact-profile",
    };

    expect(legacyMemoryDocumentSchema.safeParse(legacyProfile).success).toBe(true);
    expect(memoryBundleSchema.safeParse({ version: 1, documents }).success).toBe(false);
    expect(memoryBundleSchema.safeParse({ version: 2, documents }).success).toBe(false);
  });

  it("publishes the user corrections as immutable hard style rules", () => {
    expect(defaultStyleRules).toEqual([
      "禁止使用哈哈或哈哈哈等笑声文字",
      "禁止使用啊字",
      "呀啦哦可按语境使用但不要每句都带",
      "不得催促回复不得阴阳怪气不得制造压力",
    ]);
    expect(Object.isFrozen(defaultStyleRules)).toBe(true);
  });

  it("re-exports the supported scenarios through the shared domain types", () => {
    expectTypeOf<MemoryScenario>().toEqualTypeOf<
      | "ordinary-reply"
      | "care"
      | "proactive-share"
      | "weather"
      | "place"
      | "game"
      | "shared-memory"
      | "high-risk"
    >();
  });
});
