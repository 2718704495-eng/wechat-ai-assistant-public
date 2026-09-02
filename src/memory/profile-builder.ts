import type { ChatMessage, MessageKind } from "../domain/types.js";

export interface StyleProfile {
  sampleSize: number;
  averageMessageLength: number;
  questionRatio: number;
  emojiRatio: number;
  topicJumpRate: number;
  commonPhrases: string[];
  hardOverrides: {
    bannedSubstrings: string[];
    allowedParticles: string[];
  };
  sourceMessageIds: string[];
}

export interface InitializationReport {
  coverage: {
    startAt: string | null;
    endAt: string | null;
    totalMessages: number;
    bySource: { wechat: number; douyin: number };
    byKind: Record<MessageKind, number>;
  };
  missingKinds: MessageKind[];
  ocrConfidence: {
    count: number;
    min: number;
    max: number;
    average: number;
  } | null;
  styleProfile: StyleProfile;
  sharedMemories: Array<{ summary: string; sourceMessageIds: string[] }>;
  relationshipHypotheses: Array<{
    statement: string;
    status: "unverified";
    sourceMessageIds: string[];
  }>;
  sourceMessageIds: string[];
}

const messageKinds: MessageKind[] = [
  "text",
  "emoji",
  "link",
  "image-ocr",
  "voice-transcript",
];
const historicalPhraseCandidates = [
  "好兄弟",
  "兄弟",
  "哈哈",
  "咋",
  "呗",
  "怎么说",
  "确实",
  "行",
  "啊",
  "嗯",
];

export function buildStyleProfile(messages: ChatMessage[]): StyleProfile {
  const outgoing = messages.filter((message) => message.direction === "outgoing");
  const totalLength = outgoing.reduce(
    (sum, message) => sum + Array.from(message.text).length,
    0,
  );
  const historicalPhraseCounts = historicalPhraseCandidates
    .map((phrase, order) => ({
      phrase,
      order,
      count: outgoing.filter((message) => message.text.includes(phrase)).length,
    }))
    .filter(({ count }) => count > 0)
    .sort((left, right) => right.count - left.count || left.order - right.order)
    .slice(0, 5)
    .map(({ phrase }) => phrase);

  return {
    sampleSize: outgoing.length,
    averageMessageLength: ratio(totalLength, outgoing.length),
    questionRatio: ratio(
      outgoing.filter((message) => /[?？]/u.test(message.text)).length,
      outgoing.length,
    ),
    emojiRatio: ratio(
      outgoing.filter((message) => message.kind === "emoji").length,
      outgoing.length,
    ),
    topicJumpRate: calculateTopicJumpRate(outgoing),
    commonPhrases: historicalPhraseCounts,
    hardOverrides: {
      bannedSubstrings: ["哈哈", "啊"],
      allowedParticles: ["呀", "啦", "哦"],
    },
    sourceMessageIds: outgoing.map((message) => message.id),
  };
}

export function buildInitializationReport(messages: ChatMessage[]): InitializationReport {
  const sorted = [...messages].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );
  const byKind = Object.fromEntries(
    messageKinds.map((kind) => [kind, messages.filter((message) => message.kind === kind).length]),
  ) as Record<MessageKind, number>;
  const ocrValues = messages
    .filter((message) => message.kind === "image-ocr")
    .map((message) => message.confidence);

  return {
    coverage: {
      startAt: sorted[0]?.occurredAt ?? null,
      endAt: sorted.at(-1)?.occurredAt ?? null,
      totalMessages: messages.length,
      bySource: {
        wechat: messages.filter((message) => message.source === "wechat").length,
        douyin: messages.filter((message) => message.source === "douyin").length,
      },
      byKind,
    },
    missingKinds: messageKinds.filter((kind) => byKind[kind] === 0),
    ocrConfidence: summarizeConfidence(ocrValues),
    styleProfile: buildStyleProfile(messages),
    sharedMemories: buildSharedMemories(messages),
    relationshipHypotheses: [
      { statement: "她可能喜欢我", status: "unverified", sourceMessageIds: [] },
    ],
    sourceMessageIds: messages.map((message) => message.id),
  };
}

function summarizeConfidence(
  values: number[],
): InitializationReport["ocrConfidence"] {
  if (values.length === 0) {
    return null;
  }
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function buildSharedMemories(
  messages: ChatMessage[],
): InitializationReport["sharedMemories"] {
  const definitions: Array<{ summary: string; pattern: RegExp }> = [
    { summary: "生日礼物与千纸鹤", pattern: /生日|礼物|千纸鹤/u },
    { summary: "共同游戏经历", pattern: /示例游戏|游戏/u },
    { summary: "倒班与工作", pattern: /白班|夜班|上班|工作/u },
  ];

  return definitions.flatMap(({ summary, pattern }) => {
    const sourceMessageIds = messages
      .filter((message) => pattern.test(message.text))
      .map((message) => message.id);
    return sourceMessageIds.length === 0 ? [] : [{ summary, sourceMessageIds }];
  });
}

function calculateTopicJumpRate(messages: ChatMessage[]): number {
  if (messages.length < 2) {
    return 0;
  }
  let jumps = 0;
  for (let index = 1; index < messages.length; index += 1) {
    const previous = tokenSet(messages[index - 1]?.text ?? "");
    const current = tokenSet(messages[index]?.text ?? "");
    if (![...previous].some((token) => current.has(token))) {
      jumps += 1;
    }
  }
  return jumps / (messages.length - 1);
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{Script=Han}\p{L}\p{N}]{2,}/gu) ?? []);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
