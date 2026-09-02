import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import type {
  ConversationSnapshot,
  WeChatAdapter,
  WeChatSurface,
} from "../adapters/wechat.js";
import {
  assertContactDirectory,
  ContactDirectory,
} from "../contacts/contact-directory.js";
import type { ContactReplyDelivery } from "../conversation/realtime-reply-service.js";
import {
  assertContactBoundScheduledReplyDelivery,
  type ContactBoundScheduledReplyDelivery,
} from "../runtime-v2/single-scheduler.js";
import {
  ALL_ASSISTANT_SIGNATURES,
  ASSISTANT_SIGNATURE,
} from "../assistant-identity.js";
import { TravelDemoJobRunner } from "../artifacts/travel-demo-job.js";
import {
  assertSendGate,
  type RuntimeConfig,
  type SendGateState,
} from "../config/runtime-config.js";
import type { ConversationId } from "../domain/types.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";
import type { ComfortStationDeliveryRepository } from "../storage/comfort-station-delivery-repository.js";
import type {
  AbortIntent,
  AbortIntentRepository,
  AuditRepository,
  ControlBoundaryCheckpoint,
  MessageRepository,
  PendingSend,
  PendingSendRepository,
  PersistentStopGate,
  StateRepository,
  TargetReplyTrigger,
} from "../storage/repositories.js";
import type { LiveOperationCoordinator } from "./live-operation-coordinator.js";
import type {
  LiveWechatRuntimeDependencies,
  SupervisorControlProof,
  SupervisorTargetProof,
} from "./live-server.js";

export const runtimeConsentSchema = z
  .object({
    version: z.literal(1),
    consentConfirmed: z.literal(true),
    reportHash: z.string().regex(/^[a-f0-9]{64}$/u),
    acceptanceBindingSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    activatedAt: z.string().datetime(),
  })
  .strict();
const initializationReportSchema = z
  .object({
    hash: z.string().length(64),
    approvedHash: z.string().length(64).nullable(),
  })
  .passthrough();

interface LiveWechatRuntimeOptions {
  config: RuntimeConfig;
  adapter: Pick<
    WeChatAdapter,
    | "readConversation"
    | "readControlConversation"
    | "readConversationForOwnerAdvice"
  >;
  surface: WeChatSurface;
  store: EncryptedStore;
  /**
   * Release-bound consent and the operator control boundary live in the
   * project authority root. Runtime queues may use the isolated runtime-v2
   * store, but must never treat that operational store as an authority root.
   */
  authorityStore?: EncryptedStore;
  messages: MessageRepository;
  state: StateRepository;
  pending: PendingSendRepository;
  aborts: AbortIntentRepository;
  audit: AuditRepository;
  comfortStationDeliveries: ComfortStationDeliveryRepository;
  comfortStationCard: {
    path: string;
    sha256: string;
    width: 1080;
    height: 1350;
  };
  coordinator: LiveOperationCoordinator;
  activationBindingSha256?: string;
  now?: () => Date;
}

export function createMcpContactReplyDelivery(
  directory: ContactDirectory,
  scheduledDelivery: ContactBoundScheduledReplyDelivery,
): ContactReplyDelivery {
  assertContactDirectory(directory);
  assertContactBoundScheduledReplyDelivery(scheduledDelivery);
  const delivery: ContactReplyDelivery = {
    deliver: (claim) => scheduledDelivery.deliver(claim),
    recoverSubmitted: async (claim) => {
      const status = await scheduledDelivery.recoverSubmitted(claim);
      if (status !== "verified" && status !== "submitted-uncertain") {
        throw new Error("MCP_DELIVERY_READBACK_INVALID");
      }
      return status;
    },
  };
  return Object.freeze(delivery);
}

export function createLiveWechatDependencies(
  options: LiveWechatRuntimeOptions,
): LiveWechatRuntimeDependencies {
  const now = options.now ?? (() => new Date());
  const authorityStore = options.authorityStore ?? options.store;
  const travelDemoJobs = new TravelDemoJobRunner({
    dataDir: options.config.dataDir,
    store: options.store,
    now,
  });
  const consumedSubmitTokens = new Set<string>();
  const controlProofs = new Map<string, string>();
  const targetProofs = new Map<string, string>();
  const preparedTargetTriggers = new Map<
    string,
    {
      triggerId: string;
      controlCapability: string;
      targetCapability: string;
    }
  >();

  const deliverComfortStationCard = async (
    deliveryKey: string,
    triggerMessageIdHash: string,
    preflight: () => Promise<void>,
  ): Promise<boolean> => {
    const claimed = await options.comfortStationDeliveries.claim({
      deliveryKey,
      triggerMessageIdHash,
      cardSha256: options.comfortStationCard.sha256,
      createdAt: now().toISOString(),
    });
    if (!claimed.claimed) return false;
    try {
      await preflight();
      const sender = options.surface.sendComfortStationCard?.bind(
        options.surface,
      );
      if (sender === undefined)
        throw new Error("COMFORT_STATION_IMAGE_SEND_UNAVAILABLE");
      const receipt = await sender({
        ...options.comfortStationCard,
        deliveryKey,
        token: randomBytes(32).toString("hex"),
      });
      if (
        receipt.imageSha256 !== options.comfortStationCard.sha256 ||
        !receipt.submitted ||
        !receipt.outgoingImageMatched ||
        receipt.visualFingerprintVersion !== "vision-featureprint-v1"
      ) {
        throw new Error("COMFORT_STATION_IMAGE_SEND_NOT_VERIFIED");
      }
      await options.comfortStationDeliveries.markVerified(
        deliveryKey,
        now().toISOString(),
      );
    } catch (error: unknown) {
      const finalizationErrors: unknown[] = [];
      try {
        await options.comfortStationDeliveries.markUncertain(
          deliveryKey,
          now().toISOString(),
        );
      } catch (markError: unknown) {
        finalizationErrors.push(markError);
      }
      try {
        await options.audit.record({
          type: "comfort-station-card-uncertain",
          details: {
            conversationId: "example-contact",
            deliveryKeyHash: sha256(deliveryKey),
          },
        });
      } catch (auditError: unknown) {
        finalizationErrors.push(auditError);
      }
      if (finalizationErrors.length > 0) {
        throw new AggregateError(
          [error, ...finalizationErrors],
          "COMFORT_STATION_DELIVERY_FINALIZATION_FAILED",
        );
      }
      throw error;
    }
    await options.audit.record({
      type: "comfort-station-card-verified",
      details: {
        conversationId: "example-contact",
        deliveryKeyHash: sha256(deliveryKey),
        cardSha256: options.comfortStationCard.sha256,
      },
    });
    return true;
  };

  const readTargetAtControlProof = async (
    controlProof: SupervisorControlProof,
  ) => {
    await assertBoundControlState(options, controlProof);
    const read = await readConversationWithinOperation(options, "example-contact", {
      checkpoint: controlProof.checkpoint,
      gateRevision: controlProof.gateRevision,
    });
    await assertBoundControlState(options, controlProof);
    const targetState = await options.state.getTargetReplyState();
    const trigger = targetState.pendingTrigger;
    const latestMessage = read.messages.at(-1);
    const travelDemo =
      trigger === null
        ? {
            kind: "not-applicable" as const,
            reason: "NO_TRUSTED_TARGET_TRIGGER" as const,
          }
        : await travelDemoJobs.run({
            conversationId: "example-contact",
            triggerId: trigger.triggerId,
            triggerMessageId: trigger.triggerMessageId,
            latestMessage: requireLatestTargetMessage(latestMessage, trigger),
          });
    if (travelDemo.kind === "artifact") {
      await options.audit.record({
        type: "travel-demo-job",
        details: {
          jobId: travelDemo.jobId,
          status: travelDemo.status,
          deliveryCode: travelDemo.deliveryCode,
          manifestSha256: travelDemo.manifestSha256,
        },
      });
    }
    const comfortStationRequested =
      trigger !== null &&
      latestMessage !== undefined &&
      isComfortStationWakeRequest(latestMessage.text);
    return {
      publicResult: {
        ...read,
        comfortStation: {
          requested: comfortStationRequested,
        },
        travelDemo:
          travelDemo.kind === "artifact"
            ? {
                kind: travelDemo.kind,
                jobId: travelDemo.jobId,
                status: travelDemo.status,
                deliveryCode: travelDemo.deliveryCode,
              }
            : travelDemo,
      },
      proof:
        trigger === null
          ? null
          : createTargetProof(trigger, comfortStationRequested, targetProofs),
    };
  };

  return {
    getLiveState: () =>
      options.coordinator.runExclusive(async () => {
        const abortIntent = await options.aborts.get();
        const recovered = await recoverTerminalUncertainPending(options);
        const control = recovered.control;
        const candidate = recovered.candidate;
        const gate = await readSendGate(
          authorityStore,
          options.activationBindingSha256,
        );
        return {
          connected: true,
          mode: options.config.mode,
          stopped: control.stopped,
          stopReason: control.stopReason,
          pendingSend:
            candidate === null
              ? null
              : {
                  conversationId: candidate.conversationId,
                  createdAt: candidate.createdAt,
                },
          sendGate: gate,
          targetSendReady:
            (options.config.mode === "supervised-send" ||
              options.config.mode === "live") &&
            gate.consentConfirmed &&
            gate.initializationReportApproved &&
            !control.stopped &&
            candidate === null &&
            abortIntent === null,
        };
      }),

    readConversation: (conversationId) =>
      options.coordinator.runExclusive(() =>
        readConversationWithinOperation(options, conversationId),
      ),

    establishControlBoundaryForSupervisor: () =>
      options.coordinator.runExclusive(async () => {
        const current = await options.state.getControlState();
        if (current.controlBoundary.status === "active") {
          const existingPending = await options.pending.get();
          if (existingPending !== null) {
            const issued = await options.state.issueControlBoundary();
            if (!isBoundaryCandidate(existingPending, issued.markerText)) {
              throw new Error("PENDING_SEND_EXISTS");
            }
            const snapshot =
              await options.adapter.readConversation("file-transfer");
            if (
              countBoundaryOccurrences(snapshot, issued.boundaryMessageId) !== 1
            ) {
              throw new Error("CONTROL_BOUNDARY_AMBIGUOUS");
            }
            await clearRecoveredBoundaryCandidate(
              options,
              existingPending,
              snapshot,
            );
          }
          return activeBoundaryProof({
            ...current.controlBoundary,
            status: "active",
          });
        }
        if ((await options.aborts.get()) !== null)
          throw new Error("ABORT_INTENT_EXISTS");
        const issued = await options.state.issueControlBoundary();
        const initial = await options.adapter.readConversation("file-transfer");
        const existingOccurrences = countBoundaryOccurrences(
          initial,
          issued.boundaryMessageId,
        );
        const existingPending = await options.pending.get();
        if (existingOccurrences === 1) {
          if (
            existingPending !== null &&
            !isBoundaryCandidate(existingPending, issued.markerText)
          ) {
            throw new Error("PENDING_SEND_EXISTS");
          }
          const proof = await options.state.activateControlBoundary({
            expectedEpoch: issued.epoch,
            boundaryMessageId: issued.boundaryMessageId,
            markerOccurrenceCount: 1,
          });
          if (existingPending !== null) {
            await clearRecoveredBoundaryCandidate(
              options,
              existingPending,
              initial,
            );
          }
          return proof;
        }
        if (existingOccurrences > 1)
          throw new Error("CONTROL_BOUNDARY_AMBIGUOUS");
        if (existingPending !== null) {
          if (isBoundaryCandidate(existingPending, issued.markerText)) {
            throw new Error("CONTROL_BOUNDARY_SUBMIT_UNCERTAIN");
          }
          throw new Error("PENDING_SEND_EXISTS");
        }
        if (!isComposerProvenEmpty(initial)) throw new Error("INPUT_NOT_EMPTY");
        const candidateToken = randomBytes(32).toString("hex");
        const tokenHash = sha256(candidateToken);
        await options.surface.focusConversation(
          "file-transfer",
          initial.windowRevision,
        );
        await options.pending.put({
          conversationId: "file-transfer",
          text: issued.markerText,
          tokenHash,
          fingerprint: null,
          baselineMessageIds: initial.messages.map((message) => message.id),
          createdAt: now().toISOString(),
          draftVerifiedAt: null,
        });
        let submitStarted = false;
        try {
          await options.surface.replaceDraft(
            "file-transfer",
            issued.markerText,
            candidateToken,
          );
          const drafted =
            await options.adapter.readConversation("file-transfer");
          if (
            ![drafted.draftText, ...(drafted.draftAlternatives ?? [])].some(
              (draft) => sameDraft(draft, issued.markerText),
            )
          ) {
            throw new Error("DRAFT_WRITE_NOT_VERIFIED");
          }
          await options.pending.markDraftVerified(
            tokenHash,
            now().toISOString(),
          );
          submitStarted = true;
          await options.surface.submitDraft("file-transfer", candidateToken);
          const read = await options.adapter.readControlConversation();
          const markerOccurrenceCount = read.snapshot.messages.filter(
            (message) => message.id === issued.boundaryMessageId,
          ).length;
          const proof = await options.state.activateControlBoundary({
            expectedEpoch: issued.epoch,
            boundaryMessageId: issued.boundaryMessageId,
            markerOccurrenceCount,
          });
          await options.pending.clearMatching(tokenHash);
          await options.messages.appendUnique(read.snapshot.messages);
          await options.audit.record({
            type: "live-control-boundary-established",
            details: {
              epochHash: sha256(proof.epoch),
              boundaryMessageIdHash: sha256(proof.boundaryMessageId),
            },
          });
          return proof;
        } catch (error: unknown) {
          if (!submitStarted) {
            await clearUnsentBoundaryCandidate(
              options,
              tokenHash,
              candidateToken,
            );
          }
          throw error;
        }
      }),

    readControlForSupervisor: () =>
      options.coordinator.runExclusive(async () => {
        await recoverTerminalUncertainPending(options);
        const read = await options.adapter.readControlConversation();
        await options.messages.appendUnique(read.snapshot.messages);
        const control = await options.state.getControlState();
        const checkpoint =
          read.controlCheckpoint ??
          (await options.state.getControlBoundaryCheckpoint());
        return {
          publicResult: {
            control: read.control,
            stopped: control.stopped,
            stopReason: control.stopReason,
            checkpointReady: true,
          },
          proof: createControlProof(
            checkpoint,
            control.gateRevision,
            "ui-observed",
            controlProofs,
          ),
        };
      }),

    readTargetForSupervisor: (controlProof) =>
      options.coordinator.runExclusive(async () => {
        await assertCurrentControlProof(options, controlProof, controlProofs);
        return readTargetAtControlProof(controlProof);
      }),

    readTargetDirectForSupervisor: () =>
      options.coordinator.runExclusive(async () => {
        await recoverTerminalUncertainPending(options);
        const control = await options.state.getControlState();
        if (control.stopped) {
          return {
            publicResult: {
              stopped: true,
              stopReason: control.stopReason,
              replyDecision: {
                action: "wait" as const,
                triggerMessageId: null,
                reason: "CONTROL_STOPPED" as const,
              },
              travelDemo: {
                kind: "not-applicable" as const,
                reason: "NO_TRUSTED_TARGET_TRIGGER" as const,
              },
            },
            controlProof: null,
            proof: null,
          };
        }
        const gate = await options.state.getPersistentStopGate();
        const controlProof = createControlProof(
          gate.checkpoint,
          gate.gateRevision,
          "persistent-stop-gate",
          controlProofs,
        );
        const target = await readTargetAtControlProof(controlProof);
        return { ...target, controlProof };
      }),

    prepareLatestReplyForSupervisor: (text, controlProof, targetProof) =>
      options.coordinator.runExclusive(async () => {
        assertTargetControlBinding(targetProof, controlProof);
        if ((await options.aborts.get()) !== null)
          throw new Error("ABORT_INTENT_EXISTS");
        if ((await options.pending.get()) !== null)
          throw new Error("PENDING_SEND_EXISTS");
        assertTargetProof(targetProof, targetProofs);
        assertSendGate(
          options.config,
          await readSendGate(authorityStore, options.activationBindingSha256),
        );
        await rereadAndAssertControl(options, controlProof, controlProofs);
        const snapshot = await options.adapter.readConversation("example-contact");
        await assertBoundControlState(options, controlProof);
        const addedIds = await options.messages.appendUnique(snapshot.messages);
        const evaluated = await options.state.evaluateTargetReply({
          messages: snapshot.messages,
          addedIds,
          unreadIndicator: snapshot.unreadIndicator,
          controlCheckpoint: controlProof.checkpoint,
          expectedGateRevision: controlProof.gateRevision,
        });
        if (
          evaluated.trigger?.triggerId !== targetProof.trigger.triggerId ||
          snapshot.messages.at(-1)?.id !==
            targetProof.trigger.triggerMessageId ||
          snapshot.messages.at(-1)?.direction !== "incoming"
        ) {
          throw new Error("TARGET_TRIGGER_CHANGED");
        }
        await assertBoundControlState(options, controlProof);
        const finalText = withAssistantSignature(text);
        const prepared = await prepareDraftFromSnapshot(
          options,
          now,
          "example-contact",
          finalText,
          snapshot,
          {
            checkpoint: controlProof.checkpoint,
            gateRevision: controlProof.gateRevision,
          },
        );
        try {
          await options.surface.replaceDraft(
            "example-contact",
            finalText,
            prepared.candidateToken,
          );
        } catch (error: unknown) {
          const candidate = await options.pending.get();
          if (
            candidate !== null &&
            candidate.tokenHash === sha256(prepared.candidateToken)
          ) {
            await cancelPreparedDraft(
              options,
              candidate,
              prepared.candidateToken,
            );
          }
          throw error;
        }
        preparedTargetTriggers.set(sha256(prepared.candidateToken), {
          triggerId: targetProof.trigger.triggerId,
          controlCapability: controlProof.capability,
          targetCapability: targetProof.capability,
        });
        controlProofs.delete(controlProof.capability);
        targetProofs.delete(targetProof.capability);
        return {
          candidateToken: prepared.candidateToken,
          prepared: true as const,
          conversationId: "example-contact" as const,
        };
      }),

    showComfortStationCardForSupervisor: (controlProof, targetProof) =>
      options.coordinator.runExclusive(async () => {
        assertTargetControlBinding(targetProof, controlProof);
        assertTargetProof(targetProof, targetProofs);
        if ((await options.aborts.get()) !== null)
          throw new Error("ABORT_INTENT_EXISTS");
        if ((await options.pending.get()) !== null)
          throw new Error("PENDING_SEND_EXISTS");
        assertSendGate(
          options.config,
          await readSendGate(authorityStore, options.activationBindingSha256),
        );
        if (!targetProof.comfortStationRequested) {
          controlProofs.delete(controlProof.capability);
          targetProofs.delete(targetProof.capability);
          return {
            status: "not-requested" as const,
            conversationId: "example-contact" as const,
          };
        }
        const deliveryKey = comfortStationDeliveryKey(
          targetProof.trigger.triggerMessageId,
          options.comfortStationCard.sha256,
        );
        const delivered = await deliverComfortStationCard(
          deliveryKey,
          sha256(targetProof.trigger.triggerMessageId),
          async () => {
            await rereadAndAssertControl(options, controlProof, controlProofs);
            const snapshot =
              await options.adapter.readConversation("example-contact");
            if (!isComposerProvenEmpty(snapshot))
              throw new Error("INPUT_NOT_EMPTY");
            const addedIds = await options.messages.appendUnique(
              snapshot.messages,
            );
            const evaluated = await options.state.evaluateTargetReply({
              messages: snapshot.messages,
              addedIds,
              unreadIndicator: snapshot.unreadIndicator,
              controlCheckpoint: controlProof.checkpoint,
              expectedGateRevision: controlProof.gateRevision,
            });
            const latest = snapshot.messages.at(-1);
            if (
              evaluated.trigger?.triggerId !== targetProof.trigger.triggerId ||
              latest?.id !== targetProof.trigger.triggerMessageId ||
              latest.direction !== "incoming" ||
              !isComfortStationWakeRequest(latest.text)
            ) {
              throw new Error("TARGET_TRIGGER_CHANGED");
            }
            await assertBoundControlState(options, controlProof);
          },
        );
        if (!delivered) {
          await options.state.consumeTargetReplyTrigger(
            targetProof.trigger.triggerId,
          );
          controlProofs.delete(controlProof.capability);
          targetProofs.delete(targetProof.capability);
          return {
            status: "already-handled" as const,
            conversationId: "example-contact" as const,
          };
        }
        await options.state.consumeTargetReplyTrigger(
          targetProof.trigger.triggerId,
        );
        controlProofs.delete(controlProof.capability);
        targetProofs.delete(targetProof.capability);
        return {
          status: "verified" as const,
          conversationId: "example-contact" as const,
        };
      }),

    showComfortStationCardForReleaseAcceptance: () =>
      options.coordinator.runExclusive(async () => {
        if ((await options.aborts.get()) !== null)
          throw new Error("ABORT_INTENT_EXISTS");
        if ((await options.pending.get()) !== null)
          throw new Error("PENDING_SEND_EXISTS");
        const activationBindingSha256 = options.activationBindingSha256;
        if (
          activationBindingSha256 === undefined ||
          !/^[a-f0-9]{64}$/u.test(activationBindingSha256)
        ) {
          throw new Error("ACTIVATION_BINDING_REQUIRED");
        }
        assertSendGate(
          options.config,
          await readSendGate(authorityStore, activationBindingSha256),
        );
        const control = await options.state.getControlState();
        if (control.stopped) throw new Error("CONTROL_STOPPED");
        if (control.controlBoundary.status !== "active") {
          throw new Error("CONTROL_BOUNDARY_REQUIRED");
        }
        const deliveryKey = comfortStationReleaseAcceptanceDeliveryKey(
          activationBindingSha256,
          options.comfortStationCard.sha256,
        );
        const delivered = await deliverComfortStationCard(
          deliveryKey,
          sha256(
            `comfort-station-release-acceptance-trigger-v1\0${activationBindingSha256}`,
          ),
          async () => {
            const snapshot =
              await options.adapter.readConversation("example-contact");
            if (!isComposerProvenEmpty(snapshot))
              throw new Error("INPUT_NOT_EMPTY");
            await options.messages.appendUnique(snapshot.messages);
          },
        );
        return {
          status: delivered
            ? ("verified" as const)
            : ("already-handled" as const),
          conversationId: "example-contact" as const,
        };
      }),

    submitAuthorizedDraftForSupervisor: (
      candidateToken,
      controlProof,
      targetProof,
    ) =>
      options.coordinator.runExclusive(async () => {
        assertTargetControlBinding(targetProof, controlProof);
        const tokenHash = sha256(candidateToken);
        if (consumedSubmitTokens.has(tokenHash))
          throw new Error("SUBMIT_PROOF_CONSUMED");
        const candidate = await options.pending.get();
        const preparedBinding = preparedTargetTriggers.get(tokenHash);
        if (
          candidate === null ||
          candidate.tokenHash !== tokenHash ||
          candidate.conversationId !== "example-contact" ||
          candidate.draftVerifiedAt === null ||
          preparedBinding?.triggerId !== targetProof.trigger.triggerId ||
          preparedBinding.controlCapability !== controlProof.capability ||
          preparedBinding.targetCapability !== targetProof.capability
        ) {
          throw new Error("SUBMIT_PROOF_MISMATCH");
        }
        consumedSubmitTokens.add(tokenHash);
        let submitStarted = false;
        try {
          await rereadAndAssertBoundControl(options, controlProof);
          const snapshot = await options.adapter.readConversation("example-contact");
          const addedIds = await options.messages.appendUnique(
            snapshot.messages,
          );
          const evaluated = await options.state.evaluateTargetReply({
            messages: snapshot.messages,
            addedIds,
            unreadIndicator: snapshot.unreadIndicator,
            controlCheckpoint: controlProof.checkpoint,
            expectedGateRevision: controlProof.gateRevision,
          });
          if (
            evaluated.trigger?.triggerId !== targetProof.trigger.triggerId ||
            snapshot.messages.at(-1)?.id !==
              targetProof.trigger.triggerMessageId ||
            snapshot.messages.at(-1)?.direction !== "incoming"
          ) {
            throw new Error("TARGET_TRIGGER_CHANGED");
          }
          await assertBoundControlState(options, controlProof);
          submitStarted = true;
          await options.surface.submitDraft("example-contact", candidateToken);
          return {
            submitted: true as const,
            conversationId: "example-contact" as const,
          };
        } catch (error: unknown) {
          if (submitStarted) {
            await finalizeUncertainSendAttempt(
              options,
              candidate,
              preparedBinding.triggerId,
            );
            preparedTargetTriggers.delete(tokenHash);
            await options.audit.record({
              type: "live-send-uncertain",
              details: { conversationId: candidate.conversationId },
            });
          } else {
            await cancelPreparedDraft(options, candidate, candidateToken);
            preparedTargetTriggers.delete(tokenHash);
          }
          throw error;
        }
      }),

    abortPreparedDraftForSupervisor: (candidateToken) =>
      options.coordinator.runExclusive(async () => {
        const tokenHash = sha256(candidateToken);
        if (consumedSubmitTokens.has(tokenHash))
          throw new Error("SUBMIT_PROOF_CONSUMED");
        const candidate = await options.pending.get();
        if (
          candidate === null ||
          candidate.tokenHash !== tokenHash ||
          candidate.conversationId !== "example-contact" ||
          preparedTargetTriggers.get(tokenHash) === undefined
        ) {
          throw new Error("SUBMIT_PROOF_MISMATCH");
        }
        await cancelPreparedDraft(options, candidate, candidateToken);
        preparedTargetTriggers.delete(tokenHash);
        return {
          aborted: true as const,
          conversationId: "example-contact" as const,
        };
      }),

    readTargetConversationForAdvice: () =>
      options.coordinator.runExclusive(async () => {
        const snapshot =
          await options.adapter.readConversationForOwnerAdvice("example-contact");
        return {
          conversationId: "example-contact",
          messages: snapshot.messages,
          draftEmpty: isComposerProvenEmpty(snapshot),
        };
      }),

    prepareDraft: (conversationId, text) =>
      options.coordinator.runExclusive(async () => {
        if ((await options.aborts.get()) !== null)
          throw new Error("ABORT_INTENT_EXISTS");
        if ((await options.pending.get()) !== null)
          throw new Error("PENDING_SEND_EXISTS");
        if (conversationId === "example-contact") {
          assertSendGate(
            options.config,
            await readSendGate(authorityStore, options.activationBindingSha256),
          );
        }

        const initial = await options.adapter.readConversation(conversationId);
        return prepareDraftFromSnapshot(
          options,
          now,
          conversationId,
          text,
          initial,
        );
      }),

    verifyDraft: (candidateToken) =>
      options.coordinator.runExclusive(async () => {
        if ((await options.aborts.get()) !== null)
          throw new Error("ABORT_INTENT_EXISTS");
        const tokenHash = sha256(candidateToken);
        const candidate = await options.pending.get();
        if (candidate === null || candidate.tokenHash !== tokenHash) {
          throw new Error("PENDING_SEND_TOKEN_MISMATCH");
        }
        const snapshot = await options.adapter.readConversation(
          candidate.conversationId,
        );
        if (
          ![snapshot.draftText, ...(snapshot.draftAlternatives ?? [])].some(
            (draft) => sameDraft(draft, candidate.text),
          )
        ) {
          throw new Error("DRAFT_WRITE_NOT_VERIFIED");
        }
        await options.pending.markDraftVerified(tokenHash, now().toISOString());
        await options.audit.record({
          type: "live-draft-verified",
          details: {
            conversationId: candidate.conversationId,
            textHash: sha256(candidate.text),
          },
        });
        return {
          draftVerified: true,
          conversationId: candidate.conversationId,
          readyForComputerUseReturn: true,
        };
      }),

    abortDraft: (candidateToken) =>
      options.coordinator.runExclusive(async () => {
        const tokenHash = sha256(candidateToken);
        const existingIntent = await options.aborts.get();
        const candidate = await options.pending.get();
        let intent: AbortIntent;

        if (existingIntent === null) {
          if (candidate === null || candidate.tokenHash !== tokenHash) {
            throw new Error("PENDING_SEND_TOKEN_MISMATCH");
          }
          await assertAbortCandidateIsRecoverable(options, candidate);
          if (candidate.fingerprint !== null) {
            await options.state.assertOutgoingClaimed(candidate.fingerprint);
          }
          intent = createAbortIntent(candidate);
          await options.aborts.put(intent);
        } else {
          if (existingIntent.tokenHash !== tokenHash) {
            throw new Error("PENDING_SEND_TOKEN_MISMATCH");
          }
          intent = existingIntent;
          if (candidate !== null) {
            if (candidateIdentity(candidate) !== intent.candidateId) {
              throw new Error("ABORT_INTENT_CONFLICT");
            }
            await assertAbortCandidateIsRecoverable(options, candidate);
          } else {
            await assertComposerProvenEmpty(options, intent.conversationId);
          }
        }

        if (intent.fingerprint !== null) {
          await options.state.releaseOutgoingClaimForAbort(intent.fingerprint);
        }
        await options.pending.clearMatchingIfPresent(intent.tokenHash);
        await options.audit.recordOnce(intent.auditId, {
          type: "live-draft-aborted",
          details: {
            conversationId: intent.conversationId,
            textHash: intent.textHash,
          },
        });
        await options.aborts.clearMatching(intent.intentId);
        preparedTargetTriggers.delete(intent.tokenHash);
        return { aborted: true, conversationId: intent.conversationId };
      }),

    verifySend: (candidateToken) =>
      options.coordinator.runExclusive(async () => {
        if ((await options.aborts.get()) !== null)
          throw new Error("ABORT_INTENT_EXISTS");
        const tokenHash = sha256(candidateToken);
        const candidate = await options.pending.get();
        if (candidate === null || candidate.tokenHash !== tokenHash) {
          throw new Error("PENDING_SEND_TOKEN_MISMATCH");
        }
        if (candidate.draftVerifiedAt === null)
          throw new Error("DRAFT_NOT_VERIFIED");
        try {
          const snapshot = await options.adapter.readConversation(
            candidate.conversationId,
          );
          const sent = snapshot.messages.some(
            (message) =>
              message.direction === "outgoing" &&
              message.text === candidate.text &&
              !candidate.baselineMessageIds.includes(message.id),
          );
          if (!isComposerProvenEmpty(snapshot) || !sent) {
            throw new Error("SEND_RESULT_NOT_VERIFIED");
          }
          if (candidate.fingerprint !== null) {
            await options.state.markOutgoingVerified(candidate.fingerprint);
          }
          await options.messages.appendUnique(snapshot.messages);
          await options.audit.record({
            type: "live-send-verified",
            details: {
              conversationId: candidate.conversationId,
              textHash: sha256(candidate.text),
            },
          });
          const targetTrigger = preparedTargetTriggers.get(tokenHash);
          if (targetTrigger !== undefined) {
            await options.state.consumeTargetReplyTrigger(
              targetTrigger.triggerId,
            );
            preparedTargetTriggers.delete(tokenHash);
          }
          await options.pending.clearMatching(tokenHash);
          return {
            status: "verified",
            conversationId: candidate.conversationId,
          };
        } catch (error: unknown) {
          const targetTrigger = preparedTargetTriggers.get(tokenHash);
          await finalizeUncertainSendAttempt(
            options,
            candidate,
            targetTrigger?.triggerId,
          );
          preparedTargetTriggers.delete(tokenHash);
          await options.audit.record({
            type: "live-send-uncertain",
            details: { conversationId: candidate.conversationId },
          });
          throw error;
        }
      }),
  };
}

export function isComfortStationWakeRequest(text: string): boolean {
  const normalized = text.normalize("NFC").trim();
  return /^示例用户[。！!?？]?$/u.test(normalized);
}

function comfortStationDeliveryKey(
  incomingMessageId: string,
  cardSha256: string,
): string {
  return sha256(
    [
      "comfort-station-delivery-v1",
      "example-contact",
      incomingMessageId,
      cardSha256,
    ].join("\0"),
  );
}

export function comfortStationReleaseAcceptanceDeliveryKey(
  activationBindingSha256: string,
  cardSha256: string,
): string {
  if (
    !/^[a-f0-9]{64}$/u.test(activationBindingSha256) ||
    !/^[a-f0-9]{64}$/u.test(cardSha256)
  ) {
    throw new Error("COMFORT_STATION_RELEASE_ACCEPTANCE_IDENTITY_INVALID");
  }
  return sha256(
    [
      "comfort-station-release-acceptance-v1",
      activationBindingSha256,
      cardSha256,
    ].join("\0"),
  );
}

function requireLatestTargetMessage(
  latestMessage: ConversationSnapshot["messages"][number] | undefined,
  trigger: TargetReplyTrigger,
): ConversationSnapshot["messages"][number] {
  if (
    latestMessage === undefined ||
    latestMessage.id !== trigger.triggerMessageId ||
    latestMessage.direction !== "incoming"
  ) {
    throw new Error("TRAVEL_DEMO_TRIGGER_MISMATCH");
  }
  return latestMessage;
}

export async function readSendGate(
  store: EncryptedStore,
  expectedAcceptanceBindingSha256?: string,
): Promise<SendGateState> {
  const [consent, report] = await Promise.all([
    store.read("state/consent.enc", z.unknown()),
    store.read(
      "profiles/initialization-report.enc",
      initializationReportSchema,
    ),
  ]);
  const approved =
    report !== null &&
    report.approvedHash !== null &&
    report.approvedHash === report.hash;
  if (expectedAcceptanceBindingSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(expectedAcceptanceBindingSha256)) {
      throw new Error("ACCEPTANCE_RELEASE_BINDING_INVALID");
    }
    const parsed = runtimeConsentSchema.safeParse(consent);
    return {
      consentConfirmed:
        parsed.success &&
        approved &&
        parsed.data.reportHash === report.hash &&
        parsed.data.acceptanceBindingSha256 === expectedAcceptanceBindingSha256,
      initializationReportApproved: approved,
    };
  }
  return {
    consentConfirmed: isPlainLegacyConsent(consent),
    initializationReportApproved: approved,
  };
}

function isPlainLegacyConsent(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { consentConfirmed?: unknown }).consentConfirmed === true
  );
}

async function readConversationWithinOperation(
  options: LiveWechatRuntimeOptions,
  conversationId: ConversationId,
  expectedGate?: PersistentStopGate,
): Promise<{
  conversationId: ConversationId;
  control: unknown;
  addedIds: string[];
  messages: ConversationSnapshot["messages"];
  draftEmpty: boolean;
  replyDecision?: Awaited<
    ReturnType<StateRepository["evaluateTargetReply"]>
  >["decision"];
}> {
  if (conversationId === "file-transfer") {
    const read = await options.adapter.readControlConversation();
    const addedIds = await options.messages.appendUnique(
      read.snapshot.messages,
    );
    await options.audit.record({
      type: "live-conversation-read",
      details: {
        conversationId,
        addedCount: addedIds.length,
        control: read.control?.command ?? null,
      },
    });
    return {
      conversationId,
      control: read.control,
      addedIds,
      messages: read.snapshot.messages,
      draftEmpty: isComposerProvenEmpty(read.snapshot),
    };
  }

  const snapshot = await options.adapter.readConversation(conversationId);
  const addedIds = await options.messages.appendUnique(snapshot.messages);
  const gate = expectedGate ?? (await options.state.getPersistentStopGate());
  const evaluated = await options.state.evaluateTargetReply({
    messages: snapshot.messages,
    addedIds,
    unreadIndicator: snapshot.unreadIndicator,
    controlCheckpoint: gate.checkpoint,
    expectedGateRevision: gate.gateRevision,
  });
  await options.audit.record({
    type: "live-conversation-read",
    details: {
      conversationId,
      addedCount: addedIds.length,
      control: null,
      replyDecision: evaluated.decision.reason,
    },
  });
  return {
    conversationId,
    control: null,
    addedIds,
    messages: snapshot.messages,
    draftEmpty: isComposerProvenEmpty(snapshot),
    replyDecision: evaluated.decision,
  };
}

async function prepareDraftFromSnapshot(
  options: LiveWechatRuntimeOptions,
  now: () => Date,
  conversationId: ConversationId,
  text: string,
  initial: ConversationSnapshot,
  expectedGate?: PersistentStopGate,
): Promise<{
  candidateToken: string;
  prepared: true;
  conversationId: ConversationId;
  draftVerified: false;
}> {
  if (!isComposerProvenEmpty(initial)) throw new Error("INPUT_NOT_EMPTY");
  if (hasExactOutgoing(initial, text))
    throw new Error("VISIBLE_DUPLICATE_REPLY");

  const fingerprint =
    conversationId === "example-contact"
      ? fingerprintReply(conversationId, text)
      : null;
  if (
    fingerprint !== null &&
    !(await options.state.claimOutgoing(fingerprint, expectedGate))
  ) {
    throw new Error("DUPLICATE_REPLY");
  }

  const candidateToken = randomBytes(32).toString("hex");
  const tokenHash = sha256(candidateToken);
  let pendingCreated = false;
  try {
    await options.surface.focusConversation(
      conversationId,
      initial.windowRevision,
    );
    await options.pending.put({
      conversationId,
      text,
      tokenHash,
      fingerprint,
      baselineMessageIds: initial.messages.map((message) => message.id),
      createdAt: now().toISOString(),
      draftVerifiedAt: null,
    });
    pendingCreated = true;
    await options.audit.record({
      type: "live-draft-prepared",
      details: { conversationId, textHash: sha256(text) },
    });
    return {
      candidateToken,
      prepared: true,
      conversationId,
      draftVerified: false,
    };
  } catch (error: unknown) {
    const cleanupFailures: unknown[] = [];
    if (pendingCreated) {
      await options.pending
        .clearMatching(tokenHash)
        .catch((cleanupError: unknown) => {
          cleanupFailures.push(cleanupError);
        });
    }
    if (fingerprint !== null) {
      await options.state
        .releaseOutgoingClaim(fingerprint)
        .catch((cleanupError: unknown) => {
          cleanupFailures.push(cleanupError);
        });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "DRAFT_PREPARATION_CLEANUP_FAILED",
      );
    }
    throw error;
  }
}

function createControlProof(
  checkpoint: ControlBoundaryCheckpoint,
  gateRevision: string,
  verification: SupervisorControlProof["verification"],
  proofRegistry: Map<string, string>,
): SupervisorControlProof {
  const capability = randomBytes(32).toString("hex");
  const proof = { capability, checkpoint, verification, gateRevision };
  proofRegistry.set(capability, controlProofIdentity(proof));
  return proof;
}

function createTargetProof(
  trigger: TargetReplyTrigger,
  comfortStationRequested: boolean,
  proofRegistry: Map<string, string>,
): SupervisorTargetProof {
  const capability = randomBytes(32).toString("hex");
  const proof = { capability, trigger, comfortStationRequested };
  proofRegistry.set(capability, targetProofIdentity(proof));
  return proof;
}

function assertTargetProof(
  proof: SupervisorTargetProof,
  proofRegistry: Map<string, string>,
): void {
  if (proofRegistry.get(proof.capability) !== targetProofIdentity(proof)) {
    throw new Error("TARGET_PROOF_MISMATCH");
  }
}

function targetProofIdentity(proof: SupervisorTargetProof): string {
  return `${proof.trigger.triggerId}\0${proof.comfortStationRequested ? "wake" : "ordinary"}`;
}

function assertTargetControlBinding(
  targetProof: SupervisorTargetProof,
  controlProof: SupervisorControlProof,
): void {
  if (
    targetProof.trigger.gateRevision !== controlProof.gateRevision ||
    checkpointIdentity(targetProof.trigger.controlCheckpoint) !==
      checkpointIdentity(controlProof.checkpoint)
  ) {
    throw new Error("TARGET_PROOF_CONTROL_MISMATCH");
  }
}

async function assertCurrentControlProof(
  options: LiveWechatRuntimeOptions,
  proof: SupervisorControlProof,
  proofRegistry: Map<string, string>,
): Promise<void> {
  if (proofRegistry.get(proof.capability) !== controlProofIdentity(proof)) {
    throw new Error("CONTROL_PROOF_MISMATCH");
  }
  await assertBoundControlState(options, proof);
}

async function assertBoundControlState(
  options: LiveWechatRuntimeOptions,
  proof: SupervisorControlProof,
): Promise<void> {
  await options.state.assertPersistentStopGate({
    checkpoint: proof.checkpoint,
    gateRevision: proof.gateRevision,
  });
}

async function rereadAndAssertControl(
  options: LiveWechatRuntimeOptions,
  proof: SupervisorControlProof,
  proofRegistry: Map<string, string>,
): Promise<void> {
  await assertCurrentControlProof(options, proof, proofRegistry);
  if (proof.verification === "ui-observed") {
    await rereadAndCompareControl(options, proof.checkpoint);
  }
}

async function rereadAndAssertBoundControl(
  options: LiveWechatRuntimeOptions,
  proof: SupervisorControlProof,
): Promise<void> {
  await assertBoundControlState(options, proof);
  if (proof.verification === "ui-observed") {
    await rereadAndCompareControl(options, proof.checkpoint);
  }
}

function controlProofIdentity(proof: SupervisorControlProof): string {
  return [
    checkpointIdentity(proof.checkpoint),
    proof.verification,
    proof.gateRevision,
  ].join("\0");
}

async function rereadAndCompareControl(
  options: LiveWechatRuntimeOptions,
  checkpoint: ControlBoundaryCheckpoint,
): Promise<void> {
  let read: Awaited<
    ReturnType<LiveWechatRuntimeOptions["adapter"]["readControlConversation"]>
  >;
  try {
    read = await options.adapter.readControlConversation();
  } catch {
    throw new Error("CONTROL_CHANGED");
  }
  await options.messages.appendUnique(read.snapshot.messages);
  const control = await options.state.getControlState();
  if (
    read.control !== null ||
    control.stopped ||
    checkpointIdentity(read.controlCheckpoint) !==
      checkpointIdentity(checkpoint)
  ) {
    throw new Error("CONTROL_CHANGED");
  }
}

async function cancelPreparedDraft(
  options: LiveWechatRuntimeOptions,
  candidate: PendingSend,
  candidateToken: string,
): Promise<void> {
  await options.surface.clearDraft(candidate.conversationId, candidateToken);
  const snapshot =
    candidate.conversationId === "example-contact"
      ? await options.adapter.readConversationForOwnerAdvice(
          candidate.conversationId,
        )
      : await options.adapter.readConversation(candidate.conversationId);
  if (!isComposerProvenEmpty(snapshot))
    throw new Error("DRAFT_CLEAR_NOT_VERIFIED");
  await options.pending.clearMatching(candidate.tokenHash);
  if (candidate.fingerprint !== null) {
    await options.state.releaseOutgoingClaimForAbort(candidate.fingerprint);
  }
}

async function clearUnsentBoundaryCandidate(
  options: LiveWechatRuntimeOptions,
  tokenHash: string,
  candidateToken: string,
): Promise<void> {
  await options.surface.clearDraft("file-transfer", candidateToken);
  const cleared = await options.adapter.readConversation("file-transfer");
  if (!isComposerProvenEmpty(cleared))
    throw new Error("DRAFT_CLEAR_NOT_VERIFIED");
  await options.pending.clearMatchingIfPresent(tokenHash);
}

async function clearRecoveredBoundaryCandidate(
  options: LiveWechatRuntimeOptions,
  candidate: PendingSend,
  snapshot: ConversationSnapshot,
): Promise<void> {
  if (!isComposerProvenEmpty(snapshot)) {
    await options.surface.clearDraft(
      "file-transfer",
      randomBytes(32).toString("hex"),
    );
    const cleared = await options.adapter.readConversation("file-transfer");
    if (!isComposerProvenEmpty(cleared))
      throw new Error("DRAFT_CLEAR_NOT_VERIFIED");
  }
  await options.pending.clearMatching(candidate.tokenHash);
}

function isBoundaryCandidate(
  candidate: PendingSend,
  markerText: string,
): boolean {
  return (
    candidate.conversationId === "file-transfer" &&
    candidate.text === markerText &&
    candidate.fingerprint === null
  );
}

function countBoundaryOccurrences(
  snapshot: ConversationSnapshot,
  boundaryMessageId: string,
): number {
  return snapshot.messages.filter((message) => message.id === boundaryMessageId)
    .length;
}

function activeBoundaryProof(boundary: {
  status: "active";
  epoch: string;
  boundaryMessageId: string;
  consumedCount: number;
  prefixChainHash: string;
}): {
  status: "active";
  epoch: string;
  boundaryMessageId: string;
  consumedCount: number;
  prefixChainHash: string;
  markerOccurrenceCount: 1;
} {
  return {
    status: "active",
    epoch: boundary.epoch,
    boundaryMessageId: boundary.boundaryMessageId,
    consumedCount: boundary.consumedCount,
    prefixChainHash: boundary.prefixChainHash,
    markerOccurrenceCount: 1,
  };
}

function checkpointIdentity(checkpoint: ControlBoundaryCheckpoint): string {
  return [
    checkpoint.epoch,
    checkpoint.boundaryMessageId,
    String(checkpoint.consumedCount),
    checkpoint.prefixChainHash,
  ].join("\0");
}

async function finalizeUncertainSendAttempt(
  options: LiveWechatRuntimeOptions,
  candidate: PendingSend,
  targetTriggerId?: string,
): Promise<void> {
  if (candidate.fingerprint !== null) {
    await options.state
      .markOutgoingUncertain(candidate.fingerprint)
      .catch(() => undefined);
  }
  if (targetTriggerId !== undefined) {
    await options.state.consumeTargetReplyTrigger(targetTriggerId);
  }
  await options.pending.clearMatchingIfPresent(candidate.tokenHash);
}

async function recoverTerminalUncertainPending(
  options: LiveWechatRuntimeOptions,
): Promise<{
  control: Awaited<ReturnType<StateRepository["getControlState"]>>;
  candidate: PendingSend | null;
}> {
  const control = await options.state.getControlState();
  const candidate = await options.pending.get();
  if (
    candidate === null ||
    candidate.fingerprint === null ||
    candidate.draftVerifiedAt === null ||
    control.stopped ||
    control.outgoing[candidate.fingerprint]?.status !== "uncertain"
  ) {
    return { control, candidate };
  }
  if (candidate.conversationId === "example-contact") {
    const target = await options.state.getTargetReplyState();
    const trigger = target.pendingTrigger;
    if (
      trigger !== null &&
      candidate.baselineMessageIds.at(-1) === trigger.triggerMessageId
    ) {
      await options.state.consumeTargetReplyTrigger(trigger.triggerId);
    }
  }
  await options.pending.clearMatchingIfPresent(candidate.tokenHash);
  return { control, candidate: null };
}

async function assertAbortCandidateIsRecoverable(
  options: LiveWechatRuntimeOptions,
  candidate: PendingSend,
): Promise<void> {
  if (candidate.draftVerifiedAt !== null) {
    throw new Error("DRAFT_ALREADY_VERIFIED");
  }
  await assertComposerProvenEmpty(options, candidate.conversationId);
}

async function assertComposerProvenEmpty(
  options: LiveWechatRuntimeOptions,
  conversationId: ConversationId,
): Promise<void> {
  const snapshot = await options.adapter.readConversation(conversationId);
  if (!isComposerProvenEmpty(snapshot)) {
    throw new Error("DRAFT_NOT_EMPTY_OR_UNKNOWN");
  }
}

function createAbortIntent(candidate: PendingSend): AbortIntent {
  const candidateId = candidateIdentity(candidate);
  const intentId = sha256(`live-draft-abort-intent-v1\0${candidateId}`);
  return {
    intentId,
    candidateId,
    tokenHash: candidate.tokenHash,
    conversationId: candidate.conversationId,
    fingerprint: candidate.fingerprint,
    textHash: sha256(candidate.text),
    auditId: deterministicUuid(`live-draft-abort-audit-v1\0${intentId}`),
  };
}

function candidateIdentity(candidate: PendingSend): string {
  return sha256(
    [
      "live-draft-abort-candidate-v1",
      candidate.tokenHash,
      candidate.conversationId,
      candidate.fingerprint ?? "",
      sha256(candidate.text),
      candidate.createdAt,
      candidate.draftVerifiedAt ?? "",
      ...candidate.baselineMessageIds,
    ].join("\0"),
  );
}

function deterministicUuid(value: string): string {
  const digest = sha256(value);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function hasExactOutgoing(
  snapshot: ConversationSnapshot,
  text: string,
): boolean {
  return snapshot.messages.some(
    (message) => message.direction === "outgoing" && message.text === text,
  );
}

function isComposerProvenEmpty(snapshot: ConversationSnapshot): boolean {
  return (
    snapshot.composerEvidence === "proven-empty" &&
    snapshot.draftText.length === 0 &&
    (snapshot.draftAlternatives?.every((draft) => draft.length === 0) ?? true)
  );
}

function sameDraft(actual: string, expected: string): boolean {
  return (
    actual.replace(/\s+/gu, "").replace(/[|｜]$/u, "") ===
    expected.replace(/\s+/gu, "")
  );
}

function withAssistantSignature(text: string): string {
  const currentSuffix = `\n${ASSISTANT_SIGNATURE}`;
  if (text.endsWith(currentSuffix)) {
    const body = text.slice(0, -currentSuffix.length);
    if (!ALL_ASSISTANT_SIGNATURES.some((signature) => body.includes(signature)))
      return text;
    throw new Error("AUTOMATIC_REPLY_SIGNATURE_INVALID");
  }
  if (ALL_ASSISTANT_SIGNATURES.some((signature) => text.includes(signature))) {
    throw new Error("AUTOMATIC_REPLY_SIGNATURE_INVALID");
  }
  return `${text}\n${ASSISTANT_SIGNATURE}`;
}

function fingerprintReply(
  conversationId: ConversationId,
  text: string,
): string {
  return sha256(`${conversationId}\0${text}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
