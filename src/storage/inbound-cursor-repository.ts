import { createHash } from "node:crypto";

import { z } from "zod";

import { contactIdSchema, type ContactId } from "../contacts/contact-schema.js";
import type { EncryptedStore } from "./encrypted-store.js";

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const bindingSchema = z.string().trim().min(1).max(512);
const cursorSchema = z.object({
  version: z.literal(1),
  contactId: contactIdSchema,
  contactRevision: z.number().int().positive(),
  sourceEpoch: bindingSchema,
  sessionIdHash: hex64Schema,
  baselineHashes: z.array(hex64Schema).max(2_048),
  consumedProofIds: z.array(hex64Schema).max(512),
  nextSequence: z.number().int().positive(),
}).strict();
export type InboundCursor = Readonly<z.infer<typeof cursorSchema>>;

export interface EstablishInboundBaseline {
  readonly contactId: ContactId;
  readonly contactRevision: number;
  readonly sourceEpoch: string;
  readonly sessionId: string;
  readonly baselineHashes: readonly string[];
  readonly proofIds: readonly string[];
}

export interface CommitInboundDelivery {
  readonly contactId: ContactId;
  readonly contactRevision: number;
  readonly sourceEpoch: string;
  readonly sessionId: string;
  readonly expectedSequence: number;
  readonly baselineHashes: readonly string[];
  readonly proofId: string | null;
}

export type RefreshInboundBaseline = Omit<CommitInboundDelivery, "proofId"> & {
  readonly proofIds: readonly string[];
};

export class InboundCursorRepository {
  public constructor(private readonly store: EncryptedStore) {}

  public read(contactId: ContactId): Promise<InboundCursor | null> {
    const parsed = contactIdSchema.parse(contactId);
    return this.readPath(parsed).then((cursor) => cursor === null ? null : copyCursor(cursor));
  }

  public establishBaseline(input: EstablishInboundBaseline): Promise<InboundCursor> {
    const identity = parseIdentity(input);
    const baselineHashes = parseHashes(input.baselineHashes);
    const consumedProofIds = uniqueRecentProofs(parseHashes(input.proofIds));
    const path = cursorPath(identity.contactId);
    return this.store.runExclusiveTransaction(`${path}.lock`, async () => {
      const current = await this.readPath(identity.contactId);
      if (current !== null && sameIdentity(current, identity)) return copyCursor(current);
      const cursor = cursorSchema.parse({
        version: 1,
        ...identity,
        baselineHashes,
        consumedProofIds,
        nextSequence: 1,
      });
      await this.store.write(path, cursor);
      return copyCursor(cursor);
    });
  }

  public commitDelivered(input: CommitInboundDelivery): Promise<InboundCursor> {
    const identity = parseIdentity(input);
    const path = cursorPath(identity.contactId);
    return this.store.runExclusiveTransaction(`${path}.lock`, () =>
      this.commitDeliveredWithoutTransaction(identity, input));
  }

  public refreshBaseline(input: RefreshInboundBaseline): Promise<InboundCursor> {
    const identity = parseIdentity(input);
    const path = cursorPath(identity.contactId);
    return this.store.runExclusiveTransaction(`${path}.lock`, () =>
      this.refreshBaselineWithoutTransaction(identity, input));
  }

  private async commitDeliveredWithoutTransaction(
    identity: ReturnType<typeof parseIdentity>,
    input: Pick<CommitInboundDelivery, "expectedSequence" | "baselineHashes" | "proofId">,
  ): Promise<InboundCursor> {
    const expectedSequence = z.number().int().positive().parse(input.expectedSequence);
    const baselineHashes = parseHashes(input.baselineHashes);
    const proofId = input.proofId === null ? null : hex64Schema.parse(input.proofId);
    const current = await this.requireCurrent(identity, expectedSequence);
    const consumedProofIds = proofId === null
      ? current.consumedProofIds
      : uniqueRecentProofs([...current.consumedProofIds, proofId]);
    const updated = cursorSchema.parse({
      ...current,
      baselineHashes,
      consumedProofIds,
      nextSequence: current.nextSequence + 1,
    });
    await this.store.write(cursorPath(identity.contactId), updated);
    return copyCursor(updated);
  }

  private async refreshBaselineWithoutTransaction(
    identity: ReturnType<typeof parseIdentity>,
    input: Pick<RefreshInboundBaseline, "expectedSequence" | "baselineHashes" | "proofIds">,
  ): Promise<InboundCursor> {
    const expectedSequence = z.number().int().positive().parse(input.expectedSequence);
    const baselineHashes = parseHashes(input.baselineHashes);
    const proofIds = parseHashes(input.proofIds);
    const current = await this.requireCurrent(identity, expectedSequence);
    const updated = cursorSchema.parse({
      ...current,
      baselineHashes,
      consumedProofIds: uniqueRecentProofs([...current.consumedProofIds, ...proofIds]),
    });
    await this.store.write(cursorPath(identity.contactId), updated);
    return copyCursor(updated);
  }

  private async requireCurrent(
    identity: ReturnType<typeof parseIdentity>,
    expectedSequence: number,
  ): Promise<InboundCursor> {
    const current = await this.readPath(identity.contactId);
    if (current === null) throw new Error("INBOUND_CURSOR_NOT_FOUND");
    if (!sameIdentity(current, identity)) throw new Error("INBOUND_CURSOR_IDENTITY_MISMATCH");
    if (current.nextSequence !== expectedSequence) {
      throw new Error("INBOUND_CURSOR_SEQUENCE_MISMATCH");
    }
    return current;
  }

  private readPath(contactId: ContactId): Promise<InboundCursor | null> {
    return this.store.read(cursorPath(contactId), cursorSchema);
  }
}

function parseIdentity(input: {
  contactId: ContactId;
  contactRevision: number;
  sourceEpoch: string;
  sessionId: string;
}) {
  return {
    contactId: contactIdSchema.parse(input.contactId),
    contactRevision: z.number().int().positive().parse(input.contactRevision),
    sourceEpoch: bindingSchema.parse(input.sourceEpoch),
    sessionIdHash: sha256(bindingSchema.parse(input.sessionId)),
  };
}

function cursorPath(contactId: ContactId): string {
  return `state/inbound/${sha256(contactId)}.enc`;
}

function sameIdentity(
  cursor: InboundCursor,
  identity: ReturnType<typeof parseIdentity>,
): boolean {
  return cursor.contactId === identity.contactId &&
    cursor.contactRevision === identity.contactRevision &&
    cursor.sourceEpoch === identity.sourceEpoch &&
    cursor.sessionIdHash === identity.sessionIdHash;
}

function parseHashes(values: readonly string[]): string[] {
  return z.array(hex64Schema).max(2_048).parse([...values]);
}

function uniqueRecentProofs(values: readonly string[]): string[] {
  return [...new Set(values)].slice(-512);
}

function copyCursor(cursor: InboundCursor): InboundCursor {
  const copied = structuredClone(cursor);
  Object.freeze(copied.baselineHashes);
  Object.freeze(copied.consumedProofIds);
  return Object.freeze(copied);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
