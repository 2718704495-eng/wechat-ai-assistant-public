export interface CareLoopItem {
  status: "open" | "closed";
  expiresAt: string;
  nextFollowUpAt: string;
  followUpCount: number;
}

export interface CareFollowUpInput {
  item: CareLoopItem;
  now: Date;
  hasNewInformationSinceLastFollowUp?: boolean;
}

export type CareFollowUpDecision =
  | { action: "wait"; reason: "CARE_LOOP_CLOSED" | "CARE_FOLLOW_UP_NOT_DUE" }
  | {
      action: "close";
      reason:
        | "CARE_LOOP_EXPIRED"
        | "CARE_FOLLOW_UP_LIMIT_REACHED"
        | "CARE_NO_NEW_INFORMATION"
        | "CARE_TIMESTAMP_INVALID";
    }
  | { action: "follow-up"; reason: "CARE_FOLLOW_UP_READY" };

export function decideCareFollowUp(
  input: CareFollowUpInput,
): CareFollowUpDecision {
  if (input.item.status === "closed") {
    return { action: "wait", reason: "CARE_LOOP_CLOSED" };
  }

  const now = input.now.getTime();
  const expiresAt = Date.parse(input.item.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
    return { action: "close", reason: "CARE_TIMESTAMP_INVALID" };
  }

  if (now >= expiresAt) {
    return { action: "close", reason: "CARE_LOOP_EXPIRED" };
  }

  const nextFollowUpAt = Date.parse(input.item.nextFollowUpAt);
  if (
    !Number.isFinite(nextFollowUpAt) ||
    !Number.isInteger(input.item.followUpCount) ||
    input.item.followUpCount < 0
  ) {
    return { action: "close", reason: "CARE_TIMESTAMP_INVALID" };
  }

  if (now < nextFollowUpAt) {
    return { action: "wait", reason: "CARE_FOLLOW_UP_NOT_DUE" };
  }

  if (input.item.followUpCount >= 2) {
    return { action: "close", reason: "CARE_FOLLOW_UP_LIMIT_REACHED" };
  }

  if (
    input.item.followUpCount > 0 &&
    input.hasNewInformationSinceLastFollowUp !== true
  ) {
    return { action: "close", reason: "CARE_NO_NEW_INFORMATION" };
  }

  return { action: "follow-up", reason: "CARE_FOLLOW_UP_READY" };
}
