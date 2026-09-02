import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { ChatMessage } from "../domain/types.js";
import {
  buildInitializationReport,
  type InitializationReport,
} from "../memory/profile-builder.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";
import type { MessageRepository } from "../storage/repositories.js";

export type HistoryItem =
  | (Omit<ChatMessage, "kind" | "confidence"> & {
      kind: "text";
      confidence: number;
    })
  | (Omit<ChatMessage, "kind" | "text" | "confidence"> & {
      kind: "image";
      ocrText: string | null;
      ocrConfidence: number | null;
      temporaryPath: string;
    })
  | (Omit<ChatMessage, "kind" | "text" | "confidence"> & {
      kind: "voice";
      visibleTranscript: string | null;
      transcriptConfidence: number | null;
    });

export interface ImportBatch {
  items: HistoryItem[];
  nextCursor: string | null;
  complete: boolean;
}

export interface HistorySource {
  readonly source: "wechat" | "douyin";
  readBatch(cursor: string | null, batchSize: number): Promise<ImportBatch>;
}

export interface HistoryImportReport {
  initialization: InitializationReport;
  gaps: Array<{ id: string; source: "wechat" | "douyin"; reason: string }>;
}

const checkpointSchema = z.object({
  sources: z.partialRecord(
    z.enum(["wechat", "douyin"]),
    z.object({
      cursor: z.string().nullable(),
      complete: z.boolean(),
      batches: z.number().int().nonnegative(),
      startAt: z.string().datetime().nullable(),
      endAt: z.string().datetime().nullable(),
      gaps: z.array(
        z.object({
          id: z.string(),
          source: z.enum(["wechat", "douyin"]),
          reason: z.string(),
        }),
      ),
    }),
  ),
});

const reportSchema = z.object({
  report: z.unknown(),
  hash: z.string(),
  approvedHash: z.string().nullable(),
});

type Checkpoints = z.infer<typeof checkpointSchema>;

export class HistoryImporter {
  public constructor(
    private readonly store: EncryptedStore,
    private readonly messages: MessageRepository,
    private readonly temporaryRoot: string,
  ) {}

  public async importSource(source: HistorySource, batchSize = 100): Promise<void> {
    const checkpoints = await this.loadCheckpoints();
    const current = checkpoints.sources[source.source] ?? {
      cursor: null,
      complete: false,
      batches: 0,
      startAt: null,
      endAt: null,
      gaps: [],
    };
    if (current.complete) return;

    const batch = await source.readBatch(current.cursor, batchSize);
    const normalized: ChatMessage[] = [];
    for (const item of batch.items) {
      const result = await this.normalize(item);
      if (result.message === null) {
        current.gaps.push({ id: item.id, source: source.source, reason: result.reason });
      } else {
        normalized.push(result.message);
      }
    }
    await this.messages.appendUnique(normalized);
    current.cursor = batch.nextCursor;
    current.complete = batch.complete;
    current.batches += 1;
    const timestamps = batch.items.map((item) => item.occurredAt).sort();
    current.startAt = earliest(current.startAt, timestamps[0] ?? null);
    current.endAt = latest(current.endAt, timestamps.at(-1) ?? null);
    checkpoints.sources[source.source] = current;
    await this.store.write("state/history-import.enc", checkpoints);
  }

  public async buildReport(): Promise<{ report: HistoryImportReport; hash: string }> {
    const checkpoints = await this.loadCheckpoints();
    const report: HistoryImportReport = {
      initialization: buildInitializationReport(await this.messages.list()),
      gaps: Object.values(checkpoints.sources).flatMap((entry) => entry?.gaps ?? []),
    };
    const hash = createHash("sha256").update(stableJson(report)).digest("hex");
    await this.store.write("profiles/initialization-report.enc", {
      report,
      hash,
      approvedHash: null,
    });
    return { report, hash };
  }

  public async approveReport(hash: string): Promise<void> {
    const document = await this.store.read(
      "profiles/initialization-report.enc",
      reportSchema,
    );
    if (document === null || document.hash !== hash) {
      throw new Error("INITIALIZATION_REPORT_HASH_MISMATCH");
    }
    await this.store.write("profiles/initialization-report.enc", {
      ...document,
      approvedHash: hash,
    });
  }

  public async isReportApproved(): Promise<boolean> {
    const document = await this.store.read(
      "profiles/initialization-report.enc",
      reportSchema,
    );
    return document !== null && document.approvedHash === document.hash;
  }

  private async normalize(
    item: HistoryItem,
  ): Promise<{ message: ChatMessage | null; reason: string }> {
    if (item.kind === "text") return { message: item, reason: "" };
    if (item.kind === "voice") {
      if (item.visibleTranscript === null || item.transcriptConfidence === null) {
        return { message: null, reason: "VOICE_TRANSCRIPT_NOT_VISIBLE" };
      }
      return {
        message: {
          ...withoutSpecialFields(item),
          kind: "voice-transcript",
          text: item.visibleTranscript,
          confidence: item.transcriptConfidence,
        },
        reason: "",
      };
    }

    this.assertTemporaryPath(item.temporaryPath);
    try {
      if (item.ocrText === null || item.ocrConfidence === null) {
        return { message: null, reason: "IMAGE_OCR_MISSING" };
      }
      return {
        message: {
          ...withoutSpecialFields(item),
          kind: "image-ocr",
          text: item.ocrText,
          confidence: item.ocrConfidence,
        },
        reason: "",
      };
    } finally {
      await unlink(item.temporaryPath).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      });
    }
  }

  private assertTemporaryPath(candidate: string): void {
    const root = path.resolve(this.temporaryRoot);
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("TEMPORARY_PATH_OUTSIDE_ROOT");
    }
  }

  private async loadCheckpoints(): Promise<Checkpoints> {
    return (
      (await this.store.read("state/history-import.enc", checkpointSchema)) ?? {
        sources: {},
      }
    );
  }
}

function withoutSpecialFields(item: HistoryItem): Omit<ChatMessage, "kind" | "text" | "confidence"> {
  return {
    id: item.id,
    conversationId: item.conversationId,
    direction: item.direction,
    occurredAt: item.occurredAt,
    source: item.source,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function earliest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function latest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}
