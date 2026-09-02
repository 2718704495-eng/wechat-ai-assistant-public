import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DailyReviewService } from "../../src/application/review.js";
import { FailureRepository, runOnce, type RunOnceDependencies } from "../../src/application/run-once.js";
import type { ChatMessage } from "../../src/domain/types.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";

const ordinary: ChatMessage = {
  id: "incoming-1",
  conversationId: "example-contact",
  direction: "incoming",
  kind: "text",
  text: "今天上班好累",
  occurredAt: "2026-08-19T09:00:00.000Z",
  source: "wechat",
  confidence: 0.99,
};

describe("runOnce simulated E2E", () => {
  let root: string;
  let store: EncryptedStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "simulated-run-"));
    const key = randomBytes(32);
    store = new EncryptedStore(root, { getOrCreate: () => Promise.resolve(key) });
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("processes an ordinary message in safety order and skips its replay", async () => {
    const trace: string[] = [];
    const known = new Set<string>();
    const dependencies = fixture(trace, ordinary, known);

    const first = await runOnce(dependencies, new Date("2026-08-19T09:01:00+08:00"));
    const second = await runOnce(dependencies, new Date("2026-08-19T09:06:00+08:00"));

    expect(first.status).toBe("success");
    expect(second.summary).toBe("no-new-message");
    expect(trace).toEqual([
      "control", "preflight", "read", "persist", "generate:incoming-1", "send:辛苦了，先歇会儿", "audit:reply-verified", "review",
      "control", "preflight", "read", "persist", "review",
    ]);
  });

  it("pauses on a sensitive message and produces a user-actionable notification", async () => {
    const trace: string[] = [];
    const sensitive = { ...ordinary, text: "你是不是喜欢我" };
    const result = await runOnce(fixture(trace, sensitive, new Set()), new Date("2026-08-19T09:01:00+08:00"));

    expect(result.status).toBe("blocked");
    expect(trace).toContain("notify:SENSITIVE_RELATIONSHIP|你是不是喜欢我|请本人处理后再发送继续生成");
    expect(trace.some((entry) => entry.startsWith("generate:"))).toBe(false);
    expect(trace.some((entry) => entry.startsWith("send:"))).toBe(false);
  });

  it("creates the Shanghai daily review only once after 18:30", async () => {
    const emitted: string[] = [];
    const review = new DailyReviewService(store, (payload) => {
      emitted.push(payload.date);
      return Promise.resolve();
    });

    await expect(review.runIfDue(new Date("2026-08-19T18:29:00+08:00"), () => Promise.resolve(reviewPayload()))).resolves.toBe(false);
    await expect(review.runIfDue(new Date("2026-08-19T18:30:00+08:00"), () => Promise.resolve(reviewPayload()))).resolves.toBe(true);
    await expect(review.runIfDue(new Date("2026-08-19T22:00:00+08:00"), () => Promise.resolve(reviewPayload()))).resolves.toBe(false);
    expect(emitted).toEqual(["2026-08-19"]);
  });

  it("changes diagnostics on the second equal failure and stops on the third", async () => {
    const failures = new FailureRepository(store);
    await expect(failures.record("WECHAT_NOT_LOGGED_IN")).resolves.toMatchObject({ count: 1, stopped: false, strategy: "retry-after-preflight" });
    await expect(failures.record("WECHAT_NOT_LOGGED_IN")).resolves.toMatchObject({ count: 2, stopped: false, strategy: "capture-window-and-permission-state" });
    await expect(failures.record("WECHAT_NOT_LOGGED_IN")).resolves.toMatchObject({ count: 3, stopped: true, strategy: "request-user-intervention" });
  });
});

function fixture(trace: string[], message: ChatMessage, known: Set<string>): RunOnceDependencies {
  return {
    readControlCommand: () => { trace.push("control"); return Promise.resolve(null); },
    preflight: () => { trace.push("preflight"); return Promise.resolve(); },
    readMessages: () => { trace.push("read"); return Promise.resolve([message]); },
    persistMessages: (messages) => {
      trace.push("persist");
      return Promise.resolve(messages.flatMap((entry) => known.has(entry.id) ? [] : (known.add(entry.id), [entry.id])));
    },
    generateReply: (current) => { trace.push(`generate:${current.id}`); return Promise.resolve({ text: "辛苦了，先歇会儿", citedMessageIds: [current.id], claims: [] }); },
    sendReply: (text) => { trace.push(`send:${text}`); return Promise.resolve({ status: "verified" }); },
    notifyUser: ({ reason, latestMessage, todo }) => { trace.push(`notify:${reason}|${latestMessage}|${todo}`); return Promise.resolve(); },
    audit: (type) => { trace.push(`audit:${type}`); return Promise.resolve(); },
    runDailyReview: () => { trace.push("review"); return Promise.resolve(); },
  };
}

function reviewPayload() {
  return { effectiveness: "有实质回应", evidence: ["incoming-1"], pauses: [], improvements: ["保持简短"] };
}
