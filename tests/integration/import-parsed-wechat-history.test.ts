import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { importParsedWechatHistory } from "../../src/application/import-parsed-wechat-history.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { MessageRepository } from "../../src/storage/repositories.js";

describe("importParsedWechatHistory", () => {
  let root: string;
  let store: EncryptedStore;
  let messages: MessageRepository;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "parsed-wechat-history-"));
    const key = randomBytes(32);
    store = new EncryptedStore(root, { getOrCreate: () => Promise.resolve(key) });
    messages = new MessageRepository(store);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  test("atomically imports deduplicated messages and advances the encrypted checkpoint", async () => {
    const page = [
      line("2025年11月2日", 0.74, 0.12),
      line("锦春意年", 0.69),
      line("2025年11月2日20:35", 0.69, 0.68, 0.5),
      line("好兄弟", 0.66),
    ];

    const first = await importParsedWechatHistory({ pages: [page, page], store, messages, temporaryRoot: path.join(root, "temp") });
    const second = await importParsedWechatHistory({ pages: [page], store, messages, temporaryRoot: path.join(root, "temp") });

    expect(first).toMatchObject({ parsed: 1, added: 1, total: 1, complete: true });
    expect(second).toMatchObject({ parsed: 1, added: 0, total: 1, complete: true });
    const checkpoint = await store.read("state/history-import.enc", z.object({
      sources: z.object({ wechat: z.object({ complete: z.boolean(), cursor: z.string(), startAt: z.string(), endAt: z.string() }) }),
    }).passthrough());
    expect(checkpoint?.sources.wechat).toMatchObject({
      complete: true,
      cursor: "mcp-chronological-complete",
      startAt: "2025-11-02T12:35:00.000Z",
      endAt: "2025-11-02T12:35:00.000Z",
    });
    expect(first.reportHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("keeps the checkpoint incomplete when the caller declares a known capture gap", async () => {
    const result = await importParsedWechatHistory({
      pages: [],
      store,
      messages,
      temporaryRoot: path.join(root, "temp"),
      complete: false,
      extraGaps: [{ id: "calibration-gap", reason: "CALIBRATION_PAGES_NOT_PERSISTED" }],
    });

    expect(result.complete).toBe(false);
    const checkpoint = await store.read("state/history-import.enc", z.object({
      sources: z.object({ wechat: z.object({ complete: z.boolean(), gaps: z.array(z.object({ reason: z.string() })) }) }),
    }).passthrough());
    expect(checkpoint?.sources.wechat.complete).toBe(false);
    expect(checkpoint?.sources.wechat.gaps).toContainEqual(expect.objectContaining({ reason: "CALIBRATION_PAGES_NOT_PERSISTED" }));
  });

  test("backs up and replaces earlier WeChat extraction without keeping wrong timestamps", async () => {
    await messages.appendUnique([{
      id: "wrong-year",
      conversationId: "example-contact",
      direction: "incoming",
      kind: "text",
      text: "旧错误记录",
      occurredAt: "2025-02-26T05:05:00.000Z",
      source: "wechat",
      confidence: 1,
    }]);
    const page = [
      line("2025年11月2日", 0.74, 0.12),
      line("锦春意年", 0.69),
      line("2025年11月2日20:35", 0.69, 0.68, 0.5),
      line("好兄弟", 0.66),
    ];

    await importParsedWechatHistory({
      pages: [page, page],
      store,
      messages,
      temporaryRoot: path.join(root, "temp"),
      complete: false,
      extraGaps: [{ id: "stale-gap", reason: "STALE_CAPTURE_GAP" }],
    });

    await importParsedWechatHistory({
      pages: [page],
      store,
      messages,
      temporaryRoot: path.join(root, "temp"),
      replaceWechatSource: true,
    });

    expect((await messages.list()).map(({ text }) => text)).toEqual(["好兄弟"]);
    const backup = await store.read("vault/messages.before-chronological-rebuild.enc", z.object({ messages: z.array(z.object({ id: z.string() }).passthrough()) }));
    expect(backup?.messages).toContainEqual(expect.objectContaining({ id: "wrong-year" }));
    const checkpoint = await store.read("state/history-import.enc", z.object({
      sources: z.object({ wechat: z.object({ batches: z.number(), gaps: z.array(z.object({ id: z.string() })) }) }),
    }).passthrough());
    expect(checkpoint?.sources.wechat.batches).toBe(1);
    expect(checkpoint?.sources.wechat.gaps).not.toContainEqual(expect.objectContaining({ id: "stale-gap" }));
  });
});

function line(text: string, y: number, x = 0.185, confidence = 1) {
  return { text, confidence, bounds: { x, y, width: 0.2, height: 0.02 } };
}
