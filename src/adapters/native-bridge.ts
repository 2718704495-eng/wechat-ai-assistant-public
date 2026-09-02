import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  defaultNativeTextTargetCapabilityKeyProvider,
  verifyNativeTextTargetCapability,
  type NativeTextTargetCapabilityV2,
} from "../security/native-capability-mac.js";
import type { KeyProvider } from "../security/keychain.js";
import type { WechatIdentityEnrollment } from "../storage/wechat-identity-enrollment-repository.js";

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

const windowDescriptorSchema = z.object({
  windowID: z.number().int().nonnegative(),
  processID: z.number().int(),
  bundleID: z.string().min(1),
  title: z.string(),
  ownerName: z.string(),
  bounds: boundsSchema,
});

const ocrLineSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  bounds: boundsSchema,
  alternatives: z.array(z.string()).optional(),
});

const permissionReportSchema = z.object({
  accessibility: z.boolean(),
  screenRecording: z.boolean(),
});

const captureResultSchema = z.object({ output: z.string().min(1) });
const successSchema = z.object({ ok: z.literal(true) });
const focusedTextSchema = z.object({ text: z.string() });
const composerMutationReceiptSchema = z.object({
  text: z.string(),
  cleared: z.boolean(),
});
const imageAttachmentReceiptSchema = z.object({
  imageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  width: z.literal(1080),
  height: z.literal(1350),
  attachmentCount: z.literal(1),
  textEmpty: z.literal(true),
});
const imageSendReceiptSchema = imageAttachmentReceiptSchema.extend({
  submitted: z.literal(true),
  outgoingImageMatched: z.literal(true),
  visualFingerprintVersion: z.literal("vision-featureprint-v1"),
});
const imageQuarantineRecoveryReceiptSchema = z
  .object({
    status: z.enum(["recovered", "already-clean"]),
    archiveName: z.union([
      z.literal(""),
      z.string().regex(/^dirty-archive-[a-f0-9]{64}$/u),
    ]),
    composerEmpty: z.literal(true),
  })
  .superRefine((value, context) => {
    if ((value.status === "recovered") !== (value.archiveName !== "")) {
      context.addIssue({
        code: "custom",
        message: "IMAGE_QUARANTINE_RECEIPT_INVALID",
      });
    }
  });
const identityMatchEvidenceSchema = z
  .object({
    normalizedY: z.number().min(0).max(1),
    distance: z.number().nonnegative(),
    observedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    fingerprintVersion: z.string().min(1).max(64),
  })
  .strict();
const identityMatchSchema = z.discriminatedUnion("proofPhase", [
  identityMatchEvidenceSchema
    .extend({
      proofPhase: z.literal("pre-click"),
      selected: z.literal(false),
      selectedRowTitle: z.null(),
      selectedRowNormalizedY: z.null(),
      selectionProofHash: z.null(),
    })
    .strict(),
  identityMatchEvidenceSchema
    .extend({
      proofPhase: z.literal("selected"),
      selected: z.literal(true),
      selectedRowTitle: z.string().trim().min(1).max(64),
      selectedRowNormalizedY: z.number().min(0).max(1),
      selectionProofHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
]);
const identityCaptureReceiptSchema = z
  .object({
    fingerprintVersion: z.literal("vision-featureprint-v1"),
    windowRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    leftPaneProofHash: z.string().regex(/^[a-f0-9]{64}$/u),
    headerProofHash: z.string().regex(/^[a-f0-9]{64}$/u),
    referenceSamples: z.array(z.string().min(4).max(32_768)).min(3).max(5),
    observedFingerprints: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .min(3)
      .max(5),
    maximumPairwiseDistance: z.number().min(0).max(0.18),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.referenceSamples.length !== value.observedFingerprints.length) {
      context.addIssue({
        code: "custom",
        message: "WECHAT_IDENTITY_CAPTURE_RECEIPT_INVALID",
      });
    }
    const decoded = value.referenceSamples.map((sample) =>
      Buffer.from(sample, "base64"),
    );
    if (
      decoded.some(
        (sample, index) =>
          sample.length < 32 ||
          sample.length > 24_576 ||
          sample.subarray(0, 8).toString("ascii") !== "bplist00" ||
          sample.toString("base64") !== value.referenceSamples[index],
      ) ||
      new Set(decoded.map(({ length }) => length)).size !== 1
    ) {
      context.addIssue({
        code: "custom",
        message: "WECHAT_IDENTITY_CAPTURE_RECEIPT_INVALID",
      });
    }
  });
const MAX_SENSITIVE_REQUEST_BYTES = 64 * 1024;
const MAX_SENSITIVE_RESPONSE_BYTES = 64 * 1024;
const MAX_IDENTITY_CAPTURE_RESPONSE_BYTES = 192 * 1024;
const MAX_DYNAMIC_CAPABILITY_RESERVATIONS = 1_024;
const DYNAMIC_PENDING_TTL_MS = 180_000;
const requestBindingDomain = "wechat-native-request-binding-v1";

export type WindowDescriptor = z.infer<typeof windowDescriptorSchema>;
export type OCRLine = z.infer<typeof ocrLineSchema>;
export type PermissionReport = z.infer<typeof permissionReportSchema>;
export type WechatComposerMutationReceipt = z.infer<
  typeof composerMutationReceiptSchema
>;
export type WechatImageAttachmentReceipt = z.infer<
  typeof imageAttachmentReceiptSchema
>;
export type WechatImageSendReceipt = z.infer<typeof imageSendReceiptSchema>;
export type WechatImageQuarantineRecoveryReceipt = z.infer<
  typeof imageQuarantineRecoveryReceiptSchema
>;

export interface NativeBridgeOptions {
  executablePath: string;
  baseArguments?: string[];
  dataDir: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  nativeCapabilityKeyProvider?: KeyProvider;
}

export interface ReadOnlyScrollRequest {
  windowID: number;
  bundleID: string;
  title: string;
  deltaY: number;
}

export interface ReadOnlyScrollbarDragRequest {
  windowID: number;
  bundleID: string;
  title: string;
  fromY: number;
  toY: number;
}

export interface WechatWindowClickRequest {
  windowID: number;
  bundleID: string;
  title: string;
  region: "conversation-list" | "composer";
  normalizedX: number;
  normalizedY: number;
  token: string;
  conversationTitle?: string;
  slotKey?: string;
  capability?: WechatMutationCapability;
}

export type WechatMutationAction =
  | "select-conversation"
  | "focus-composer"
  | "replace-draft"
  | "clear-draft"
  | "attach-image"
  | "send-image";

export interface WechatMutationCapabilityV1 {
  version: 1;
  capabilityId: string;
  action: WechatMutationAction;
  candidateHash: string;
  slotHash: string;
  identityFingerprint: string;
  windowRevision: string;
  expiresAt: string;
}

export type WechatMutationCapability =
  WechatMutationCapabilityV1 | NativeTextTargetCapabilityV2;

export interface WechatTextMutationRequest {
  windowID: number;
  bundleID: "com.tencent.xinWeChat";
  title: "微信";
  conversationTitle: string;
  token: string;
  slotKey: string;
  text: string;
  capability: WechatMutationCapability;
}

export interface WechatImageAttachmentRequest {
  windowID: number;
  bundleID: "com.tencent.xinWeChat";
  title: "微信";
  conversationTitle: "文件传输助手";
  token: string;
  slotKey: string;
  imagePath: string;
  imageSha256: string;
  width: 1080;
  height: 1350;
  capability: WechatMutationCapabilityV1;
}

export interface WechatImageSendRequest {
  windowID: number;
  bundleID: "com.tencent.xinWeChat";
  title: "微信";
  conversationTitle: "示例联系人";
  token: string;
  slotKey: string;
  imagePath: string;
  imageSha256: string;
  width: 1080;
  height: 1350;
  capability: WechatMutationCapabilityV1;
}

export interface WechatImageQuarantineRecoveryRequest {
  windowID: number;
  bundleID: "com.tencent.xinWeChat";
  title: "微信";
  conversationTitle: "示例联系人";
}

export interface WechatDraftSubmitRequest {
  windowID: number;
  bundleID: string;
  title: string;
  conversationTitle: string;
  token: string;
  slotKey?: string;
  draftText?: string;
  identityEnrollment?: WechatIdentityEnrollment;
  conversationProof?: NativeSubmitConversationProof;
  capability?:
    | WechatWriteCapability
    | NativeTextTargetCapabilityV2
    | BoundNativeTextTargetCapabilityV2;
}

export interface NativeSubmitConversationProof {
  readonly version: 1;
  readonly latestMessageId: string;
  readonly latestTextHash: string;
  readonly latestDirection: "incoming";
  readonly controlRevision: string;
}

export interface NativeDraftSubmitControl {
  readonly signal: AbortSignal;
  readonly markSubmitStarted: () => Promise<boolean>;
}

export interface BoundNativeTextTargetCapabilityV2
  extends NativeTextTargetCapabilityV2 {
  readonly requestBindingMac: string;
}

export async function bindNativeTextTargetRequest(input: {
  readonly capability: NativeTextTargetCapabilityV2;
  readonly windowID: number;
  readonly bundleID: "com.tencent.xinWeChat";
  readonly title: "微信";
  readonly conversationTitle: string;
  readonly token: string;
  readonly slotKey: string;
  readonly draftText: string;
  readonly conversationProof: NativeSubmitConversationProof;
  readonly keyProvider: KeyProvider;
}): Promise<BoundNativeTextTargetCapabilityV2> {
  const key = await input.keyProvider.getOrCreate();
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
  }
  return Object.freeze({
    ...input.capability,
    requestBindingMac: createHmac("sha256", key)
      .update(canonicalNativeRequestBinding(input))
      .digest("hex"),
  });
}

export interface WechatDraftSubmitReceipt {
  readonly attempted: boolean;
}

export interface WechatWriteCapability {
  version: 1;
  capabilityId: string;
  candidateHash: string;
  slotHash: string;
  identityFingerprint: string;
  windowRevision: string;
  expiresAt: string;
}

export interface WechatIdentityMatchRequest {
  windowID: number;
  bundleID: string;
  title: string;
  conversationTitle: string;
  proofPhase?: "pre-click" | "selected";
  enrollment: WechatIdentityEnrollment;
}

export interface WechatIdentityCaptureRequest {
  windowID: number;
  bundleID: "com.tencent.xinWeChat";
  title: "微信";
  conversationTitle: string;
  expectedPreviewHash: string;
  expectedWindowRevision: string;
  sampleCount: 3 | 4 | 5;
}

export type WechatIdentityMatch = z.infer<typeof identityMatchSchema>;
export type WechatIdentityCaptureReceipt = z.infer<
  typeof identityCaptureReceiptSchema
>;

export class NativeBridge {
  private readonly executablePath: string;
  private readonly baseArguments: string[];
  private readonly tempDir: string;
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly nativeCapabilityKeyProvider: KeyProvider;
  private readonly usedCapabilityIds = new Set<string>();
  private readonly dynamicCapabilityReservations = new Map<
    string,
    { readonly state: "pending" | "consumed"; readonly cleanupAt: number }
  >();

  public constructor(options: NativeBridgeOptions) {
    this.executablePath = options.executablePath;
    this.baseArguments = options.baseArguments ?? [];
    this.tempDir = path.resolve(options.dataDir, "temp");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.environment = options.environment ?? process.env;
    this.nativeCapabilityKeyProvider =
      options.nativeCapabilityKeyProvider ??
      defaultNativeTextTargetCapabilityKeyProvider;
  }

  public listWindows(bundleID: string): Promise<WindowDescriptor[]> {
    return this.run(
      "list-windows",
      ["--bundle-id", bundleID],
      z.array(windowDescriptorSchema),
    );
  }

  public async capture(windowID: number): Promise<string> {
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    const output = path.join(this.tempDir, `${randomUUID()}.png`);
    const result = await this.run(
      "capture",
      ["--window-id", String(windowID), "--output", output],
      captureResultSchema,
    );
    if (path.resolve(result.output) !== output) {
      throw new Error("UNEXPECTED_CAPTURE_PATH");
    }
    return this.validateTempPath(output);
  }

  public async ocr(imagePath: string): Promise<OCRLine[]> {
    const validatedPath = await this.validateTempPath(imagePath);
    try {
      return await this.run(
        "ocr",
        ["--input", validatedPath],
        z.array(ocrLineSchema),
      );
    } finally {
      await unlink(validatedPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }

  public async focus(windowID: number): Promise<void> {
    await this.run("focus", ["--window-id", String(windowID)], successSchema);
  }

  public async typeText(
    request: WechatTextMutationRequest,
  ): Promise<WechatComposerMutationReceipt> {
    assertMutationRequest(request, request?.capability?.action);
    const capability = request.capability;
    if (isNativeTextTargetCapability(capability)) {
      if (
        capability.action !== "replace-draft" &&
        capability.action !== "clear-draft"
      ) {
        throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
      }
      const payload = {
        ...request,
        capability: nativeCapabilityPayload(capability),
      };
      const prepared = await this.prepareAndConsumeDynamicMutation(
        { ...request, capability },
        capability.action,
        () => this.prepareSensitiveRequest("type-text", payload),
      );
      return this.runPreparedSensitive(
        prepared,
        composerMutationReceiptSchema,
      );
    }
    if (
      request.capability.action !== "replace-draft" &&
      request.capability.action !== "clear-draft"
    ) {
      throw new Error("WRITE_CAPABILITY_ACTION_MISMATCH");
    }
    if (
      request.capability.action === "replace-draft" &&
      sha256Canonical(request.text) !== request.capability.candidateHash
    ) {
      throw new Error("WRITE_CAPABILITY_CANDIDATE_MISMATCH");
    }
    if (request.capability.action === "clear-draft" && request.text !== "") {
      throw new Error("WRITE_CAPABILITY_CANDIDATE_MISMATCH");
    }
    return this.runSensitive(
      "type-text",
      request,
      composerMutationReceiptSchema,
    );
  }

  public async prepareWechatImageAttachment(
    request: WechatImageAttachmentRequest,
  ): Promise<WechatImageAttachmentReceipt> {
    assertMutationRequest(request, "attach-image");
    if (request.conversationTitle !== "文件传输助手") {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_TARGET_NOT_ALLOWED");
    }
    if (
      request.imageSha256 !== request.capability.candidateHash ||
      request.width !== 1080 ||
      request.height !== 1350
    ) {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH");
    }
    await assertReviewedPng(request.imagePath, request.imageSha256);
    if (this.usedCapabilityIds.has(request.capability.capabilityId)) {
      throw new Error("WRITE_CAPABILITY_ALREADY_USED");
    }
    this.usedCapabilityIds.add(request.capability.capabilityId);
    return this.runSensitive(
      "attach-wechat-image",
      request,
      imageAttachmentReceiptSchema,
    );
  }

  public async sendWechatImage(
    request: WechatImageSendRequest,
  ): Promise<WechatImageSendReceipt> {
    assertMutationRequest(request, "send-image");
    if (request.conversationTitle !== "示例联系人") {
      throw new Error("WECHAT_IMAGE_SEND_TARGET_NOT_ALLOWED");
    }
    if (
      request.imageSha256 !== request.capability.candidateHash ||
      request.width !== 1080 ||
      request.height !== 1350
    ) {
      throw new Error("WECHAT_IMAGE_SEND_CANDIDATE_MISMATCH");
    }
    await assertReviewedPng(request.imagePath, request.imageSha256);
    if (this.usedCapabilityIds.has(request.capability.capabilityId)) {
      throw new Error("WRITE_CAPABILITY_ALREADY_USED");
    }
    this.usedCapabilityIds.add(request.capability.capabilityId);
    return this.runSensitive(
      "send-wechat-image",
      request,
      imageSendReceiptSchema,
    );
  }

  public recoverWechatImageQuarantine(
    request: WechatImageQuarantineRecoveryRequest,
  ): Promise<WechatImageQuarantineRecoveryReceipt> {
    if (
      request.bundleID !== "com.tencent.xinWeChat" ||
      request.title !== "微信" ||
      request.conversationTitle !== "示例联系人" ||
      !Number.isInteger(request.windowID) ||
      request.windowID < 0
    ) {
      return Promise.reject(
        new Error("WECHAT_IMAGE_ATTACHMENT_RECOVERY_TARGET_NOT_ALLOWED"),
      );
    }
    return this.runSensitive(
      "recover-wechat-image-quarantine",
      request,
      imageQuarantineRecoveryReceiptSchema,
    );
  }

  public async pressEnter(token: string): Promise<void> {
    assertWriteToken(token);
    await this.runSensitive("press-enter", { token }, successSchema);
  }

  public async readFocusedText(): Promise<string> {
    return (await this.run("read-focused-text", [], focusedTextSchema)).text;
  }

  public async submitWechatDraft(
    request: WechatDraftSubmitRequest,
    control?: NativeDraftSubmitControl,
  ): Promise<WechatDraftSubmitReceipt> {
    assertExactSubmitRequestKeys(request);
    if (request.capability === undefined) {
      if (
        request.bundleID !== "com.tencent.xinWeChat" ||
        request.title !== "微信"
      ) {
        throw new Error("WECHAT_SUBMIT_TARGET_NOT_ALLOWED");
      }
      if (
        request.conversationTitle !== "文件传输助手" &&
        request.conversationTitle !== "示例联系人"
      ) {
        throw new Error("WECHAT_CONVERSATION_TARGET_NOT_ALLOWED");
      }
      throw new Error("WRITE_CAPABILITY_REQUIRED");
    }
    assertStrictSubmitRequest(request);
    assertWriteToken(request.token);
    if (
      request.bundleID !== "com.tencent.xinWeChat" ||
      request.title !== "微信"
    ) {
      throw new Error("WECHAT_SUBMIT_TARGET_NOT_ALLOWED");
    }
    const capability = request.capability;
    if (isNativeTextTargetCapability(capability)) {
      if (control === undefined)
        throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
      const reservation = this.reserveDynamicMutation(
        { ...request, capability },
        "submit-draft",
      );
      try {
        await this.verifyDynamicMutation({ ...request, capability }, "submit-draft");
        await this.verifyRequestBinding({
          windowID: request.windowID,
          bundleID: "com.tencent.xinWeChat",
          title: "微信",
          conversationTitle: request.conversationTitle,
          token: request.token,
          slotKey: request.slotKey!,
          draftText: request.draftText!,
          conversationProof: request.conversationProof!,
          capability: capability as BoundNativeTextTargetCapabilityV2,
        });
        const payload = submitPayload(request, capability);
        const prepared = this.prepareSensitiveRequest(
          "submit-wechat-draft",
          payload,
        );
        this.consumeDynamicMutation(reservation, capability.expiresAt);
        throwIfAborted(control.signal);
        if (!(await control.markSubmitStarted())) {
          return { attempted: false };
        }
        throwIfAborted(control.signal);
        await this.runPreparedSensitive(
          prepared,
          successSchema,
          MAX_SENSITIVE_RESPONSE_BYTES,
          control.signal,
        );
        return { attempted: true };
      } catch (error: unknown) {
        this.releasePendingDynamicMutation(reservation);
        throw error;
      }
    }
    if (
      request.conversationTitle !== "文件传输助手" &&
      request.conversationTitle !== "示例联系人"
    ) {
      throw new Error("WECHAT_CONVERSATION_TARGET_NOT_ALLOWED");
    }
    assertWriteCapability(capability);
    if (request.draftText === undefined || request.slotKey === undefined) {
      throw new Error("WRITE_CAPABILITY_BINDING_REQUIRED");
    }
    if (sha256Canonical(request.draftText) !== capability.candidateHash) {
      throw new Error("WRITE_CAPABILITY_CANDIDATE_MISMATCH");
    }
    if (
      createHash("sha256").update(request.slotKey).digest("hex") !==
      capability.slotHash
    ) {
      throw new Error("WRITE_CAPABILITY_SLOT_MISMATCH");
    }
    if (
      titleIdentityFingerprint(
        request.conversationTitle,
        capability.windowRevision,
      ) !== capability.identityFingerprint
    ) {
      throw new Error("WRITE_CAPABILITY_IDENTITY_MISMATCH");
    }
    if (this.usedCapabilityIds.has(capability.capabilityId)) {
      throw new Error("WRITE_CAPABILITY_ALREADY_USED");
    }
    this.usedCapabilityIds.add(capability.capabilityId);
    await this.runSensitive("submit-wechat-draft", request, successSchema);
    return { attempted: true };
  }

  public async matchWechatIdentityRows(
    request: WechatIdentityMatchRequest,
  ): Promise<WechatIdentityMatch[]> {
    if (
      request.bundleID !== "com.tencent.xinWeChat" ||
      request.title !== "微信"
    ) {
      throw new Error("WECHAT_IDENTITY_TARGET_NOT_ALLOWED");
    }
    const proofPhase = request.proofPhase ?? "selected";
    const matches = await this.runSensitive(
      "match-wechat-identity",
      { ...request, proofPhase },
      z.array(identityMatchSchema),
    );
    if (matches.some((match) => match.proofPhase !== proofPhase)) {
      throw new Error("WECHAT_IDENTITY_PROOF_PHASE_MISMATCH");
    }
    return matches;
  }

  public async captureWechatIdentitySamples(
    request: WechatIdentityCaptureRequest,
  ): Promise<WechatIdentityCaptureReceipt> {
    if (
      !Number.isInteger(request.windowID) ||
      request.windowID < 0 ||
      request.bundleID !== "com.tencent.xinWeChat" ||
      request.title !== "微信" ||
      request.conversationTitle.normalize("NFC").trim() !==
        request.conversationTitle ||
      request.conversationTitle.length === 0 ||
      request.conversationTitle.length > 64 ||
      !isHash(request.expectedPreviewHash) ||
      !isHash(request.expectedWindowRevision) ||
      ![3, 4, 5].includes(request.sampleCount)
    ) {
      throw new Error("WECHAT_IDENTITY_CAPTURE_REQUEST_INVALID");
    }
    const receipt = await this.runSensitive(
      "capture-wechat-identity-samples",
      request,
      identityCaptureReceiptSchema,
      MAX_IDENTITY_CAPTURE_RESPONSE_BYTES,
    );
    if (
      receipt.windowRevision !== request.expectedWindowRevision ||
      receipt.referenceSamples.length !== request.sampleCount
    ) {
      throw new Error("WECHAT_IDENTITY_CAPTURE_RECEIPT_INVALID");
    }
    return receipt;
  }

  public async clickWechatWindowPoint(
    request: WechatWindowClickRequest,
  ): Promise<void> {
    const action =
      request.region === "conversation-list"
        ? "select-conversation"
        : "focus-composer";
    assertMutationRequest(request, action);
    const capability = request.capability;
    if (isNativeTextTargetCapability(capability)) {
      if (
        request.bundleID !== "com.tencent.xinWeChat" ||
        request.title !== "微信"
      ) {
        throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
      }
      const allowed =
        request.region === "conversation-list"
          ? request.normalizedX >= 0.08 &&
            request.normalizedX <= 0.36 &&
            request.normalizedY >= 0.05 &&
            request.normalizedY <= 0.95
          : request.normalizedX >= 0.38 &&
            request.normalizedX <= 0.98 &&
            request.normalizedY >= 0.62 &&
            request.normalizedY <= 0.98;
      if (!allowed) throw new Error("WECHAT_CLICK_POINT_NOT_ALLOWED");
      const payload = {
        ...request,
        capability: nativeCapabilityPayload(capability),
      };
      const prepared = await this.prepareAndConsumeDynamicMutation(
        { ...request, capability },
        action,
        () => this.prepareSensitiveRequest("click-wechat-point", payload),
      );
      await this.runPreparedSensitive(prepared, successSchema);
      return;
    }
    if (
      request.bundleID !== "com.tencent.xinWeChat" ||
      request.title !== "微信"
    ) {
      throw new Error("WECHAT_CLICK_TARGET_NOT_ALLOWED");
    }
    const allowed =
      request.region === "conversation-list"
        ? request.normalizedX >= 0.08 &&
          request.normalizedX <= 0.36 &&
          request.normalizedY >= 0.05 &&
          request.normalizedY <= 0.95
        : request.normalizedX >= 0.38 &&
          request.normalizedX <= 0.98 &&
          request.normalizedY >= 0.62 &&
          request.normalizedY <= 0.98;
    if (!allowed) throw new Error("WECHAT_CLICK_POINT_NOT_ALLOWED");
    await this.runSensitive("click-wechat-point", request, successSchema);
  }

  public async scrollReadOnly(request: ReadOnlyScrollRequest): Promise<void> {
    if (
      request.bundleID !== "com.tencent.xinWeChat" ||
      request.title !== "与“示例联系人”的聊天记录"
    ) {
      throw new Error("READ_ONLY_SCROLL_TARGET_NOT_ALLOWED");
    }
    if (
      !Number.isInteger(request.deltaY) ||
      request.deltaY === 0 ||
      Math.abs(request.deltaY) > 1_200
    ) {
      throw new Error("READ_ONLY_SCROLL_DELTA_NOT_ALLOWED");
    }
    await this.run(
      "scroll-read-only",
      [
        "--window-id",
        String(request.windowID),
        "--bundle-id",
        request.bundleID,
        "--title",
        request.title,
        "--delta-y",
        String(request.deltaY),
      ],
      successSchema,
    );
  }

  public async dragScrollbarReadOnly(
    request: ReadOnlyScrollbarDragRequest,
  ): Promise<void> {
    if (
      request.bundleID !== "com.tencent.xinWeChat" ||
      request.title !== "与“示例联系人”的聊天记录"
    ) {
      throw new Error("READ_ONLY_SCROLLBAR_DRAG_TARGET_NOT_ALLOWED");
    }
    if (
      !Number.isInteger(request.fromY) ||
      !Number.isInteger(request.toY) ||
      request.fromY < 40 ||
      request.toY <= request.fromY ||
      request.toY - request.fromY > 600
    ) {
      throw new Error("READ_ONLY_SCROLLBAR_DRAG_NOT_ALLOWED");
    }
    await this.run(
      "drag-scrollbar-read-only",
      [
        "--window-id",
        String(request.windowID),
        "--bundle-id",
        request.bundleID,
        "--title",
        request.title,
        "--from-y",
        String(request.fromY),
        "--to-y",
        String(request.toY),
      ],
      successSchema,
    );
  }

  public diagnosePermissions(): Promise<PermissionReport> {
    return this.run("diagnose-permissions", [], permissionReportSchema);
  }

  private async validateTempPath(candidate: string): Promise<string> {
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    const realTempDir = await realpath(this.tempDir);
    const realCandidate = await realpath(candidate);
    if (!realCandidate.startsWith(`${realTempDir}${path.sep}`)) {
      throw new Error("PATH_OUTSIDE_TEMP_DIR");
    }
    return realCandidate;
  }

  private run<T>(
    command: string,
    arguments_: string[],
    schema: z.ZodType<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn(
        this.executablePath,
        [...this.baseArguments, command, ...arguments_],
        {
          env: this.environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("NATIVE_BRIDGE_TIMEOUT"));
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error("NATIVE_BRIDGE_START_FAILED", { cause: error }));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`NATIVE_BRIDGE_EXIT_${String(code)}`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          resolve(schema.parse(parsed));
        } catch (error: unknown) {
          reject(new Error("INVALID_NATIVE_BRIDGE_JSON", { cause: error }));
        }
      });
    });
  }

  private runSensitive<T>(
    command:
      | "type-text"
      | "press-enter"
      | "click-wechat-point"
      | "submit-wechat-draft"
      | "match-wechat-identity"
      | "attach-wechat-image"
      | "send-wechat-image"
      | "recover-wechat-image-quarantine"
      | "capture-wechat-identity-samples",
    payload: object,
    schema: z.ZodType<T>,
    maximumResponseBytes = MAX_SENSITIVE_RESPONSE_BYTES,
  ): Promise<T> {
    return this.runPreparedSensitive(
      this.prepareSensitiveRequest(command, payload),
      schema,
      maximumResponseBytes,
    );
  }

  private prepareSensitiveRequest(
    command:
      | "type-text"
      | "press-enter"
      | "click-wechat-point"
      | "submit-wechat-draft"
      | "match-wechat-identity"
      | "attach-wechat-image"
      | "send-wechat-image"
      | "recover-wechat-image-quarantine"
      | "capture-wechat-identity-samples",
    payload: object,
  ): Buffer {
    const encoded = Buffer.from(
      JSON.stringify({ version: 1, command, payload }),
      "utf8",
    );
    if (encoded.length === 0 || encoded.length > MAX_SENSITIVE_REQUEST_BYTES) {
      throw new Error("SENSITIVE_REQUEST_TOO_LARGE");
    }
    const frame = Buffer.allocUnsafe(encoded.length + 4);
    frame.writeUInt32BE(encoded.length, 0);
    encoded.copy(frame, 4);
    return frame;
  }

  private runPreparedSensitive<T>(
    frame: Buffer,
    schema: z.ZodType<T>,
    maximumResponseBytes = MAX_SENSITIVE_RESPONSE_BYTES,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted === true) {
      return Promise.reject(
        new Error("NATIVE_BRIDGE_ABORTED", { cause: signal.reason }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const child = spawn(
        this.executablePath,
        [...this.baseArguments, "write-command"],
        {
          env: minimalSensitiveEnvironment(this.environment),
          shell: false,
          stdio: ["pipe", "ignore", "ignore", "pipe"],
        },
      );
      const response = child.stdio[3];
      const requestInput = child.stdin;
      let responseBytes = Buffer.alloc(0);
      let settled = false;
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        reject(error);
      };
      const onAbort = (): void => {
        finishReject(
          new Error("NATIVE_BRIDGE_ABORTED", { cause: signal?.reason }),
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        finishReject(new Error("NATIVE_BRIDGE_TIMEOUT"));
      }, this.timeoutMs);
      if (
        response === null ||
        response === undefined ||
        requestInput === null
      ) {
        finishReject(new Error("NATIVE_BRIDGE_RESPONSE_CHANNEL_MISSING"));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        responseBytes = Buffer.concat([responseBytes, Buffer.from(chunk)]);
        if (responseBytes.length > maximumResponseBytes) {
          finishReject(new Error("NATIVE_BRIDGE_RESPONSE_TOO_LARGE"));
        }
      });
      child.on("error", () => {
        finishReject(new Error("NATIVE_BRIDGE_START_FAILED"));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (code !== 0) {
          reject(new Error(`NATIVE_BRIDGE_EXIT_${String(code)}`));
          return;
        }
        try {
          const parsed: unknown = JSON.parse(responseBytes.toString("utf8"));
          resolve(schema.parse(parsed));
        } catch (error: unknown) {
          reject(new Error("INVALID_NATIVE_BRIDGE_JSON", { cause: error }));
        }
      });
      requestInput.on("error", () => {
        finishReject(new Error("NATIVE_BRIDGE_REQUEST_WRITE_FAILED"));
      });
      requestInput.end(frame);
    });
  }

  private async prepareAndConsumeDynamicMutation(
    request: {
      conversationTitle?: string;
      token?: string;
      slotKey?: string;
      text?: string;
      draftText?: string;
      capability: NativeTextTargetCapabilityV2;
    },
    action: NativeTextTargetCapabilityV2["action"],
    prepare: () => Buffer,
  ): Promise<Buffer> {
    const reservation = this.reserveDynamicMutation(request, action);
    try {
      await this.verifyDynamicMutation(request, action);
      const prepared = prepare();
      this.consumeDynamicMutation(reservation, request.capability.expiresAt);
      return prepared;
    } catch (error: unknown) {
      this.releasePendingDynamicMutation(reservation);
      throw error;
    }
  }

  private reserveDynamicMutation(
    request: {
      conversationTitle?: string;
      token?: string;
      slotKey?: string;
      text?: string;
      draftText?: string;
      capability: NativeTextTargetCapabilityV2;
    },
    action: NativeTextTargetCapabilityV2["action"],
  ): string {
    const capability = request.capability;
    const trustedNow = Date.now();
    this.pruneDynamicCapabilities(trustedNow);
    if (
      request.token !== capability.capabilityId ||
      request.conversationTitle !== capability.conversationTitle ||
      request.slotKey === undefined ||
      capability.action !== action ||
      this.dynamicCapabilityReservations.has(capability.capabilityId)
    ) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    if (
      this.dynamicCapabilityReservations.size >=
      MAX_DYNAMIC_CAPABILITY_RESERVATIONS
    ) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_CAPACITY");
    }
    this.dynamicCapabilityReservations.set(capability.capabilityId, {
      state: "pending",
      cleanupAt: trustedNow + DYNAMIC_PENDING_TTL_MS,
    });
    return capability.capabilityId;
  }

  private consumeDynamicMutation(capabilityId: string, expiresAt: string): void {
    const current = this.dynamicCapabilityReservations.get(capabilityId);
    const expiry = Date.parse(expiresAt);
    if (
      current?.state !== "pending" ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now()
    ) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    this.dynamicCapabilityReservations.set(capabilityId, {
      state: "consumed",
      cleanupAt: expiry,
    });
  }

  private releasePendingDynamicMutation(capabilityId: string): void {
    if (
      this.dynamicCapabilityReservations.get(capabilityId)?.state === "pending"
    ) {
      this.dynamicCapabilityReservations.delete(capabilityId);
    }
  }

  private pruneDynamicCapabilities(now: number): void {
    for (const [capabilityId, reservation] of this.dynamicCapabilityReservations) {
      if (reservation.cleanupAt <= now) {
        this.dynamicCapabilityReservations.delete(capabilityId);
      }
    }
  }

  private async verifyDynamicMutation(
    request: {
      conversationTitle?: string;
      token?: string;
      slotKey?: string;
      text?: string;
      draftText?: string;
      capability: NativeTextTargetCapabilityV2;
    },
    action: NativeTextTargetCapabilityV2["action"],
  ): Promise<void> {
    const capability = request.capability;
    const draftText = request.text ?? request.draftText ?? "";
    if (request.slotKey === undefined)
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    await verifyNativeTextTargetCapability({
      capability,
      action,
      target: {
        contactId: capability.contactId,
        displayName: capability.conversationTitle,
        revision: capability.contactRevision,
        enrollmentFingerprint: capability.enrollmentFingerprint,
        bindingHash: capability.bindingHash,
      },
      draftText,
      slotKey: request.slotKey,
      windowRevision: capability.windowRevision,
      keyProvider: this.nativeCapabilityKeyProvider,
    });
  }

  private async verifyRequestBinding(request: {
    readonly windowID: number;
    readonly bundleID: "com.tencent.xinWeChat";
    readonly title: "微信";
    readonly conversationTitle: string;
    readonly token: string;
    readonly slotKey: string;
    readonly draftText: string;
    readonly conversationProof: NativeSubmitConversationProof;
    readonly capability: BoundNativeTextTargetCapabilityV2;
  }): Promise<void> {
    if (!isHash(request.capability.requestBindingMac)) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    const key = await this.nativeCapabilityKeyProvider.getOrCreate();
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    const expected = createHmac("sha256", key)
      .update(canonicalNativeRequestBinding({
        ...request,
        capability: request.capability,
      }))
      .digest();
    const actual = Buffer.from(request.capability.requestBindingMac, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new Error("NATIVE_BRIDGE_ABORTED", { cause: signal.reason });
}

function assertExactSubmitRequestKeys(request: WechatDraftSubmitRequest): void {
  const actual = Reflect.ownKeys(request).sort().join(",");
  const allowed = [
    "bundleID",
    "capability",
    "conversationTitle",
    "conversationProof",
    "draftText",
    "identityEnrollment",
    "slotKey",
    "title",
    "token",
    "windowID",
  ];
  if (actual.split(",").some((key) => !allowed.includes(key))) {
    throw new Error("WECHAT_SUBMIT_REQUEST_INVALID");
  }
}

function assertStrictSubmitRequest(request: WechatDraftSubmitRequest): void {
  const capability = request.capability;
  if (
    !Number.isFinite(request.windowID) ||
    !Number.isInteger(request.windowID) ||
    request.windowID < 0 ||
    typeof request.conversationTitle !== "string" ||
    request.conversationTitle.length < 1 ||
    request.conversationTitle.length > 64 ||
    request.conversationTitle !== request.conversationTitle.normalize("NFC").trim() ||
    typeof request.token !== "string" ||
    !isHash(request.token) ||
    typeof request.slotKey !== "string" ||
    !/^(?:\d{4}-\d{2}-\d{2}\/(?:morning|night)|non-daily\/[a-f0-9]{64})$/u.test(
      request.slotKey,
    ) ||
    typeof request.draftText !== "string" ||
    request.draftText.length < 1
  ) {
    throw new Error("WECHAT_SUBMIT_REQUEST_INVALID");
  }
  if (
    request.bundleID !== "com.tencent.xinWeChat" ||
    request.title !== "微信"
  ) {
    throw new Error("WECHAT_SUBMIT_TARGET_NOT_ALLOWED");
  }
  if (isNativeTextTargetCapability(capability)) {
    const proof = request.conversationProof;
    if (
      request.identityEnrollment !== undefined ||
      request.draftText !==
        request.draftText.normalize("NFC").replace(/\r\n?/gu, "\n") ||
      capability.version !== 2 ||
      capability.action !== "submit-draft" ||
      capability.capabilityId !== request.token ||
      capability.conversationTitle !== request.conversationTitle ||
      !Number.isSafeInteger(capability.contactRevision) ||
      capability.contactRevision < 1 ||
      !isHash(capability.enrollmentFingerprint) ||
      !isHash(capability.bindingHash) ||
      !isHash(capability.candidateHash) ||
      !isHash(capability.slotHash) ||
      !isHash(capability.windowRevision) ||
      !isHash(capability.authorizationMac) ||
      !isHash((capability as Partial<BoundNativeTextTargetCapabilityV2>).requestBindingMac ?? "")
      || proof?.version !== 1
      || !isHash(proof.latestMessageId)
      || !isHash(proof.latestTextHash)
      || proof.latestDirection !== "incoming"
      || !isHash(proof.controlRevision)
    ) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
  }
}

function canonicalNativeRequestBinding(input: {
  readonly capability: NativeTextTargetCapabilityV2;
  readonly windowID: number;
  readonly bundleID: string;
  readonly title: string;
  readonly conversationTitle: string;
  readonly token: string;
  readonly slotKey: string;
  readonly draftText: string;
  readonly conversationProof: NativeSubmitConversationProof;
}): Buffer {
  return Buffer.from(
    [
      requestBindingDomain,
      input.capability.authorizationMac,
      String(input.windowID),
      input.bundleID,
      input.title,
      input.conversationTitle,
      input.token,
      input.slotKey,
      input.draftText.normalize("NFC").replace(/\r\n?/gu, "\n"),
      input.capability.windowRevision,
      String(input.conversationProof.version),
      input.conversationProof.latestMessageId,
      input.conversationProof.latestTextHash,
      input.conversationProof.latestDirection,
      input.conversationProof.controlRevision,
    ].join("\0"),
    "utf8",
  );
}

function submitPayload(
  request: WechatDraftSubmitRequest,
  capability: NativeTextTargetCapabilityV2,
): object {
  return {
    windowID: request.windowID,
    bundleID: request.bundleID,
    title: request.title,
    conversationTitle: request.conversationTitle,
    token: request.token,
    slotKey: request.slotKey,
    draftText: request.draftText,
    conversationProof: request.conversationProof,
    ...(request.identityEnrollment === undefined
      ? {}
      : { identityEnrollment: request.identityEnrollment }),
    capability: nativeCapabilityPayload(capability),
  };
}

function nativeCapabilityPayload(
  capability: NativeTextTargetCapabilityV2,
): NativeTextTargetCapabilityV2 | BoundNativeTextTargetCapabilityV2 {
  return {
    version: capability.version,
    capabilityId: capability.capabilityId,
    action: capability.action,
    contactId: capability.contactId,
    contactRevision: capability.contactRevision,
    conversationTitle: capability.conversationTitle,
    enrollmentFingerprint: capability.enrollmentFingerprint,
    bindingHash: capability.bindingHash,
    candidateHash: capability.candidateHash,
    slotHash: capability.slotHash,
    windowRevision: capability.windowRevision,
    expiresAt: capability.expiresAt,
    authorizationMac: capability.authorizationMac,
    ...("requestBindingMac" in capability
      ? { requestBindingMac: capability.requestBindingMac }
      : {}),
  };
}

function assertWriteToken(token: string): void {
  if (!/^[0-9a-fA-F]{64}$/u.test(token)) {
    throw new Error("WRITE_TOKEN_REQUIRED");
  }
}

function assertMutationRequest(
  request: unknown,
  expectedAction:
    WechatMutationAction | NativeTextTargetCapabilityV2["action"] | undefined,
): asserts request is {
  bundleID: "com.tencent.xinWeChat";
  title: "微信";
  conversationTitle: string;
  token: string;
  slotKey: string;
  capability: WechatMutationCapability;
} {
  if (typeof request !== "object" || request === null) {
    throw new Error("WRITE_CAPABILITY_REQUIRED");
  }
  const candidate = request as {
    bundleID?: unknown;
    title?: unknown;
    conversationTitle?: unknown;
    token?: unknown;
    slotKey?: unknown;
    capability?: Partial<WechatMutationCapability>;
  };
  const capability = candidate.capability;
  if (
    candidate.bundleID !== "com.tencent.xinWeChat" ||
    candidate.title !== "微信" ||
    typeof candidate.conversationTitle !== "string" ||
    typeof candidate.token !== "string" ||
    typeof candidate.slotKey !== "string" ||
    capability === undefined ||
    capability.action !== expectedAction ||
    capability.capabilityId !== candidate.token ||
    typeof capability.capabilityId !== "string" ||
    !isHash(capability.capabilityId)
  ) {
    throw new Error("WRITE_CAPABILITY_REQUIRED");
  }
  if (isNativeTextTargetCapability(capability)) return;
  if (
    capability.version !== 1 ||
    typeof capability.candidateHash !== "string" ||
    typeof capability.slotHash !== "string" ||
    typeof capability.identityFingerprint !== "string" ||
    typeof capability.windowRevision !== "string" ||
    typeof capability.expiresAt !== "string" ||
    !isHash(capability.candidateHash) ||
    !isHash(capability.slotHash) ||
    !isHash(capability.identityFingerprint) ||
    !isHash(capability.windowRevision)
  ) {
    throw new Error("WRITE_CAPABILITY_REQUIRED");
  }
  assertWriteToken(candidate.token);
  if (
    !/^(?:\d{4}-\d{2}-\d{2}\/(?:morning|night)|non-daily\/[a-f0-9]{64})$/u.test(
      candidate.slotKey,
    ) ||
    createHash("sha256").update(candidate.slotKey).digest("hex") !==
      capability.slotHash
  ) {
    throw new Error("WRITE_CAPABILITY_SLOT_MISMATCH");
  }
  if (
    titleIdentityFingerprint(
      candidate.conversationTitle,
      capability.windowRevision,
    ) !== capability.identityFingerprint
  ) {
    throw new Error("WRITE_CAPABILITY_IDENTITY_MISMATCH");
  }
  const expiry = new Date(capability.expiresAt);
  const now = Date.now();
  if (
    !Number.isFinite(expiry.getTime()) ||
    expiry.getTime() <= now ||
    expiry.getTime() - now > 180_000
  ) {
    throw new Error("WRITE_CAPABILITY_EXPIRED");
  }
}

async function assertReviewedPng(
  candidatePath: string,
  expectedSha256: string,
): Promise<void> {
  if (!path.isAbsolute(candidatePath) || !isHash(expectedSha256)) {
    throw new Error("WECHAT_IMAGE_ATTACHMENT_INVALID");
  }
  let handle;
  try {
    handle = await open(
      candidatePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error: unknown) {
    throw new Error("WECHAT_IMAGE_ATTACHMENT_INVALID", { cause: error });
  }
  try {
    const before = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 2 * 1024 * 1024 ||
      (currentUid !== undefined && before.uid !== currentUid) ||
      (before.mode & 0o022) !== 0
    ) {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_INVALID");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size
    ) {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_INVALID");
    }
    const signature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(signature) ||
      bytes.subarray(12, 16).toString("ascii") !== "IHDR" ||
      bytes.readUInt32BE(16) !== 1080 ||
      bytes.readUInt32BE(20) !== 1350 ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256
    ) {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH");
    }
  } finally {
    await handle.close();
  }
}

function assertWriteCapability(
  capability: WechatWriteCapability | undefined,
): asserts capability is WechatWriteCapability {
  if (
    capability === undefined ||
    capability.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(capability.capabilityId) ||
    !/^[a-f0-9]{64}$/u.test(capability.candidateHash) ||
    !/^[a-f0-9]{64}$/u.test(capability.slotHash) ||
    !/^[a-f0-9]{64}$/u.test(capability.identityFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(capability.windowRevision)
  ) {
    throw new Error("WRITE_CAPABILITY_REQUIRED");
  }
  const expiry = new Date(capability.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new Error("WRITE_CAPABILITY_EXPIRED");
  }
}

function sha256Canonical(text: string): string {
  const canonical = text.normalize("NFC").replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function titleIdentityFingerprint(
  conversationTitle: string,
  windowRevision: string,
): string {
  return createHash("sha256")
    .update(
      ["wechat-unique-title-v1", conversationTitle, windowRevision].join("\0"),
    )
    .digest("hex");
}

function isNativeTextTargetCapability<
  T extends
    Partial<WechatMutationCapability> | WechatWriteCapability | undefined,
>(capability: T): capability is T & NativeTextTargetCapabilityV2 {
  return (
    capability?.version === 2 &&
    typeof capability.authorizationMac === "string" &&
    typeof capability.contactId === "string" &&
    typeof capability.contactRevision === "number" &&
    typeof capability.conversationTitle === "string" &&
    typeof capability.enrollmentFingerprint === "string" &&
    typeof capability.bindingHash === "string"
  );
}

function isHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function minimalSensitiveEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "FAKE_BRIDGE_SCENARIO",
    "FAKE_BRIDGE_ARGS_PATH",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}
