import { createHash } from "node:crypto";

import type { OCRLine } from "../adapters/native-bridge.js";
import type { ChatMessage } from "../domain/types.js";

export interface WechatHistoryParseResult {
  messages: ChatMessage[];
  gaps: Array<{ id: string; reason: string }>;
}

const senders = new Map<string, ChatMessage["direction"]>([
  ["锦春意年", "outgoing"],
  ["示例联系人", "incoming"],
]);

export function parseWechatHistoryPages(pages: OCRLine[][]): WechatHistoryParseResult {
  const messages: ChatMessage[] = [];
  const gaps: Array<{ id: string; reason: string }> = [];
  let lastOccurredAt: string | null = null;

  for (const page of pages) {
    const lines = [...page].sort((left, right) => right.bounds.y - left.bounds.y || left.bounds.x - right.bounds.x);
    const pageDate = inferPageDate(lines);
    for (let index = 0; index < lines.length; index += 1) {
      const sender = lines[index];
      if (sender === undefined) continue;
      const direction = senders.get(sender.text);
      if (direction === undefined) continue;
      const timestamp = lines.find((line) => Math.abs(line.bounds.y - sender.bounds.y) < 0.02 && line.bounds.x > 0.55);
      if (timestamp === undefined) continue;
      const parsedTimestamp = parseTimestamp(timestamp.text, pageDate);
      if (parsedTimestamp === null) continue;
      let occurredAt = parsedTimestamp.occurredAt;
      if (!parsedTimestamp.explicitYear && lastOccurredAt !== null) {
        const lastTime = Date.parse(lastOccurredAt);
        let candidate = Date.parse(occurredAt);
        const ninetyDays = 90 * 24 * 60 * 60 * 1000;
        while (candidate < lastTime - ninetyDays) {
          const rolled = new Date(candidate);
          rolled.setUTCFullYear(rolled.getUTCFullYear() + 1);
          candidate = rolled.getTime();
        }
        occurredAt = new Date(candidate).toISOString();
      }
      if (lastOccurredAt === null || occurredAt > lastOccurredAt) lastOccurredAt = occurredAt;

      const content: OCRLine[] = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line === undefined) continue;
        if (senders.has(line.text)) break;
        if (line === timestamp || isUiLine(line.text)) continue;
        content.push(line);
      }
      const sanitized = content
        .map((line) => ({ text: sanitizeContentLine(line.text), confidence: line.confidence }))
        .filter((line) => line.text.length > 0);
      const text = sanitizeContentLine(sanitized.map((line) => line.text).join(""));
      const gapId = createHash("sha256").update(`${direction}\0${occurredAt}\0gap`).digest("hex");
      if (text.length === 0 || /^\d{1,2}:\d{2}$/u.test(text)) {
        gaps.push({ id: gapId, reason: "NON_TEXT_CONTENT_NOT_EXTRACTED" });
        continue;
      }
      if (containsPrivateContent(text)) {
        gaps.push({ id: gapId, reason: "SENSITIVE_PRIVATE_CONTENT_REDACTED" });
        continue;
      }
      const id = createHash("sha256").update(`${direction}\0${occurredAt}\0${text}`).digest("hex");
      messages.push({
        id,
        conversationId: "example-contact",
        direction,
        kind: "text",
        text,
        occurredAt,
        source: "wechat",
        confidence: Math.min(...sanitized.map((line) => line.confidence), timestamp.confidence),
      });
    }
  }

  const unique = [...new Map(messages.map((message) => [message.id, message])).values()]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const uniqueGaps = [...new Map(gaps.map((gap) => [`${gap.id}:${gap.reason}`, gap])).values()];
  return { messages: unique, gaps: uniqueGaps };
}

interface PageDate {
  year: number;
  month: number;
  day: number;
}

function parseTimestamp(text: string, pageDate: PageDate | null): { occurredAt: string; explicitYear: boolean } | null {
  const match = text.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})$/u);
  let year: number;
  let month: number;
  let day: number;
  let hour: number;
  let minute: number;
  let explicitYear: boolean;
  if (match !== null) {
    explicitYear = match[1] !== undefined;
    year = match[1] === undefined ? (pageDate?.year ?? Number.NaN) : Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
    hour = Number(match[4]);
    minute = Number(match[5]);
  } else {
    const relative = text.match(/^(?:昨天|星期[一二三四五六日天]|周[一二三四五六日天])\s*(\d{1,2}):(\d{2})$/u);
    if (relative === null || pageDate === null) return null;
    year = pageDate.year;
    month = pageDate.month;
    day = pageDate.day;
    hour = Number(relative[1]);
    minute = Number(relative[2]);
    explicitYear = true;
  }
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const localAsUtc = Date.UTC(year, month - 1, day, hour - 8, minute);
  return { occurredAt: new Date(localAsUtc).toISOString(), explicitYear };
}

function inferPageDate(lines: OCRLine[]): PageDate | null {
  for (const line of lines) {
    const match = line.text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/u);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    }
  }
  return null;
}

function containsPrivateContent(text: string): boolean {
  return /1[3-9]\d{9}/u.test(text) || /(?:单号|订单).{0,12}\d{3,}/u.test(text);
}

function isUiLine(text: string): boolean {
  return text === "定位到聊天位置" || /^(\d{4}年)?\d{1,2}月\d{1,2}日$/u.test(text);
}

function sanitizeContentLine(text: string): string {
  const trailingTimestamp = /(?:(?:\d{4}年)?\d{1,2}月\d{1,2}日|昨天|星期[一二三四五六日天]|周[一二三四五六日天])\s*\d{1,2}:\d{2}$/u;
  return text
    .replace(/定位到聊天位置/gu, "")
    .replace(trailingTimestamp, "")
    .replace(/\s+/gu, "")
    .trim();
}
