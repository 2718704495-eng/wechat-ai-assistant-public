import { z } from "zod";

export const artifactRequestStatusSchema = z.enum([
  "collecting",
  "ready",
  "researching",
  "rendered",
  "validated",
  "failed",
  "cancelled",
]);

export const artifactRequestSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.enum(["example-contact", "file-transfer"]),
  kind: z.enum(["travel-guide", "plan", "comparison", "checklist"]),
  trigger: z.enum(["explicit", "implicit"]),
  status: artifactRequestStatusSchema,
  fields: z.object({
    destination: z.string().trim().min(1).max(80).optional(),
    days: z.number().int().min(1).max(30).optional(),
    origin: z.string().trim().min(1).max(80).optional(),
    budget: z.string().trim().min(1).max(80).optional(),
    companions: z.string().trim().min(1).max(80).optional(),
    preferences: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  }).strict(),
  assumptions: z.array(z.string().min(1)).max(8),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  failureCode: z.string().min(1).nullable(),
  failureCounts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  attemptsStopped: z.boolean().default(false),
}).strict();

export const artifactSourceSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(160),
  url: z.url().refine(
    (value) => new URL(value).protocol === "https:",
    "HTTPS_SOURCE_REQUIRED",
  ),
  accessedAt: z.iso.datetime({ offset: true }),
}).strict();

export const artifactSectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  heading: z.string().trim().min(1).max(120),
  paragraphs: z.array(z.string().trim().min(1).max(1000)).min(1),
  sourceIds: z.array(z.string().trim().min(1)),
}).strict();

export const htmlArtifactModelSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(1000),
  assumptions: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  sections: z.array(artifactSectionSchema).min(1),
  checklist: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
  sources: z.array(artifactSourceSchema).min(1),
  generatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((model, context) => {
  const sourceIds = new Set<string>();

  for (const source of model.sources) {
    if (sourceIds.has(source.id)) {
      context.addIssue({ code: "custom", message: "DUPLICATE_SOURCE_ID" });
    }
    sourceIds.add(source.id);
  }

  for (const section of model.sections) {
    for (const sourceId of section.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        context.addIssue({ code: "custom", message: "UNKNOWN_SOURCE_ID" });
      }
    }
  }
});

export const artifactManifestSchema = z.object({
  requestId: z.string().uuid(),
  filename: z.string().regex(/^[a-z0-9-]+\.html$/u),
  path: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  generatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const artifactWorkflowResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-applicable") }).strict(),
  z.object({
    kind: z.literal("clarification"),
    requestId: z.string().uuid(),
    status: z.literal("collecting"),
    questions: z.array(z.string().min(1)).min(1).max(2),
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    requestId: z.string().uuid(),
    status: z.literal("validated"),
    manifest: artifactManifestSchema,
  }).strict(),
  z.object({
    kind: z.literal("failure"),
    requestId: z.string().uuid(),
    status: z.literal("failed"),
    code: z.string().min(1),
  }).strict(),
]).superRefine((result, context) => {
  if (
    result.kind === "artifact"
    && result.requestId !== result.manifest.requestId
  ) {
    context.addIssue({
      code: "custom",
      message: "ARTIFACT_REQUEST_ID_MISMATCH",
      path: ["manifest", "requestId"],
    });
  }
});

export type ArtifactRequest = z.infer<typeof artifactRequestSchema>;
export type HtmlArtifactModel = z.infer<typeof htmlArtifactModelSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ArtifactWorkflowResult = z.infer<typeof artifactWorkflowResultSchema>;
