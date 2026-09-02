import { describe, expect, it } from "vitest";

import {
  contactIdSchema,
  contactRecordSchema,
  contactStyleOverrideSchema,
} from "../../src/contacts/contact-schema.js";

const binding = {
  fingerprintVersion: "vision-featureprint-v1" as const,
  enrollmentFingerprint: "a".repeat(64),
  leftPaneProofHash: "b".repeat(64),
  headerProofHash: "c".repeat(64),
  confidence: 0.98,
  confirmedAt: "2026-08-31T03:00:00.000+08:00",
};

describe("contact schema", () => {
  it("accepts only the reserved or 32-hex contact identifiers", () => {
    expect(contactIdSchema.parse("example-contact")).toBe("example-contact");
    expect(contactIdSchema.parse(`contact-${"a".repeat(32)}`)).toBe(`contact-${"a".repeat(32)}`);
    expect(() => contactIdSchema.parse("contact-ABC")).toThrow();
  });

  it("rejects unknown fields in style overrides and confirmed contact records", () => {
    expect(() => contactStyleOverrideSchema.parse({
      salutation: null,
      tone: null,
      preferredLength: null,
      emojiPolicy: null,
      bannedTopics: [],
      unsupported: true,
    })).toThrow();

    expect(() => contactRecordSchema.parse({
      version: 1,
      contactId: "example-contact",
      displayName: "示例联系人",
      lifecycle: "active",
      autoReplyEnabled: true,
      scheduledCareEnabled: false,
      scheduledCareSlots: [],
      styleOverride: {
        salutation: null,
        tone: null,
        preferredLength: null,
        emojiPolicy: null,
        bannedTopics: [],
      },
      memoryNamespace: `contact-${"d".repeat(64)}`,
      identityBinding: binding,
      revision: 1,
      createdAt: "2026-08-31T03:00:00.000+08:00",
      updatedAt: "2026-08-31T03:00:00.000+08:00",
      unknown: true,
    })).toThrow();
  });
});
