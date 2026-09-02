import { describe, expect, it } from "vitest";

import type { OCRLine } from "../../src/adapters/native-bridge.js";
import { NativeOcrReadonlyCanary } from "../../src/conversation/native-ocr-readonly-canary.js";

function line(text: string, x: number, y: number, confidence = 1): OCRLine {
  return { text, confidence, bounds: { x, y, width: 0.08, height: 0.02 } };
}

function frame(input: {
  header?: string;
  minute: string;
  preview: string;
  pane: OCRLine[];
  revision: string;
}) {
  return {
    capturedAt: new Date("2026-08-30T18:12:30.000Z"),
    windowRevision: input.revision,
    lines: [
      line("我", 0.18, 0.62),
      line(input.minute, 0.25, 0.62),
      line(input.preview, 0.18, 0.58),
      line(input.header ?? "我", 0.42, 0.94),
      ...input.pane,
    ],
  };
}

function harness(frames: ReturnType<typeof frame>[]) {
  let index = 0;
  return new NativeOcrReadonlyCanary({
    sourceEpoch: "test-only-epoch",
    readFrame: () => {
      const current = frames[index];
      index += 1;
      if (current === undefined) throw new Error("NO_CANARY_FRAME");
      return Promise.resolve(current);
    },
  });
}

describe("NativeOcrReadonlyCanary", () => {
  it("baselines history without exposing or emitting message text", async () => {
    const canary = harness([frame({
      minute: "02:10",
      preview: "历史回复",
      pane: [line("02:10", 0.55, 0.66), line("历史回复", 0.72, 0.56)],
      revision: "1".repeat(64),
    })]);

    const receipt = await canary.start();

    expect(receipt).toMatchObject({
      version: 1,
      mode: "test-only-readonly",
      state: "waiting",
      emittedCount: 0,
      reason: null,
    });
    expect(JSON.stringify(receipt)).not.toContain("历史回复");
    expect("replaceDraft" in canary).toBe(false);
    expect("submitDraft" in canary).toBe(false);
  });

  it("accepts exactly one fresh incoming after viewport truncation and suppresses replay", async () => {
    const current = frame({
      minute: "02:12",
      preview: "测试消息-A",
      pane: [
        line("裁剪后的旧消息", 0.72, 0.70),
        line("02:12", 0.55, 0.60),
        line("测试消息-A", 0.43, 0.50),
      ],
      revision: "3".repeat(64),
    });
    const canary = harness([
      frame({
        minute: "02:10",
        preview: "旧消息-B",
        pane: [line("旧消息-A", 0.72, 0.70), line("旧消息-B", 0.72, 0.56)],
        revision: "2".repeat(64),
      }),
      current,
      current,
    ]);
    await canary.start();

    const first = await canary.poll();
    const replay = await canary.poll();

    expect(first).toMatchObject({
      state: "waiting",
      emittedCount: 1,
      events: [{ direction: "incoming", kind: "text" }],
    });
    expect(first.events[0]?.messageId).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("测试消息-A");
    expect(replay).toMatchObject({ state: "waiting", emittedCount: 0, events: [] });
  });

  it("fails closed when the selected conversation header is not the test account", async () => {
    const canary = harness([frame({
      header: "其他人",
      minute: "02:12",
      preview: "测试消息",
      pane: [line("02:12", 0.55, 0.60), line("测试消息", 0.43, 0.50)],
      revision: "4".repeat(64),
    })]);

    await expect(canary.start()).rejects.toThrowError("CANARY_TEST_ACCOUNT_IDENTITY_INVALID");
  });

  it("degrades without emission when a discontinuity has no fresh proof", async () => {
    const canary = harness([
      frame({
        minute: "02:10",
        preview: "旧消息",
        pane: [line("旧消息", 0.72, 0.56)],
        revision: "5".repeat(64),
      }),
      frame({
        minute: "01:40",
        preview: "过期测试消息",
        pane: [line("01:40", 0.55, 0.60), line("过期测试消息", 0.43, 0.50)],
        revision: "6".repeat(64),
      }),
    ]);
    await canary.start();

    const receipt = await canary.poll();

    expect(receipt).toMatchObject({
      state: "degraded",
      emittedCount: 0,
      events: [],
      reason: "OCR_BASELINE_DISCONTINUITY",
    });
    expect(JSON.stringify(receipt)).not.toContain("过期测试消息");
  });
});
