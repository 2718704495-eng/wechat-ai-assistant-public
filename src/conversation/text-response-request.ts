import type { ChatMessage } from "../domain/types.js";
import {
  assertAuthorizedWechatTarget,
  assertContactDirectory,
  ContactDirectory,
} from "../contacts/contact-directory.js";
import type { ContactId } from "../contacts/contact-schema.js";
import type { MemoryEntry } from "../memory/schema.js";
import { validateReplyStyle } from "../memory/style-guard.js";
import type { EffectiveContactStyle } from "./contact-style.js";
import type { ResponseActKind, ResponsePlan } from "./response-plan.js";

export interface TextResponseRequest {
  readonly contactId: ContactId;
  readonly contactRevision: number;
  readonly effectiveStyle: EffectiveContactStyle;
  readonly current: Readonly<Pick<ChatMessage, "id" | "text">>;
  readonly plan: ResponsePlan;
  readonly constraints: ReadonlyArray<{
    id: "user-voice" | "gentle" | "hard-rules";
    priority: "equal" | "required";
    enforcement: "generation-only";
    instruction: string;
  }>;
  readonly voiceEvidence: ReadonlyArray<{
    memoryEntryId: string;
    sourceMessageIds: string[];
    summary: string;
  }>;
  readonly interactionRules: ReadonlyArray<{ memoryEntryId: string; summary: string }>;
  readonly hardRules: readonly string[];
  readonly hardRuleEnforcement: "generation-only";
}

const allowedVoiceSourceTypes: ReadonlySet<MemoryEntry["sourceType"]> = new Set([
  "wechat-message",
  "user-onboarding",
  "user-correction",
]);

export async function buildTextResponseRequest(input: {
  directory: ContactDirectory;
  contactId: ContactId;
  expectedRevision: number;
  effectiveStyle: EffectiveContactStyle;
  current: ChatMessage;
  plan: ResponsePlan;
  voiceExamples: MemoryEntry[];
  interactionRules: MemoryEntry[];
  hardRules: string[];
}): Promise<TextResponseRequest> {
  if (!(input.directory instanceof ContactDirectory)) {
    throw new Error("TEXT_RESPONSE_DIRECTORY_REQUIRED");
  }
  if (Object.hasOwn(input.directory, "requireActiveAutoReplyTarget")) {
    throw new Error("CONTACT_DIRECTORY_METHOD_OVERRIDDEN");
  }
  assertContactDirectory(input.directory);
  const target = await ContactDirectory.prototype.requireActiveAutoReplyTarget.call(
    input.directory,
    input.contactId,
  );
  assertAuthorizedWechatTarget(target);
  if (target.contactId !== input.contactId) {
    throw new Error("TEXT_RESPONSE_TARGET_INVALID");
  }
  if (target.revision !== input.expectedRevision) {
    throw new Error("CONTACT_REVISION_MISMATCH");
  }
  if (input.current.conversationId !== target.contactId) {
    throw new Error("TEXT_RESPONSE_TARGET_INVALID");
  }
  if (
    input.hardRules.length === 0 ||
    input.hardRules.some((rule) => rule.trim().length === 0)
  ) {
    throw new Error("HARD_RULES_REQUIRED");
  }

  const eligible = (entry: MemoryEntry) =>
    entry.status === "active" &&
    entry.sensitivity === "normal" &&
    entry.confidence !== "low";

  const effectiveStyle = cloneEffectiveStyle(input.effectiveStyle);

  const request: TextResponseRequest = {
    contactId: target.contactId,
    contactRevision: target.revision,
    effectiveStyle,
    current: { id: input.current.id, text: input.current.text },
    plan: input.plan,
    constraints: [
      {
        id: "user-voice",
        priority: "equal",
        enforcement: "generation-only",
        instruction: "优先使用已引用语料的短句、口语节奏和自然起手，不解释回应策略",
      },
      {
        id: "gentle",
        priority: "equal",
        enforcement: "generation-only",
        instruction: "负面语境先接住再推进，不诊断、不说教、不催促，故事未讲清时不先给方案",
      },
      {
        id: "hard-rules",
        priority: "required",
        enforcement: "generation-only",
        instruction: input.hardRules.join("；"),
      },
    ],
    voiceEvidence: input.voiceExamples
      .filter((entry) => (
        eligible(entry)
        && entry.kind === "style-example"
        && entry.subject === "user"
        && allowedVoiceSourceTypes.has(entry.sourceType)
      ))
      .map((entry) => ({
        memoryEntryId: entry.id,
        sourceMessageIds: entry.sourceMessageIds,
        summary: entry.summary,
      })),
    interactionRules: input.interactionRules
      .filter((entry) => eligible(entry) && entry.kind === "interaction-pattern")
      .map((entry) => ({
        memoryEntryId: entry.id,
        summary: entry.summary,
      })),
    hardRules: [...input.hardRules],
    hardRuleEnforcement: "generation-only",
  };
  return deepFreeze(structuredClone(request));
}

export interface TextResponseCandidate {
  text: string;
  segments: Array<{ act: ResponseActKind; text: string }>;
}

export function validateTextResponseCandidate(
  request: TextResponseRequest,
  candidate: TextResponseCandidate,
) {
  const reasons: string[] = [];
  const expected = request.plan.orderedActs.map(({ kind }) => kind);
  const actual = candidate.segments.map(({ act }) => act);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reasons.push("ACT_ORDER_MISMATCH");
  }
  if (candidate.segments.map(({ text }) => text).join("，") !== candidate.text) {
    reasons.push("SEGMENT_TEXT_MISMATCH");
  }
  if (candidate.segments.some(({ text }) => text.trim().length === 0)) {
    reasons.push("SEGMENT_EMPTY");
  }
  const connections = candidate.segments.filter(
    ({ act }) => act === "colloquial-connect",
  );
  if (connections.some(({ text }) => [...text].length > 8)) {
    reasons.push("CONNECT_NOT_SHORT");
  }
  const hard = validateReplyStyle(candidate.text);
  if (automaticReplySignaturePattern.test(candidate.text)) {
    reasons.push("AUTOMATIC_REPLY_SIGNATURE_FORBIDDEN");
  }
  return {
    ok: reasons.length === 0 && hard.ok,
    reasons: [...reasons, ...hard.reasons],
  };
}

const automaticReplySignaturePattern = /(?:\n|\s)*(?:[—–-]{1,3}\s*)?(?:示例用户|AI\s*助手|聊天助手|智能助手)\s*$/iu;

function cloneEffectiveStyle(style: EffectiveContactStyle): EffectiveContactStyle {
  return {
    salutation: style.salutation,
    tone: style.tone,
    preferredLength: style.preferredLength,
    emojiPolicy: style.emojiPolicy,
    bannedTopics: [...style.bannedTopics],
    appendSignature: false,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
