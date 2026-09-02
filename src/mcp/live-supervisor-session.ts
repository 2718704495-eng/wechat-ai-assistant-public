import { z } from "zod";

import type {
  LiveWechatRuntimeDependencies,
  SupervisorControlProof,
  SupervisorTargetProof,
} from "./live-server.js";

const candidateTextSchema = z.string()
  .min(1)
  .max(500)
  .refine((text) => text.trim().length > 0)
  .refine((text) => !/[\r\n]/u.test(text));

export const liveSupervisorCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("establish-control-boundary") }).strict(),
  z.object({ op: z.literal("read-control") }).strict(),
  z.object({ op: z.literal("read-target") }).strict(),
  z.object({
    op: z.literal("prepare-latest-reply"),
    text: candidateTextSchema,
  }).strict(),
  z.object({ op: z.literal("show-comfort-station") }).strict(),
  z.object({ op: z.literal("verify-draft") }).strict(),
  z.object({ op: z.literal("submit-authorized-draft") }).strict(),
  z.object({ op: z.literal("abort-draft") }).strict(),
  z.object({ op: z.literal("verify-send") }).strict(),
  z.object({ op: z.literal("close") }).strict(),
]);

export type LiveSupervisorCommand = z.infer<typeof liveSupervisorCommandSchema>;

type SessionPhase =
  | "idle"
  | "control-read"
  | "target-read"
  | "prepared"
  | "draft-verified"
  | "submitted"
  | "send-verified"
  | "closed";

export interface LiveSupervisorSession {
  execute(command: unknown): Promise<unknown>;
  close(): void;
}

export function createLiveSupervisorSession(
  dependencies: LiveWechatRuntimeDependencies,
  options: { directTargetStart?: boolean } = {},
): LiveSupervisorSession {
  let phase: SessionPhase = "idle";
  let controlProof: SupervisorControlProof | null = null;
  let targetProof: SupervisorTargetProof | null = null;
  let candidateToken: string | null = null;

  return { execute, close };

  async function execute(commandValue: unknown): Promise<unknown> {
    if (phase === "closed") throw new Error("SUPERVISOR_SESSION_CLOSED");
    const command = liveSupervisorCommandSchema.parse(commandValue);
    switch (command.op) {
      case "establish-control-boundary": {
        if (phase === "prepared" || phase === "draft-verified" || phase === "submitted") {
          throw new Error("SUPERVISOR_SEQUENCE_ERROR");
        }
        const proof = await dependencies.establishControlBoundaryForSupervisor();
        return {
          status: "active" as const,
          epoch: proof.epoch,
          boundaryMessageId: proof.boundaryMessageId,
          consumedCount: proof.consumedCount,
          prefixChainHash: proof.prefixChainHash,
          markerOccurrenceCount: 1 as const,
        };
      }
      case "read-control": {
        assertPhase("idle", "send-verified");
        const read = await dependencies.readControlForSupervisor();
        controlProof = read.proof;
        targetProof = null;
        candidateToken = null;
        phase = "control-read";
        return read.publicResult;
      }
      case "read-target": {
        if (options.directTargetStart === true) {
          assertPhase("idle", "send-verified");
          const read = await dependencies.readTargetDirectForSupervisor();
          controlProof = read.controlProof;
          targetProof = read.proof;
          candidateToken = null;
          phase = "target-read";
          return read.publicResult;
        }
        assertPhase("control-read");
        if (controlProof === null) throw new Error("SUPERVISOR_SEQUENCE_ERROR");
        const read = await dependencies.readTargetForSupervisor(controlProof);
        targetProof = read.proof;
        phase = "target-read";
        return read.publicResult;
      }
      case "prepare-latest-reply": {
        assertPhase("target-read");
        if (controlProof === null || targetProof === null) {
          throw new Error("SUPERVISOR_SEQUENCE_ERROR");
        }
        const prepared = await dependencies.prepareLatestReplyForSupervisor(
          command.text,
          controlProof,
          targetProof,
        );
        candidateToken = prepared.candidateToken;
        phase = "prepared";
        return { prepared: true as const, conversationId: "example-contact" as const };
      }
      case "show-comfort-station": {
        assertPhase("target-read");
        if (controlProof === null || targetProof === null) {
          throw new Error("SUPERVISOR_SEQUENCE_ERROR");
        }
        const result = await dependencies.showComfortStationCardForSupervisor(
          controlProof,
          targetProof,
        );
        invalidateProofs();
        phase = "send-verified";
        return result;
      }
      case "verify-draft": {
        assertPhase("prepared");
        const token = requireCandidateToken();
        const verified = await dependencies.verifyDraft(token);
        phase = "draft-verified";
        return {
          draftVerified: true as const,
          conversationId: conversationIdFrom(verified),
        };
      }
      case "submit-authorized-draft": {
        assertPhase("draft-verified");
        const token = requireCandidateToken();
        if (controlProof === null || targetProof === null) {
          throw new Error("SUPERVISOR_SEQUENCE_ERROR");
        }
        phase = "submitted";
        const submitted = await dependencies.submitAuthorizedDraftForSupervisor(
          token,
          controlProof,
          targetProof,
        );
        return {
          submitted: submitted.submitted,
          conversationId: submitted.conversationId,
        };
      }
      case "abort-draft": {
        assertPhase("prepared", "draft-verified");
        const aborted = await dependencies.abortPreparedDraftForSupervisor(
          requireCandidateToken(),
        );
        invalidateProofs();
        phase = "idle";
        return {
          aborted: true as const,
          conversationId: conversationIdFrom(aborted),
        };
      }
      case "verify-send": {
        assertPhase("submitted");
        const verified = await dependencies.verifySend(requireCandidateToken());
        invalidateProofs();
        phase = "send-verified";
        return {
          status: "verified" as const,
          conversationId: conversationIdFrom(verified),
        };
      }
      case "close":
        close();
        return { closed: true as const };
    }
  }

  function close(): void {
    invalidateProofs();
    phase = "closed";
  }

  function assertPhase(...allowed: SessionPhase[]): void {
    if (!allowed.includes(phase)) throw new Error("SUPERVISOR_SEQUENCE_ERROR");
  }

  function requireCandidateToken(): string {
    if (candidateToken === null) throw new Error("SUPERVISOR_SEQUENCE_ERROR");
    return candidateToken;
  }

  function invalidateProofs(): void {
    controlProof = null;
    targetProof = null;
    candidateToken = null;
  }
}

function conversationIdFrom(value: unknown): "example-contact" {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).conversationId !== "example-contact"
  ) {
    throw new Error("SUPERVISOR_RUNTIME_RESULT_INVALID");
  }
  return "example-contact";
}
