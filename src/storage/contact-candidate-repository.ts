import { createHash } from "node:crypto";

import { z } from "zod";

import { contactIdSchema } from "../contacts/contact-schema.js";
import type { EncryptedStore } from "./encrypted-store.js";

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const displayNameSchema = z.string().trim().min(1).max(64);
const candidateSchema = z.object({
  candidateId: hex64Schema,
  proposedContactId: contactIdSchema,
  displayName: displayNameSchema,
  previewHash: hex64Schema,
  windowRevision: hex64Schema,
  observedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
const consumedCandidateSchema = z.object({
  candidateId: hex64Schema,
  consumedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
const stateSchema = z.object({
  version: z.literal(1),
  candidates: z.array(candidateSchema).max(512),
  consumed: z.array(consumedCandidateSchema).default([]),
}).strict();

const statePath = "state/contact-candidates.enc";
const lockPath = "state/contact-candidates.lock";
const ttlMilliseconds = 24 * 60 * 60 * 1_000;

export type ContactCandidate = Readonly<z.infer<typeof candidateSchema>>;

export interface ObserveContactCandidate {
  readonly displayName: string;
  readonly previewHash: string;
  readonly windowRevision: string;
  readonly now: Date;
}

export class ContactCandidateRepository {
  public constructor(
    private readonly store: EncryptedStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public observe(input: ObserveContactCandidate): Promise<ContactCandidate> {
    const displayName = displayNameSchema.parse(input.displayName).normalize("NFC");
    const previewHash = hex64Schema.parse(input.previewHash);
    const windowRevision = hex64Schema.parse(input.windowRevision);
    const observedAt = timestamp(input.now);
    const evidenceHash = sha256(["wechat-contact-candidate-v1", displayName, previewHash, windowRevision]);
    const candidateId = evidenceHash;
    const proposedContactId = contactIdSchema.parse(`contact-${evidenceHash.slice(0, 32)}`);

    return this.withState(input.now, async (state) => {
      if (state.consumed.some((item) => item.candidateId === candidateId)) {
        throw new Error("CONTACT_CANDIDATE_ALREADY_CONSUMED");
      }
      const existing = state.candidates.find((candidate) => candidate.candidateId === candidateId);
      if (existing !== undefined) return copyCandidate(existing);
      const candidate = candidateSchema.parse({
        candidateId,
        proposedContactId,
        displayName,
        previewHash,
        windowRevision,
        observedAt,
        expiresAt: new Date(input.now.getTime() + ttlMilliseconds).toISOString(),
      });
      state.candidates.push(candidate);
      if (state.candidates.length > 512) state.candidates.splice(0, state.candidates.length - 512);
      await this.writeState(state);
      return copyCandidate(candidate);
    });
  }

  public listFresh(now: Date): Promise<readonly ContactCandidate[]> {
    return this.withState(now, (state) => Promise.resolve(Object.freeze(
      state.candidates.map(copyCandidate),
    )));
  }

  public getFresh(candidateId: string, now: Date = this.now()): Promise<ContactCandidate> {
    const parsedCandidateId = hex64Schema.parse(candidateId);
    return this.withState(now, (state) => {
      const candidate = state.candidates.find((item) => item.candidateId === parsedCandidateId);
      if (candidate === undefined) throw new Error("CONTACT_CANDIDATE_NOT_FOUND");
      return Promise.resolve(copyCandidate(candidate));
    });
  }

  public consume(
    candidateId: string,
    expectedWindowRevision: string,
    now: Date = this.now(),
  ): Promise<ContactCandidate> {
    const parsedCandidateId = hex64Schema.parse(candidateId);
    const parsedRevision = hex64Schema.parse(expectedWindowRevision);
    return this.withState(now, async (state) => {
      const index = state.candidates.findIndex((item) => item.candidateId === parsedCandidateId);
      const candidate = state.candidates[index];
      if (index === -1 || candidate === undefined) throw new Error("CONTACT_CANDIDATE_NOT_FOUND");
      if (candidate.windowRevision !== parsedRevision) {
        throw new Error("CONTACT_CANDIDATE_WINDOW_REVISION_MISMATCH");
      }
      state.candidates.splice(index, 1);
      state.consumed.push({
        candidateId: candidate.candidateId,
        consumedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMilliseconds).toISOString(),
      });
      await this.writeState(state);
      return copyCandidate(candidate);
    });
  }

  private withState<T>(now: Date, operation: (state: z.infer<typeof stateSchema>) => Promise<T>): Promise<T> {
    const currentTime = validDate(now).getTime();
    return this.store.runExclusiveTransaction(lockPath, async () => {
      const state = (await this.store.read(statePath, stateSchema)) ?? {
        version: 1 as const,
        candidates: [],
        consumed: [],
      };
      const before = state.candidates.length + state.consumed.length;
      state.candidates = state.candidates.filter((candidate) =>
        new Date(candidate.expiresAt).getTime() > currentTime
      );
      state.consumed = state.consumed.filter((candidate) =>
        new Date(candidate.expiresAt).getTime() > currentTime
      );
      if (state.candidates.length + state.consumed.length !== before) await this.writeState(state);
      return operation(state);
    });
  }

  private writeState(state: z.infer<typeof stateSchema>): Promise<void> {
    return this.store.write(statePath, stateSchema.parse(state));
  }
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("CONTACT_CANDIDATE_TIMESTAMP_INVALID");
  return value;
}

function timestamp(value: Date): string {
  return validDate(value).toISOString();
}

function sha256(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function copyCandidate(candidate: ContactCandidate): ContactCandidate {
  return Object.freeze(structuredClone(candidate));
}
