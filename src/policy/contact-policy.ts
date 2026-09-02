import type { ChatMessage, Decision } from "../domain/types.js";

export interface ProactiveAttempt {
  sentAt: string;
}

export interface ContactHistory {
  recentMessages: ChatMessage[];
  proactiveAttemptsWithoutSubstantialResponse: ProactiveAttempt[];
  lightFollowUpUsed: boolean;
  activeShift: "day" | "night" | "unknown";
  activeShiftConfidence: "high" | "medium" | "low";
  /** Total text, weather, and sticker proactive sends for the Shanghai day. */
  proactiveCountToday: number;
  weatherCountToday: number;
  candidateKind: "text" | "weather" | "sticker";
  countedForShanghaiDate: string;
  hasExplicitOpenTopic?: boolean;
}

const coldReplyPattern = /^(?:嗯+|哦+|噢+|哈哈+|呵呵+|行吧|好吧|好的|ok)$/iu;
const twoHoursMilliseconds = 2 * 60 * 60 * 1000;

export function decideProactiveContact(history: ContactHistory, now: Date): Decision {
  const normalized = normalizeHistory(history, now);
  if (normalized === null) {
    return { action: "wait", reason: "INVALID_HISTORY_TIMESTAMP" };
  }

  const { latestAttempt, incoming, latestOutgoing, nowMilliseconds } = normalized;
  const latestResponseBoundary = Math.max(
    latestAttempt?.at ?? Number.NEGATIVE_INFINITY,
    latestOutgoing?.at ?? Number.NEGATIVE_INFINITY,
  );
  const substantiveIncoming = [...incoming]
    .reverse()
    .find(
      ({ message, at }) =>
        at > latestResponseBoundary && isSubstantial(message),
    );
  if (substantiveIncoming !== undefined) {
    return {
      action: "reply",
      reason: "RESPOND_TO_SUBSTANTIAL_MESSAGE",
      triggerMessageId: substantiveIncoming.message.id,
    };
  }

  if (
    !isNonNegativeInteger(history.proactiveCountToday) ||
    !isNonNegativeInteger(history.weatherCountToday)
  ) {
    return { action: "wait", reason: "INVALID_DAILY_COUNTS" };
  }

  if (history.countedForShanghaiDate !== shanghaiDate(now)) {
    return { action: "wait", reason: "DAILY_COUNTS_DATE_MISMATCH" };
  }

  if (history.proactiveCountToday >= 5) {
    return { action: "wait", reason: "DAILY_PROACTIVE_LIMIT_REACHED" };
  }

  if (history.candidateKind === "weather" && history.weatherCountToday >= 1) {
    return { action: "wait", reason: "WEATHER_DAILY_LIMIT_REACHED" };
  }

  if (
    latestAttempt !== undefined &&
    nowMilliseconds - latestAttempt.at < twoHoursMilliseconds
  ) {
    return {
      action: "wait",
      reason: "WAIT_TWO_HOURS_AFTER_UNANSWERED_PROACTIVE",
    };
  }

  const shanghaiMinute = minuteOfShanghaiDay(now);
  if (
    history.activeShift === "night" &&
    history.activeShiftConfidence === "low" &&
    isInWindow(shanghaiMinute, 12 * 60 + 30, 18 * 60 + 30)
  ) {
    return { action: "wait", reason: "LOW_CONFIDENCE_SHIFT_AVOIDANCE" };
  }

  if (
    history.activeShift === "night" &&
    history.activeShiftConfidence !== "low" &&
    isInWindow(shanghaiMinute, 12 * 60 + 30, 18 * 60 + 30)
  ) {
    return { action: "wait", reason: "NIGHT_SHIFT_REST_WINDOW" };
  }

  const latestPendingIncoming = [...incoming]
    .reverse()
    .find(({ at }) => at > latestResponseBoundary);
  if (
    latestPendingIncoming !== undefined &&
    isColdReply(latestPendingIncoming.message)
  ) {
    return history.lightFollowUpUsed
      ? { action: "wait", reason: "COLD_REPLY_FOLLOW_UP_USED" }
      : {
          action: "reply",
          reason: "ONE_LIGHT_FOLLOW_UP",
          triggerMessageId: latestPendingIncoming.message.id,
        };
  }

  if (history.activeShiftConfidence !== "low") {
    if (
      history.activeShift === "day" &&
      isInWindow(shanghaiMinute, 20 * 60 + 30, 23 * 60 + 30)
    ) {
      return { action: "reply", reason: "DAY_SHIFT_PREFERRED_WINDOW" };
    }

    if (
      history.activeShift === "night" &&
      (isInWindow(shanghaiMinute, 18 * 60 + 30, 19 * 60 + 15) ||
        isInWindow(shanghaiMinute, 8 * 60 + 30, 11 * 60 + 30))
    ) {
      return { action: "reply", reason: "NIGHT_SHIFT_PREFERRED_WINDOW" };
    }
  }

  if (
    latestAttempt !== undefined &&
    isLikelyWorkPeriod(history.activeShift, shanghaiMinute)
  ) {
    return { action: "wait", reason: "WORK_PERIOD_MESSAGE_ALREADY_LEFT" };
  }

  if (history.hasExplicitOpenTopic === true) {
    return { action: "reply", reason: "ONE_LOW_PRESSURE_OPEN_TOPIC_MESSAGE" };
  }

  return { action: "wait", reason: "WAIT_FOR_PREFERRED_WINDOW" };
}

interface TimedIncoming {
  message: ChatMessage;
  at: number;
}

interface TimedAttempt {
  at: number;
}

interface TimedOutgoing {
  at: number;
}

function normalizeHistory(
  history: ContactHistory,
  now: Date,
): {
  nowMilliseconds: number;
  incoming: TimedIncoming[];
  latestAttempt: TimedAttempt | undefined;
  latestOutgoing: TimedOutgoing | undefined;
} | null {
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) return null;

  const attempts: TimedAttempt[] = [];
  for (const attempt of history.proactiveAttemptsWithoutSubstantialResponse) {
    const at = Date.parse(attempt.sentAt);
    if (!Number.isFinite(at) || at > nowMilliseconds) return null;
    attempts.push({ at });
  }

  const incoming: TimedIncoming[] = [];
  const outgoing: TimedOutgoing[] = [];
  for (const message of history.recentMessages) {
    const at = Date.parse(message.occurredAt);
    if (!Number.isFinite(at) || at > nowMilliseconds) return null;
    if (message.direction === "incoming") {
      incoming.push({ message, at });
    } else {
      outgoing.push({ at });
    }
  }

  attempts.sort((left, right) => left.at - right.at);
  incoming.sort((left, right) => left.at - right.at);
  outgoing.sort((left, right) => left.at - right.at);
  return {
    nowMilliseconds,
    latestAttempt: attempts.at(-1),
    incoming,
    latestOutgoing: outgoing.at(-1),
  };
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function minuteOfShanghaiDay(now: Date): number {
  const shanghaiOffsetMilliseconds = 8 * 60 * 60 * 1000;
  const shanghai = new Date(now.getTime() + shanghaiOffsetMilliseconds);
  return shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
}

function shanghaiDate(now: Date): string {
  const shanghaiOffsetMilliseconds = 8 * 60 * 60 * 1000;
  return new Date(now.getTime() + shanghaiOffsetMilliseconds)
    .toISOString()
    .slice(0, 10);
}

function isInWindow(minute: number, start: number, end: number): boolean {
  return minute >= start && minute < end;
}

function isLikelyWorkPeriod(
  shift: ContactHistory["activeShift"],
  minute: number,
): boolean {
  if (shift === "day") {
    return isInWindow(minute, 7 * 60, 20 * 60 + 30);
  }
  if (shift === "night") {
    return minute >= 19 * 60 + 15 || minute < 8 * 60 + 30;
  }
  return false;
}

function isColdReply(message: ChatMessage): boolean {
  return message.kind === "emoji" || coldReplyPattern.test(message.text.trim());
}

function isSubstantial(message: ChatMessage): boolean {
  if (isColdReply(message)) return false;

  const text = message.text.trim();
  return (
    (message.kind === "text" && text.length > 0) ||
    message.kind === "link" ||
    message.kind === "image-ocr" ||
    message.kind === "voice-transcript"
  );
}
