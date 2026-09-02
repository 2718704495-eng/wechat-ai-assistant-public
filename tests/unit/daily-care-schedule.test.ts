import { describe, expect, it } from "vitest";

import {
  createTestSlot,
  resolveExpiredProductionSlot,
  resolveProductionSlot,
} from "../../src/daily-care/schedule.js";

describe("daily-care schedule", () => {
  it("owns three ten-minute scheduler buckets from 06:30 until 07:00 in Shanghai", () => {
    expect(resolveProductionSlot(new Date("2026-08-22T22:30:00.000Z"))).toEqual({
      slotKey: "2026-08-23/morning",
      localDate: "2026-08-23",
      kind: "morning",
      targetMode: "production",
    });
    expect(resolveProductionSlot(new Date("2026-08-22T22:30:12.000Z"))?.kind).toBe("morning");
    expect(resolveProductionSlot(new Date("2026-08-22T22:40:33.000Z"))?.kind).toBe("morning");
    expect(resolveProductionSlot(new Date("2026-08-22T22:50:33.000Z"))?.kind).toBe("morning");
    expect(resolveProductionSlot(new Date("2026-08-22T23:00:00.000Z"))).toBeNull();
  });

  it("owns three ten-minute scheduler buckets from 22:00 until 22:30 in Shanghai", () => {
    expect(resolveProductionSlot(new Date("2026-08-23T14:00:00.000Z"))).toEqual({
      slotKey: "2026-08-23/night",
      localDate: "2026-08-23",
      kind: "night",
      targetMode: "production",
    });
    expect(resolveProductionSlot(new Date("2026-08-23T14:01:03.000Z"))?.kind).toBe("night");
    expect(resolveProductionSlot(new Date("2026-08-23T14:10:33.000Z"))?.kind).toBe("night");
    expect(resolveProductionSlot(new Date("2026-08-23T14:20:33.000Z"))?.kind).toBe("night");
    expect(resolveProductionSlot(new Date("2026-08-23T14:30:00.000Z"))).toBeNull();
  });

  it("does not backfill outside either twelve-minute window", () => {
    expect(resolveProductionSlot(new Date("2026-08-22T22:29:59.999Z"))).toBeNull();
    expect(resolveProductionSlot(new Date("2026-08-23T13:59:59.999Z"))).toBeNull();
    expect(resolveProductionSlot(new Date("2026-08-23T14:30:00.000Z"))).toBeNull();
  });

  it("marks the 22:00 night slot expired exactly at 22:30 Shanghai", () => {
    expect(resolveExpiredProductionSlot(new Date("2026-08-23T14:29:59.999Z"))).toBeNull();
    expect(resolveExpiredProductionSlot(new Date("2026-08-23T14:30:00.000Z"))).toEqual({
      slotKey: "2026-08-23/night",
      localDate: "2026-08-23",
      kind: "night",
      targetMode: "production",
    });
  });

  it("creates a test-only slot without a production date key", () => {
    const txid = "a".repeat(64);
    expect(createTestSlot("night", new Date("2026-08-23T10:00:00.000Z"), txid)).toEqual({
      slotKey: `test/${txid}`,
      localDate: "2026-08-23",
      kind: "night",
      targetMode: "test",
    });
  });

  it.each(["", "A".repeat(64), "a".repeat(63), "a".repeat(65), "../unsafe"])(
    "rejects an invalid test transaction id: %s",
    (txid) => {
      expect(() => createTestSlot("morning", new Date(), txid)).toThrow(
        "DAILY_CARE_TEST_TXID_INVALID",
      );
    },
  );
});
