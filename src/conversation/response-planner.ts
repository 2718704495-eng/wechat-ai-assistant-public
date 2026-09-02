import type { ChatMessage } from "../domain/types.js";
import type { MemoryEntry } from "../memory/schema.js";
import { analyzeConversationSignals } from "./conversation-signals.js";
import {
  assertResponsePlanInvariants,
  type ResponseActKind,
  type ResponsePlan,
} from "./response-plan.js";

export interface ConversationPlanningInput {
  current: ChatMessage;
  recentMessages: ChatMessage[];
  voiceExamples: MemoryEntry[];
  interactionRules: MemoryEntry[];
}

export function planConversationResponse(input: ConversationPlanningInput): ResponsePlan {
  const signals = analyzeConversationSignals(input.current, input.recentMessages);
  const kinds: ResponseActKind[] = [];

  if (signals.emotionalState === "negative") {
    kinds.push("colloquial-connect");
    if (signals.storyComplete) kinds.push("gentle-reflect");
    kinds.push("open-invite");
    if (signals.adviceRequested) kinds.push("advise");
  } else if (signals.artifactIntent !== null) {
    kinds.push("offer-artifact");
  } else {
    kinds.push(signals.directQuestion ? "answer" : "open-invite");
  }

  const plan: ResponsePlan = {
    emotionalState: signals.emotionalState,
    intensity: signals.intensity,
    storyComplete: signals.storyComplete,
    orderedActs: kinds.map((kind) => ({
      kind,
      evidenceMessageIds: signals.evidenceMessageIds,
    })),
    voiceBlend: { userVoicePriority: "equal", gentlePriority: "equal" },
    artifactIntent: signals.artifactIntent,
    missingInformation: signals.missingInformation,
    evidenceMessageIds: signals.evidenceMessageIds,
  };

  assertResponsePlanInvariants(plan);
  return plan;
}
