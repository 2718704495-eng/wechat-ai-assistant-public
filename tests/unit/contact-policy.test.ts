import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import {
  decideProactiveContact,
  type ContactHistory,
} from "../../src/policy/contact-policy.js";

function message(
  text: string,
  direction: "incoming" | "outgoing",
  occurredAt: string,
  kind: ChatMessage["kind"] = "text",
): ChatMessage {
  return {
    id: `${direction}-${occurredAt}-${text}`,
    conversationId: "example-contact",
    direction,
    kind,
    text,
    occurredAt,
    source: "wechat",
    confidence: 0.99,
  };
}

function history(overrides: Partial<ContactHistory> = {}): ContactHistory {
  return {
    recentMessages: [],
    proactiveAttemptsWithoutSubstantialResponse: [],
    lightFollowUpUsed: false,
    activeShift: "unknown",
    activeShiftConfidence: "low",
    proactiveCountToday: 0,
    weatherCountToday: 0,
    candidateKind: "text",
    countedForShanghaiDate: "2026-08-19",
    hasExplicitOpenTopic: false,
    ...overrides,
  };
}

describe("decideProactiveContact", () => {
  it("replies to a new substantial message before applying proactive limits", () => {
    const incoming = message(
      "今天夜班忙死了，刚刚才有空",
      "incoming",
      "2026-08-19T12:50:00.000Z",
    );
    expect(
      decideProactiveContact(
        history({
          recentMessages: [incoming],
          proactiveAttemptsWithoutSubstantialResponse: [
            { sentAt: "2026-08-19T12:40:00.000Z" },
          ],
          proactiveCountToday: 5,
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({
      action: "reply",
      reason: "RESPOND_TO_SUBSTANTIAL_MESSAGE",
      triggerMessageId: incoming.id,
    });
  });

  it.each([
    "我累了",
    "下班了",
    "感冒了",
    "肚子疼",
    "在上班",
    "上班了",
    "饿了",
  ])(
    "replies to semantically meaningful short message: %s",
    (text) => {
      const incoming = message(text, "incoming", "2026-08-19T07:50:00.000Z");

      expect(
        decideProactiveContact(
          history({ recentMessages: [incoming] }),
          new Date("2026-08-19T08:00:00.000Z"),
        ),
      ).toEqual({
        action: "reply",
        reason: "RESPOND_TO_SUBSTANTIAL_MESSAGE",
        triggerMessageId: incoming.id,
      });
    },
  );

  it("does not let a trailing cold reply hide an earlier pending substantive message", () => {
    const substantive = message(
      "今天真的很累",
      "incoming",
      "2026-08-19T12:00:00.000Z",
    );
    const cold = message("嗯", "incoming", "2026-08-19T12:01:00.000Z");

    expect(
      decideProactiveContact(
        history({
          recentMessages: [substantive, cold],
          lightFollowUpUsed: true,
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({
      action: "reply",
      reason: "RESPOND_TO_SUBSTANTIAL_MESSAGE",
      triggerMessageId: substantive.id,
    });
  });

  it("does not let a trailing cold reply hide an earlier ordinary short text", () => {
    const ordinary = message("上班了", "incoming", "2026-08-19T12:00:00.000Z");
    const cold = message("嗯", "incoming", "2026-08-19T12:01:00.000Z");

    expect(
      decideProactiveContact(
        history({ recentMessages: [ordinary, cold], lightFollowUpUsed: true }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({
      action: "reply",
      reason: "RESPOND_TO_SUBSTANTIAL_MESSAGE",
      triggerMessageId: ordinary.id,
    });
  });

  it("does not treat an incoming message already followed by an outgoing reply as new", () => {
    expect(
      decideProactiveContact(
        history({
          recentMessages: [
            message("今天夜班有点忙", "incoming", "2026-08-19T12:00:00.000Z"),
            message("你先忙，忙完再说", "outgoing", "2026-08-19T12:05:00.000Z"),
          ],
          activeShift: "day",
          activeShiftConfidence: "high",
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "reply", reason: "DAY_SHIFT_PREFERRED_WINDOW" });
  });

  it("waits after five proactive messages today", () => {
    expect(
      decideProactiveContact(
        history({
          activeShift: "day",
          activeShiftConfidence: "high",
          proactiveCountToday: 5,
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "DAILY_PROACTIVE_LIMIT_REACHED" });
  });

  it.each(["weather", "sticker"] as const)(
    "counts a %s candidate toward the shared daily proactive limit",
    (candidateKind) => {
      expect(
        decideProactiveContact(
          history({
            activeShift: "day",
            activeShiftConfidence: "high",
            candidateKind,
            proactiveCountToday: 5,
          }),
          new Date("2026-08-19T13:00:00.000Z"),
        ),
      ).toEqual({ action: "wait", reason: "DAILY_PROACTIVE_LIMIT_REACHED" });
    },
  );

  it("blocks a second weather proactive on the same Shanghai day", () => {
    expect(
      decideProactiveContact(
        history({
          activeShift: "day",
          activeShiftConfidence: "high",
          candidateKind: "weather",
          proactiveCountToday: 1,
          weatherCountToday: 1,
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "WEATHER_DAILY_LIMIT_REACHED" });
  });

  it("fails closed when daily counters are for a different Shanghai day", () => {
    expect(
      decideProactiveContact(
        history({
          activeShift: "day",
          activeShiftConfidence: "high",
          candidateKind: "weather",
          countedForShanghaiDate: "2026-08-18",
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "DAILY_COUNTS_DATE_MISMATCH" });
  });

  it("waits until an unanswered proactive message is two hours old", () => {
    expect(
      decideProactiveContact(
        history({
          activeShift: "day",
          activeShiftConfidence: "high",
          proactiveAttemptsWithoutSubstantialResponse: [
            { sentAt: "2026-08-19T11:30:00.000Z" },
          ],
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "WAIT_TWO_HOURS_AFTER_UNANSWERED_PROACTIVE" });
  });

  it("fails closed for an invalid unanswered-attempt timestamp", () => {
    expect(
      decideProactiveContact(
        history({
          proactiveAttemptsWithoutSubstantialResponse: [{ sentAt: "later" }],
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "INVALID_HISTORY_TIMESTAMP" });
  });

  it("uses a low-confidence night shift only to avoid the protected rest window", () => {
    expect(
      decideProactiveContact(
        history({ activeShift: "night", activeShiftConfidence: "low" }),
        new Date("2026-08-19T06:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "LOW_CONFIDENCE_SHIFT_AVOIDANCE" });
  });

  it("does not use a low-confidence day shift to claim a preferred window", () => {
    expect(
      decideProactiveContact(
        history({ activeShift: "day", activeShiftConfidence: "low" }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "WAIT_FOR_PREFERRED_WINDOW" });
  });

  it("never initiates during the night-shift 12:30-18:30 rest window", () => {
    expect(
      decideProactiveContact(
        history({ activeShift: "night", activeShiftConfidence: "high" }),
        new Date("2026-08-19T06:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "NIGHT_SHIFT_REST_WINDOW" });
  });

  it("uses the day-shift 20:30-23:30 preferred window", () => {
    expect(
      decideProactiveContact(
        history({ activeShift: "day", activeShiftConfidence: "high" }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "reply", reason: "DAY_SHIFT_PREFERRED_WINDOW" });
  });

  it.each([
    "2026-08-19T10:45:00.000Z",
    "2026-08-19T02:00:00.000Z",
  ])("uses a night-shift preferred window at %s", (now) => {
    expect(
      decideProactiveContact(
        history({ activeShift: "night", activeShiftConfidence: "high" }),
        new Date(now),
      ),
    ).toEqual({ action: "reply", reason: "NIGHT_SHIFT_PREFERRED_WINDOW" });
  });

  it("allows one low-pressure open-topic message outside a preferred window", () => {
    expect(
      decideProactiveContact(
        history({
          activeShift: "day",
          activeShiftConfidence: "high",
          hasExplicitOpenTopic: true,
        }),
        new Date("2026-08-19T11:00:00.000Z"),
      ),
    ).toEqual({ action: "reply", reason: "ONE_LOW_PRESSURE_OPEN_TOPIC_MESSAGE" });
  });

  it("does not leave a second unanswered message during a work period", () => {
    expect(
      decideProactiveContact(
        history({
          activeShift: "day",
          activeShiftConfidence: "high",
          hasExplicitOpenTopic: true,
          proactiveAttemptsWithoutSubstantialResponse: [
            { sentAt: "2026-08-19T07:00:00.000Z" },
          ],
        }),
        new Date("2026-08-19T11:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "WORK_PERIOD_MESSAGE_ALREADY_LEFT" });
  });

  it("waits outside preferred windows when there is no explicit open topic", () => {
    expect(
      decideProactiveContact(
        history({ activeShift: "unknown", activeShiftConfidence: "low" }),
        new Date("2026-08-19T08:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "WAIT_FOR_PREFERRED_WINDOW" });
  });

  it("permits one light follow-up after a cold incoming reply", () => {
    const incoming = message("嗯", "incoming", "2026-08-19T12:00:00.000Z");
    expect(
      decideProactiveContact(
        history({
          recentMessages: [incoming],
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({
      action: "reply",
      reason: "ONE_LIGHT_FOLLOW_UP",
      triggerMessageId: incoming.id,
    });
  });

  it("does not send a second light follow-up after a cold reply", () => {
    expect(
      decideProactiveContact(
        history({
          recentMessages: [message("哦", "incoming", "2026-08-19T12:00:00.000Z")],
          lightFollowUpUsed: true,
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "wait", reason: "COLD_REPLY_FOLLOW_UP_USED" });
  });

  it("replaces the old one-day delay with a two-hour reassessment", () => {
    expect(
      decideProactiveContact(
        history({
          activeShift: "day",
          activeShiftConfidence: "high",
          proactiveAttemptsWithoutSubstantialResponse: [
            { sentAt: "2026-08-19T10:30:00.000Z" },
          ],
        }),
        new Date("2026-08-19T13:00:00.000Z"),
      ),
    ).toEqual({ action: "reply", reason: "DAY_SHIFT_PREFERRED_WINDOW" });
  });
});
