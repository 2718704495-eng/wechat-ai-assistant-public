import type { DailyCareKind, DailyCareSlot } from "./types.js";

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface ShanghaiParts {
  date: string;
  hour: number;
  minute: number;
  second: number;
}

const GRACE_MILLISECONDS = 30 * 60 * 1000;

function toShanghaiParts(now: Date): ShanghaiParts {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("DAILY_CARE_NOW_INVALID");
  }
  const parts = Object.fromEntries(
    SHANGHAI_FORMATTER.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (year === undefined || month === undefined || day === undefined ||
      !Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) {
    throw new Error("DAILY_CARE_NOW_INVALID");
  }
  return { date: `${year}-${month}-${day}`, hour, minute, second };
}

function isInsideWindow(
  parts: ShanghaiParts,
  hour: number,
  startMinute: number,
  milliseconds: number,
): boolean {
  if (parts.hour !== hour || parts.minute < startMinute) {
    return false;
  }
  const elapsed = (((parts.minute - startMinute) * 60) + parts.second) * 1000 + milliseconds;
  return elapsed < GRACE_MILLISECONDS;
}

export function resolveProductionSlot(now: Date): DailyCareSlot | null {
  const parts = toShanghaiParts(now);
  const milliseconds = now.getUTCMilliseconds();
  const kind = isInsideWindow(parts, 6, 30, milliseconds)
    ? "morning"
    : isInsideWindow(parts, 22, 0, milliseconds)
      ? "night"
      : null;
  if (kind === null) {
    return null;
  }
  return {
    slotKey: `${parts.date}/${kind}`,
    localDate: parts.date,
    kind,
    targetMode: "production",
  };
}

export function resolveExpiredProductionSlot(now: Date): DailyCareSlot | null {
  const parts = toShanghaiParts(now);
  const milliseconds = now.getUTCMilliseconds();
  const nightElapsed = ((((parts.hour - 22) * 60) + parts.minute) * 60 + parts.second) * 1000 + milliseconds;
  if (parts.hour < 6 || (parts.hour === 6 && parts.minute < 30)) {
    return productionSlot(previousDate(parts.date), "night");
  }
  if (parts.hour === 6) return null;
  if (parts.hour < 22) {
    return productionSlot(parts.date, "morning");
  }
  return nightElapsed >= GRACE_MILLISECONDS ? productionSlot(parts.date, "night") : null;
}

function productionSlot(date: string, kind: DailyCareKind): DailyCareSlot {
  return {
    slotKey: `${date}/${kind}`,
    localDate: date,
    kind,
    targetMode: "production",
  };
}

function previousDate(date: string): string {
  const midnight = new Date(`${date}T00:00:00.000Z`);
  midnight.setUTCDate(midnight.getUTCDate() - 1);
  return midnight.toISOString().slice(0, 10);
}

export function createTestSlot(kind: DailyCareKind, now: Date, txid: string): DailyCareSlot {
  if (!/^[a-f0-9]{64}$/u.test(txid)) {
    throw new Error("DAILY_CARE_TEST_TXID_INVALID");
  }
  return {
    slotKey: `test/${txid}`,
    localDate: toShanghaiParts(now).date,
    kind,
    targetMode: "test",
  };
}
