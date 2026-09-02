import { z } from "zod";

export const EXAMPLE_CONTACT_CONTACT_ID = "example-contact" as const;

export const contactIdSchema = z.string().regex(
  /^(?:example-contact|contact-[a-f0-9]{32})$/u,
);

export const contactStyleOverrideSchema = z.object({
  salutation: z.string().trim().min(1).max(32).nullable(),
  tone: z.enum(["natural", "gentle", "professional"]).nullable(),
  preferredLength: z.enum(["short", "medium"]).nullable(),
  emojiPolicy: z.enum(["none", "light"]).nullable(),
  bannedTopics: z.array(z.string().trim().min(1).max(80)).max(32),
}).strict();

export const contactIdentityBindingSchema = z.object({
  fingerprintVersion: z.literal("vision-featureprint-v1"),
  enrollmentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  leftPaneProofHash: z.string().regex(/^[a-f0-9]{64}$/u),
  headerProofHash: z.string().regex(/^[a-f0-9]{64}$/u),
  confidence: z.number().min(0.95).max(1),
  confirmedAt: z.iso.datetime({ offset: true }),
}).strict();

export const contactRecordSchema = z.object({
  version: z.literal(1),
  contactId: contactIdSchema,
  displayName: z.string().trim().min(1).max(64),
  lifecycle: z.enum(["active", "paused", "deleted"]),
  autoReplyEnabled: z.boolean(),
  scheduledCareEnabled: z.boolean(),
  scheduledCareSlots: z.array(z.enum(["06:30", "22:00"])).max(2),
  styleOverride: contactStyleOverrideSchema,
  memoryNamespace: z.string().regex(/^contact-[a-f0-9]{64}$/u),
  identityBinding: contactIdentityBindingSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export type ContactId = z.infer<typeof contactIdSchema>;
export type ContactRecord = z.infer<typeof contactRecordSchema>;
export type ContactSummary = Omit<ContactRecord, "identityBinding"> & {
  identityConfirmed: true;
};

export interface CreateConfirmedContact {
  readonly contactId: ContactId;
  readonly displayName: string;
  readonly identityBinding: z.input<typeof contactIdentityBindingSchema>;
  readonly now: Date;
}

export type ContactPatch = Partial<Pick<ContactRecord,
  "lifecycle" | "autoReplyEnabled" | "scheduledCareEnabled" |
  "scheduledCareSlots" | "styleOverride"
>>;
