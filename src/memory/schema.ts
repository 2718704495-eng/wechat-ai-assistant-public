import { z } from "zod";

export const memoryDocumentNames = [
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
] as const;

export const legacyMemoryDocumentNames = [
  "00-memory-index",
  "01-user-voice",
  "02-example-contact-profile",
  "03-relationship-timeline",
  "04-interaction-patterns",
  "05-contact-timing",
  "06-topic-playbook",
  "07-research-policy",
  "08-live-context",
  "09-care-playbook",
] as const;

export const memoryScenarioSchema = z.enum([
  "ordinary-reply",
  "care",
  "proactive-share",
  "weather",
  "place",
  "game",
  "shared-memory",
  "high-risk",
]);

export const memoryEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "fact",
      "preference",
      "style-rule",
      "style-example",
      "timeline-event",
      "interaction-pattern",
      "inference",
      "open-loop",
      "research-rule",
    ]),
    subject: z.enum(["user", "contact", "relationship", "runtime"]),
    summary: z.string().min(1).max(500),
    sourceType: z.enum([
      "wechat-message",
      "user-onboarding",
      "user-correction",
      "derived-statistic",
      "external-source",
    ]),
    sourceMessageIds: z.array(z.string().min(1)).default([]),
    observedAt: z.string().datetime().optional(),
    validFrom: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    sensitivity: z.enum(["normal", "sensitive"]),
    status: z.enum(["active", "superseded", "expired", "needs-confirmation"]),
    supersedes: z.array(z.string()).default([]),
  })
  .superRefine((entry, context) => {
    if (entry.kind === "fact" && entry.sourceType === "derived-statistic") {
      context.addIssue({
        code: "custom",
        message: "DERIVED_VALUE_MUST_BE_INFERENCE",
      });
    }

    if (
      entry.sourceType === "wechat-message" &&
      entry.sourceMessageIds.length === 0
    ) {
      context.addIssue({ code: "custom", message: "MESSAGE_SOURCE_REQUIRED" });
    }
  });

export const memoryDocumentSchema = z.object({
  name: z.enum(memoryDocumentNames),
  bundleId: z.string().length(64),
  generatedAt: z.string().datetime(),
  entries: z.array(memoryEntrySchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const legacyMemoryEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["fact", "preference", "style-rule", "style-example", "timeline-event", "interaction-pattern", "inference", "open-loop", "research-rule"]),
  subject: z.enum(["user", "example-contact", "relationship", "runtime"]),
  summary: z.string().min(1).max(500),
  sourceType: z.enum(["wechat-message", "user-onboarding", "user-correction", "derived-statistic", "external-source"]),
  sourceMessageIds: z.array(z.string().min(1)).default([]),
  observedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  sensitivity: z.enum(["normal", "sensitive"]),
  status: z.enum(["active", "superseded", "expired", "needs-confirmation"]),
  supersedes: z.array(z.string()).default([]),
}).superRefine((entry, context) => {
  if (entry.kind === "fact" && entry.sourceType === "derived-statistic") {
    context.addIssue({ code: "custom", message: "DERIVED_VALUE_MUST_BE_INFERENCE" });
  }
  if (entry.sourceType === "wechat-message" && entry.sourceMessageIds.length === 0) {
    context.addIssue({ code: "custom", message: "MESSAGE_SOURCE_REQUIRED" });
  }
});

export const legacyMemoryDocumentSchema = z.object({
  name: z.enum(legacyMemoryDocumentNames),
  bundleId: z.string().length(64),
  generatedAt: z.string().datetime(),
  entries: z.array(legacyMemoryEntrySchema),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const memorySeedEntrySchema = z.object({
  document: z.enum(memoryDocumentNames),
  entry: memoryEntrySchema,
});

export const memoryBundleSchema = z
  .object({
    version: z.literal(2),
    documents: z.record(z.enum(memoryDocumentNames), memoryDocumentSchema),
  })
  .superRefine((bundle, context) => {
    for (const name of memoryDocumentNames) {
      if (bundle.documents[name]?.name !== name) {
        context.addIssue({
          code: "custom",
          message: `MEMORY_DOCUMENT_NAME_MISMATCH:${name}`,
        });
      }
    }
    if (bundle.documents["02-contact-profile"].entries.some(
      (entry) => entry.subject !== "contact",
    )) {
      context.addIssue({ code: "custom", message: "CONTACT_PROFILE_SUBJECT_REQUIRED" });
    }
  });

export type MemoryScenario = z.infer<typeof memoryScenarioSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemorySeedEntry = z.infer<typeof memorySeedEntrySchema>;
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;
export type MemoryBundle = z.infer<typeof memoryBundleSchema>;
export type MemoryDocumentName = (typeof memoryDocumentNames)[number];
export type LegacyMemoryDocumentName = (typeof legacyMemoryDocumentNames)[number];
export type LegacyMemoryDocument = z.infer<typeof legacyMemoryDocumentSchema>;

export interface LiveMemoryResult {
  healthy: boolean;
  scenario: MemoryScenario;
  coverage: {
    totalMessages: number;
    startAt: string | null;
    endAt: string | null;
  };
  entries: MemoryEntry[];
  hardRules: string[];
  requiresExternalResearch: boolean;
  allowGeneration: boolean;
  reason: string;
}
