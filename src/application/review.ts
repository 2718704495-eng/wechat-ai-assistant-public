import { z } from "zod";

import type { EncryptedStore } from "../storage/encrypted-store.js";

export interface DailyReviewPayload {
  effectiveness: string;
  evidence: string[];
  pauses: string[];
  improvements: string[];
}

export interface DatedDailyReview extends DailyReviewPayload {
  date: string;
}

const reviewStateSchema = z.object({ lastSentDate: z.string().nullable() });

export class DailyReviewService {
  public constructor(
    private readonly store: EncryptedStore,
    private readonly notify: (review: DatedDailyReview) => Promise<void>,
  ) {}

  public async runIfDue(
    now: Date,
    build: () => Promise<DailyReviewPayload>,
  ): Promise<boolean> {
    const local = shanghaiDateParts(now);
    if (local.hour < 18 || (local.hour === 18 && local.minute < 30)) return false;
    const state =
      (await this.store.read("state/daily-review.enc", reviewStateSchema)) ?? {
        lastSentDate: null,
      };
    if (state.lastSentDate === local.date) return false;

    await this.notify({ date: local.date, ...(await build()) });
    await this.store.write("state/daily-review.enc", { lastSentDate: local.date });
    return true;
  }
}

function shanghaiDateParts(now: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}
