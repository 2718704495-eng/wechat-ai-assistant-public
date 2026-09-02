import type { ChatMessage, GeneratedReply, RunMode } from "../domain/types.js";
import type { StyleProfile } from "../memory/profile-builder.js";
import { retrieveContext } from "../memory/retriever.js";

export interface ReplyContext {
  currentMessage: ChatMessage;
  retrievedMessages: ChatMessage[];
  style: Pick<StyleProfile, "averageMessageLength" | "questionRatio" | "emojiRatio" | "commonPhrases">;
  boundaries: string[];
  mode: RunMode;
}

export function buildReplyContext(
  currentMessage: ChatMessage,
  history: ChatMessage[],
  style: StyleProfile,
  mode: RunMode,
): ReplyContext {
  return {
    currentMessage,
    retrievedMessages: retrieveContext(currentMessage.text, history, 8).messages,
    style: {
      averageMessageLength: style.averageMessageLength,
      questionRatio: style.questionRatio,
      emojiRatio: style.emojiRatio,
      commonPhrases: style.commonPhrases,
    },
    boundaries: [
      "不得替用户表白、定义关系或承诺",
      "不得编造位置、行程、情绪、能力或未来安排",
      "敏感内容必须暂停并通知用户",
    ],
    mode,
  };
}

export function assertReplyFacts(reply: GeneratedReply, available: ChatMessage[]): void {
  const availableIds = new Set(available.map((message) => message.id));
  for (const id of reply.citedMessageIds) {
    if (!availableIds.has(id)) throw new Error("FACT_SOURCE_MISSING");
  }
  for (const claim of reply.claims) {
    const source = available.find((message) => message.id === claim.sourceMessageId);
    if (source === undefined || !source.text.includes(claim.text)) {
      throw new Error("FACT_SOURCE_MISSING");
    }
  }

  const riskyFact = /我(?:现在|今天|明天|后天|周末)?(?:在|要去|会去|能|可以|答应|保证)|我(?:很|有点)?(?:开心|难过|生气|累)/u;
  if (riskyFact.test(reply.text) && reply.claims.length === 0) {
    throw new Error("FACT_SOURCE_MISSING");
  }
}
