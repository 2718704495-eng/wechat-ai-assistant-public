import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  ASSISTANT_DISPLAY_NAME,
  ASSISTANT_SIGNATURE,
} from "../assistant-identity.js";
import type { ChatMessage, ConversationId } from "../domain/types.js";
import {
  WechatIdentityEnrollmentRepository,
  wechatIdentityEnrollmentFingerprint,
  type WechatIdentityEnrollment,
} from "../storage/wechat-identity-enrollment-repository.js";
import type { AuthorizedWechatTarget } from "../contacts/contact-directory.js";
import type { ContactId } from "../contacts/contact-schema.js";
import {
  defaultNativeTextTargetCapabilityKeyProvider,
  issueNativeTextTargetCapability,
  type NativeTextTargetCapabilityAction,
  type NativeTextTargetCapabilityV2,
} from "../security/native-capability-mac.js";
import type { KeyProvider } from "../security/keychain.js";
import type {
  ConversationSnapshot,
  IdentityProfile,
  LatestIncomingEvidence,
  WeChatSurface,
} from "./wechat.js";
import type {
  BoundNativeTextTargetCapabilityV2,
  NativeDraftSubmitControl,
  NativeSubmitConversationProof,
  NativeBridge,
  OCRLine,
  WechatDraftSubmitRequest,
  WechatDraftSubmitReceipt,
  WechatComposerMutationReceipt,
  WechatIdentityMatchRequest,
  WechatIdentityCaptureReceipt,
  WechatIdentityCaptureRequest,
  WechatImageAttachmentRequest,
  WechatImageAttachmentReceipt,
  WechatImageSendRequest,
  WechatImageSendReceipt,
  WechatImageQuarantineRecoveryReceipt,
  WechatMutationAction,
  WechatMutationCapability,
  WechatTextMutationRequest,
  WechatWindowClickRequest,
  WindowDescriptor,
} from "./native-bridge.js";
import { bindNativeTextTargetRequest } from "./native-bridge.js";

const bundleID = "com.tencent.xinWeChat";
const mainWindowTitle = "微信";
const conversationListMaxX = 0.31;
const conversationHeaderMinX = 0.32;
const names: Record<ConversationId, WechatDraftSubmitRequest["conversationTitle"]> = {
  "example-contact": "示例联系人",
  "file-transfer": "文件传输助手",
};

export const liveWechatIdentities: Record<ConversationId, IdentityProfile> = {
  "example-contact": identityProfile("example-contact"),
  "file-transfer": identityProfile("file-transfer"),
};

export interface NativeWechatDriver {
  listWindows(bundleID: string): Promise<WindowDescriptor[]>;
  capture(windowID: number): Promise<string>;
  ocr(imagePath: string): Promise<OCRLine[]>;
  focus(windowID: number): Promise<void>;
  clickWechatWindowPoint(request: WechatWindowClickRequest): Promise<void>;
  matchWechatIdentityRows(request: WechatIdentityMatchRequest): Promise<NativeWechatIdentityEvidence[]>;
  captureWechatIdentitySamples(request: WechatIdentityCaptureRequest): Promise<WechatIdentityCaptureReceipt>;
  typeText(request: WechatTextMutationRequest): Promise<WechatComposerMutationReceipt>;
  prepareWechatImageAttachment(
    request: WechatImageAttachmentRequest,
  ): Promise<WechatImageAttachmentReceipt>;
  sendWechatImage(request: WechatImageSendRequest): Promise<WechatImageSendReceipt>;
  recoverWechatImageQuarantine?(request: {
    windowID: number;
    bundleID: "com.tencent.xinWeChat";
    title: "微信";
    conversationTitle: "示例联系人";
  }): Promise<WechatImageQuarantineRecoveryReceipt>;
  submitWechatDraft(
    request: WechatDraftSubmitRequest,
    control?: NativeDraftSubmitControl,
  ): Promise<WechatDraftSubmitReceipt>;
}

interface NativeWechatIdentityEvidence {
  readonly normalizedY: number;
  readonly distance: number;
  readonly observedFingerprint: string;
  readonly fingerprintVersion: string;
  readonly proofPhase?: "pre-click" | "selected";
  readonly selected: boolean;
  readonly selectedRowTitle: string | null;
  readonly selectedRowNormalizedY: number | null;
  readonly selectionProofHash: string | null;
}

interface ConversationFocusProof {
  conversationId: ConversationId;
  window: WindowDescriptor;
  windowRevision: string;
}

export interface NativeWechatSurfaceOptions {
  identityEnrollments?: Partial<Record<ConversationId, WechatIdentityEnrollment>>;
  textTargetDirectory?: TextTargetDirectory;
  nativeCapabilityKeyProvider?: KeyProvider;
}

export interface TextTargetDirectory {
  requireTextTarget(contactId: ContactId, expectedRevision: number): Promise<AuthorizedWechatTarget>;
}

export interface NativeConversationListSnapshot {
  readonly windowRevision: string;
  readonly lines: readonly OCRLine[];
}

export interface NativeAuthorizedConversationSnapshot {
  readonly conversationId: ContactId;
  readonly identity: {
    readonly conversationId: ContactId;
    readonly visibleName: string;
    readonly enrollmentFingerprint: string;
    readonly observedFingerprint: string;
    readonly confidence: number;
  };
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly conversationId: ContactId;
    readonly direction: ChatMessage["direction"];
    readonly kind: ChatMessage["kind"];
    readonly text: string;
    readonly occurredAt: string;
    readonly confidence: number;
  }>;
  readonly windowRevision: string;
  readonly latestIncomingEvidence?: {
    readonly version: 1;
    readonly proofId: string;
    readonly messageId: string;
    readonly observedMinute: string;
    readonly confidence: number;
    readonly contactId: ContactId;
    readonly contactRevision: number;
    readonly windowRevision: string;
  };
}

interface AuthorizedPreClickIdentityMatch {
  readonly proofPhase: "pre-click";
  readonly normalizedY: number;
  readonly observedFingerprint: string;
}

interface AuthorizedIdentityMatch {
  readonly proofPhase: "selected";
  readonly normalizedY: number;
  readonly observedFingerprint: string;
  readonly selectedRowTitle: string;
  readonly selectedRowNormalizedY: number;
  readonly selectionProofHash: string;
}

export class NativeWechatSurface implements WeChatSurface {
  private activeConversation: ConversationId | null = null;
  private focusProof: ConversationFocusProof | null = null;
  private dailyCareWriteContext: {
    slotKey: string;
    candidateHash: string;
    expiresAt: string;
  } | null = null;
  private preparedDraft: string | null = null;
  private preparedWindowRevision: string | null = null;
  private authorizedTextDraft: {
    target: AuthorizedWechatTarget;
    slotKey: string;
    text: string;
    windowRevision: string;
  } | null = null;
  private readonly usedCapabilityIds = new Set<string>();

  public constructor(
    private readonly driver: NativeWechatDriver | NativeBridge,
    private readonly now: () => Date = () => new Date(),
    private readonly settle: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 450)),
    private readonly options: NativeWechatSurfaceOptions = {},
  ) {}

  public bindDailyCareWriteContext(context: {
    slotKey: string;
    candidateHash: string;
    expiresAt: string;
  }): void {
    const expiry = new Date(context.expiresAt);
    const current = this.now();
    if (!/^\d{4}-\d{2}-\d{2}\/(?:morning|night)$/u.test(context.slotKey) ||
        !/^[a-f0-9]{64}$/u.test(context.candidateHash) ||
        !Number.isFinite(current.getTime()) || !Number.isFinite(expiry.getTime()) ||
        expiry.getTime() <= current.getTime() || expiry.getTime() - current.getTime() > 180_000) {
      throw new Error("DAILY_CARE_WRITE_CONTEXT_INVALID");
    }
    this.dailyCareWriteContext = { ...context };
  }

  /**
   * Captures the current WeChat window once for the read-only list detector.
   * This method deliberately performs no focus, click, draft, or submit action.
   */
  public async readConversationListSnapshot(): Promise<NativeConversationListSnapshot> {
    const window = await this.mainWindow();
    const imagePath = await this.driver.capture(window.windowID);
    const lines = await this.driver.ocr(imagePath);
    return Object.freeze({
      windowRevision: revision(window),
      lines: Object.freeze(lines.map((line) => structuredClone(line))),
    });
  }

  /** Reads the already-selected dynamic conversation without focus or mutation. */
  public async readAuthorizedConversationSnapshot(input: {
    readonly contactId: ContactId;
    readonly expectedRevision: number;
  }): Promise<NativeAuthorizedConversationSnapshot> {
    const target = await this.requireTextTarget(input.contactId, input.expectedRevision);
    const window = await this.mainWindow();
    const windowRevision = revision(window);
    const capturedAt = this.now();
    const initialLines = await this.readLines(window);
    let initialIdentity: AuthorizedIdentityMatch;
    try {
      initialIdentity = await this.matchAuthorizedIdentity(window, target);
    } catch {
      throw new Error("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
    }
    const lines = await this.readLines(window);
    let identity: AuthorizedIdentityMatch;
    try {
      identity = await this.matchAuthorizedIdentity(window, target);
    } catch {
      throw new Error("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
    }
    const currentWindow = await this.mainWindow();
    const currentTarget = await this.requireTextTarget(input.contactId, input.expectedRevision);
    if (revision(currentWindow) !== windowRevision || !sameAuthorizedTarget(currentTarget, target)) {
      throw new Error("WECHAT_AUTHORIZED_READ_BINDING_CHANGED");
    }
    if (!sameSelectedRow(initialIdentity, identity)) {
      throw new Error("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
    }
    const initialSelection = authorizedConversationSelection(initialLines, {
      target,
      capturedAt,
      windowRevision,
      identity: initialIdentity,
    });
    const selection = authorizedConversationSelection(lines, {
      target,
      capturedAt,
      windowRevision,
      identity,
    });
    if (initialSelection === null || selection === null ||
        initialSelection.continuityProof !== selection.continuityProof) {
      throw new Error("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
    }
    return Object.freeze({
      conversationId: target.contactId,
      identity: Object.freeze({
        conversationId: target.contactId,
        visibleName: target.displayName,
        enrollmentFingerprint: target.enrollmentFingerprint,
        observedFingerprint: identity.observedFingerprint,
        confidence: selection.confidence,
      }),
      messages: selection.messages,
      windowRevision,
      latestIncomingEvidence: selection.latestIncomingEvidence,
    });
  }

  public async locateConversation(id: ConversationId): Promise<ConversationSnapshot> {
    this.focusProof = null;
    this.activeConversation = null;
    const { window, lines, identity } = await this.selectConversation(id);
    await this.focusComposer(window, id);
    const composer = parseVisibleComposer(lines);
    const capturedAt = this.now();
    const messages = parseVisibleWechatMessages(lines, id, capturedAt);
    const unreadIndicator = parseUnreadIndicator(lines, id);
    const windowRevision = revision(window);
    const latestIncomingEvidence = parseLatestIncomingEvidence(lines, {
      conversationId: id,
      visibleName: names[id],
      messages,
      capturedAt,
      windowRevision,
    });
    this.activeConversation = id;
    this.focusProof = { conversationId: id, window, windowRevision };
    return {
      conversationId: id,
      identity: {
        conversationId: id,
        visibleName: names[id],
        avatarFingerprint: identity.enrollmentFingerprint,
        recentMessageFingerprint: identity.observedFingerprint,
        confidence: 0.99,
      },
      messages,
      draftText: composer.draftText,
      draftAlternatives: composer.draftAlternatives,
      composerEvidence: composer.evidence,
      unreadIndicator,
      windowRevision,
      ...(latestIncomingEvidence === null ? {} : { latestIncomingEvidence }),
    };
  }

  public async focusConversation(id: ConversationId, windowRevision: string): Promise<void> {
    const proof = this.focusProof;
    this.focusProof = null;
    this.activeConversation = null;
    if (
      proof === null ||
      proof.conversationId !== id ||
      proof.windowRevision !== windowRevision ||
      revision(proof.window) !== windowRevision
    ) {
      throw new Error("CONVERSATION_FOCUS_PROOF_MISMATCH");
    }
    const window = await this.mainWindow();
    if (revision(window) !== windowRevision) throw new Error("WINDOW_REVISION_CHANGED");
    await this.focusComposer(window, id);
    this.activeConversation = id;
  }

  public async replaceDraft(id: ConversationId, text: string, token: string): Promise<void> {
    this.focusProof = null;
    this.activeConversation = null;
    const { window } = await this.selectConversation(id);
    if (this.dailyCareWriteContext !== null &&
        this.dailyCareWriteContext.candidateHash !== sha256Canonical(text)) {
      throw new Error("WRITE_CAPABILITY_CANDIDATE_MISMATCH");
    }
    await this.focusComposer(window, id, token, text);
    await this.assertCurrentConversation(window, id);
    const receipt = await this.driver.typeText(
      this.textMutationRequest(window, id, token, "replace-draft", text),
    );
    await this.settle();
    if (receipt.cleared || canonicalComposerText(receipt.text) !== canonicalComposerText(text)) {
      throw new Error("DRAFT_WRITE_NOT_VERIFIED");
    }
    if (text.endsWith(`\n${ASSISTANT_SIGNATURE}`)) {
      const written = parseVisibleComposer(await this.readLines(window));
      if (!written.signatureLineProven) {
        throw new Error("DRAFT_WRITE_NOT_VERIFIED");
      }
    }
    this.activeConversation = id;
    this.preparedDraft = canonicalComposerText(text);
    this.preparedWindowRevision = revision(window);
  }

  public async clearDraft(id: ConversationId, token: string): Promise<void> {
    this.focusProof = null;
    this.activeConversation = null;
    const { window } = await this.selectConversation(id);
    await this.focusComposer(window, id, token, "");
    await this.assertCurrentConversation(window, id);
    const receipt = await this.driver.typeText(
      this.textMutationRequest(window, id, token, "clear-draft", ""),
    );
    await this.settle();
    if (!receipt.cleared || canonicalComposerText(receipt.text) !== "" ||
        parseVisibleComposer(await this.readLines(window)).evidence !== "proven-empty") {
      throw new Error("DRAFT_CLEAR_NOT_VERIFIED");
    }
    this.activeConversation = id;
    this.preparedDraft = null;
    this.preparedWindowRevision = null;
  }

  public async prepareAuthorizedTextDraft(input: {
    contactId: ContactId;
    expectedRevision: number;
    text: string;
    slotKey: string;
  }): Promise<void> {
    this.focusProof = null;
    this.activeConversation = null;
    this.authorizedTextDraft = null;
    const target = await this.requireTextTarget(input.contactId, input.expectedRevision);
    if (input.text === "" || !/^(?:\d{4}-\d{2}-\d{2}\/(?:morning|night)|non-daily\/[a-f0-9]{64})$/u.test(
      input.slotKey,
    )) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    const window = await this.mainWindow();
    await this.selectAuthorizedConversation(window, target, input.slotKey);
    await this.focusAuthorizedComposer(window, target, input.slotKey, "");
    await this.assertAuthorizedCurrentConversation(window, target);
    const capability = await this.dynamicCapability(
      target,
      "replace-draft",
      input.text,
      input.slotKey,
      window,
    );
    const receipt = await this.driver.typeText({
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: target.displayName,
      token: capability.capabilityId,
      slotKey: input.slotKey,
      text: input.text,
      capability,
    });
    await this.settle();
    if (receipt.cleared || canonicalComposerText(receipt.text) !== canonicalComposerText(input.text)) {
      throw new Error("DRAFT_WRITE_NOT_VERIFIED");
    }
    this.authorizedTextDraft = {
      target,
      slotKey: input.slotKey,
      text: canonicalComposerText(input.text),
      windowRevision: revision(window),
    };
  }

  public async submitAuthorizedTextDraft(input: {
    contactId: ContactId;
    expectedRevision: number;
    markSubmitStarted: () => Promise<boolean>;
    signal: AbortSignal;
    conversationProof: NativeSubmitConversationProof;
  }): Promise<{ readonly attempted: true } | { readonly attempted: false }> {
    const prepared = this.authorizedTextDraft;
    this.authorizedTextDraft = null;
    if (prepared === null) throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    const target = await this.requireTextTarget(input.contactId, input.expectedRevision);
    if (!sameAuthorizedTarget(target, prepared.target)) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    const window = await this.mainWindow();
    if (revision(window) !== prepared.windowRevision) throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    await this.focusAuthorizedComposer(window, target, prepared.slotKey, "");
    await this.assertAuthorizedCurrentConversation(window, target);
    // The OCR baseline is deliberately captured only after every pre-submit binding
    // check.  A post-submit readback may only prove a newly appended bubble, never
    // an already visible historical message with the same text.
    const baseline = parseVisibleWechatMessageCandidates(await this.readLines(window));
    const capability = await this.dynamicCapability(
      target,
      "submit-draft",
      prepared.text,
      prepared.slotKey,
      window,
      input.conversationProof,
    );
    const submit = await this.driver.submitWechatDraft(
      {
        windowID: window.windowID,
        bundleID,
        title: mainWindowTitle,
        conversationTitle: target.displayName,
        token: capability.capabilityId,
        slotKey: prepared.slotKey,
        draftText: prepared.text,
        conversationProof: input.conversationProof,
        capability,
      },
      { signal: input.signal, markSubmitStarted: input.markSubmitStarted },
    );
    if (!submit.attempted) return { attempted: false };
    await this.settle();
    const verifiedTarget = await this.requireTextTarget(input.contactId, input.expectedRevision);
    const verifiedWindow = await this.mainWindow();
    if (!sameAuthorizedTarget(verifiedTarget, target) ||
        revision(verifiedWindow) !== prepared.windowRevision) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    await this.assertAuthorizedCurrentConversation(verifiedWindow, verifiedTarget);
    const candidates = parseVisibleWechatMessageCandidates(await this.readLines(verifiedWindow));
    if (!isSingleMonotonicOutgoingAppend(baseline, candidates, prepared.text)) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    return { attempted: true };
  }

  public async clearAuthorizedTextDraft(input: {
    contactId: ContactId;
    expectedRevision: number;
    slotKey: string;
  }): Promise<void> {
    this.focusProof = null;
    this.activeConversation = null;
    this.authorizedTextDraft = null;
    const target = await this.requireTextTarget(input.contactId, input.expectedRevision);
    if (!/^(?:\d{4}-\d{2}-\d{2}\/(?:morning|night)|non-daily\/[a-f0-9]{64})$/u.test(
      input.slotKey,
    )) throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    const window = await this.mainWindow();
    await this.selectAuthorizedConversation(window, target, input.slotKey);
    await this.focusAuthorizedComposer(window, target, input.slotKey, "");
    await this.assertAuthorizedCurrentConversation(window, target);
    const capability = await this.dynamicCapability(target, "clear-draft", "", input.slotKey, window);
    const receipt = await this.driver.typeText({
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: target.displayName,
      token: capability.capabilityId,
      slotKey: input.slotKey,
      text: "",
      capability,
    });
    await this.settle();
    if (!receipt.cleared || canonicalComposerText(receipt.text) !== "" ||
        parseVisibleComposer(await this.readLines(window)).evidence !== "proven-empty") {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    const verifiedTarget = await this.requireTextTarget(input.contactId, input.expectedRevision);
    const verifiedWindow = await this.mainWindow();
    if (!sameAuthorizedTarget(verifiedTarget, target) || revision(verifiedWindow) !== revision(window)) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    await this.assertAuthorizedCurrentConversation(verifiedWindow, verifiedTarget);
    if (parseVisibleComposer(await this.readLines(verifiedWindow)).evidence !== "proven-empty") {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
  }

  public async prepareImageAttachment(
    id: "file-transfer",
    image: { path: string; sha256: string; width: 1080; height: 1350 },
    token: string,
  ): Promise<WechatImageAttachmentReceipt> {
    this.focusProof = null;
    this.activeConversation = null;
    this.preparedDraft = null;
    this.preparedWindowRevision = null;
    if (id !== "file-transfer") throw new Error("WECHAT_IMAGE_ATTACHMENT_TARGET_NOT_ALLOWED");
    if (!/^[a-f0-9]{64}$/u.test(token) || !/^[a-f0-9]{64}$/u.test(image.sha256) ||
        !path.isAbsolute(image.path) || image.width !== 1080 || image.height !== 1350) {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_INVALID");
    }
    if (this.usedCapabilityIds.has(token)) throw new Error("WRITE_CAPABILITY_ALREADY_USED");
    const window = await this.mainWindow();
    await this.assertCurrentConversation(window, id);
    const slotKey = `non-daily/${sha256(token)}`;
    const request: WechatImageAttachmentRequest = {
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: "文件传输助手",
      token,
      slotKey,
      imagePath: image.path,
      imageSha256: image.sha256,
      width: image.width,
      height: image.height,
      capability: {
        version: 1,
        capabilityId: token,
        action: "attach-image",
        candidateHash: image.sha256,
        slotHash: sha256(slotKey),
        identityFingerprint: titleIdentityFingerprint(id, window),
        windowRevision: revision(window),
        expiresAt: new Date(this.now().getTime() + 15_000).toISOString(),
      },
    };
    this.usedCapabilityIds.add(token);
    const receipt = await this.driver.prepareWechatImageAttachment(request);
    if (receipt.imageSha256 !== image.sha256 || receipt.width !== image.width ||
        receipt.height !== image.height || receipt.attachmentCount !== 1 || !receipt.textEmpty) {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_NOT_VERIFIED");
    }
    return receipt;
  }

  public async sendComfortStationCard(input: {
    path: string;
    sha256: string;
    width: 1080;
    height: 1350;
    deliveryKey: string;
    token: string;
  }): Promise<WechatImageSendReceipt> {
    this.focusProof = null;
    this.activeConversation = null;
    this.preparedDraft = null;
    this.preparedWindowRevision = null;
    if (!path.isAbsolute(input.path) || !/^[a-f0-9]{64}$/u.test(input.sha256) ||
        !/^[a-f0-9]{64}$/u.test(input.deliveryKey) ||
        !/^[a-f0-9]{64}$/u.test(input.token) ||
        input.width !== 1080 || input.height !== 1350) {
      throw new Error("WECHAT_IMAGE_SEND_INVALID");
    }
    if (this.usedCapabilityIds.has(input.token)) throw new Error("WRITE_CAPABILITY_ALREADY_USED");
    const window = await this.mainWindow();
    await this.assertCurrentConversation(window, "example-contact");
    const slotKey = `non-daily/${input.deliveryKey}`;
    const request: WechatImageSendRequest = {
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: "示例联系人",
      token: input.token,
      slotKey,
      imagePath: input.path,
      imageSha256: input.sha256,
      width: input.width,
      height: input.height,
      capability: {
        version: 1,
        capabilityId: input.token,
        action: "send-image",
        candidateHash: input.sha256,
        slotHash: sha256(slotKey),
        identityFingerprint: titleIdentityFingerprint("example-contact", window),
        windowRevision: revision(window),
        expiresAt: new Date(this.now().getTime() + 15_000).toISOString(),
      },
    };
    this.usedCapabilityIds.add(input.token);
    const receipt = await this.driver.sendWechatImage(request);
    if (receipt.imageSha256 !== input.sha256 || receipt.width !== 1080 ||
        receipt.height !== 1350 || receipt.attachmentCount !== 1 || !receipt.textEmpty ||
        !receipt.submitted || !receipt.outgoingImageMatched ||
        receipt.visualFingerprintVersion !== "vision-featureprint-v1") {
      throw new Error("WECHAT_IMAGE_SEND_NOT_VERIFIED");
    }
    return receipt;
  }

  public async recoverImageAttachmentQuarantine(): Promise<WechatImageQuarantineRecoveryReceipt> {
    this.focusProof = null;
    this.activeConversation = null;
    this.preparedDraft = null;
    this.preparedWindowRevision = null;
    if (this.driver.recoverWechatImageQuarantine === undefined) {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_RECOVERY_UNAVAILABLE");
    }
    const window = await this.mainWindow();
    await this.assertCurrentConversation(window, "example-contact");
    const receipt = await this.driver.recoverWechatImageQuarantine({
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: "示例联系人",
    });
    if (!receipt.composerEmpty ||
        (receipt.status === "recovered") !== /^dirty-archive-[a-f0-9]{64}$/u.test(
          receipt.archiveName,
        ) || (receipt.status === "already-clean" && receipt.archiveName !== "")) {
      throw new Error("WECHAT_IMAGE_ATTACHMENT_RECOVERY_NOT_VERIFIED");
    }
    return receipt;
  }

  public async submitDraft(id: ConversationId, token: string): Promise<void> {
    this.focusProof = null;
    if (this.usedCapabilityIds.has(token)) throw new Error("WRITE_CAPABILITY_ALREADY_USED");
    if (this.activeConversation !== id) throw new Error("ACTIVE_CONVERSATION_MISMATCH");
    const draftText = this.preparedDraft;
    if (draftText === null) throw new Error("WRITE_CAPABILITY_BINDING_REQUIRED");
    const window = await this.mainWindow();
    const windowRevision = revision(window);
    if (this.preparedWindowRevision !== windowRevision) throw new Error("WINDOW_REVISION_CHANGED");
    await this.focusComposer(window, id, token, draftText);
    const identity = await this.assertCurrentConversation(window, id);
    const expiresAt = this.dailyCareWriteContext?.expiresAt ??
      new Date(this.now().getTime() + 15_000).toISOString();
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= this.now().getTime()) {
      throw new Error("WRITE_CAPABILITY_EXPIRED");
    }
    const candidateHash = sha256Canonical(draftText);
    const context = this.dailyCareWriteContext;
    if (context !== null && context.candidateHash !== candidateHash) {
      throw new Error("WRITE_CAPABILITY_CANDIDATE_MISMATCH");
    }
    const slotKey = context?.slotKey ?? `non-daily/${sha256(token)}`;
    this.usedCapabilityIds.add(token);
    await this.driver.submitWechatDraft({
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: names[id],
      token,
      slotKey,
      draftText,
      capability: {
        version: 1,
        capabilityId: token,
        candidateHash,
        slotHash: sha256(slotKey),
          identityFingerprint: identity.enrollmentFingerprint,
        windowRevision,
        expiresAt,
      },
    });
    await this.settle();
  }

  private async selectConversation(id: ConversationId): Promise<{
    window: WindowDescriptor;
    lines: OCRLine[];
    identity: { enrollmentFingerprint: string; observedFingerprint: string };
  }> {
    const window = await this.mainWindow();
    let lines = await this.readLines(window);
    if (this.options.identityEnrollments?.[id] === undefined) {
      if (!hasUniqueHeader(lines, names[id])) {
        const minimumLabelConfidence = id === "file-transfer" ? 0.25 : 0.5;
        const labels = findConversationLabels(lines, id).filter(
          ({ confidence }) => confidence >= minimumLabelConfidence,
        );
        if (labels.length === 0) throw new Error("WECHAT_CONVERSATION_LABEL_NOT_VISIBLE");
        if (labels.length !== 1) throw new Error("WECHAT_CONVERSATION_LABEL_NOT_UNIQUE");
        const label = labels[0];
        if (label === undefined) throw new Error("WECHAT_CONVERSATION_LABEL_NOT_UNIQUE");
        const token = createToken();
        await this.driver.clickWechatWindowPoint(this.clickMutationRequest(
          window,
          id,
          token,
          "conversation-list",
          0.22,
          Math.min(0.95, Math.max(0.05, 1 - centerY(label))),
        ));
        await this.settle();
        lines = await this.readLines(window);
      }
      if (!hasUniqueHeader(lines, names[id])) throw new Error("WECHAT_CONVERSATION_HEADER_MISMATCH");
      const fingerprint = titleIdentityFingerprint(id, window);
      return {
        window,
        lines,
        identity: {
          enrollmentFingerprint: fingerprint,
          observedFingerprint: fingerprint,
        },
      };
    }
    const identity = await this.matchEnrolledIdentity(window, id);
    if (!hasUniqueHeader(lines, names[id]) || identity.candidateCount > 1) {
      const label = { bounds: { y: identity.normalizedY, height: 0 } } as OCRLine;
      const center = 1 - centerY(label);
      const points = [
        { x: 0.12, y: center },
        { x: 0.22, y: center },
        { x: 0.12, y: center + 0.04 },
        { x: 0.22, y: center + 0.04 },
        { x: 0.12, y: center - 0.04 },
        { x: 0.22, y: center - 0.04 },
      ];
      for (const point of points) {
        const token = createToken();
        await this.driver.clickWechatWindowPoint(this.clickMutationRequest(
          window,
          id,
          token,
          "conversation-list",
          point.x,
          Math.min(0.95, Math.max(0.05, point.y)),
        ));
        await this.settle();
        lines = await this.readLines(window);
        if (hasUniqueHeader(lines, names[id])) break;
      }
    }
    if (!hasUniqueHeader(lines, names[id])) throw new Error("WECHAT_CONVERSATION_HEADER_MISMATCH");
    return {
      window,
      lines,
      identity: {
        enrollmentFingerprint: identity.enrollmentFingerprint,
        observedFingerprint: identity.observedFingerprint,
      },
    };
  }

  private async selectAuthorizedConversation(
    window: WindowDescriptor,
    target: AuthorizedWechatTarget,
    slotKey: string,
  ): Promise<void> {
    let lines = await this.readLines(window);
    if (!hasUniqueAuthorizedHeader(lines, target.displayName)) {
      const match = await this.locateAuthorizedIdentity(window, target);
      const capability = await this.dynamicCapability(target, "select-conversation", "", slotKey, window);
      await this.driver.clickWechatWindowPoint({
        windowID: window.windowID,
        bundleID,
        title: mainWindowTitle,
        conversationTitle: target.displayName,
        region: "conversation-list",
        normalizedX: 0.22,
        normalizedY: Math.min(0.95, Math.max(0.05, 1 - match.normalizedY)),
        token: capability.capabilityId,
        slotKey,
        capability,
      });
      await this.settle();
      lines = await this.readLines(window);
    }
    await this.matchAuthorizedIdentity(window, target);
    if (!hasUniqueAuthorizedHeader(lines, target.displayName)) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
  }

  private async focusAuthorizedComposer(
    window: WindowDescriptor,
    target: AuthorizedWechatTarget,
    slotKey: string,
    draftText: string,
  ): Promise<void> {
    const capability = await this.dynamicCapability(target, "focus-composer", draftText, slotKey, window);
    await this.driver.clickWechatWindowPoint({
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: target.displayName,
      region: "composer",
      normalizedX: 0.68,
      normalizedY: 0.82,
      token: capability.capabilityId,
      slotKey,
      capability,
    });
    await this.settle();
  }

  private async assertAuthorizedCurrentConversation(
    window: WindowDescriptor,
    target: AuthorizedWechatTarget,
  ): Promise<void> {
    await this.matchAuthorizedIdentity(window, target);
    if (!hasUniqueAuthorizedHeader(await this.readLines(window), target.displayName)) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
  }

  private async matchAuthorizedIdentity(
    window: WindowDescriptor,
    target: AuthorizedWechatTarget,
  ): Promise<AuthorizedIdentityMatch> {
    const matches = await this.driver.matchWechatIdentityRows({
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: target.displayName,
      proofPhase: "selected",
      enrollment: target.enrollment,
    });
    const expectedTitle = target.displayName.normalize("NFC").trim();
    const thresholdMatches = matches.filter((match) =>
      match.distance <= WechatIdentityEnrollmentRepository.maximumDistance
    );
    if (thresholdMatches.length !== 1) throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    const match = thresholdMatches[0];
    if (match === undefined || match.proofPhase !== "selected" || !match.selected ||
        match.selectedRowTitle === null || match.selectedRowNormalizedY === null ||
        match.selectionProofHash === null) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    const expectedSelectionProof = selectedRowProofHash(
      expectedTitle,
      match.selectedRowNormalizedY,
      revision(window),
    );
    if (match.fingerprintVersion !== target.enrollment.fingerprintVersion ||
        match.selectedRowTitle.normalize("NFC").trim() !== expectedTitle ||
        Math.abs(match.selectedRowNormalizedY - match.normalizedY) > 0.04 ||
        !safeHashEqual(match.selectionProofHash, expectedSelectionProof)) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    return Object.freeze({
      proofPhase: "selected" as const,
      normalizedY: match.normalizedY,
      observedFingerprint: match.observedFingerprint,
      selectedRowTitle: match.selectedRowTitle.normalize("NFC").trim(),
      selectedRowNormalizedY: match.selectedRowNormalizedY,
      selectionProofHash: match.selectionProofHash,
    });
  }

  private async locateAuthorizedIdentity(
    window: WindowDescriptor,
    target: AuthorizedWechatTarget,
  ): Promise<AuthorizedPreClickIdentityMatch> {
    const matches = await this.driver.matchWechatIdentityRows({
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: target.displayName,
      proofPhase: "pre-click",
      enrollment: target.enrollment,
    });
    const thresholdMatches = matches.filter((match) =>
      match.distance <= WechatIdentityEnrollmentRepository.maximumDistance
    );
    if (thresholdMatches.length !== 1) throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    const match = thresholdMatches[0];
    if (match === undefined || match.proofPhase !== "pre-click" || match.selected ||
        match.fingerprintVersion !== target.enrollment.fingerprintVersion) {
      throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    }
    return Object.freeze({
      proofPhase: "pre-click" as const,
      normalizedY: match.normalizedY,
      observedFingerprint: match.observedFingerprint,
    });
  }

  private dynamicCapability(
    target: AuthorizedWechatTarget,
    action: NativeTextTargetCapabilityAction,
    draftText: string,
    slotKey: string,
    window: WindowDescriptor,
    conversationProof?: NativeSubmitConversationProof,
  ): Promise<NativeTextTargetCapabilityV2 | BoundNativeTextTargetCapabilityV2> {
    const keyProvider = this.options.nativeCapabilityKeyProvider ??
      defaultNativeTextTargetCapabilityKeyProvider;
    return issueNativeTextTargetCapability({
      target,
      action,
      draftText,
      slotKey,
      windowRevision: revision(window),
      expiresAt: new Date(this.now().getTime() + 15_000).toISOString(),
      capabilityId: createToken(),
      keyProvider,
      now: this.now,
    }).then((capability) =>
      action === "submit-draft"
        ? bindNativeTextTargetRequest({
        capability,
        windowID: window.windowID,
        bundleID,
        title: mainWindowTitle,
        conversationTitle: target.displayName,
        token: capability.capabilityId,
        slotKey,
        draftText,
        conversationProof: conversationProof!,
        keyProvider,
          })
        : capability,
    );
  }

  private async requireTextTarget(
    contactId: ContactId,
    expectedRevision: number,
  ): Promise<AuthorizedWechatTarget> {
    const directory = this.options.textTargetDirectory;
    if (directory === undefined) throw new Error("WECHAT_CONTACT_CAPABILITY_INVALID");
    return directory.requireTextTarget(contactId, expectedRevision);
  }

  private async assertCurrentConversation(window: WindowDescriptor, id: ConversationId): Promise<{
    enrollmentFingerprint: string;
  }> {
    if (this.options.identityEnrollments?.[id] === undefined) {
      if (!hasUniqueHeader(await this.readLines(window), names[id])) {
        throw new Error("WECHAT_CONVERSATION_HEADER_MISMATCH");
      }
      return { enrollmentFingerprint: titleIdentityFingerprint(id, window) };
    }
    const identity = await this.matchEnrolledIdentity(window, id);
    if (!hasUniqueHeader(await this.readLines(window), names[id])) {
      throw new Error("WECHAT_CONVERSATION_HEADER_MISMATCH");
    }
    return { enrollmentFingerprint: identity.enrollmentFingerprint };
  }

  private async matchEnrolledIdentity(window: WindowDescriptor, id: ConversationId): Promise<{
    normalizedY: number;
    enrollmentFingerprint: string;
    observedFingerprint: string;
    candidateCount: number;
  }> {
    const enrollment = this.requireEnrollment(id);
    if (enrollment.fingerprintVersion !== "vision-featureprint-v1") {
      throw new Error("WECHAT_IDENTITY_ENROLLMENT_VERSION_MISMATCH");
    }
    const matches = await this.driver.matchWechatIdentityRows({
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: names[id],
      enrollment,
    });
    if (matches.some(({ fingerprintVersion }) => fingerprintVersion !== enrollment.fingerprintVersion)) {
      throw new Error("WECHAT_IDENTITY_ENROLLMENT_VERSION_MISMATCH");
    }
    const accepted = matches.filter(({ distance }) =>
      distance <= WechatIdentityEnrollmentRepository.maximumDistance
    );
    if (accepted.length === 0) throw new Error("WECHAT_ENROLLED_IDENTITY_NOT_MATCHED");
    if (accepted.length !== 1) throw new Error("WECHAT_ENROLLED_IDENTITY_NOT_UNIQUE");
    const match = accepted[0];
    if (match === undefined) throw new Error("WECHAT_ENROLLED_IDENTITY_NOT_MATCHED");
    return {
      normalizedY: match.normalizedY,
      enrollmentFingerprint: wechatIdentityEnrollmentFingerprint(enrollment),
      observedFingerprint: match.observedFingerprint,
      candidateCount: matches.length,
    };
  }

  private requireEnrollment(id: ConversationId): WechatIdentityEnrollment {
    const enrollment = this.options.identityEnrollments?.[id];
    if (enrollment === undefined) throw new Error("WECHAT_IDENTITY_ENROLLMENT_REQUIRED");
    return enrollment;
  }

  private async focusComposer(
    window: WindowDescriptor,
    id: ConversationId,
    token = createToken(),
    draftText = "",
  ): Promise<void> {
    await this.driver.clickWechatWindowPoint(this.clickMutationRequest(
      window,
      id,
      token,
      "composer",
      0.68,
      0.82,
      draftText,
    ));
    await this.settle();
  }

  private textMutationRequest(
    window: WindowDescriptor,
    id: ConversationId,
    token: string,
    action: "replace-draft" | "clear-draft",
    text: string,
  ): WechatTextMutationRequest {
    const { slotKey, capability } = this.mutationCapability(window, id, token, action, text);
    return {
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: names[id],
      token,
      slotKey,
      text,
      capability,
    };
  }

  private clickMutationRequest(
    window: WindowDescriptor,
    id: ConversationId,
    token: string,
    region: WechatWindowClickRequest["region"],
    normalizedX: number,
    normalizedY: number,
    draftText = "",
  ): WechatWindowClickRequest {
    const action = region === "conversation-list" ? "select-conversation" : "focus-composer";
    const { slotKey, capability } = this.mutationCapability(window, id, token, action, draftText);
    return {
      windowID: window.windowID,
      bundleID,
      title: mainWindowTitle,
      conversationTitle: names[id],
      region,
      normalizedX,
      normalizedY,
      token,
      slotKey,
      capability,
    };
  }

  private mutationCapability(
    window: WindowDescriptor,
    id: ConversationId,
    token: string,
    action: WechatMutationAction,
    text: string,
  ): { slotKey: string; capability: WechatMutationCapability } {
    const context = this.dailyCareWriteContext;
    const slotKey = context?.slotKey ?? `non-daily/${sha256(token)}`;
    const candidateHash = action === "replace-draft"
      ? sha256Canonical(text)
      : context?.candidateHash ?? sha256Canonical(text);
    const expiresAt = context?.expiresAt ?? new Date(this.now().getTime() + 15_000).toISOString();
    return {
      slotKey,
      capability: {
        version: 1,
        capabilityId: token,
        action,
        candidateHash,
        slotHash: sha256(slotKey),
        identityFingerprint: titleIdentityFingerprint(id, window),
        windowRevision: revision(window),
        expiresAt,
      },
    };
  }

  private async mainWindow(): Promise<WindowDescriptor> {
    const matches = (await this.driver.listWindows(bundleID)).filter((window) => window.title === mainWindowTitle);
    if (matches.length !== 1) throw new Error("WECHAT_MAIN_WINDOW_NOT_UNIQUE");
    const window = matches[0];
    if (window === undefined) throw new Error("WECHAT_MAIN_WINDOW_NOT_FOUND");
    return window;
  }

  private async readLines(window: WindowDescriptor): Promise<OCRLine[]> {
    return this.driver.ocr(await this.driver.capture(window.windowID));
  }
}

export function parseVisibleWechatMessages(
  lines: OCRLine[],
  conversationId: ConversationId,
  capturedAt: Date,
): ChatMessage[] {
  const candidates = parseVisibleWechatMessageCandidates(lines);
  return candidates.map(({ text, direction, confidence }) => {
    const id = createHash("sha256").update(`${conversationId}\0${direction}\0${text}`).digest("hex");
    return {
      id,
      conversationId,
      direction,
      kind: "text" as const,
      text,
      occurredAt: capturedAt.toISOString(),
      source: "wechat" as const,
      confidence,
    };
  });
}

interface VisibleWechatMessageCandidate {
  readonly direction: ChatMessage["direction"];
  readonly text: string;
  readonly confidence: number;
}

function isSingleMonotonicOutgoingAppend(
  baseline: VisibleWechatMessageCandidate[],
  current: VisibleWechatMessageCandidate[],
  expectedText: string,
): boolean {
  // Candidate equality intentionally includes OCR confidence. If OCR reorders,
  // truncates, or changes any baseline evidence, there is no safe proof that the
  // observed bubble was created by this submit.
  if (current.length !== baseline.length + 1 || !baseline.every((candidate, index) =>
    sameVisibleWechatMessageCandidate(candidate, current[index]),
  )) return false;
  const appended = current.at(-1);
  return appended !== undefined && appended.direction === "outgoing" &&
    canonicalComposerText(appended.text) === expectedText;
}

function sameVisibleWechatMessageCandidate(
  left: VisibleWechatMessageCandidate,
  right: VisibleWechatMessageCandidate | undefined,
): boolean {
  return right !== undefined && left.direction === right.direction && left.text === right.text &&
    left.confidence === right.confidence;
}

function parseVisibleWechatMessageCandidates(lines: OCRLine[]): VisibleWechatMessageCandidate[] {
  const candidates = [...lines]
    .filter((line) => line.confidence >= 0.5)
    .filter((line) => line.bounds.x >= 0.38 && line.bounds.y >= 0.4 && line.bounds.y <= 0.86)
    .filter((line) => /[\p{L}\p{N}]/u.test(line.text))
    .filter((line) => !/^(?:昨天\s*)?\d{1,2}:\d{2}$/u.test(line.text.trim()))
    .sort((left, right) => right.bounds.y - left.bounds.y || left.bounds.x - right.bounds.x);
  return mergeWrappedLines(candidates).map((group) => {
    const text = group.map((line) => line.text.replace(/\s+/gu, " ").trim()).join("");
    const direction: ChatMessage["direction"] = Math.max(...group.map(centerX)) >= 0.64 ? "outgoing" : "incoming";
    return {
      direction,
      text,
      confidence: Math.min(...group.map((line) => line.confidence)),
    };
  });
}

export function parseLatestIncomingEvidence(
  lines: OCRLine[],
  input: {
    conversationId: ConversationId;
    visibleName: string;
    messages: ChatMessage[];
    capturedAt: Date;
    windowRevision: string;
  },
): LatestIncomingEvidence | null {
  if (input.conversationId !== "example-contact" || !Number.isFinite(input.capturedAt.getTime()) ||
      !/^[a-f0-9]{64}$/u.test(input.windowRevision)) {
    return null;
  }
  const latest = input.messages.at(-1);
  if (latest === undefined || latest.direction !== "incoming" || latest.confidence < 0.5) {
    return null;
  }
  const labels = lines.filter((line) =>
    line.bounds.x < conversationListMaxX && line.confidence >= 0.9 &&
    normalizeEvidenceText(line.text) === normalizeEvidenceText(input.visibleName)
  );
  if (labels.length !== 1) return null;
  const label = labels[0];
  if (label === undefined) return null;
  const labelCenter = centerY(label);
  const rowTimes = lines.filter((line) =>
    line.bounds.x < conversationListMaxX && line.confidence >= 0.5 &&
    parseClockMinute(line.text) !== null && Math.abs(centerY(line) - labelCenter) <= 0.04
  );
  if (rowTimes.length !== 1) return null;
  const rowTime = rowTimes[0];
  if (rowTime === undefined) return null;
  const observedMinute = parseClockMinute(rowTime.text);
  if (observedMinute === null || !isFreshClockMinute(observedMinute, input.capturedAt)) return null;
  const paneTimes = lines.filter((line) =>
    line.bounds.x >= conversationHeaderMinX && line.bounds.y >= 0.4 && line.bounds.y <= 0.86 &&
    line.confidence >= 0.5 && parseClockMinute(line.text) === observedMinute
  );
  if (paneTimes.length !== 1) return null;
  const previews = lines.filter((line) => {
    if (line === label || line === rowTime || line.bounds.x >= conversationListMaxX ||
        line.confidence < 0.5 || !/[\p{L}\p{N}]/u.test(line.text)) {
      return false;
    }
    const verticalOffset = labelCenter - centerY(line);
    return verticalOffset >= 0.015 && verticalOffset <= 0.08;
  });
  if (previews.length !== 1) return null;
  const preview = previews[0];
  const paneTime = paneTimes[0];
  if (preview === undefined || paneTime === undefined) return null;
  const previewKey = normalizeEvidenceText(preview.text).replace(/[….]+$/u, "");
  const messageKey = normalizeEvidenceText(latest.text);
  if (previewKey.length < 2 || !messageKey.startsWith(previewKey)) return null;
  const confidence = Math.min(
    label.confidence,
    rowTime.confidence,
    paneTime.confidence,
    preview.confidence,
    latest.confidence,
  );
  return {
    version: 1,
    proofId: sha256([
      "wechat-fresh-latest-incoming-v1",
      input.conversationId,
      input.visibleName,
      observedMinute,
      previewKey,
      latest.id,
      input.windowRevision,
    ].join("\0")),
    messageId: latest.id,
    observedMinute,
    confidence,
  };
}

function parseAuthorizedLatestIncomingEvidence(
  lines: readonly OCRLine[],
  input: {
    readonly target: AuthorizedWechatTarget;
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly direction: ChatMessage["direction"];
      readonly text: string;
      readonly confidence: number;
    }>;
    readonly capturedAt: Date;
    readonly windowRevision: string;
  },
) {
  const latest = input.messages.at(-1);
  if (latest === undefined || latest.direction !== "incoming" || latest.confidence < 0.5 ||
      !Number.isFinite(input.capturedAt.getTime()) || !/^[a-f0-9]{64}$/u.test(input.windowRevision)) {
    return null;
  }
  const expected = input.target.displayName.normalize("NFC").trim();
  const labels = lines.filter((line) => line.bounds.x < conversationListMaxX &&
    line.confidence >= 0.9 && line.text.normalize("NFC").trim() === expected);
  if (labels.length !== 1 || labels[0] === undefined) return null;
  const label = labels[0];
  const rowTimes = lines.filter((line) => line.bounds.x < conversationListMaxX &&
    line.confidence >= 0.5 && parseClockMinute(line.text) !== null &&
    Math.abs(centerY(line) - centerY(label)) <= 0.04);
  if (rowTimes.length !== 1 || rowTimes[0] === undefined) return null;
  const observedMinute = parseClockMinute(rowTimes[0].text);
  if (observedMinute === null || !isFreshClockMinute(observedMinute, input.capturedAt)) return null;
  const paneTimes = lines.filter((line) => line.bounds.x >= conversationHeaderMinX &&
    line.bounds.y >= 0.4 && line.bounds.y <= 0.86 && line.confidence >= 0.5 &&
    parseClockMinute(line.text) === observedMinute);
  const previews = lines.filter((line) => {
    if (line === label || line === rowTimes[0] || line.bounds.x >= conversationListMaxX ||
        line.confidence < 0.5 || !/[\p{L}\p{N}]/u.test(line.text)) return false;
    const offset = centerY(label) - centerY(line);
    return offset >= 0.015 && offset <= 0.08;
  });
  if (paneTimes.length !== 1 || paneTimes[0] === undefined ||
      previews.length !== 1 || previews[0] === undefined) return null;
  const previewKey = normalizeEvidenceText(previews[0].text).replace(/[….]+$/u, "");
  if (previewKey.length < 2 || !normalizeEvidenceText(latest.text).startsWith(previewKey)) return null;
  const confidence = Math.min(label.confidence, rowTimes[0].confidence, paneTimes[0].confidence,
    previews[0].confidence, latest.confidence);
  return {
    version: 1 as const,
    proofId: sha256(["wechat-authorized-fresh-latest-incoming-v1", input.target.contactId,
      String(input.target.revision), observedMinute, previewKey, latest.id, input.windowRevision].join("\0")),
    messageId: latest.id,
    observedMinute,
    confidence,
    contactId: input.target.contactId,
    contactRevision: input.target.revision,
    windowRevision: input.windowRevision,
  };
}

function authorizedConversationSelection(
  lines: readonly OCRLine[],
  input: {
    readonly target: AuthorizedWechatTarget;
    readonly capturedAt: Date;
    readonly windowRevision: string;
    readonly identity: AuthorizedIdentityMatch;
  },
) {
  const expected = input.target.displayName.normalize("NFC").trim();
  const labels = lines.filter((line) => line.bounds.x < conversationListMaxX &&
    line.confidence >= 0.9 && line.text.normalize("NFC").trim() === expected);
  const headers = lines.filter((line) => line.bounds.x >= conversationHeaderMinX &&
    line.bounds.y >= 0.86 && line.confidence >= 0.5 &&
    line.text.normalize("NFC").trim() === expected);
  const label = labels[0];
  const header = headers[0];
  if (labels.length !== 1 || headers.length !== 1 || label === undefined || header === undefined ||
      !Number.isFinite(input.identity.normalizedY) ||
      input.identity.selectedRowTitle !== expected ||
      Math.abs(input.identity.selectedRowNormalizedY - input.identity.normalizedY) > 0.04 ||
      Math.abs(centerY(label) - input.identity.selectedRowNormalizedY) > 0.04 ||
      !/^[a-f0-9]{64}$/u.test(input.identity.selectionProofHash)) {
    return null;
  }
  const messages = Object.freeze(parseVisibleWechatMessageCandidates([...lines]).map(
    ({ text, direction, confidence }) => Object.freeze({
      id: sha256([input.target.contactId, direction, text].join("\0")),
      conversationId: input.target.contactId,
      direction,
      kind: "text" as const,
      text,
      occurredAt: input.capturedAt.toISOString(),
      confidence,
    }),
  ));
  const latestIncomingEvidence = parseAuthorizedLatestIncomingEvidence(lines, {
    target: input.target,
    messages,
    capturedAt: input.capturedAt,
    windowRevision: input.windowRevision,
  });
  return Object.freeze({
    messages,
    ...(latestIncomingEvidence === null
      ? {}
      : { latestIncomingEvidence: Object.freeze(latestIncomingEvidence) }),
    confidence: Math.min(label.confidence, header.confidence),
    continuityProof: sha256([
      "wechat-authorized-selected-row-v2",
      input.target.contactId,
      String(input.target.revision),
      input.target.enrollmentFingerprint,
      input.windowRevision,
      input.identity.selectedRowTitle,
      String(input.identity.selectedRowNormalizedY),
      input.identity.selectionProofHash,
    ].join("\0")),
  });
}

function sameSelectedRow(left: AuthorizedIdentityMatch, right: AuthorizedIdentityMatch): boolean {
  return left.selectedRowTitle === right.selectedRowTitle &&
    left.selectionProofHash === right.selectionProofHash &&
    Math.abs(left.selectedRowNormalizedY - right.selectedRowNormalizedY) <= 0.005;
}

function normalizeEvidenceText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").trim();
}

function parseClockMinute(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function isFreshClockMinute(observedMinute: string, capturedAt: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(capturedAt);
  const currentHour = Number(parts.find(({ type }) => type === "hour")?.value);
  const currentMinute = Number(parts.find(({ type }) => type === "minute")?.value);
  const observed = parseClockMinute(observedMinute);
  if (!Number.isInteger(currentHour) || !Number.isInteger(currentMinute) || observed === null) {
    return false;
  }
  const [observedHourText, observedMinuteText] = observed.split(":");
  const observedTotal = Number(observedHourText) * 60 + Number(observedMinuteText);
  const currentTotal = (currentHour % 24) * 60 + currentMinute;
  const elapsed = (currentTotal - observedTotal + 24 * 60) % (24 * 60);
  return elapsed <= 15;
}

function mergeWrappedLines(lines: OCRLine[]): OCRLine[][] {
  const groups: OCRLine[][] = [];
  for (const line of lines) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    const verticalGap = previous === undefined
      ? Number.POSITIVE_INFINITY
      : previous.bounds.y - (line.bounds.y + line.bounds.height);
    if (
      previousGroup !== undefined &&
      previous !== undefined &&
      Math.abs(previous.bounds.x - line.bounds.x) <= 0.015 &&
      verticalGap >= -0.005 &&
      verticalGap <= 0.02
    ) {
      previousGroup.push(line);
    } else {
      groups.push([line]);
    }
  }
  return groups;
}

function findConversationLabels(lines: OCRLine[], id: ConversationId): OCRLine[] {
  return lines.filter((line) => {
    if (line.bounds.x >= conversationListMaxX) return false;
    const text = line.text.replace(/[.…]+$/u, "");
    return id === "file-transfer" ? text.startsWith("文件传输") : text === names[id];
  });
}

function parseUnreadIndicator(
  lines: OCRLine[],
  id: ConversationId,
): boolean | null {
  if (id !== "example-contact") return null;
  const labels = findConversationLabels(lines, id);
  if (labels.length !== 1) return null;
  const label = labels[0];
  if (label === undefined || label.confidence < 0.9) return null;
  const labelCenterY = centerY(label);
  return lines.some((line) => {
    const text = line.text.trim();
    const rightEdge = line.bounds.x + line.bounds.width;
    const horizontalGap = label.bounds.x - rightEdge;
    return (
      line !== label &&
      line.confidence >= 0.5 &&
      /^(?:[1-9]|[1-9]\d)$/u.test(text) &&
      line.bounds.x >= 0.02 &&
      line.bounds.x < 0.36 &&
      line.bounds.width <= 0.05 &&
      horizontalGap >= 0.005 &&
      horizontalGap <= 0.05 &&
      Math.abs(centerY(line) - labelCenterY) <= 0.03
    );
  });
}

function hasUniqueHeader(lines: OCRLine[], expected: string): boolean {
  const headers = lines.filter((line) =>
    line.bounds.x >= conversationHeaderMinX && line.bounds.y >= 0.86 &&
    line.text === expected && line.confidence >= 0.5
  );
  if (headers.length !== 1) return false;
  const header = headers[0];
  if (header === undefined) return false;
  if (header.confidence >= 0.9) return true;
  const id = expected === names["example-contact"] ? "example-contact" :
    expected === names["file-transfer"] ? "file-transfer" : null;
  return id !== null && findConversationLabels(lines, id).filter(
    ({ confidence }) => confidence >= 0.9,
  ).length === 1;
}

function hasUniqueAuthorizedHeader(lines: OCRLine[], expected: string): boolean {
  const headers = lines.filter((line) =>
    line.bounds.x >= conversationHeaderMinX && line.bounds.y >= 0.86 &&
    line.text.normalize("NFC") === expected.normalize("NFC") && line.confidence >= 0.5
  );
  const labels = lines.filter((line) =>
    line.bounds.x < conversationListMaxX &&
    line.text.replace(/[.…]+$/u, "").normalize("NFC") === expected.normalize("NFC") &&
    line.confidence >= 0.9
  );
  return headers.length === 1 && labels.length === 1;
}

function sameAuthorizedTarget(left: AuthorizedWechatTarget, right: AuthorizedWechatTarget): boolean {
  return left.contactId === right.contactId && left.revision === right.revision &&
    left.displayName.normalize("NFC") === right.displayName.normalize("NFC") &&
    left.enrollmentFingerprint === right.enrollmentFingerprint && left.bindingHash === right.bindingHash;
}

function identityProfile(id: ConversationId): IdentityProfile {
  return {
    visibleName: names[id],
    avatarFingerprint: createHash("sha256").update(`wechat-allowlisted-avatar:${id}`).digest("hex"),
    recentMessageFingerprint: createHash("sha256").update(`wechat-live-pane:${id}`).digest("hex"),
  };
}

function revision(window: WindowDescriptor): string {
  return createHash("sha256")
    .update(
      [
        window.windowID,
        window.processID,
        window.bundleID,
        window.title,
        window.ownerName,
      ].join("\0"),
    )
    .digest("hex");
}

function selectedRowProofHash(
  title: string,
  normalizedY: number,
  windowRevision: string,
): string {
  if (!Number.isFinite(normalizedY) || normalizedY < 0 || normalizedY > 1) return "";
  return sha256([
    "wechat-selected-conversation-row-v1",
    title.normalize("NFC").trim(),
    normalizedY.toFixed(6),
    windowRevision,
  ].join("\0"));
}

function safeHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function titleIdentityFingerprint(id: ConversationId, window: WindowDescriptor): string {
  return sha256([
    "wechat-unique-title-v1",
    names[id],
    revision(window),
  ].join("\0"));
}

function parseVisibleComposer(lines: OCRLine[]): {
  draftText: string;
  draftAlternatives: string[];
  evidence: ConversationSnapshot["composerEvidence"];
  signatureLineProven: boolean;
} {
  const composerLines = lines
    .filter((line) =>
      line.bounds.x >= conversationHeaderMinX && line.bounds.y <= 0.37 &&
      !isInputMethodIndicator(line)
    )
    .sort((left, right) => right.bounds.y - left.bounds.y || left.bounds.x - right.bounds.x);
  const reliableLines = composerLines.filter((line) => line.confidence >= 0.5);
  const primaryEvidence = reliableLines.map((line) => normalizeComposerText(line.text));
  const meaningfulPrimary = primaryEvidence.filter(hasMeaningfulComposerText);
  const finalVisualLine = composerLines.at(-1);
  const normalizedFinalVisualLine = finalVisualLine === undefined
    ? ""
    : normalizeComposerText(finalVisualLine.text);
  const signatureLineProven = finalVisualLine !== undefined &&
    finalVisualLine.confidence >= 0.25 &&
    /^[—－-]{1,2}/u.test(normalizedFinalVisualLine) &&
    normalizedFinalVisualLine.replace(/^[—－-]{1,2}/u, "") === ASSISTANT_DISPLAY_NAME &&
    composerLines.slice(0, -1).some((line) =>
      line.confidence >= 0.5 && hasMeaningfulComposerText(normalizeComposerText(line.text))
    );
  const draftText = signatureLineProven
    ? `${meaningfulPrimary.slice(0, -1).join("")}\n${ASSISTANT_SIGNATURE}`
    : meaningfulPrimary.join("");
  const alternateEvidence = reliableLines.flatMap((line) =>
    (line.alternatives ?? [])
      .map(normalizeComposerText)
      .map((text) => text.replace(/[|｜]+$/u, ""))
      .filter((text) => text.length > 0),
  );
  const draftAlternatives = reliableLines.length === 1
    ? alternateEvidence
    : [];
  const allReliableEvidence = [...primaryEvidence, ...alternateEvidence];
  const hasMeaningfulContent = allReliableEvidence.some(hasMeaningfulComposerText);
  const hasLowConfidenceEvidence = composerLines.some((line) => line.confidence < 0.5);
  const hasUnresolvedEvidence = allReliableEvidence.some(
    (text) => text.length > 0 && !isCursorOnly(text) && !hasMeaningfulComposerText(text),
  );
  let evidence: ConversationSnapshot["composerEvidence"] = "proven-empty";
  if (hasLowConfidenceEvidence || (hasUnresolvedEvidence && !hasMeaningfulContent)) {
    evidence = "ambiguous";
  } else if (hasMeaningfulContent) {
    evidence = "meaningful-content";
  }

  return {
    draftText,
    draftAlternatives,
    evidence,
    signatureLineProven,
  };
}

function isInputMethodIndicator(line: OCRLine): boolean {
  const compactInputModeLabel = (
    /^(?:拼|英|中)$/u.test(line.text.trim()) &&
    line.bounds.x >= conversationHeaderMinX &&
    line.bounds.x < 0.42 &&
    line.bounds.y >= 0.28 &&
    line.bounds.y <= 0.36 &&
    line.bounds.width <= 0.05 &&
    line.bounds.height <= 0.04
  );
  const boundaryToolbarArtifact = (
    /^(?:一|[|｜])$/u.test(line.text.trim()) &&
    line.confidence < 0.5 &&
    line.bounds.x >= conversationHeaderMinX &&
    line.bounds.x < 0.335 &&
    line.bounds.y >= 0.28 &&
    line.bounds.y <= 0.36 &&
    line.bounds.width <= 0.04 &&
    line.bounds.height <= 0.04
  );
  const rightActionToolbarArtifact = (
    line.confidence < 0.5 &&
    line.bounds.x >= 0.88 &&
    line.bounds.y >= 0.32 &&
    line.bounds.y <= 0.37 &&
    line.bounds.width <= 0.10 &&
    line.bounds.height <= 0.05 &&
    [...line.text.trim()].length >= 1 &&
    [...line.text.trim()].length <= 2
  );
  return compactInputModeLabel || boundaryToolbarArtifact || rightActionToolbarArtifact;
}

function normalizeComposerText(text: string): string {
  return canonicalComposerText(text).trim();
}

function hasMeaningfulComposerText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function isCursorOnly(text: string): boolean {
  return /^[|｜]+$/u.test(text);
}

function canonicalComposerText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/gu, "\n");
}

function sha256Canonical(text: string): string {
  return sha256(canonicalComposerText(text));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function centerX(line: OCRLine): number { return line.bounds.x + line.bounds.width / 2; }
function centerY(line: OCRLine): number { return line.bounds.y + line.bounds.height / 2; }
function createToken(): string { return randomBytes(32).toString("hex"); }
