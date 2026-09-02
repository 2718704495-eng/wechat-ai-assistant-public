import { describe, expect, it } from "vitest";

import type { OCRLine } from "../../src/adapters/native-bridge.js";
import type { AuthorizedWechatTarget } from "../../src/contacts/contact-directory.js";
import { NativeConversationListDetector } from "../../src/conversation/native-conversation-list-detector.js";

const target: AuthorizedWechatTarget = {
  contactId: "contact-0123456789abcdef0123456789abcdef",
  displayName: "我",
  revision: 3,
  enrollment: {
    version: 2,
    contactId: "contact-0123456789abcdef0123456789abcdef",
    displayName: "我",
    fingerprintVersion: "vision-featureprint-v1",
    referenceSamples: [],
    enrolledAt: "2026-08-31T04:00:00.000Z",
  },
  enrollmentFingerprint: "a".repeat(64),
  bindingHash: "b".repeat(64),
};

function line(text: string, x: number, y: number, confidence = 0.99): OCRLine {
  return { text, confidence, bounds: { x, y, width: 0.08, height: 0.02 } };
}

function page(preview = "旧预览") {
  return [
    line("我", 0.10, 0.78), line("04:01", 0.22, 0.78), line(preview, 0.10, 0.73),
    line("陌生人", 0.10, 0.60), line("04:02", 0.22, 0.60), line("候选预览", 0.13, 0.55),
  ];
}

describe("NativeConversationListDetector", () => {
  it("uses one capture/OCR, baselines first, then signals only changed active targets", async () => {
    let reads = 0;
    const pages = [page(), page("新预览")];
    const observed: unknown[] = [];
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([target]) },
      candidates: { observe: (input) => { observed.push(input); return Promise.resolve({}); } },
      reader: { readConversationListSnapshot: () => {
        const lines = pages[reads];
        reads += 1;
        if (lines === undefined) throw new Error("NO_PAGE");
        return Promise.resolve({ windowRevision: "c".repeat(64), lines });
      } },
      now: () => new Date("2026-08-31T04:00:00.000Z"),
    });
    expect(await detector.scan()).toEqual([]);
    const signals = await detector.scan();
    expect(signals).toEqual([expect.objectContaining({
      contactId: target.contactId,
      contactRevision: 3,
      observedMinute: "04:01",
      windowRevision: "c".repeat(64),
    })]);
    expect(signals[0]?.previewHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(reads).toBe(2);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
  });

  it("rejects reentry and fails closed on target title ambiguity", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([target]) },
      candidates: { observe: () => Promise.resolve({}) },
      reader: { readConversationListSnapshot: async () => {
        await pending;
        return { windowRevision: "c".repeat(64), lines: page() };
      } },
    });
    const first = detector.scan();
    await expect(detector.scan()).rejects.toThrow("CONVERSATION_LIST_SCAN_REENTRANT");
    release?.();
    await first;

    const ambiguous = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([target]) },
      candidates: { observe: () => Promise.resolve({}) },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64), lines: [
          ...page(), line("我", 0.10, 0.45), line("04:03", 0.22, 0.45), line("重复预览", 0.13, 0.40),
        ],
      }) },
    });
    await expect(ambiguous.scan()).rejects.toThrow("CONVERSATION_LIST_TARGET_AMBIGUOUS");
  });

  it("does not signal contacts no longer returned by the active directory", async () => {
    let active = true;
    let preview = "旧预览";
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve(active ? [target] : []) },
      candidates: { observe: () => Promise.resolve({}) },
      reader: { readConversationListSnapshot: () => Promise.resolve({ windowRevision: "c".repeat(64), lines: page(preview) }) },
    });
    await detector.scan();
    active = false;
    preview = "新预览";
    expect(await detector.scan()).toEqual([]);
  });

  it("uses NFC-plus-trim exact titles and rebaselines a new contact revision", async () => {
    let currentTarget: AuthorizedWechatTarget = { ...target, displayName: "我 内" };
    let lines = [line("我内", 0.10, 0.78), line("旧预览", 0.10, 0.73)];
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([currentTarget]) },
      candidates: { observe: () => Promise.resolve({}) },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64), lines,
      }) },
    });
    await detector.scan();
    lines = [line("我内", 0.10, 0.78), line("新预览", 0.10, 0.73)];
    expect(await detector.scan()).toEqual([]);

    currentTarget = target;
    lines = page();
    expect(await detector.scan()).toEqual([]);
    currentTarget = { ...target, revision: 4 };
    lines = page("修订后预览");
    expect(await detector.scan()).toEqual([]);
  });

  it("groups compact rows so a preview can never become a candidate title", async () => {
    const observed: Array<{ displayName: string }> = [];
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([]) },
      candidates: { observe: (input) => {
        observed.push(input);
        return Promise.resolve({});
      } },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64),
        lines: [
          line("陌生甲", 0.10, 0.78),
          line("04:01", 0.22, 0.78),
          line("甲的预览", 0.13, 0.73),
          line("陌生乙", 0.10, 0.69),
          line("04:02", 0.22, 0.69),
          line("乙的预览", 0.13, 0.64),
        ],
      }) },
      now: () => new Date("2026-08-31T04:00:00.000Z"),
    });

    await detector.scan();

    expect(observed.map(({ displayName }) => displayName)).toEqual(["陌生甲", "陌生乙"]);
  });

  it("skips a row with a missing or low-confidence preview without consuming the next anchored title", async () => {
    const observed: Array<{ displayName: string }> = [];
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([]) },
      candidates: { observe: (input) => {
        observed.push(input);
        return Promise.resolve({});
      } },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64),
        lines: [
          line("缺失预览", 0.10, 0.78), line("04:01", 0.22, 0.78),
          line("低置信度文字", 0.10, 0.73, 0.3),
          line("下一联系人", 0.10, 0.69), line("04:02", 0.22, 0.69),
          line("它的真实预览", 0.10, 0.64),
        ],
      }) },
    });

    await detector.scan();

    expect(observed.map(({ displayName }) => displayName)).toEqual(["下一联系人"]);
  });

  it("skips an ambiguous date-anchored multiline cluster without swallowing the next valid row", async () => {
    const observed: Array<{ displayName: string }> = [];
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([]) },
      candidates: { observe: (input) => {
        observed.push(input);
        return Promise.resolve({});
      } },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64),
        lines: [
          line("歧义联系人", 0.10, 0.78), line("昨天", 0.22, 0.78),
          line("第一行预览", 0.10, 0.73), line("第二行预览", 0.10, 0.70),
          line("合法联系人", 0.10, 0.64), line("04:02", 0.22, 0.64),
          line("它的真实预览", 0.10, 0.59),
        ],
      }) },
    });

    await detector.scan();

    expect(observed.map(({ displayName }) => displayName)).toEqual(["合法联系人"]);
  });

  it("skips an unanchored odd cluster instead of treating a later title as the missing preview", async () => {
    const observed: Array<{ displayName: string }> = [];
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([]) },
      candidates: { observe: (input) => {
        observed.push(input);
        return Promise.resolve({});
      } },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64),
        lines: [
          line("缺少预览的标题", 0.10, 0.78),
          line("可能是下一标题", 0.10, 0.69),
          line("它的预览", 0.10, 0.64),
        ],
      }) },
    });

    await detector.scan();

    expect(observed).toEqual([]);
  });

  it("rejects an even unanchored segment whose title-preview phase is not uniquely evidenced", async () => {
    const observed: Array<{ displayName: string }> = [];
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([]) },
      candidates: { observe: (input) => { observed.push(input); return Promise.resolve({}); } },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64),
        lines: [
          line("A title", 0.10, 0.78),
          line("B title", 0.10, 0.73),
          line("B preview", 0.10, 0.68),
          line("extra", 0.10, 0.63),
        ],
      }) },
    });

    await detector.scan();

    expect(observed).toEqual([]);
  });

  it("rejects alternating columns when their apparent roles come only from assumed pair phase", async () => {
    const observed: Array<{ displayName: string }> = [];
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([]) },
      candidates: { observe: (input) => { observed.push(input); return Promise.resolve({}); } },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64),
        lines: [
          line("A title", 0.10, 0.78),
          line("B title", 0.13, 0.73),
          line("B preview", 0.10, 0.68),
          line("extra", 0.13, 0.63),
        ],
      }) },
    });

    await detector.scan();

    expect(observed).toEqual([]);
  });

  it("ignores a low-confidence time anchor and does not emit an observed minute", async () => {
    let preview = "旧预览";
    const detector = new NativeConversationListDetector({
      directory: { listActiveAutoReplyTargets: () => Promise.resolve([target]) },
      candidates: { observe: () => Promise.resolve({}) },
      reader: { readConversationListSnapshot: () => Promise.resolve({
        windowRevision: "c".repeat(64),
        lines: [
          line("我", 0.10, 0.78), line("04:01", 0.22, 0.78, 0.49),
          line(preview, 0.10, 0.73),
        ],
      }) },
    });

    await detector.scan();
    preview = "新预览";
    const signals = await detector.scan();

    expect(signals).toEqual([]);
  });
});
