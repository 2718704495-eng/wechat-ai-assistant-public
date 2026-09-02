import { createHash } from "node:crypto";

import type { OCRLine } from "../adapters/native-bridge.js";
import type { NativeConversationListSnapshot } from "../adapters/native-wechat-surface.js";
import type { AuthorizedWechatTarget } from "../contacts/contact-directory.js";
import type { ContactId } from "../contacts/contact-schema.js";
import type { ObserveContactCandidate } from "../storage/contact-candidate-repository.js";

const listMaxX = 0.31;
const hex64Pattern = /^[a-f0-9]{64}$/u;

export interface ConversationListSignal {
  readonly contactId: ContactId;
  readonly contactRevision: number;
  readonly previewHash: string;
  readonly observedMinute: string | null;
  readonly unread: boolean;
  readonly windowRevision: string;
}

export interface ConversationListSnapshotReader {
  readConversationListSnapshot(): Promise<NativeConversationListSnapshot>;
}

interface CandidateObserver {
  observe(input: ObserveContactCandidate): Promise<unknown>;
}

interface ActiveTargetDirectory {
  listActiveAutoReplyTargets(): Promise<readonly AuthorizedWechatTarget[]>;
}

interface ParsedRow {
  readonly displayName: string;
  readonly previewHash: string;
  readonly observedMinute: string | null;
  readonly unread: boolean;
}

export class NativeConversationListDetector {
  private scanning = false;
  private readonly baseline = new Map<ContactId, { revision: number; state: string }>();

  public constructor(private readonly dependencies: {
    readonly directory: ActiveTargetDirectory;
    readonly candidates: CandidateObserver;
    readonly reader: ConversationListSnapshotReader;
    readonly now?: () => Date;
  }) {}

  public async scan(): Promise<readonly ConversationListSignal[]> {
    if (this.scanning) throw new Error("CONVERSATION_LIST_SCAN_REENTRANT");
    this.scanning = true;
    try {
      const beforeTargets = await this.dependencies.directory.listActiveAutoReplyTargets();
      assertUniqueTargetNames(beforeTargets);
      const snapshot = await this.dependencies.reader.readConversationListSnapshot();
      if (!hex64Pattern.test(snapshot.windowRevision)) {
        throw new Error("CONVERSATION_LIST_WINDOW_REVISION_INVALID");
      }
      const afterTargets = await this.dependencies.directory.listActiveAutoReplyTargets();
      if (!sameTargetSet(beforeTargets, afterTargets)) {
        throw new Error("CONVERSATION_LIST_DIRECTORY_CHANGED");
      }
      const rows = parseRows(snapshot.lines);
      const targetNames = new Set(beforeTargets.map((target) => normalizeTitle(target.displayName)));
      const now = this.dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error("CONVERSATION_LIST_TIMESTAMP_INVALID");
      for (const row of rows) {
        if (!targetNames.has(normalizeTitle(row.displayName))) {
          try {
            await this.dependencies.candidates.observe({
              displayName: row.displayName,
              previewHash: row.previewHash,
              windowRevision: snapshot.windowRevision,
              now,
            });
          } catch (error: unknown) {
            if (!(error instanceof Error) || error.message !== "CONTACT_CANDIDATE_ALREADY_CONSUMED") {
              throw error;
            }
          }
        }
      }

      const signals: ConversationListSignal[] = [];
      const currentTargetIds = new Set(beforeTargets.map(({ contactId }) => contactId));
      for (const contactId of this.baseline.keys()) {
        if (!currentTargetIds.has(contactId)) this.baseline.delete(contactId);
      }
      for (const target of beforeTargets) {
        const matches = rows.filter((row) =>
          normalizeTitle(row.displayName) === normalizeTitle(target.displayName)
        );
        if (matches.length !== 1) {
          if (matches.length > 1) throw new Error("CONVERSATION_LIST_TARGET_AMBIGUOUS");
          continue;
        }
        const row = matches[0];
        if (row === undefined) continue;
        const state = rowState(target, row);
        const previous = this.baseline.get(target.contactId);
        this.baseline.set(target.contactId, { revision: target.revision, state });
        if (previous === undefined || previous.revision !== target.revision || previous.state === state) continue;
        signals.push(Object.freeze({
          contactId: target.contactId,
          contactRevision: target.revision,
          previewHash: row.previewHash,
          observedMinute: row.observedMinute,
          unread: row.unread,
          windowRevision: snapshot.windowRevision,
        }));
      }
      return Object.freeze(signals);
    } finally {
      this.scanning = false;
    }
  }
}

function parseRows(lines: readonly OCRLine[]): ParsedRow[] {
  const pane = lines.filter((line) => line.bounds.x < listMaxX);
  const content = pane.filter((line) =>
    isMeaningful(line.text) && !isTemporalAnchor(line.text) && !isUnreadCount(line.text)
  ).sort((left, right) => centerY(right) - centerY(left));
  const titleCandidates = content.filter((line) => line.confidence >= 0.9);
  const temporalLines = pane.filter((line) =>
    line.confidence >= 0.9 && isTemporalAnchor(line.text)
  );
  const temporalAssignments = new Map<OCRLine, OCRLine[]>();
  for (const temporal of temporalLines) {
    const candidates = titleCandidates.filter((line) =>
      line.bounds.x < temporal.bounds.x && Math.abs(centerY(line) - centerY(temporal)) <= 0.025
    );
    const title = candidates[0];
    if (candidates.length === 1 && title !== undefined) {
      const assigned = temporalAssignments.get(title) ?? [];
      assigned.push(temporal);
      temporalAssignments.set(title, assigned);
    }
  }
  const anchors = [...temporalAssignments.entries()]
    .filter(([, temporals]) => temporals.length === 1)
    .map(([title, temporals]) => ({ title, temporal: temporals[0] as OCRLine }));
  anchors.sort((left, right) => centerY(right.title) - centerY(left.title));
  const rows: ParsedRow[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    if (anchor === undefined) continue;
    const title = anchor.title;
    const titleCenter = centerY(title);
    const nextAnchor = anchors[index + 1];
    const lowerBoundary = nextAnchor === undefined
      ? titleCenter - 0.081
      : centerY(nextAnchor.title) + 0.015;
    const cluster = content.filter((line) => {
      if (line === title || anchors.some(({ title: anchored }) => anchored === line)) return false;
      const offset = titleCenter - centerY(line);
      return offset >= 0.015 && offset <= 0.081 && centerY(line) > lowerBoundary;
    }).sort((left, right) => centerY(right) - centerY(left));
    if (cluster.length !== 1 || cluster[0] === undefined || cluster[0].confidence < 0.5) continue;
    const minutes = temporalLines.map((line) => ({ line, minute: parseMinute(line.text) })).filter(({ line, minute }) =>
      minute !== null && Math.abs(centerY(line) - titleCenter) <= 0.04
    );
    if (minutes.length > 1) throw new Error("CONVERSATION_LIST_ROW_AMBIGUOUS");
    rows.push(parsedRow(title, cluster[0], pane, minutes[0]?.minute ?? null));
  }

  return rows;
}

function parsedRow(
  title: OCRLine,
  preview: OCRLine,
  pane: readonly OCRLine[],
  observedMinute: string | null,
): ParsedRow {
  const titleCenter = centerY(title);
  return {
    displayName: title.text.normalize("NFC").trim(),
    previewHash: sha256(["wechat-conversation-preview-v1", normalizePreview(preview.text)]),
    observedMinute,
    unread: pane.some((line) => line !== title && isUnreadCount(line.text) &&
      Math.abs(centerY(line) - titleCenter) <= 0.03
    ),
  };
}

function assertUniqueTargetNames(targets: readonly AuthorizedWechatTarget[]): void {
  const names = targets.map((target) => normalizeTitle(target.displayName));
  if (new Set(names).size !== names.length) throw new Error("CONVERSATION_LIST_TARGET_AMBIGUOUS");
}

function sameTargetSet(
  left: readonly AuthorizedWechatTarget[],
  right: readonly AuthorizedWechatTarget[],
): boolean {
  const signature = (target: AuthorizedWechatTarget) => [
    target.contactId,
    target.revision,
    normalizeTitle(target.displayName),
    target.enrollmentFingerprint,
    target.bindingHash,
  ].join("\0");
  return left.length === right.length &&
    left.map(signature).sort().every((value, index) => value === right.map(signature).sort()[index]);
}

function rowState(target: AuthorizedWechatTarget, row: ParsedRow): string {
  return [target.revision, row.previewHash, row.observedMinute ?? "", row.unread ? "1" : "0"].join("\0");
}

function isMeaningful(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function isUnreadCount(value: string): boolean {
  return /^(?:[1-9]|[1-9]\d)$/u.test(value.trim());
}

function parseMinute(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isTemporalAnchor(value: string): boolean {
  const normalized = value.normalize("NFC").trim();
  return parseMinute(normalized) !== null ||
    /^(?:今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|\d{1,2}[/-]\d{1,2}|\d{1,2}月\d{1,2}日)$/u.test(normalized);
}

function centerY(line: OCRLine): number {
  return line.bounds.y + line.bounds.height / 2;
}

function normalizeTitle(value: string): string {
  return value.normalize("NFC").trim();
}

function normalizePreview(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").trim();
}

function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
