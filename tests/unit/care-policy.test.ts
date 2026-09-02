import { describe, expect, it } from "vitest";

import {
  decideCareFollowUp,
  type CareLoopItem,
} from "../../src/memory/care-policy.js";

function openLoop(overrides: Partial<CareLoopItem> = {}): CareLoopItem {
  return {
    status: "open",
    expiresAt: "2026-08-20T12:00:00.000Z",
    nextFollowUpAt: "2026-08-19T10:00:00.000Z",
    followUpCount: 0,
    ...overrides,
  };
}

describe("decideCareFollowUp", () => {
  const now = new Date("2026-08-19T10:00:00.000Z");

  it("stops immediately when the care loop is already closed", () => {
    expect(
      decideCareFollowUp({
        item: openLoop({
          status: "closed",
          expiresAt: "2026-08-18T00:00:00.000Z",
        }),
        now,
      }),
    ).toEqual({ action: "wait", reason: "CARE_LOOP_CLOSED" });
  });

  it("closes an expired care loop", () => {
    expect(
      decideCareFollowUp({
        item: openLoop({ expiresAt: "2026-08-19T10:00:00.000Z" }),
        now,
      }),
    ).toEqual({ action: "close", reason: "CARE_LOOP_EXPIRED" });
  });

  it("reports expiry before malformed later-stage fields", () => {
    expect(
      decideCareFollowUp({
        item: openLoop({
          expiresAt: "2026-08-19T09:00:00.000Z",
          nextFollowUpAt: "later",
          followUpCount: -1,
        }),
        now,
      }),
    ).toEqual({ action: "close", reason: "CARE_LOOP_EXPIRED" });
  });

  it("does not repeat a care loop before its next follow-up time", () => {
    expect(
      decideCareFollowUp({
        item: openLoop({
          nextFollowUpAt: "2026-08-19T12:00:00.000Z",
          followUpCount: 1,
        }),
        now,
      }),
    ).toEqual({ action: "wait", reason: "CARE_FOLLOW_UP_NOT_DUE" });
  });

  it("closes after the maximum two follow-ups", () => {
    expect(
      decideCareFollowUp({
        item: openLoop({ followUpCount: 2 }),
        now,
        hasNewInformationSinceLastFollowUp: true,
      }),
    ).toEqual({ action: "close", reason: "CARE_FOLLOW_UP_LIMIT_REACHED" });
  });

  it("closes instead of repeating when a previous follow-up produced no new information", () => {
    expect(
      decideCareFollowUp({
        item: openLoop({ followUpCount: 1 }),
        now,
        hasNewInformationSinceLastFollowUp: false,
      }),
    ).toEqual({ action: "close", reason: "CARE_NO_NEW_INFORMATION" });
  });

  it("allows an initial follow-up when it is due", () => {
    expect(decideCareFollowUp({ item: openLoop(), now })).toEqual({
      action: "follow-up",
      reason: "CARE_FOLLOW_UP_READY",
    });
  });

  it("allows the second follow-up only when there is new information", () => {
    expect(
      decideCareFollowUp({
        item: openLoop({ followUpCount: 1 }),
        now,
        hasNewInformationSinceLastFollowUp: true,
      }),
    ).toEqual({ action: "follow-up", reason: "CARE_FOLLOW_UP_READY" });
  });

  it("fails closed for malformed care timestamps", () => {
    expect(
      decideCareFollowUp({
        item: openLoop({ nextFollowUpAt: "later" }),
        now,
      }),
    ).toEqual({ action: "close", reason: "CARE_TIMESTAMP_INVALID" });
  });
});
