import { createHash } from "node:crypto";

import type { ChatMessage } from "../domain/types.js";
import { hashMessageSource } from "../storage/memory-repository.js";
import {
  memoryBundleSchema,
  memoryDocumentNames,
  type MemoryBundle,
  type MemoryDocument,
  type MemoryDocumentName,
  type MemoryEntry,
  type MemorySeedEntry,
} from "./schema.js";

const missingSources = [
  "pre-2025-11-02-wechat",
  "douyin",
  "non-text-media",
] as const;
const maximumStyleExamples = 12;
const maximumStyleExampleLength = 80;
const shanghaiUtcOffsetMilliseconds = 8 * 60 * 60 * 1000;
const sensitiveStyleContent =
  /(?:\d+(?:\.\d+)?\s*(?:元|块|万)|[¥￥$]|钱|转账|借款|地址|住址|手机号|电话|密码|口令|身份证|性话题|性生活|做爱|前任|前男友|前女友|前夫|前妻|(?<!\d)1[3-9]\d(?:[ -]?\d){8}(?!\d)|(?<!\d)0\d{2,3}[ -]\d{7,8}(?!\d)|(?<![\dXx])\d{17}[\dXx](?![\dXx])|(?:省|市)[^\n，。]{0,24}(?:区|县)[^\n，。]{0,24}(?:路|街|道|巷)[^\n，。]{0,16}\d+号)/u;

export interface BuildMemoryInput {
  messages: ChatMessage[];
  onboardingEntries: MemorySeedEntry[];
  now: Date;
}

export function buildMemoryBundle(input: BuildMemoryInput): MemoryBundle {
  const sorted = [...input.messages].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );
  const sourceHash = hashMessageSource(sorted.map((message) => message.id));
  const generatedAt = input.now.toISOString();
  const bundleId = createHash("sha256")
    .update(`${sourceHash}\0${generatedAt}`)
    .digest("hex");
  const documents = emptyDocuments(generatedAt, bundleId);

  documents["00-memory-index"].metadata = {
    sourceHash,
    totalMessages: sorted.length,
    startAt: sorted[0]?.occurredAt ?? null,
    endAt: sorted.at(-1)?.occurredAt ?? null,
    sourceCoverageComplete: false,
    missingSources: [...missingSources],
    formatVersion: 1,
  };

  addStyleEvidence(documents["01-user-voice"], sorted);
  addProfileFacts(documents["02-contact-profile"], sorted);
  addTimelineEvents(documents["03-relationship-timeline"], sorted);
  addInteractionPatterns(documents["04-interaction-patterns"], sorted);
  addTimingEvidence(documents["05-contact-timing"], sorted, input.now);
  addTopicEntries(documents["06-topic-playbook"], sorted);
  addResearchRules(documents["07-research-policy"]);
  addInitialLiveContext(documents["08-live-context"], generatedAt);
  addCareEntries(documents["09-care-playbook"], sorted);

  for (const seedEntry of input.onboardingEntries) {
    documents[seedEntry.document].entries.push(seedEntry.entry);
  }
  applySupersession(documents);

  return memoryBundleSchema.parse({ version: 2, documents });
}

export function selectStyleExamples(
  messages: ChatMessage[],
  limit: number,
): ChatMessage[] {
  const boundedLimit = Math.min(
    maximumStyleExamples,
    Math.max(0, Math.floor(limit)),
  );
  return messages
    .filter(
      (message) =>
        message.source === "wechat" &&
        message.direction === "outgoing" &&
        message.kind === "text" &&
        message.text.trim().length > 0 &&
        !sensitiveStyleContent.test(message.text),
    )
    .slice(0, boundedLimit)
    .map((message) => ({
      ...message,
      text: Array.from(message.text).slice(0, maximumStyleExampleLength).join(""),
    }));
}

function emptyDocuments(
  generatedAt: string,
  bundleId: string,
): Record<MemoryDocumentName, MemoryDocument> {
  const documents = {} as Record<MemoryDocumentName, MemoryDocument>;
  for (const name of memoryDocumentNames) {
    documents[name] = {
      name,
      bundleId,
      generatedAt,
      entries: [],
      metadata: {},
    };
  }
  return documents;
}

function addStyleEvidence(document: MemoryDocument, messages: ChatMessage[]): void {
  const outgoing = messages.filter(
    (message) =>
      message.source === "wechat" && message.direction === "outgoing",
  );
  for (const message of selectStyleExamples(messages, maximumStyleExamples)) {
    document.entries.push(
      entry({
        id: `style-example:${message.id}`,
        kind: "style-example",
        subject: "user",
        summary: message.text,
        sourceType: "wechat-message",
        sourceMessageIds: [message.id],
        observedAt: message.occurredAt,
        confidence: "high",
      }),
    );
  }

  if (outgoing.length > 0) {
    const totalLength = outgoing.reduce(
      (total, message) => total + Array.from(message.text).length,
      0,
    );
    document.entries.push(
      entry({
        id: "historical-style:average-length",
        kind: "interaction-pattern",
        subject: "user",
        summary: `历史统计：用户发出消息的平均长度为${formatNumber(totalLength / outgoing.length)}字`,
        sourceType: "derived-statistic",
        sourceMessageIds: outgoing.map((message) => message.id),
        confidence: "medium",
      }),
    );
  }
}

function addProfileFacts(document: MemoryDocument, messages: ChatMessage[]): void {
  for (const message of incomingWechatText(messages)) {
    if (!isExplicitStatement(message.text)) continue;
    const workLocation = message.text.match(
      /^我(?:现在|目前)?在([^，。！？!?]{1,40}?)(?:工作|上班)[。！!]?$/u,
    )?.[1];
    if (workLocation !== undefined) {
      document.entries.push(
        sourcedEntry(
          message,
          `profile-fact:${message.id}`,
          "fact",
          `对方明确表示在${workLocation}工作`,
        ),
      );
      continue;
    }

    const job = message.text.match(
      /^我(?:的工作是|是做)([^，。！？!?]{1,40})[。！!]?$/u,
    )?.[1];
    if (job !== undefined) {
      document.entries.push(
        sourcedEntry(
          message,
          `profile-fact:${message.id}`,
          "fact",
          `对方明确表示工作是${job}`,
        ),
      );
      continue;
    }

    const preference = message.text.match(
      /^我(喜欢|不喜欢|讨厌|爱吃|爱玩)([^，。！？!?]{1,40})[。！!]?$/u,
    );
    if (preference !== null) {
      document.entries.push(
        sourcedEntry(
          message,
          `profile-preference:${message.id}`,
          "preference",
          `对方明确表示${preference[1]}${preference[2]}`,
        ),
      );
      continue;
    }

    const location = message.text.match(
      /^我(住在|老家在|来自)([^，。！？!?]{1,40})[。！!]?$/u,
    );
    if (location !== null) {
      document.entries.push(
        sourcedEntry(
          message,
          `profile-fact:${message.id}`,
          "fact",
          `对方明确表示${location[1]}${location[2]}`,
        ),
      );
    }
  }
}

function addTimelineEvents(document: MemoryDocument, messages: ChatMessage[]): void {
  for (const message of incomingWechatText(messages)) {
    if (!isExplicitStatement(message.text)) continue;
    const isExplicitSharedEvent =
      /^(?:以前|上次|那次|之前).*(?:我们|你和我)|^(?:我们|你和我).*(?:过|以前|上次|那次)/u.test(
        message.text,
      );
    if (!isExplicitSharedEvent) continue;
    document.entries.push(
      sourcedEntry(
        message,
        `timeline-event:${message.id}`,
        "timeline-event",
        shorten(`共同经历证据：${message.text}`, 120),
        "relationship",
      ),
    );
  }
}

function addInteractionPatterns(
  document: MemoryDocument,
  messages: ChatMessage[],
): void {
  const textMessages = messages.filter(
    (message) => message.source === "wechat" && message.kind === "text",
  );
  if (textMessages.length < 4) return;
  const questions = textMessages.filter((message) => /[?？]/u.test(message.text));
  document.entries.push(
    entry({
      id: "historical-interaction:question-rate",
      kind: "interaction-pattern",
      subject: "relationship",
      summary: `历史统计：文字消息中问句占比${formatNumber(questions.length / textMessages.length)}`,
      sourceType: "derived-statistic",
      sourceMessageIds: textMessages.map((message) => message.id),
      confidence: "medium",
    }),
  );
}

function addTimingEvidence(
  document: MemoryDocument,
  messages: ChatMessage[],
  now: Date,
): void {
  for (const message of incomingWechatText(messages)) {
    if (!isExplicitStatement(message.text)) continue;
    const currentShift = message.text.match(
      /^我(今天|今晚|明天)(?:要)?上(白班|夜班)[。！!]?$/u,
    );
    if (currentShift === null) continue;
    document.entries.push({
      ...sourcedEntry(
        message,
        `current-shift:${message.id}`,
        "fact",
        `对方明确表示${currentShift[1]}上${currentShift[2]}`,
      ),
      expiresAt: endOfReferencedShanghaiDay(
        message.occurredAt,
        currentShift[1] === "明天" ? 1 : 0,
      ),
    });
  }

  const monthlyShiftMessages = incomingWechatText(messages).filter(
    (message) =>
      isExplicitStatement(message.text) &&
      /^我(?:这个月|本月)(?:(?:要)?上|是)?(?:白班|夜班)[。！!]?$/u.test(
        message.text,
      ),
  );
  if (monthlyShiftMessages.length < 2) return;
  document.entries.push(
    entry({
      id: "monthly-shift-pattern",
      kind: "inference",
      subject: "contact",
      summary: "历史消息显示班次可能按月变化；当前班次仍需最近明确消息确认",
      sourceType: "derived-statistic",
      sourceMessageIds: monthlyShiftMessages.map((message) => message.id),
      observedAt: now.toISOString(),
      expiresAt: startOfNextShanghaiMonth(now),
      confidence: "low",
    }),
  );
}

function addTopicEntries(document: MemoryDocument, messages: ChatMessage[]): void {
  for (const message of incomingWechatText(messages)) {
    if (!isExplicitStatement(message.text)) continue;
    if (!/^我(?:明天|后天|这周|最近)(?:要|准备|打算|在等)/u.test(message.text)) {
      continue;
    }
    document.entries.push({
      ...sourcedEntry(
        message,
        `open-topic:${message.id}`,
        "open-loop",
        shorten(`对方明确提到待续事项：${message.text}`, 120),
      ),
      expiresAt: addUtcDays(message.occurredAt, 14),
    });
  }
}

function addResearchRules(document: MemoryDocument): void {
  const rules = [
    ["research:weather", "天气和通勤影响必须先查询权威实时来源"],
    ["research:place", "地点营业预约票价等易变信息必须先查询官方来源"],
    ["research:game", "游戏版本活动等当前信息必须先查询一手来源"],
  ] as const;
  for (const [id, summary] of rules) {
    document.entries.push(
      entry({
        id,
        kind: "research-rule",
        subject: "runtime",
        summary,
        sourceType: "user-onboarding",
        confidence: "high",
      }),
    );
  }
}

function addInitialLiveContext(
  document: MemoryDocument,
  generatedAt: string,
): void {
  document.metadata = {
    initializedAt: generatedAt,
    proactiveCount: 0,
    weatherCount: 0,
    emojiCount: 0,
  };
}

function addCareEntries(document: MemoryDocument, messages: ChatMessage[]): void {
  for (const message of incomingWechatText(messages)) {
    if (!isExplicitStatement(message.text)) continue;
    if (!/^我(?:今天|现在|最近)?(?:有点|很|太)?(?:困|累|不舒服|难受)/u.test(message.text)) {
      continue;
    }
    document.entries.push({
      ...sourcedEntry(
        message,
        `care-loop:${message.id}`,
        "open-loop",
        shorten(`对方明确表达当前身体或精力状态：${message.text}`, 120),
      ),
      expiresAt: addUtcDays(message.occurredAt, 2),
    });
  }
}

function applySupersession(
  documents: Record<MemoryDocumentName, MemoryDocument>,
): void {
  const voiceEntries = documents["01-user-voice"].entries;
  const voiceEntriesById = new Map(
    voiceEntries.map((memoryEntry) => [memoryEntry.id, memoryEntry]),
  );
  for (const memoryEntry of voiceEntries) {
    if (memoryEntry.status !== "active") continue;
    for (const supersededId of memoryEntry.supersedes) {
      const superseded = voiceEntriesById.get(supersededId);
      if (superseded !== undefined && superseded.id !== memoryEntry.id) {
        superseded.status = "superseded";
      }
    }
  }

  const bannedSubstrings = voiceEntries
    .filter(
      (memoryEntry) =>
        memoryEntry.sourceType === "user-correction" &&
        memoryEntry.status === "active",
    )
    .flatMap((memoryEntry) => bannedSubstringFrom(memoryEntry.summary));
  for (const memoryEntry of voiceEntries) {
    if (memoryEntry.sourceType === "user-correction") continue;
    if (bannedSubstrings.some((substring) => memoryEntry.summary.includes(substring))) {
      memoryEntry.status = "superseded";
    }
  }
}

function bannedSubstringFrom(summary: string): string[] {
  const match = summary.match(/禁止使用[“"]?([^”"，,。；;\s]+)[”"]?/u)?.[1];
  if (match === undefined) return [];
  const substring = match.replace(/(?:字|词|表达)$/u, "");
  return substring.length === 0 ? [] : [substring];
}

function incomingWechatText(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) =>
      message.source === "wechat" &&
      message.direction === "incoming" &&
      message.kind === "text",
  );
}

function isExplicitStatement(text: string): boolean {
  const normalized = text.trim().replace(/[。.!！…]+$/u, "");
  return !/[?？]|(?:吗|么|嘛)$|(?:是不是|有没有|好像|可能|也许|大概)/u.test(
    normalized,
  );
}

function sourcedEntry(
  message: ChatMessage,
  id: string,
  kind: MemoryEntry["kind"],
  summary: string,
  subject: MemoryEntry["subject"] = "contact",
): MemoryEntry {
  return entry({
    id,
    kind,
    subject,
    summary,
    sourceType: "wechat-message",
    sourceMessageIds: [message.id],
    observedAt: message.occurredAt,
    confidence: "high",
    sensitivity: sensitiveStyleContent.test(message.text) ? "sensitive" : "normal",
  });
}

function entry(
  value: Pick<
    MemoryEntry,
    | "id"
    | "kind"
    | "subject"
    | "summary"
    | "sourceType"
    | "confidence"
  > &
    Partial<MemoryEntry>,
): MemoryEntry {
  return {
    sourceMessageIds: [],
    sensitivity: "normal",
    status: "active",
    supersedes: [],
    ...value,
  };
}

function shorten(value: string, length: number): string {
  return Array.from(value).slice(0, length).join("");
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function endOfReferencedShanghaiDay(value: string, dayOffset: number): string {
  const shanghaiDate = new Date(
    new Date(value).getTime() + shanghaiUtcOffsetMilliseconds,
  );
  return new Date(
    Date.UTC(
      shanghaiDate.getUTCFullYear(),
      shanghaiDate.getUTCMonth(),
      shanghaiDate.getUTCDate() + dayOffset + 1,
    ) - shanghaiUtcOffsetMilliseconds,
  ).toISOString();
}

function startOfNextShanghaiMonth(now: Date): string {
  const shanghaiDate = new Date(
    now.getTime() + shanghaiUtcOffsetMilliseconds,
  );
  return new Date(
    Date.UTC(
      shanghaiDate.getUTCFullYear(),
      shanghaiDate.getUTCMonth() + 1,
      1,
    ) - shanghaiUtcOffsetMilliseconds,
  ).toISOString();
}
