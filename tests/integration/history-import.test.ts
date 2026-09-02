import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HistoryImporter,
  type HistorySource,
} from "../../src/application/history-import.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { MessageRepository } from "../../src/storage/repositories.js";

describe("HistoryImporter", () => {
  let root: string;
  let temp: string;
  let importer: HistoryImporter;
  let messages: MessageRepository;
  let store: EncryptedStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "history-store-"));
    temp = await mkdtemp(path.join(os.tmpdir(), "history-images-"));
    const key = randomBytes(32);
    store = new EncryptedStore(root, { getOrCreate: () => Promise.resolve(key) });
    messages = new MessageRepository(store);
    importer = new HistoryImporter(store, messages, temp);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  });

  it("resumes from its encrypted checkpoint and deduplicates a replay", async () => {
    const readBatch = vi
      .fn<HistorySource["readBatch"]>()
      .mockResolvedValueOnce({
        items: [text("w1", "第一条")], nextCursor: "cursor-1", complete: false,
      })
      .mockResolvedValueOnce({
        items: [text("w1", "第一条"), text("w2", "第二条")], nextCursor: null, complete: true,
      });
    const source: HistorySource = { source: "wechat", readBatch };

    await importer.importSource(source, 1);
    const restarted = new HistoryImporter(store, messages, temp);
    await restarted.importSource(source, 2);
    await restarted.importSource(source, 2);

    expect(readBatch).toHaveBeenNthCalledWith(2, "cursor-1", 2);
    expect(readBatch).toHaveBeenCalledTimes(2);
    await expect(messages.list()).resolves.toHaveLength(2);
  });

  it("imports OCR and visible voice text, deletes images, and reports gaps", async () => {
    const imagePath = path.join(temp, "capture.png");
    await writeFile(imagePath, "synthetic");
    const source: HistorySource = {
      source: "wechat",
      readBatch: vi.fn().mockResolvedValue({
        nextCursor: null,
        complete: true,
        items: [
          { ...base("img1"), kind: "image", ocrText: "图片文字", ocrConfidence: 0.91, temporaryPath: imagePath },
          { ...base("voice1"), kind: "voice", visibleTranscript: "语音文字", transcriptConfidence: 0.95 },
          { ...base("voice2"), kind: "voice", visibleTranscript: null, transcriptConfidence: null },
        ],
      }),
    };

    await importer.importSource(source);
    await expect(access(imagePath)).rejects.toThrow();
    await expect(messages.list()).resolves.toEqual([
      expect.objectContaining({ id: "img1", kind: "image-ocr", text: "图片文字" }),
      expect.objectContaining({ id: "voice1", kind: "voice-transcript", text: "语音文字" }),
    ]);
    const { report, hash } = await importer.buildReport();
    expect(report.gaps).toEqual([
      { id: "voice2", source: "wechat", reason: "VOICE_TRANSCRIPT_NOT_VISIBLE" },
    ]);
    await expect(importer.approveReport("0".repeat(64))).rejects.toThrow(
      "INITIALIZATION_REPORT_HASH_MISMATCH",
    );
    await importer.approveReport(hash);
    await expect(importer.isReportApproved()).resolves.toBe(true);
  });
});

function base(id: string) {
  return {
    id,
    conversationId: "example-contact" as const,
    direction: "incoming" as const,
    occurredAt: "2026-08-19T00:00:00.000Z",
    source: "wechat" as const,
  };
}

function text(id: string, value: string) {
  return { ...base(id), kind: "text" as const, text: value, confidence: 0.99 };
}
