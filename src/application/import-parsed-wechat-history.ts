import { z } from "zod";

import type { OCRLine } from "../adapters/native-bridge.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";
import type { MessageRepository } from "../storage/repositories.js";
import { HistoryImporter } from "./history-import.js";
import { parseWechatHistoryPages } from "./wechat-history-parser.js";

const sourceCheckpointSchema = z.object({
  cursor: z.string().nullable(),
  complete: z.boolean(),
  batches: z.number().int().nonnegative(),
  startAt: z.string().datetime().nullable(),
  endAt: z.string().datetime().nullable(),
  gaps: z.array(z.object({ id: z.string(), source: z.enum(["wechat", "douyin"]), reason: z.string() })),
});

const checkpointsSchema = z.object({
  sources: z.partialRecord(z.enum(["wechat", "douyin"]), sourceCheckpointSchema),
});

export interface ImportParsedWechatHistoryOptions {
  pages: OCRLine[][];
  store: EncryptedStore;
  messages: MessageRepository;
  temporaryRoot: string;
  complete?: boolean;
  extraGaps?: Array<{ id: string; reason: string }>;
  replaceWechatSource?: boolean;
}

export async function importParsedWechatHistory(options: ImportParsedWechatHistoryOptions): Promise<{
  parsed: number;
  added: number;
  total: number;
  complete: boolean;
  gaps: number;
  reportHash: string;
}> {
  const parsed = parseWechatHistoryPages(options.pages);
  const complete = options.complete ?? true;
  let addedCount: number;
  if (options.replaceWechatSource === true) {
    const before = await options.messages.list();
    await options.store.write("vault/messages.before-chronological-rebuild.enc", { messages: before });
    await options.messages.replaceSource("wechat", parsed.messages);
    addedCount = parsed.messages.length;
  } else {
    addedCount = (await options.messages.appendUnique(parsed.messages)).length;
  }
  const all = await options.messages.list();
  const wechatMessages = all.filter((message) => message.source === "wechat").sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const checkpoints = (await options.store.read("state/history-import.enc", checkpointsSchema)) ?? { sources: {} };
  const emptyCheckpoint = {
    cursor: null,
    complete: false,
    batches: 0,
    startAt: null,
    endAt: null,
    gaps: [],
  };
  const current = options.replaceWechatSource === true
    ? emptyCheckpoint
    : checkpoints.sources.wechat ?? emptyCheckpoint;
  const mergedGaps = [
    ...current.gaps,
    ...parsed.gaps.map((gap) => ({ ...gap, source: "wechat" as const })),
    ...(options.extraGaps ?? []).map((gap) => ({ ...gap, source: "wechat" as const })),
  ];
  current.cursor = complete ? "mcp-chronological-complete" : "mcp-chronological-partial";
  current.complete = complete;
  current.batches += options.pages.length;
  current.startAt = wechatMessages[0]?.occurredAt ?? current.startAt;
  current.endAt = wechatMessages.at(-1)?.occurredAt ?? current.endAt;
  current.gaps = [...new Map(mergedGaps.map((gap) => [`${gap.id}:${gap.reason}`, gap])).values()];
  checkpoints.sources.wechat = current;
  await options.store.write("state/history-import.enc", checkpoints);

  const { hash } = await new HistoryImporter(options.store, options.messages, options.temporaryRoot).buildReport();
  return {
    parsed: parsed.messages.length,
    added: addedCount,
    total: all.length,
    complete,
    gaps: parsed.gaps.length,
    reportHash: hash,
  };
}
