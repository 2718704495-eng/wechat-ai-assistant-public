import {
  RealtimeReplyService,
  type RealtimeRecoveryReceipt,
  type RealtimeReplyServiceOptions,
  type RealtimeTickReceipt,
} from "../conversation/realtime-reply-service.js";
import { ContactDirectory } from "../contacts/contact-directory.js";
import { ContactRegistryRepository } from "../contacts/contact-registry-repository.js";
import { NativeConversationListDetector } from "../conversation/native-conversation-list-detector.js";
import { NativeOcrInboundSource } from "../conversation/native-ocr-inbound-source.js";
import {
  OfflinePersonalAccountCoordinator,
  type ConversationEngine,
} from "../conversation/personal-account-contract.js";
import { createMcpContactReplyDelivery } from "../mcp/live-runtime.js";
import { ContactCandidateRepository } from "../storage/contact-candidate-repository.js";
import { InboundCursorRepository } from "../storage/inbound-cursor-repository.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";
import {
  RealtimeReplyRepository,
  type RealtimeReplyStateRepository,
} from "../storage/repositories.js";
import { WechatIdentityEnrollmentRepository } from "../storage/wechat-identity-enrollment-repository.js";
import type {
  ProductionScheduledRuntime,
  ScheduledCycleGate,
  SingleSchedulerOptions,
} from "./single-scheduler.js";
import type { SingleScheduler } from "./single-scheduler.js";
import type { ConversationListSnapshotReader } from "../conversation/native-conversation-list-detector.js";

export interface RealtimeReplyMain {
  readonly service: RealtimeReplyService;
  start(): Promise<void>;
  stop(): Promise<void>;
  tickOnce(now: Date): Promise<RealtimeTickReceipt>;
  recoverPending(now: Date): Promise<readonly RealtimeRecoveryReceipt[]>;
}

export interface ProductionRealtimeReplyMain {
  readonly cycleGate: ScheduledCycleGate;
  start(): Promise<void>;
  stop(): Promise<void>;
  tickOnce(now: Date): Promise<RealtimeTickReceipt>;
  recoverPending(now: Date): Promise<readonly RealtimeRecoveryReceipt[]>;
  hasPendingWork(): Promise<boolean>;
  hasRecentConversation(now: Date, windowMs: number): Promise<boolean>;
  isDispatcherQuarantined(): boolean;
  createScheduler(options: Omit<SingleSchedulerOptions, "admission">): SingleScheduler;
}

export interface ProductionRealtimeReplyMainOptions {
  readonly store: EncryptedStore;
  readonly repository?: RealtimeReplyStateRepository;
  readonly conversationListReader?: ConversationListSnapshotReader;
  readonly createSource?: (
    target: Awaited<
      ReturnType<ContactDirectory["requireActiveAutoReplyTarget"]>
    >,
    directory: ContactDirectory,
    cursorRepository: InboundCursorRepository,
  ) => NativeOcrInboundSource;
  readonly createEngine: (
    target: Awaited<
      ReturnType<ContactDirectory["requireActiveAutoReplyTarget"]>
    >,
    directory: ContactDirectory,
  ) => ConversationEngine | Promise<ConversationEngine>;
  readonly createScheduledRuntime: (
    directory: ContactDirectory,
    repository: RealtimeReplyStateRepository,
  ) => ProductionScheduledRuntime;
  readonly sourceEpoch: string;
  readonly sessionId: string;
  readonly pollIntervalMs?: 3_000 | 4_000 | 5_000;
  readonly bufferWindowMs?: number;
  readonly now?: () => Date;
  readonly createNativeContext?: (
    directory: ContactDirectory,
    cursorRepository: InboundCursorRepository,
  ) => {
    readonly conversationListReader: ConversationListSnapshotReader;
    readonly createSource: NonNullable<
      ProductionRealtimeReplyMainOptions["createSource"]
    >;
  };
}

/**
 * Offline-only composition entry. Construction performs no timer, native UI,
 * model, network, automation, or send operation; callers must explicitly start.
 */
export function createRealtimeReplyMain(
  options: RealtimeReplyServiceOptions,
): RealtimeReplyMain {
  const service = new RealtimeReplyService(options);
  return Object.freeze({
    service,
    start: () => service.start(),
    stop: () => service.stop(),
    tickOnce: (now: Date) => service.tickOnce(now),
    recoverPending: (now: Date) => service.recoverPending(now),
  });
}

/**
 * Production composition root. It only constructs dependency objects: it does
 * not read the keychain, acquire UI, start timers, invoke a model, or submit.
 */
export function createProductionRealtimeReplyMain(
  options: ProductionRealtimeReplyMainOptions,
): ProductionRealtimeReplyMain {
  const registry = new ContactRegistryRepository(options.store);
  const enrollments = new WechatIdentityEnrollmentRepository(options.store);
  const directory = new ContactDirectory(registry, enrollments);
  const repository =
    options.repository ?? new RealtimeReplyRepository(options.store);
  const cursorRepository = new InboundCursorRepository(options.store);
  const native = options.createNativeContext?.(directory, cursorRepository);
  const conversationListReader =
    native?.conversationListReader ?? options.conversationListReader;
  const createSource = native?.createSource ?? options.createSource;
  if (conversationListReader === undefined || createSource === undefined) {
    throw new Error("REALTIME_PRODUCTION_NATIVE_CONTEXT_REQUIRED");
  }
  const scheduledRuntime = options.createScheduledRuntime(directory, repository);
  const candidates = new ContactCandidateRepository(options.store, options.now);
  const detector = new NativeConversationListDetector({
    directory,
    candidates,
    reader: conversationListReader,
    now: options.now,
  });
  const service = new RealtimeReplyService({
    pollIntervalMs: options.pollIntervalMs,
    bufferWindowMs: options.bufferWindowMs ?? 2_000,
    detector,
    directory,
    repository,
    admission: scheduledRuntime.realtimeControl,
    delivery: createMcpContactReplyDelivery(directory, scheduledRuntime.delivery),
    now: options.now,
    createSource: (target) => createSource(target, directory, cursorRepository),
    createCoordinator: async (target) =>
      OfflinePersonalAccountCoordinator.create({
        directory,
        contactId: target.contactId,
        expectedRevision: target.revision,
        engine: await options.createEngine(target, directory),
        source: "native-ocr",
        sourceEpoch: options.sourceEpoch,
        sessionId: options.sessionId,
      }),
  });
  return Object.freeze({
    cycleGate: scheduledRuntime.cycleGate,
    start: () => service.start(),
    stop: () => service.stop(),
    tickOnce: (now: Date) => service.tickOnce(now),
    recoverPending: (now: Date) => service.recoverPending(now),
    hasPendingWork: () => repository.hasPendingWork(),
    hasRecentConversation: (now: Date, windowMs: number) =>
      repository.hasRecentConversation(now, windowMs),
    isDispatcherQuarantined: () =>
      scheduledRuntime.realtimeControl.isQuarantined(),
    createScheduler: (
      schedulerOptions: Omit<SingleSchedulerOptions, "admission">,
    ) => scheduledRuntime.createScheduler(schedulerOptions),
  });
}
