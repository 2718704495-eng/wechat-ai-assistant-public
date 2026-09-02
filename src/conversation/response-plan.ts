import { z } from "zod";

export const responseActKindSchema = z.enum([
  "colloquial-connect",
  "gentle-reflect",
  "open-invite",
  "answer",
  "clarify",
  "offer-artifact",
  "advise",
]);
export type ResponseActKind = z.infer<typeof responseActKindSchema>;

export const artifactIntentSchema = z.object({
  kind: z.enum(["travel-guide", "plan", "comparison", "checklist"]),
  trigger: z.enum(["explicit", "implicit"]),
}).strict();
export type ArtifactIntent = z.infer<typeof artifactIntentSchema>;

export const responsePlanSchema = z.object({
  emotionalState: z.enum(["negative", "positive", "neutral", "uncertain"]),
  intensity: z.enum(["light", "medium", "high"]),
  storyComplete: z.boolean(),
  orderedActs: z.array(z.object({
    kind: responseActKindSchema,
    evidenceMessageIds: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  voiceBlend: z.object({
    userVoicePriority: z.literal("equal"),
    gentlePriority: z.literal("equal"),
  }).strict(),
  artifactIntent: artifactIntentSchema.nullable(),
  missingInformation: z.array(z.string().min(1)),
  evidenceMessageIds: z.array(z.string().min(1)).min(1),
}).strict();

export type ResponsePlan = z.infer<typeof responsePlanSchema>;

export interface ConversationSignals {
  emotionalState: ResponsePlan["emotionalState"];
  intensity: ResponsePlan["intensity"];
  storyComplete: boolean;
  adviceRequested: boolean;
  directQuestion: boolean;
  artifactIntent: ArtifactIntent | null;
  missingInformation: string[];
  evidenceMessageIds: string[];
}

export function assertResponsePlanInvariants(input: unknown): asserts input is ResponsePlan {
  const plan = responsePlanSchema.parse(input);
  if (plan.emotionalState !== "negative") return;
  if (plan.orderedActs[0]?.kind !== "colloquial-connect") {
    throw new Error("NEGATIVE_FIRST_ACT_MUST_CONNECT");
  }
  if (!plan.storyComplete) {
    const invite = plan.orderedActs.findIndex(({ kind }) => kind === "open-invite");
    if (invite < 0) {
      throw new Error("NEGATIVE_INCOMPLETE_STORY_REQUIRES_INVITE");
    }
    const advise = plan.orderedActs.findIndex(({ kind }) => kind === "advise");
    if (advise >= 0 && advise < invite) {
      throw new Error("NEGATIVE_STORY_ADVICE_BEFORE_INVITE");
    }
  }
}
