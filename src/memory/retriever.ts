import type { ChatMessage } from "../domain/types.js";

export interface RetrievedContext {
  messages: ChatMessage[];
  citedMessageIds: string[];
  bySource: {
    wechat: string[];
    douyin: string[];
  };
  excludedLowConfidenceIds: string[];
}

const maximumContextMessages = 8;
const minimumFactualConfidence = 0.85;
const dayMilliseconds = 24 * 60 * 60 * 1000;

export function retrieveContext(
  query: string,
  messages: ChatMessage[],
  limit = maximumContextMessages,
): RetrievedContext {
  const excludedLowConfidenceIds = messages
    .filter((message) => message.confidence < minimumFactualConfidence)
    .map((message) => message.id);
  const candidates = messages.filter(
    (message) => message.confidence >= minimumFactualConfidence,
  );
  const newestTimestamp = candidates.reduce(
    (newest, message) => Math.max(newest, Date.parse(message.occurredAt)),
    0,
  );
  const queryTokens = bigrams(query);
  const selected = candidates
    .map((message) => ({
      message,
      score: scoreMessage(message, queryTokens, newestTimestamp),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.message.occurredAt.localeCompare(left.message.occurredAt) ||
        left.message.id.localeCompare(right.message.id),
    )
    .slice(0, Math.min(maximumContextMessages, Math.max(0, limit)))
    .map(({ message }) => message);

  return {
    messages: selected,
    citedMessageIds: selected.map((message) => message.id),
    bySource: {
      wechat: selected.filter((message) => message.source === "wechat").map((message) => message.id),
      douyin: selected.filter((message) => message.source === "douyin").map((message) => message.id),
    },
    excludedLowConfidenceIds,
  };
}

function scoreMessage(
  message: ChatMessage,
  queryTokens: Set<string>,
  newestTimestamp: number,
): number {
  const messageTokens = bigrams(message.text);
  const overlap = [...queryTokens].filter((token) => messageTokens.has(token)).length;
  const relevance = queryTokens.size === 0 ? 0 : overlap / queryTokens.size;
  const occurredAt = Date.parse(message.occurredAt);
  const ageDays = Math.max(0, newestTimestamp - occurredAt) / dayMilliseconds;
  const recency = Math.exp(-ageDays / 180);
  return relevance * 0.7 + recency * 0.2 + message.confidence * 0.1;
}

function bigrams(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (normalized.length <= 1) {
    return new Set(normalized.length === 0 ? [] : [normalized]);
  }
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}
