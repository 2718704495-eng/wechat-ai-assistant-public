import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type {
  OCRLine,
  WechatTextMutationRequest,
  WechatComposerMutationReceipt,
  WechatDraftSubmitRequest,
  WechatDraftSubmitReceipt,
  WechatImageAttachmentRequest,
  WechatImageAttachmentReceipt,
  WechatImageSendRequest,
  WechatImageSendReceipt,
  WechatWindowClickRequest,
  WindowDescriptor,
} from "../../src/adapters/native-bridge.js";
import type { AuthorizedWechatTarget } from "../../src/contacts/contact-directory.js";
import type { ContactId } from "../../src/contacts/contact-schema.js";
import {
  NativeWechatSurface,
  parseLatestIncomingEvidence,
  parseVisibleWechatMessages,
  type NativeWechatSurfaceOptions,
  type TextTargetDirectory,
} from "../../src/adapters/native-wechat-surface.js";
import { createDailyCareProductionRuntime } from "../../src/mcp/daily-care-runtime.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { verifyNativeTextTargetCapability } from "../../src/security/native-capability-mac.js";
import { DailyCareBroadcastRepository } from "../../src/storage/daily-care-broadcast-repository.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";
import {
  wechatIdentityEnrollmentFingerprint,
  type WechatIdentityEnrollment,
} from "../../src/storage/wechat-identity-enrollment-repository.js";

const window: WindowDescriptor = {
  windowID: 42,
  processID: 100,
  bundleID: "com.tencent.xinWeChat",
  title: "微信",
  ownerName: "微信",
  bounds: { x: 0, y: 0, width: 717, height: 600 },
};

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

const enrollmentSample = (byte: number) => {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
};
const fengEnrollment: WechatIdentityEnrollment = {
  version: 1,
  conversationId: "example-contact",
  visibleName: "示例联系人",
  fingerprintVersion: "vision-featureprint-v1",
  referenceSamples: [enrollmentSample(1), enrollmentSample(2), enrollmentSample(3)],
  enrolledAt: "2026-08-23T14:00:00.000Z",
};
const fileTransferEnrollment: WechatIdentityEnrollment = {
  ...fengEnrollment,
  conversationId: "file-transfer",
  visibleName: "文件传输助手",
  referenceSamples: [enrollmentSample(4), enrollmentSample(5), enrollmentSample(6)],
};
const testSurfaceOptions = {
  identityEnrollments: {
    "example-contact": fengEnrollment,
    "file-transfer": fileTransferEnrollment,
  },
};

const dynamicTarget: AuthorizedWechatTarget = {
  contactId: "contact-0123456789abcdef0123456789abcdef",
  displayName: "我",
  revision: 3,
  enrollment: {
    version: 2,
    contactId: "contact-0123456789abcdef0123456789abcdef",
    displayName: "我",
    fingerprintVersion: "vision-featureprint-v1",
    referenceSamples: [enrollmentSample(7), enrollmentSample(8), enrollmentSample(9)],
    enrolledAt: "2026-08-31T03:00:00.000Z",
  },
  enrollmentFingerprint: "c".repeat(64),
  bindingHash: "d".repeat(64),
};

class FixedTextTargetDirectory implements TextTargetDirectory {
  public constructor(private readonly target: AuthorizedWechatTarget) {}

  public requireTextTarget(contactId: ContactId, expectedRevision: number): Promise<AuthorizedWechatTarget> {
    if (contactId !== this.target.contactId || expectedRevision !== this.target.revision) {
      return Promise.reject(new Error("CONTACT_REVISION_MISMATCH"));
    }
    return Promise.resolve(this.target);
  }
}

class SequencedTextTargetDirectory implements TextTargetDirectory {
  private calls = 0;

  public constructor(
    private readonly first: AuthorizedWechatTarget,
    private readonly later: AuthorizedWechatTarget,
  ) {}

  public requireTextTarget(contactId: ContactId, expectedRevision: number): Promise<AuthorizedWechatTarget> {
    this.calls += 1;
    if (contactId !== this.first.contactId || expectedRevision !== this.first.revision) {
      return Promise.reject(new Error("CONTACT_REVISION_MISMATCH"));
    }
    return Promise.resolve(this.calls === 1 ? this.first : this.later);
  }
}

class SwitchableTextTargetDirectory implements TextTargetDirectory {
  public constructor(public target: AuthorizedWechatTarget) {}

  public requireTextTarget(contactId: ContactId, expectedRevision: number): Promise<AuthorizedWechatTarget> {
    if (contactId !== this.target.contactId || expectedRevision !== this.target.revision) {
      return Promise.reject(new Error("CONTACT_REVISION_MISMATCH"));
    }
    return Promise.resolve(this.target);
  }
}

function line(text: string, x: number, y: number, confidence = 1): OCRLine {
  return { text, confidence, bounds: { x, y, width: 0.08, height: 0.02 } };
}

class FakeDriver {
  public readonly clicks: WechatWindowClickRequest[] = [];
  public readonly typed: string[] = [];
  public readonly textRequests: WechatTextMutationRequest[] = [];
  public listWindowsCount = 0;
  public captureCount = 0;
  public ocrCount = 0;
  public enterCount = 0;
  public readonly submitRequests: WechatDraftSubmitRequest[] = [];
  public readonly imageAttachmentRequests: WechatImageAttachmentRequest[] = [];
  public readonly imageSendRequests: WechatImageSendRequest[] = [];
  public imageAttachmentError: Error | null = null;
  public draft = "";
  public splitSignedDraft = false;
  public signatureOcrTextOverride: string | null = null;
  public signatureOcrConfidence = 1;
  public focusedTextOverride: string | null = null;
  public mutationReceiptTextOverride: string | null = null;
  public submittedBubbles: OCRLine[] = [];
  public submittedPage: OCRLine[] | null = null;
  public onSubmit: (() => void) | null = null;
  public submitError: Error | null = null;
  public readonly requestedIdentityProofPhases: string[] = [];
  public identityMatches: Array<Array<{
    normalizedY: number;
    distance: number;
    observedFingerprint: string;
    fingerprintVersion: string;
    selected?: boolean;
    selectedRowTitle?: string;
    selectedRowNormalizedY?: number;
    selectionProofHash?: string;
    proofPhase?: "pre-click" | "selected";
  }>> = [];
  private currentWindow: WindowDescriptor = window;

  public constructor(
    private readonly pages: OCRLine[][],
    private readonly windows: WindowDescriptor[] = [window],
  ) {}

  public listWindows(): Promise<WindowDescriptor[]> {
    this.listWindowsCount += 1;
    const current = this.windows.length > 1
      ? this.windows.shift()
      : this.windows[0];
    if (current !== undefined) this.currentWindow = current;
    return Promise.resolve(current === undefined ? [] : [current]);
  }
  public capture(): Promise<string> {
    this.captureCount += 1;
    return Promise.resolve("/tmp/fake.png");
  }
  public ocr(): Promise<OCRLine[]> {
    this.ocrCount += 1;
    const page = this.pages.length > 1 ? this.pages.shift() ?? [] : this.pages[0] ?? [];
    if (this.draft === "") {
      if (this.enterCount > 0 && this.submittedPage !== null) return Promise.resolve(this.submittedPage);
      return Promise.resolve([...page, ...(this.enterCount > 0 ? this.submittedBubbles : [])]);
    }
    if (this.splitSignedDraft && this.draft.includes("\n")) {
      const [body, signature] = this.draft.split("\n");
      return Promise.resolve([
        ...page,
        line(body ?? "", 0.5, 0.22),
        line(this.signatureOcrTextOverride ?? signature ?? "", 0.5, 0.18, this.signatureOcrConfidence),
      ]);
    }
    return Promise.resolve([...page, line(this.draft, 0.5, 0.2)]);
  }
  public focus(): Promise<void> { return Promise.resolve(); }
  public clickWechatWindowPoint(request: WechatWindowClickRequest): Promise<void> { this.clicks.push(request); return Promise.resolve(); }
  public matchWechatIdentityRows(request: {
    conversationTitle: string;
    proofPhase?: "pre-click" | "selected";
  }) {
    const proofPhase = request.proofPhase ?? "selected";
    this.requestedIdentityProofPhases.push(proofPhase);
    const page = this.identityMatches.length > 1
      ? this.identityMatches.shift() ?? []
      : this.identityMatches[0] ?? [{
        normalizedY: 0.44,
        distance: 0.01,
        observedFingerprint: "e5".repeat(32),
        fingerprintVersion: "vision-featureprint-v1" as const,
      }];
    return Promise.resolve(page.map((match) => ({
      ...match,
      proofPhase: match.proofPhase ?? proofPhase,
      selected: match.selected ?? proofPhase === "selected",
      selectedRowTitle: proofPhase === "selected"
        ? match.selectedRowTitle ?? request.conversationTitle
        : null,
      selectedRowNormalizedY: proofPhase === "selected"
        ? match.selectedRowNormalizedY ?? match.normalizedY
        : null,
      selectionProofHash: proofPhase === "selected"
        ? match.selectionProofHash ?? selectedRowProofHash(
          match.selectedRowTitle ?? request.conversationTitle,
          match.selectedRowNormalizedY ?? match.normalizedY,
          testWindowRevision(this.currentWindow),
        )
        : null,
    })));
  }
  public captureWechatIdentitySamples() {
    return Promise.resolve({
      fingerprintVersion: "vision-featureprint-v1" as const,
      windowRevision: createHash("sha256").update([
        window.windowID, window.processID, window.bundleID, window.title, window.ownerName,
      ].join("\0")).digest("hex"),
      leftPaneProofHash: "a".repeat(64),
      headerProofHash: "b".repeat(64),
      referenceSamples: [enrollmentSample(1), enrollmentSample(2), enrollmentSample(3)],
      observedFingerprints: ["c".repeat(64), "d".repeat(64), "e".repeat(64)],
      maximumPairwiseDistance: 0.01,
    });
  }
  public readFocusedText(): Promise<string> {
    return Promise.resolve(this.focusedTextOverride ?? this.draft);
  }
  public typeText(request: WechatTextMutationRequest): Promise<WechatComposerMutationReceipt> {
    this.textRequests.push(request);
    const { text } = request;
    this.draft = text;
    this.typed.push(text);
    return Promise.resolve({
      text: this.mutationReceiptTextOverride ?? text,
      cleared: request.capability.action === "clear-draft",
    });
  }
  public async submitWechatDraft(
    request: WechatDraftSubmitRequest,
    control?: import("../../src/adapters/native-bridge.js").NativeDraftSubmitControl,
  ): Promise<WechatDraftSubmitReceipt> {
    if (control !== undefined && !await control.markSubmitStarted()) {
      return { attempted: false };
    }
    this.enterCount += 1;
    this.submitRequests.push(request);
    this.draft = "";
    this.onSubmit?.();
    if (this.submitError !== null) throw this.submitError;
    return { attempted: true };
  }
  public prepareWechatImageAttachment(
    request: WechatImageAttachmentRequest,
  ): Promise<WechatImageAttachmentReceipt> {
    this.imageAttachmentRequests.push(request);
    if (this.imageAttachmentError !== null) return Promise.reject(this.imageAttachmentError);
    return Promise.resolve({
      imageSha256: request.imageSha256,
      width: 1080,
      height: 1350,
      attachmentCount: 1,
      textEmpty: true,
    });
  }
  public sendWechatImage(request: WechatImageSendRequest): Promise<WechatImageSendReceipt> {
    this.imageSendRequests.push(request);
    return Promise.resolve({
      imageSha256: request.imageSha256,
      width: 1080,
      height: 1350,
      attachmentCount: 1,
      textEmpty: true,
      submitted: true,
      outgoingImageMatched: true,
      visualFingerprintVersion: "vision-featureprint-v1",
    });
  }
  public recoverWechatImageQuarantine(): Promise<{
    status: "recovered";
    archiveName: string;
    composerEmpty: true;
  }> {
    return Promise.resolve({
      status: "recovered",
      archiveName: `dirty-archive-${"a".repeat(64)}`,
      composerEmpty: true,
    });
  }
}

const testConversationProof = {
  version: 1 as const,
  latestMessageId: "1".repeat(64),
  latestTextHash: "2".repeat(64),
  latestDirection: "incoming" as const,
  controlRevision: "3".repeat(64),
};

function testSubmitContext() {
  return {
    signal: new AbortController().signal,
    conversationProof: testConversationProof,
  };
}

function testWindowRevision(value: WindowDescriptor): string {
  return createHash("sha256").update([
    value.windowID, value.processID, value.bundleID, value.title, value.ownerName,
  ].join("\0")).digest("hex");
}

function selectedRowProofHash(title: string, normalizedY: number, windowRevision: string): string {
  return createHash("sha256").update([
    "wechat-selected-conversation-row-v1",
    title.normalize("NFC").trim(),
    normalizedY.toFixed(6),
    windowRevision,
  ].join("\0")).digest("hex");
}

function nativeSurface(
  driver: FakeDriver,
  now: () => Date = () => new Date(),
  settle: () => Promise<void> = () => Promise.resolve(),
  options: NativeWechatSurfaceOptions = testSurfaceOptions,
): NativeWechatSurface {
  return new NativeWechatSurface(driver, now, settle, options);
}

describe("NativeWechatSurface", () => {
  test("selects and proves the unique exact conversation title without biometric enrollment", async () => {
    const driver = new FakeDriver([
      [
        line("示例联系人", 0.20, 0.43),
        line("妈妈827", 0.40, 0.89),
      ],
      [
        line("示例联系人", 0.20, 0.43),
        line("示例联系人", 0.40, 0.89),
      ],
    ]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-24T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.identity.visibleName).toBe("示例联系人");
    expect(driver.clicks.filter(({ region }) => region === "conversation-list")).toHaveLength(1);
    expect(driver.clicks.filter(({ region }) => region === "composer")).toHaveLength(1);
  });

  test("targets only ExampleContact when file-transfer and WeChat Pay rows are also visible", async () => {
    const driver = new FakeDriver([
      [
        line("文件传输助手", 0.20, 0.73),
        line("微信支付", 0.20, 0.58),
        line("示例联系人", 0.20, 0.43),
        line("妈妈827", 0.40, 0.89),
      ],
      [line("示例联系人", 0.40, 0.89)],
    ]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-24T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    await surface.locateConversation("example-contact");

    const rowClicks = driver.clicks.filter(({ region }) => region === "conversation-list");
    expect(rowClicks).toHaveLength(1);
    expect(rowClicks[0]?.conversationTitle).toBe("示例联系人");
    expect(rowClicks[0]?.normalizedY).toBeCloseTo(1 - (0.43 + 0.01));
    expect(driver.clicks.some(({ conversationTitle }) =>
      conversationTitle === "文件传输助手"
    )).toBe(false);
  });

  test("selects the unique exact ExampleContact label at the production OCR confidence floor", async () => {
    const driver = new FakeDriver([
      [
        line("示例联系人", 0.206, 0.525, 0.5),
        line("妈妈827", 0.40, 0.89),
      ],
      [
        line("示例联系人", 0.206, 0.525, 0.5),
        line("示例联系人", 0.40, 0.89),
      ],
    ]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-24T04:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.identity.visibleName).toBe("示例联系人");
    expect(driver.clicks.filter(({ region }) => region === "conversation-list")).toHaveLength(1);
  });

  test("fails closed before any mutation when the exact conversation label is not unique", async () => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.20, 0.43),
      line("示例联系人", 0.20, 0.57),
      line("妈妈827", 0.40, 0.89),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-24T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    await expect(surface.locateConversation("example-contact")).rejects.toThrow(
      "WECHAT_CONVERSATION_LABEL_NOT_UNIQUE",
    );

    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("distinguishes an absent file-transfer row from duplicate visible rows", async () => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.20, 0.43),
      line("妈妈827", 0.40, 0.89),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-09-01T05:15:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    await expect(surface.locateConversation("file-transfer")).rejects.toThrow(
      "WECHAT_CONVERSATION_LABEL_NOT_VISIBLE",
    );

    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("selects one truncated low-confidence file-transfer row only after proving its exact header", async () => {
    const driver = new FakeDriver([
      [line("文件传输⋯. 昨天 18:43", 0.20, 0.82, 0.3)],
      [
        line("文件传输⋯. 昨天 18:43", 0.20, 0.82, 0.3),
        line("文件传输助手", 0.40, 0.89),
      ],
    ]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-24T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    const snapshot = await surface.locateConversation("file-transfer");

    expect(snapshot.identity.visibleName).toBe("文件传输助手");
    const listClicks = driver.clicks.filter(({ region }) => region === "conversation-list");
    expect(listClicks).toHaveLength(1);
    expect(listClicks[0]?.normalizedY).toBeCloseTo(1 - (0.82 + 0.01));
    expect(driver.clicks.filter(({ region }) => region === "composer")).toHaveLength(1);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("proves an already-open file-transfer header in the modern split pane", async () => {
    const driver = new FakeDriver([[
      line("文件传输助手", 0.1439, 0.8399),
      line("文件传输助手", 0.3386, 0.9324),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-29T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    await expect(surface.locateConversation("file-transfer")).resolves.toMatchObject({
      identity: { visibleName: "文件传输助手", confidence: 0.99 },
      composerEvidence: "proven-empty",
    });
    expect(driver.clicks.filter(({ region }) => region === "conversation-list")).toEqual([]);
    expect(driver.clicks.filter(({ region }) => region === "composer")).toHaveLength(1);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("accepts a lossy exact header only with one high-confidence matching conversation row", async () => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.1439, 0.725, 1),
      line("示例联系人", 0.3386, 0.9325, 0.5),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-29T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    await expect(surface.locateConversation("example-contact")).resolves.toMatchObject({
      identity: { visibleName: "示例联系人", confidence: 0.99 },
      composerEvidence: "proven-empty",
    });
    expect(driver.clicks.filter(({ region }) => region === "conversation-list")).toEqual([]);
    expect(driver.clicks.filter(({ region }) => region === "composer")).toHaveLength(1);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("rejects a lossy exact header without a matching high-confidence conversation row", async () => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.3386, 0.9325, 0.5),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-29T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    await expect(surface.locateConversation("example-contact")).rejects.toThrow(
      "WECHAT_CONVERSATION_LABEL_NOT_VISIBLE",
    );
    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("rejects an exact title in the split-pane isolation band before any mutation", async () => {
    const driver = new FakeDriver([[
      line("文件传输助手", 0.315, 0.9324),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-29T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    await expect(surface.locateConversation("file-transfer")).rejects.toThrow(
      "WECHAT_CONVERSATION_LABEL_NOT_VISIBLE",
    );
    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("rejects ambiguous low-confidence file-transfer rows before clicking", async () => {
    const driver = new FakeDriver([[
      line("文件传输⋯. 昨天 18:43", 0.20, 0.82, 0.3),
      line("文件传输⋯. 00:10", 0.20, 0.72, 0.3),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-24T03:00:00.000Z"),
      () => Promise.resolve(),
      {},
    );

    await expect(surface.locateConversation("file-transfer")).rejects.toThrow(
      "WECHAT_CONVERSATION_LABEL_NOT_UNIQUE",
    );

    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("runs a real NativeWechatSurface two-line signed NIGHT prepare and verify offline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-night-draft-"));
    try {
      await initializeTestKernelLockCatalog(root);
      const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);
      driver.splitSignedDraft = true;
      const surface = nativeSurface(
        driver,
        () => new Date("2026-08-23T14:05:00.000Z"),
        () => Promise.resolve(),
      );
      const repository = new DailyCareBroadcastRepository(
        new EncryptedStore(root, new FixedKeyProvider(randomBytes(32))),
        () => new Date("2026-08-23T14:05:00.000Z"),
      );
      const runtime = createDailyCareProductionRuntime({
        repository,
        surface,
        researchWeather: vi.fn().mockRejectedValue(new Error("NIGHT_NETWORK_FORBIDDEN")),
        isStopped: vi.fn().mockResolvedValue(false),
        release: vi.fn().mockResolvedValue(undefined),
        now: () => new Date("2026-08-23T14:05:00.000Z"),
      });
      const text = "想认真和你说声晚安。无论今天过得怎样，都希望这会儿的你能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙";

      await runtime.beginCurrentSlot();
      await expect(runtime.prepareBroadcast(text)).resolves.toEqual({ prepared: true });
      await expect(runtime.verifyDraft()).resolves.toEqual({ draftVerified: true });
      expect(driver.typed).toEqual([`${text}\n——示例用户`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selects an allowlisted conversation from OCR and verifies the header", async () => {
    const driver = new FakeDriver([
      [line("文件传输", 0.20, 0.81), line("示例联系人", 0.20, 0.43), line("文件传输助手", 0.40, 0.89)],
      [line("示例联系人", 0.20, 0.43), line("示例联系人", 0.40, 0.89), line("被骂了兄弟", 0.42, 0.72)],
    ]);
    const surface = nativeSurface(driver, () => new Date("2026-08-19T03:00:00.000Z"));

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.identity.visibleName).toBe("示例联系人");
    expect(snapshot.messages).toMatchObject([{ direction: "incoming", text: "被骂了兄弟" }]);
    expect(driver.clicks).toEqual(expect.arrayContaining([
      expect.objectContaining({ region: "conversation-list" }),
      expect.objectContaining({ region: "composer" }),
    ]));
  });

  test("associates a pure 1-99 unread badge only with the bounded target row", async () => {
    const unread = {
      ...line("14", 0.16, 0.43),
      bounds: { x: 0.16, y: 0.43, width: 0.025, height: 0.025 },
    };
    const driver = new FakeDriver([[
      line("示例联系人", 0.20, 0.43),
      unread,
      line("示例联系人", 0.40, 0.89),
      line("今天加班", 0.43, 0.72),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-23T03:00:00.000Z"),
      () => Promise.resolve(),
    );

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.unreadIndicator).toBe(true);
    expect(driver.captureCount).toBe(1);
    expect(driver.ocrCount).toBe(1);
  });

  test.each([
    { label: "time", item: line("14:39", 0.16, 0.43) },
    { label: "price", item: line("¥14.00", 0.16, 0.43) },
    { label: "preview digits", item: line("14", 0.30, 0.43) },
    { label: "different row", item: line("14", 0.16, 0.72) },
  ])("does not treat $label as the target unread badge", async ({ item }) => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.20, 0.43),
      item,
      line("示例联系人", 0.40, 0.89),
      line("今天加班", 0.43, 0.72),
    ]]);
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-23T03:00:00.000Z"),
      () => Promise.resolve(),
    );

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.unreadIndicator).toBe(false);
    expect(driver.captureCount).toBe(1);
    expect(driver.ocrCount).toBe(1);
  });

  test("replaces, verifies and submits only through the focused composer", async () => {
    const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);
    const surface = nativeSurface(driver);

    await surface.replaceDraft("example-contact", "测试自消息", "a1".repeat(32));
    await surface.submitDraft("example-contact", "a1".repeat(32));

    expect(driver.typed).toEqual(["测试自消息"]);
    expect(driver.enterCount).toBe(1);
    expect(driver.submitRequests[0]?.conversationTitle).toBe("示例联系人");
  });

  test("passes the fixed file-transfer title to the final native submit guard", async () => {
    const driver = new FakeDriver([[line("文件传输助手", 0.40, 0.89)]]);
    const surface = nativeSurface(driver);

    await surface.replaceDraft("file-transfer", "测试消息", "a1".repeat(32));
    await surface.submitDraft("file-transfer", "a1".repeat(32));

    expect(driver.submitRequests).toHaveLength(1);
    expect(driver.submitRequests[0]?.conversationTitle).toBe("文件传输助手");
  });

  test("prepares the reviewed image only in file-transfer without text or submit mutation", async () => {
    const driver = new FakeDriver([[line("文件传输助手", 0.40, 0.89)]]);
    const surface = nativeSurface(driver) as NativeWechatSurface & {
      prepareImageAttachment(
        conversationId: "file-transfer",
        image: { path: string; sha256: string; width: 1080; height: 1350 },
        token: string,
      ): Promise<WechatImageAttachmentReceipt>;
    };
    const imageSha256 = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177";

    await expect(surface.prepareImageAttachment(
      "file-transfer",
      {
        path: path.resolve(
          "assets/relationship-care/intro-card.png",
        ),
        sha256: imageSha256,
        width: 1080,
        height: 1350,
      },
      "c3".repeat(32),
    )).resolves.toEqual({
      imageSha256,
      width: 1080,
      height: 1350,
      attachmentCount: 1,
      textEmpty: true,
    });
    expect(driver.imageAttachmentRequests).toHaveLength(1);
    expect(driver.imageAttachmentRequests[0]).toMatchObject({
      conversationTitle: "文件传输助手",
      imageSha256,
      width: 1080,
      height: 1350,
      capability: { action: "attach-image", candidateHash: imageSha256 },
    });
    const expectedWindowRevision = createHash("sha256").update([
      window.windowID,
      window.processID,
      window.bundleID,
      window.title,
      window.ownerName,
    ].join("\0")).digest("hex");
    const expectedNativeIdentity = createHash("sha256").update([
      "wechat-unique-title-v1",
      "文件传输助手",
      expectedWindowRevision,
    ].join("\0")).digest("hex");
    expect(driver.imageAttachmentRequests[0]?.capability.identityFingerprint).toBe(
      expectedNativeIdentity,
    );
    expect(driver.imageAttachmentRequests[0]?.capability.identityFingerprint).not.toBe(
      wechatIdentityEnrollmentFingerprint(fileTransferEnrollment),
    );
    expect(driver.typed).toEqual([]);
    expect(driver.submitRequests).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("sends and verifies the fixed reviewed card only through a dedicated ExampleContact image capability", async () => {
    const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);
    const surface = nativeSurface(driver) as NativeWechatSurface & {
      sendComfortStationCard(input: {
        path: string;
        sha256: string;
        width: 1080;
        height: 1350;
        deliveryKey: string;
        token: string;
      }): Promise<{
        imageSha256: string;
        outgoingImageMatched: true;
        submitted: true;
      }>;
    };
    const imageSha256 = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177";

    await expect(surface.sendComfortStationCard({
      path: path.resolve("assets/relationship-care/intro-card.png"),
      sha256: imageSha256,
      width: 1080,
      height: 1350,
      deliveryKey: "d7".repeat(32),
      token: "e8".repeat(32),
    })).resolves.toMatchObject({
      imageSha256,
      outgoingImageMatched: true,
      submitted: true,
    });
    expect(driver.imageSendRequests).toHaveLength(1);
    expect(driver.imageSendRequests[0]).toMatchObject({
      conversationTitle: "示例联系人",
      imageSha256,
      capability: {
        action: "send-image",
        candidateHash: imageSha256,
      },
    });
    expect(driver.typed).toEqual([]);
    expect(driver.submitRequests).toEqual([]);
  });

  test("recovers image quarantine from an already active exact ExampleContact header without clicks", async () => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.20, 0.43),
      line("示例联系人", 0.40, 0.89),
    ]]);
    const surface = nativeSurface(driver);

    await expect(surface.recoverImageAttachmentQuarantine()).resolves.toEqual({
      status: "recovered",
      archiveName: `dirty-archive-${"a".repeat(64)}`,
      composerEmpty: true,
    });
    expect(driver.clicks).toEqual([]);
  });

  test("does not click before a replayed capability is rejected by Native", async () => {
    const driver = new FakeDriver([[line("文件传输助手", 0.40, 0.89)]]);
    const image = {
      path: path.resolve("assets/relationship-care/intro-card.png"),
      sha256: "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177",
      width: 1080 as const,
      height: 1350 as const,
    };
    const token = "c4".repeat(32);

    await nativeSurface(driver).prepareImageAttachment("file-transfer", image, token);
    driver.clicks.length = 0;
    driver.imageAttachmentError = new Error("WRITE_CAPABILITY_ALREADY_USED");

    await expect(
      nativeSurface(driver).prepareImageAttachment("file-transfer", image, token),
    ).rejects.toThrow("WRITE_CAPABILITY_ALREADY_USED");
    expect(driver.imageAttachmentRequests).toHaveLength(2);
    expect(driver.clicks).toEqual([]);
  });

  test("does not click before a durable dirty capability store rejects preparation", async () => {
    const driver = new FakeDriver([[line("文件传输助手", 0.40, 0.89)]]);
    driver.imageAttachmentError = new Error("WECHAT_IMAGE_ATTACHMENT_DIRTY");

    await expect(nativeSurface(driver).prepareImageAttachment(
      "file-transfer",
      {
        path: path.resolve("assets/relationship-care/intro-card.png"),
        sha256: "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177",
        width: 1080,
        height: 1350,
      },
      "c5".repeat(32),
    )).rejects.toThrow("WECHAT_IMAGE_ATTACHMENT_DIRTY");
    expect(driver.imageAttachmentRequests).toHaveLength(1);
    expect(driver.clicks).toEqual([]);
  });

  test("refuses a non-active file-transfer conversation without clicking or entering Native prepare", async () => {
    const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);

    await expect(nativeSurface(driver).prepareImageAttachment(
      "file-transfer",
      {
        path: path.resolve("assets/relationship-care/intro-card.png"),
        sha256: "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177",
        width: 1080,
        height: 1350,
      },
      "c6".repeat(32),
    )).rejects.toThrow("WECHAT_CONVERSATION_HEADER_MISMATCH");
    expect(driver.imageAttachmentRequests).toEqual([]);
    expect(driver.clicks).toEqual([]);
  });

  test("binds a one-time final capability to candidate, slot, UI identity, window revision and expiry", async () => {
    const now = new Date("2026-08-23T15:05:00.000Z");
    const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);
    driver.splitSignedDraft = true;
    const surface = nativeSurface(driver, () => new Date(now));
    const text = "候选正文\n——示例用户";
    const slotKey = "2026-08-23/night";
    (surface as unknown as {
      bindDailyCareWriteContext(context: { slotKey: string; candidateHash: string; expiresAt: string }): void;
    }).bindDailyCareWriteContext({
      slotKey,
      candidateHash: createHash("sha256").update(text.normalize("NFC")).digest("hex"),
      expiresAt: "2026-08-23T15:08:00.000Z",
    });

    await surface.replaceDraft("example-contact", text, "a1".repeat(32));
    await surface.submitDraft("example-contact", "b2".repeat(32));

    const request = driver.submitRequests[0] as WechatDraftSubmitRequest & {
      draftText: string;
      capability: {
        capabilityId: string;
        candidateHash: string;
        slotHash: string;
        identityFingerprint: string;
        windowRevision: string;
        expiresAt: string;
      };
    };
    expect(request.draftText).toBe(text);
    expect(request.capability).toMatchObject({
      capabilityId: "b2".repeat(32),
      candidateHash: createHash("sha256").update(text.normalize("NFC")).digest("hex"),
      slotHash: createHash("sha256").update(slotKey).digest("hex"),
      expiresAt: "2026-08-23T15:08:00.000Z",
    });
    expect(request.capability.windowRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(request.capability.identityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await expect(surface.submitDraft("example-contact", "b2".repeat(32))).rejects.toThrow(
      "WRITE_CAPABILITY_ALREADY_USED",
    );
    expect(driver.enterCount).toBe(1);
  });

  test("binds every preliminary click, replace and clear mutation to the target write context", async () => {
    const now = new Date("2026-08-24T22:05:00.000Z");
    const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);
    driver.splitSignedDraft = true;
    const surface = nativeSurface(
      driver,
      () => new Date(now),
      () => Promise.resolve(),
      {},
    );
    const text = "今天也要照顾好自己\n——示例用户";
    surface.bindDailyCareWriteContext({
      slotKey: "2026-08-24/night",
      candidateHash: createHash("sha256").update(text).digest("hex"),
      expiresAt: "2026-08-24T22:08:00.000Z",
    });

    await surface.replaceDraft("example-contact", text, "a1".repeat(32));
    await surface.clearDraft("example-contact", "b2".repeat(32));

    expect(driver.clicks.length).toBeGreaterThan(0);
    for (const request of driver.clicks) {
      expect(request.conversationTitle).toBe("示例联系人");
      expect(request.slotKey).toBe("2026-08-24/night");
      expect(request.capability?.version).toBe(1);
      expect(request.capability?.slotHash).toBe(
        createHash("sha256").update("2026-08-24/night").digest("hex"),
      );
      expect(request.capability?.windowRevision).toMatch(/^[a-f0-9]{64}$/u);
      expect(request.capability?.expiresAt).toBe("2026-08-24T22:08:00.000Z");
    }
    expect(driver.textRequests).toHaveLength(2);
    const replaceRequest = driver.textRequests[0];
    const clearRequest = driver.textRequests[1];
    expect(replaceRequest).toBeDefined();
    expect(replaceRequest?.text).toBe(text);
    expect(replaceRequest?.conversationTitle).toBe("示例联系人");
    expect(replaceRequest?.slotKey).toBe("2026-08-24/night");
    expect(replaceRequest?.capability.action).toBe("replace-draft");
    expect(clearRequest).toBeDefined();
    expect(clearRequest?.text).toBe("");
    expect(clearRequest?.conversationTitle).toBe("示例联系人");
    expect(clearRequest?.slotKey).toBe("2026-08-24/night");
    expect(clearRequest?.capability.action).toBe("clear-draft");
  });

  test("resolves a dynamic target through the directory and sends v2 select, focus, replace and submit capabilities", async () => {
    const keyProvider = new FixedKeyProvider(Buffer.alloc(32, 0x42));
    const now = new Date("2026-08-31T04:00:00.000Z");
    const text = "动态目标回复";
    const driver = new FakeDriver([
      [line("文件传输助手", 0.40, 0.89)],
      [line("我", 0.14, 0.43), line("我", 0.40, 0.89)],
    ]);
    driver.onSubmit = () => { driver.submittedBubbles.push(line(text, 0.76, 0.40)); };
    driver.identityMatches = [[{
      normalizedY: 0.44,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
    }]];
    const surface = nativeSurface(driver, () => new Date(now), () => Promise.resolve(), {
      textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
      nativeCapabilityKeyProvider: keyProvider,
    });
    const slotKey = `non-daily/${"8".repeat(64)}`;

    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: 3,
      text,
      slotKey,
    });
    await surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: 3,
      ...testSubmitContext(),
      ...testSubmitContext(),
      ...testSubmitContext(),
      ...testSubmitContext(),
      ...testSubmitContext(),
      ...testSubmitContext(),
      markSubmitStarted: vi.fn().mockResolvedValue(true),
    });

    const dynamicRequests = [
      ...driver.clicks.map(({ capability }) => capability),
      ...driver.textRequests.map(({ capability }) => capability),
      ...driver.submitRequests.map(({ capability }) => capability),
    ].filter((capability) => capability?.version === 2);
    expect(driver.clicks.map(({ capability }) => capability?.action)).toEqual([
      "select-conversation",
      "focus-composer",
      "focus-composer",
    ]);
    expect(driver.textRequests.map(({ capability }) => capability.action)).toEqual([
      "replace-draft",
    ]);
    expect(driver.submitRequests.map(({ capability }) =>
      capability?.version === 2 ? capability.action : undefined,
    )).toEqual([
      "submit-draft",
    ]);
    for (const capability of dynamicRequests) {
      if (capability?.version !== 2) throw new Error("DYNAMIC_CAPABILITY_MISSING");
      await expect(verifyNativeTextTargetCapability({
        capability,
        action: capability.action,
        target: dynamicTarget,
        draftText: capability.action === "replace-draft" || capability.action === "submit-draft"
          ? text
          : "",
        slotKey,
        windowRevision: capability.windowRevision,
        keyProvider,
        now: () => now,
      })).resolves.toBeUndefined();
    }
    expect(driver.typed).toEqual([text]);
    expect(driver.enterCount).toBe(1);
  });

  test("locates an unselected authorized B with a pre-click proof and writes only after selected proof", async () => {
    const currentA = [line("当前 A", 0.14, 0.43), line("当前 A", 0.40, 0.89)];
    const selectedB = [line("我", 0.14, 0.43), line("我", 0.40, 0.89)];
    const driver = new FakeDriver([currentA, selectedB]);
    driver.identityMatches = [[{
      normalizedY: 0.44,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
      proofPhase: "pre-click",
      selected: false,
    }], [{
      normalizedY: 0.44,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
      proofPhase: "selected",
      selected: true,
    }]];
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });

    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text: "安全切换后写入",
      slotKey: `non-daily/${"8".repeat(64)}`,
    });

    expect(driver.requestedIdentityProofPhases).toEqual(["pre-click", "selected", "selected"]);
    expect(driver.clicks.map(({ region }) => region)).toEqual(["conversation-list", "composer"]);
    expect(driver.typed).toEqual(["安全切换后写入"]);
  });

  test("rejects a pre-click proof at the post-click selected boundary before composer mutation", async () => {
    const currentA = [line("当前 A", 0.14, 0.43), line("当前 A", 0.40, 0.89)];
    const apparentB = [line("我", 0.14, 0.43), line("我", 0.40, 0.89)];
    const preClick = {
      normalizedY: 0.44,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
      proofPhase: "pre-click" as const,
      selected: false,
    };
    const driver = new FakeDriver([currentA, apparentB]);
    driver.identityMatches = [[preClick], [preClick]];
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });

    await expect(surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text: "不得写入",
      slotKey: `non-daily/${"8".repeat(64)}`,
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
    expect(driver.clicks.map(({ region }) => region)).toEqual(["conversation-list"]);
    expect(driver.typed).toEqual([]);
    expect(driver.textRequests).toEqual([]);
  });

  test("rejects an old dynamic target revision before any click, paste or submit", async () => {
    const driver = new FakeDriver([[line("我", 0.40, 0.89)]]);
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });

    await expect(surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: 2,
      text: "不得写入",
      slotKey: `non-daily/${"8".repeat(64)}`,
    })).rejects.toThrow("CONTACT_REVISION_MISMATCH");
    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("reads a directory-bound dynamic detail snapshot without any mutation", async () => {
    const observedAt = new Date("2026-08-30T20:00:00.000Z");
    const driver = new FakeDriver([[
      line("我", 0.14, 0.78),
      line("刚发来的问题", 0.14, 0.73),
      line("04:00", 0.25, 0.78),
      line("我", 0.50, 0.90),
      line("04:00", 0.50, 0.70),
      line("刚发来的问题", 0.48, 0.66),
    ]]);
    driver.identityMatches = [[{
      normalizedY: 0.79,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
    }]];
    const surface = nativeSurface(driver, () => observedAt, () => Promise.resolve(), {
      textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
    });

    const result = await surface.readAuthorizedConversationSnapshot({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
    });

    expect(result).toMatchObject({
      conversationId: dynamicTarget.contactId,
      identity: {
        conversationId: dynamicTarget.contactId,
        visibleName: "我",
        enrollmentFingerprint: dynamicTarget.enrollmentFingerprint,
      },
      latestIncomingEvidence: {
        contactId: dynamicTarget.contactId,
        contactRevision: dynamicTarget.revision,
      },
    });
    expect(result.windowRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.messages).toEqual([
      expect.objectContaining({ conversationId: dynamicTarget.contactId, text: "刚发来的问题", direction: "incoming" }),
    ]);
    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.submitRequests).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("uses native selected-row attestation even when there is no fresh incoming proof", async () => {
    const lines = [
      line("我", 0.14, 0.78),
      line("我", 0.50, 0.90),
      line("我已回复", 0.72, 0.66),
    ];
    const driver = new FakeDriver([lines]);
    driver.identityMatches = [[{
      normalizedY: 0.79,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
      selected: true,
      selectedRowTitle: "我",
      selectedRowNormalizedY: 0.79,
    }]];
    const surface = nativeSurface(driver, () => new Date("2026-08-30T20:00:00.000Z"),
      () => Promise.resolve(), { textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget) });

    const result = await surface.readAuthorizedConversationSnapshot({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
    });

    expect(result.latestIncomingEvidence).toBeUndefined();
    expect(result.messages).toEqual([
      expect.objectContaining({ text: "我已回复", direction: "outgoing" }),
    ]);
    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.submitRequests).toEqual([]);
  });

  test("rejects visible content collisions unless the enrolled row is natively selected", async () => {
    const collision = [
      line("我", 0.14, 0.78), line("同样预览", 0.14, 0.73), line("04:00", 0.25, 0.78),
      line("我", 0.50, 0.90), line("04:00", 0.50, 0.70), line("同样预览", 0.48, 0.66),
    ];
    const driver = new FakeDriver([collision]);
    driver.identityMatches = [[{
      normalizedY: 0.79,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
      selected: false,
      selectedRowTitle: "我",
      selectedRowNormalizedY: 0.79,
      selectionProofHash: "1".repeat(64),
    }]];
    const surface = nativeSurface(driver, () => new Date("2026-08-30T20:00:00.000Z"),
      () => Promise.resolve(), { textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget) });

    await expect(surface.readAuthorizedConversationSnapshot({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
    })).rejects.toThrow("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.submitRequests).toEqual([]);
  });

  test("rejects an arbitrary hexadecimal selected-row proof", async () => {
    const lines = [line("我", 0.14, 0.78), line("我", 0.50, 0.90)];
    const driver = new FakeDriver([lines]);
    driver.identityMatches = [[{
      normalizedY: 0.79,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
      selected: true,
      selectedRowTitle: "我",
      selectedRowNormalizedY: 0.79,
      selectionProofHash: "1".repeat(64),
    }]];
    const surface = nativeSurface(driver, () => new Date("2026-08-30T20:00:00.000Z"),
      () => Promise.resolve(), { textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget) });

    await expect(surface.readAuthorizedConversationSnapshot({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
    })).rejects.toThrow("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
  });

  test("fails closed when selected and unselected same-name rows both match enrollment", async () => {
    const lines = [line("我", 0.14, 0.78), line("我", 0.50, 0.90)];
    const driver = new FakeDriver([lines]);
    driver.identityMatches = [[
      {
        normalizedY: 0.79, distance: 0.01, observedFingerprint: "e".repeat(64),
        fingerprintVersion: "vision-featureprint-v1", selected: true,
        selectedRowTitle: "我", selectedRowNormalizedY: 0.79,
      },
      {
        normalizedY: 0.59, distance: 0.02, observedFingerprint: "d".repeat(64),
        fingerprintVersion: "vision-featureprint-v1", selected: false,
        selectedRowTitle: "我", selectedRowNormalizedY: 0.79,
      },
    ]];
    const surface = nativeSurface(driver, () => new Date("2026-08-30T20:00:00.000Z"),
      () => Promise.resolve(), { textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget) });

    await expect(surface.readAuthorizedConversationSnapshot({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
    })).rejects.toThrow("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
  });

  test("requires the enrolled left row itself to be the continuously selected conversation", async () => {
    const selected = [
      line("我", 0.14, 0.78),
      line("刚发来的问题", 0.14, 0.73),
      line("04:00", 0.25, 0.78),
      line("我", 0.50, 0.90),
      line("04:00", 0.50, 0.70),
      line("刚发来的问题", 0.48, 0.66),
    ];
    const driver = new FakeDriver([selected, [
      line("我", 0.14, 0.78),
      line("刚发来的问题", 0.14, 0.73),
      line("04:00", 0.25, 0.78),
      line("其他会话", 0.50, 0.90),
      line("04:00", 0.50, 0.70),
      line("另一条内容", 0.48, 0.66),
    ]]);
    driver.identityMatches = [[{
      normalizedY: 0.79,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
    }]];
    const surface = nativeSurface(driver, () => new Date("2026-08-30T20:00:00.000Z"),
      () => Promise.resolve(), { textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget) });

    await expect(surface.readAuthorizedConversationSnapshot({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
    })).rejects.toThrow("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.submitRequests).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("rejects an offscreen enrollment match and visible same-name ambiguity without selecting", async () => {
    const ambiguous = [
      line("我", 0.14, 0.78), line("第一条", 0.14, 0.73), line("04:00", 0.25, 0.78),
      line("我", 0.14, 0.58), line("第二条", 0.14, 0.53),
      line("我", 0.50, 0.90), line("04:00", 0.50, 0.70), line("第一条", 0.48, 0.66),
    ];
    const driver = new FakeDriver([ambiguous]);
    driver.identityMatches = [[{
      normalizedY: 0.44,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
    }]];
    const surface = nativeSurface(driver, () => new Date("2026-08-30T20:00:00.000Z"),
      () => Promise.resolve(), { textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget) });

    await expect(surface.readAuthorizedConversationSnapshot({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
    })).rejects.toThrow("WECHAT_AUTHORIZED_CONVERSATION_SELECTION_REQUIRED");
    expect(driver.clicks).toEqual([]);
    expect(driver.typed).toEqual([]);
    expect(driver.submitRequests).toEqual([]);
  });

  test("clears an authorized dynamic draft only after directory, identity and empty-composer checks", async () => {
    const keyProvider = new FixedKeyProvider(Buffer.alloc(32, 0x42));
    const driver = new FakeDriver([[line("我", 0.14, 0.43), line("我", 0.40, 0.89)]]);
    driver.draft = "待清除草稿";
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: keyProvider,
      });

    await surface.clearAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      slotKey: `non-daily/${"8".repeat(64)}`,
    });

    expect(driver.textRequests).toHaveLength(1);
    expect(driver.textRequests[0]?.capability.action).toBe("clear-draft");
    expect(driver.typed).toEqual([""]);
  });

  test("rejects a dynamic clear when the directory binding drifts after the proven-empty receipt", async () => {
    const driver = new FakeDriver([[line("我", 0.14, 0.43), line("我", 0.40, 0.89)]]);
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new SequencedTextTargetDirectory(dynamicTarget, {
          ...dynamicTarget,
          revision: dynamicTarget.revision + 1,
        }),
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });

    await expect(surface.clearAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      slotKey: `non-daily/${"8".repeat(64)}`,
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
    expect(driver.typed).toEqual([""]);
  });

  test("rejects a dynamic clear when the post-clear window revision drifts", async () => {
    const driftedWindow = { ...window, ownerName: "其他进程" };
    const driver = new FakeDriver(
      [[line("我", 0.14, 0.43), line("我", 0.40, 0.89)]],
      [window, driftedWindow],
    );
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });

    await expect(surface.clearAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      slotKey: `non-daily/${"8".repeat(64)}`,
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  test("rejects a dynamic clear when post-clear identity proof drifts", async () => {
    const normal = [line("我", 0.14, 0.43), line("我", 0.40, 0.89)];
    const driver = new FakeDriver([normal, normal, normal, [line("我", 0.14, 0.43)]]);
    driver.identityMatches = [[{
      normalizedY: 0.44,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
    }], [{
      normalizedY: 0.44,
      distance: 0.01,
      observedFingerprint: "e".repeat(64),
      fingerprintVersion: "vision-featureprint-v1",
    }], []];
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });

    await expect(surface.clearAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      slotKey: `non-daily/${"8".repeat(64)}`,
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  test("rejects a dynamic clear when the post-clear header proof drifts", async () => {
    const normal = [line("我", 0.14, 0.43), line("我", 0.40, 0.89)];
    const driver = new FakeDriver([normal, normal, normal, [line("我", 0.14, 0.43)]]);
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });

    await expect(surface.clearAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      slotKey: `non-daily/${"8".repeat(64)}`,
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  test("rejects dynamic submit verification when the latest visible bubble is incoming", async () => {
    const keyProvider = new FixedKeyProvider(Buffer.alloc(32, 0x42));
    const text = "不能确认发送";
    const driver = new FakeDriver([
      [line("我", 0.14, 0.43), line("我", 0.40, 0.89)],
    ]);
    driver.onSubmit = () => { driver.submittedBubbles.push(line("对方新消息", 0.42, 0.40)); };
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: keyProvider,
      });
    const slotKey = `non-daily/${"8".repeat(64)}`;

    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text,
      slotKey,
    });
    await expect(surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      ...testSubmitContext(),
      markSubmitStarted: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
    expect(driver.enterCount).toBe(1);
  });

  test("rejects dynamic submit verification when duplicate outgoing evidence is ambiguous", async () => {
    const keyProvider = new FixedKeyProvider(Buffer.alloc(32, 0x42));
    const text = "重复读回";
    const driver = new FakeDriver([[
      line("我", 0.14, 0.43), line("我", 0.40, 0.89),
    ]]);
    driver.onSubmit = () => {
      driver.submittedBubbles.push(line(text, 0.76, 0.40), line(text, 0.76, 0.41));
    };
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: keyProvider,
      });
    const slotKey = `non-daily/${"8".repeat(64)}`;

    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text,
      slotKey,
    });
    await expect(surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      ...testSubmitContext(),
      markSubmitStarted: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
    expect(driver.enterCount).toBe(1);
  });

  test("rejects a historical matching outgoing bubble when submit adds no new evidence", async () => {
    const keyProvider = new FixedKeyProvider(Buffer.alloc(32, 0x42));
    const text = "历史同文";
    const driver = new FakeDriver([[
      line("我", 0.14, 0.43), line("我", 0.40, 0.89), line(text, 0.76, 0.40),
    ]]);
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: keyProvider,
      });
    const slotKey = `non-daily/${"8".repeat(64)}`;

    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text,
      slotKey,
    });
    await expect(surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      ...testSubmitContext(),
      markSubmitStarted: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  test("does not cross the submit fence when a dynamic target preflight fails", async () => {
    const directory = new SwitchableTextTargetDirectory(dynamicTarget);
    const driver = new FakeDriver([[
      line("我", 0.14, 0.43), line("我", 0.40, 0.89),
    ]]);
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: directory,
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });
    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text: "fence 之前失败",
      slotKey: `non-daily/${"8".repeat(64)}`,
    });
    directory.target = { ...dynamicTarget, revision: dynamicTarget.revision + 1 };
    const markSubmitStarted = vi.fn().mockResolvedValue(true);

    await expect(surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      ...testSubmitContext(),
      markSubmitStarted,
    })).rejects.toThrow("CONTACT_REVISION_MISMATCH");
    expect(markSubmitStarted).not.toHaveBeenCalled();
    expect(driver.enterCount).toBe(0);
  });

  test("crosses the submit fence exactly once before a driver submit failure", async () => {
    const text = "driver 异常";
    const driver = new FakeDriver([[
      line("我", 0.14, 0.43), line("我", 0.40, 0.89),
    ]]);
    driver.submitError = new Error("DRIVER_SUBMIT_FAILED");
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: new FixedKeyProvider(Buffer.alloc(32, 0x42)),
      });
    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text,
      slotKey: `non-daily/${"8".repeat(64)}`,
    });
    const markSubmitStarted = vi.fn().mockResolvedValue(true);

    await expect(surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      ...testSubmitContext(),
      markSubmitStarted,
    })).rejects.toThrow("DRIVER_SUBMIT_FAILED");
    expect(markSubmitStarted).toHaveBeenCalledTimes(1);
    expect(driver.enterCount).toBe(1);
  });

  test("accepts a historical matching bubble only when submit proves one fresh matching append", async () => {
    const keyProvider = new FixedKeyProvider(Buffer.alloc(32, 0x42));
    const text = "历史同文";
    const driver = new FakeDriver([[
      line("我", 0.14, 0.43), line("我", 0.40, 0.89), line(text, 0.76, 0.48),
    ]]);
    driver.onSubmit = () => { driver.submittedBubbles.push(line(text, 0.76, 0.40)); };
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: keyProvider,
      });
    const slotKey = `non-daily/${"8".repeat(64)}`;

    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text,
      slotKey,
    });
    await expect(surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      ...testSubmitContext(),
      markSubmitStarted: vi.fn().mockResolvedValue(true),
    })).resolves.toEqual({ attempted: true });
  });

  test("rejects dynamic submit readback when the observed sequence is truncated", async () => {
    const keyProvider = new FixedKeyProvider(Buffer.alloc(32, 0x42));
    const text = "截断拒绝";
    const normal = [line("我", 0.14, 0.43), line("我", 0.40, 0.89), line("旧消息", 0.76, 0.40)];
    const driver = new FakeDriver([normal]);
    driver.onSubmit = () => { driver.submittedPage = [line("我", 0.14, 0.43), line("我", 0.40, 0.89)]; };
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: keyProvider,
      });
    const slotKey = `non-daily/${"8".repeat(64)}`;

    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text,
      slotKey,
    });
    await expect(surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      ...testSubmitContext(),
      markSubmitStarted: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  test("rejects dynamic submit readback when the observed sequence is reordered", async () => {
    const keyProvider = new FixedKeyProvider(Buffer.alloc(32, 0x42));
    const text = "重排拒绝";
    const normal = [
      line("我", 0.14, 0.43), line("我", 0.40, 0.89),
      line("旧消息甲", 0.76, 0.42), line("旧消息乙", 0.76, 0.40),
    ];
    const driver = new FakeDriver([normal]);
    driver.onSubmit = () => {
      driver.submittedPage = [
        line("我", 0.14, 0.43), line("我", 0.40, 0.89),
        line("旧消息乙", 0.76, 0.42), line("旧消息甲", 0.76, 0.40), line(text, 0.76, 0.39),
      ];
    };
    const surface = nativeSurface(driver, () => new Date("2026-08-31T04:00:00.000Z"),
      () => Promise.resolve(), {
        textTargetDirectory: new FixedTextTargetDirectory(dynamicTarget),
        nativeCapabilityKeyProvider: keyProvider,
      });
    const slotKey = `non-daily/${"8".repeat(64)}`;

    await surface.prepareAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      text,
      slotKey,
    });
    await expect(surface.submitAuthorizedTextDraft({
      contactId: dynamicTarget.contactId,
      expectedRevision: dynamicTarget.revision,
      ...testSubmitContext(),
      markSubmitStarted: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  test("writes zero characters when the allowlisted header proof is duplicated", async () => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.40, 0.89),
      line("示例联系人", 0.55, 0.91),
    ]]);
    const surface = nativeSurface(driver);

    await expect(
      surface.replaceDraft("example-contact", "禁止写入", "a1".repeat(32)),
    ).rejects.toThrow(/ALLOWLISTED_CONVERSATION_NOT_VISIBLE|WECHAT_CONVERSATION_HEADER_MISMATCH/u);

    expect(driver.typed).toEqual([]);
  });

  test("writes zero characters when two same-name conversation rows are visible", async () => {
    const driver = new FakeDriver([
      [
        line("示例联系人", 0.20, 0.43),
        line("示例联系人", 0.20, 0.57),
        line("文件传输助手", 0.40, 0.89),
      ],
      [line("示例联系人", 0.40, 0.89)],
    ]);
    driver.identityMatches = [[
      { normalizedY: 0.44, distance: 0.01, observedFingerprint: "a1".repeat(32), fingerprintVersion: "vision-featureprint-v1" },
      { normalizedY: 0.58, distance: 0.02, observedFingerprint: "b2".repeat(32), fingerprintVersion: "vision-featureprint-v1" },
    ]];
    const surface = nativeSurface(driver);

    await expect(
      surface.replaceDraft("example-contact", "禁止写入", "a1".repeat(32)),
    ).rejects.toThrow("WECHAT_ENROLLED_IDENTITY_NOT_UNIQUE");

    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("selects the unique same-name row that matches a supervised multi-frame enrollment", async () => {
    const driver = new FakeDriver([
      [
        line("示例联系人", 0.20, 0.43),
        line("示例联系人", 0.20, 0.57),
        line("文件传输助手", 0.40, 0.89),
      ],
      [line("示例联系人", 0.40, 0.89)],
    ]);
    driver.identityMatches = [[
      { normalizedY: 0.44, distance: 0.42, observedFingerprint: "d4".repeat(32), fingerprintVersion: "vision-featureprint-v1" },
      { normalizedY: 0.58, distance: 0.04, observedFingerprint: "c3".repeat(32), fingerprintVersion: "vision-featureprint-v1" },
    ]];
    const surface = nativeSurface(
      driver,
      () => new Date("2026-08-23T15:05:00.000Z"),
      () => Promise.resolve(),
      testSurfaceOptions,
    );

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.identity.avatarFingerprint).toBe(
      wechatIdentityEnrollmentFingerprint(fengEnrollment),
    );
    expect(driver.clicks.find(({ region }) => region === "conversation-list")?.normalizedY)
      .toBeCloseTo(1 - 0.58);
  });

  test.each([
    { label: "zero matches", matches: [], error: "WECHAT_ENROLLED_IDENTITY_NOT_MATCHED" },
    {
      label: "threshold drift",
      matches: [{ normalizedY: 0.43, distance: 0.181, observedFingerprint: "d4".repeat(32), fingerprintVersion: "vision-featureprint-v1" }],
      error: "WECHAT_ENROLLED_IDENTITY_NOT_MATCHED",
    },
    {
      label: "version mismatch",
      matches: [{ normalizedY: 0.43, distance: 0.01, observedFingerprint: "d4".repeat(32), fingerprintVersion: "vision-featureprint-v2" }],
      error: "WECHAT_IDENTITY_ENROLLMENT_VERSION_MISMATCH",
    },
  ])("fails closed with zero writes on $label", async ({ matches, error }) => {
    const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);
    driver.identityMatches = [matches];
    const surface = nativeSurface(driver);

    await expect(surface.replaceDraft("example-contact", "禁止写入", "a1".repeat(32)))
      .rejects.toThrow(error);
    expect(driver.typed).toEqual([]);
    expect(driver.enterCount).toBe(0);
  });

  test("does not erase meaningful whitespace while proving the exact composer value", async () => {
    const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);
    driver.mutationReceiptTextOverride = "秘密草稿";
    const surface = nativeSurface(driver);

    await expect(
      surface.replaceDraft("example-contact", "秘密 草稿", "a1".repeat(32)),
    ).rejects.toThrow("DRAFT_WRITE_NOT_VERIFIED");
  });

  test("uses the atomic Native mutation receipt without requiring focused AX text", async () => {
    const text = "两行正文\n——示例用户";
    const driver = new FakeDriver([[line("示例联系人", 0.40, 0.89)]]);
    driver.splitSignedDraft = true;
    const focusedRead = vi.spyOn(driver, "readFocusedText")
      .mockRejectedValue(new Error("FOCUSED_ELEMENT_UNAVAILABLE"));
    const surface = nativeSurface(driver);

    await expect(surface.replaceDraft("example-contact", text, "a1".repeat(32)))
      .resolves.toBeUndefined();

    expect(focusedRead).not.toHaveBeenCalled();
    expect(driver.draft).toBe(text);
  });

  test("accepts lossy OCR signature geometry only after the Native receipt proves exact text", async () => {
    const text = "两行正文\n——示例用户";
    const driver = new FakeDriver([[line("文件传输助手", 0.40, 0.89)]]);
    driver.splitSignedDraft = true;
    driver.signatureOcrTextOverride = "—示例用户";
    driver.signatureOcrConfidence = 0.3;
    const surface = nativeSurface(driver);

    await expect(surface.replaceDraft("file-transfer", text, "a1".repeat(32)))
      .resolves.toBeUndefined();
  });

  test("rejects an unrelated low-confidence second line despite an exact Native receipt", async () => {
    const text = "两行正文\n——示例用户";
    const driver = new FakeDriver([[line("文件传输助手", 0.40, 0.89)]]);
    driver.splitSignedDraft = true;
    driver.signatureOcrTextOverride = "—聊天助理";
    driver.signatureOcrConfidence = 0.3;
    const surface = nativeSurface(driver);

    await expect(surface.replaceDraft("file-transfer", text, "a1".repeat(32)))
      .rejects.toThrow("DRAFT_WRITE_NOT_VERIFIED");
  });

  test("rechecks the exact current header before final Native submit after target drift", async () => {
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89)],
      [line("示例联系人", 0.40, 0.89)],
      [line("文件传输助手", 0.40, 0.89)],
    ]);
    const surface = nativeSurface(driver);
    await surface.replaceDraft("example-contact", "测试消息", "a1".repeat(32));

    await expect(surface.submitDraft("example-contact", "a1".repeat(32))).rejects.toThrow(
      "WECHAT_CONVERSATION_HEADER_MISMATCH",
    );

    expect(driver.enterCount).toBe(0);
    expect(driver.submitRequests).toEqual([]);
  });

  test("keeps the window revision stable when volatile message OCR changes", async () => {
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89), line("第一条消息", 0.42, 0.72)],
      [line("示例联系人", 0.40, 0.89), line("随后出现的新消息", 0.42, 0.72)],
    ]);
    const surface = nativeSurface(driver);

    const initial = await surface.locateConversation("example-contact");

    await expect(
      surface.focusConversation("example-contact", initial.windowRevision),
    ).resolves.toBeUndefined();
  });

  test("reuses the verified locate proof without repeating capture or OCR when preparing focus", async () => {
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89), line("第一条消息", 0.42, 0.72)],
    ]);
    const surface = nativeSurface(driver);

    const initial = await surface.locateConversation("example-contact");
    await surface.focusConversation("example-contact", initial.windowRevision);

    expect(driver.listWindowsCount).toBe(2);
    expect(driver.captureCount).toBe(1);
    expect(driver.ocrCount).toBe(1);
    expect(driver.clicks.filter((click) => click.region === "composer")).toHaveLength(2);
  });

  test("clears a mismatched locate proof and fails closed without re-reading the conversation", async () => {
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89)],
    ]);
    const surface = nativeSurface(driver);
    const initial = await surface.locateConversation("example-contact");

    await expect(
      surface.focusConversation("example-contact", "wrong-window-revision"),
    ).rejects.toThrow("CONVERSATION_FOCUS_PROOF_MISMATCH");
    await expect(
      surface.focusConversation("example-contact", initial.windowRevision),
    ).rejects.toThrow("CONVERSATION_FOCUS_PROOF_MISMATCH");

    expect(driver.listWindowsCount).toBe(1);
    expect(driver.captureCount).toBe(1);
    expect(driver.ocrCount).toBe(1);
  });

  test("rejects a different native window identity for the same conversation", async () => {
    const replacementWindow: WindowDescriptor = { ...window, windowID: 43 };
    const driver = new FakeDriver(
      [[line("示例联系人", 0.40, 0.89)]],
      [window, replacementWindow],
    );
    const surface = nativeSurface(driver);
    const initial = await surface.locateConversation("example-contact");

    await expect(
      surface.focusConversation("example-contact", initial.windowRevision),
    ).rejects.toThrow("WINDOW_REVISION_CHANGED");
  });

  test("keeps meaningful alternate composer OCR when the primary is only a cursor", async () => {
    const cursor = {
      ...line("|", 0.5, 0.2),
      alternatives: ["未核验草稿"],
    };
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89), cursor],
    ]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot).toMatchObject({
      draftText: "",
      draftAlternatives: ["未核验草稿"],
      composerEvidence: "meaningful-content",
    });
  });

  test("reads composer text from the modern split-pane boundary", async () => {
    const driver = new FakeDriver([[
      line("文件传输助手", 0.3386175273, 0.9324547128),
      line("测试信息", 0.3400973133, 0.2923865377),
    ]]);
    const surface = nativeSurface(driver, () => new Date(), () => Promise.resolve(), {});

    const snapshot = await surface.locateConversation("file-transfer");

    expect(snapshot).toMatchObject({
      draftText: "测试信息",
      composerEvidence: "meaningful-content",
    });
  });

  test("marks low-confidence composer OCR as ambiguous instead of empty", async () => {
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89), line("可能有草稿", 0.5, 0.2, 0.49)],
    ]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot).toMatchObject({
      draftText: "",
      composerEvidence: "ambiguous",
    });
  });

  test("ignores the compact WeChat input-method indicator outside the editable body", async () => {
    const imeIndicator: OCRLine = {
      text: "拼",
      confidence: 1,
      bounds: { x: 0.385, y: 0.317, width: 0.027, height: 0.018 },
    };
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89), imeIndicator],
    ]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot).toMatchObject({
      draftText: "",
      composerEvidence: "proven-empty",
    });
  });

  test("ignores the low-confidence toolbar dash at the modern composer boundary", async () => {
    const toolbarDash: OCRLine = {
      text: "一",
      confidence: 0.3,
      bounds: { x: 0.3227, y: 0.2885, width: 0.0291, height: 0.0317 },
    };
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89), toolbarDash],
    ]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot).toMatchObject({
      draftText: "",
      composerEvidence: "proven-empty",
    });
  });

  test("treats the observed low-confidence cursor glyph as cursor-only evidence", async () => {
    const observedCursor: OCRLine = {
      text: "|",
      confidence: 0.3,
      bounds: {
        x: 0.32267441912164896,
        y: 0.29388560088846283,
        width: 0.023255813355539334,
        height: 0.02761341291735453,
      },
    };
    const driver = new FakeDriver([[
      line("示例联系人", 0.40, 0.89),
      observedCursor,
    ]]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot).toMatchObject({
      draftText: "",
      composerEvidence: "proven-empty",
    });
  });

  test("ignores only a compact low-confidence OCR artifact in the right action toolbar", async () => {
    const rightActionToolbarArtifact: OCRLine = {
      text: "C日",
      confidence: 0.3,
      bounds: { x: 0.8939, y: 0.3417, width: 0.0785, height: 0.0378 },
    };
    const accepted = await nativeSurface(new FakeDriver([[
      line("示例联系人", 0.40, 0.89),
      rightActionToolbarArtifact,
    ]])).locateConversation("example-contact");

    expect(accepted).toMatchObject({ draftText: "", composerEvidence: "proven-empty" });

    for (const rejectedArtifact of [
      { ...rightActionToolbarArtifact, bounds: { ...rightActionToolbarArtifact.bounds, x: 0.80 } },
      { ...rightActionToolbarArtifact, bounds: { ...rightActionToolbarArtifact.bounds, y: 0.20 } },
      { ...rightActionToolbarArtifact, confidence: 0.5 },
      { ...rightActionToolbarArtifact, bounds: { ...rightActionToolbarArtifact.bounds, width: 0.11 } },
      { ...rightActionToolbarArtifact, text: "工具栏" },
    ]) {
      const rejected = await nativeSurface(new FakeDriver([[
        line("示例联系人", 0.40, 0.89),
        rejectedArtifact,
      ]])).locateConversation("example-contact");
      expect(rejected.composerEvidence).not.toBe("proven-empty");
    }
  });

  test("does not ignore the same dash inside the editable composer body", async () => {
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89), line("一", 0.3401, 0.2924, 0.3)],
    ]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.composerEvidence).toBe("ambiguous");
  });

  test("does not ignore the same character inside the editable body", async () => {
    const driver = new FakeDriver([
      [line("示例联系人", 0.40, 0.89), line("拼", 0.50, 0.20)],
    ]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.composerEvidence).toBe("meaningful-content");
  });

  test("inspects alternate OCR independently across multiple composer lines", async () => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.40, 0.89),
      { ...line("|", 0.5, 0.22), alternatives: ["未核验草稿"] },
      line("—", 0.5, 0.18),
    ]]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.composerEvidence).toBe("meaningful-content");
  });

  test("keeps mixed reliable and low-confidence composer evidence ambiguous", async () => {
    const driver = new FakeDriver([[
      line("示例联系人", 0.40, 0.89),
      line("可靠文本", 0.5, 0.22),
      line("低置信证据", 0.5, 0.18, 0.49),
    ]]);
    const surface = nativeSurface(driver);

    const snapshot = await surface.locateConversation("example-contact");

    expect(snapshot.composerEvidence).toBe("ambiguous");
  });
});

describe("parseVisibleWechatMessages", () => {
  test("keeps only the right conversation pane and infers bubble direction", () => {
    const messages = parseVisibleWechatMessages([
      line("示例联系人", 0.20, 0.43),
      line("示例联系人", 0.40, 0.89),
      line("今天又加班", 0.43, 0.75),
      line("辛苦了", 0.76, 0.68),
      line("搜索", 0.18, 0.90),
    ], "example-contact", new Date("2026-08-19T03:00:00.000Z"));

    expect(messages.map(({ direction, text }) => ({ direction, text }))).toEqual([
      { direction: "incoming", text: "今天又加班" },
      { direction: "outgoing", text: "辛苦了" },
    ]);
  });

  test("joins adjacent OCR lines from the same wrapped outgoing bubble", () => {
    const messages = parseVisibleWechatMessages([
      line("文件传输助手", 0.40, 0.89),
      { ...line("好家伙昨晚你一锁屏我就只能在旁边", 0.57558, 0.50823), bounds: { x: 0.57558, y: 0.50823, width: 0.2747, height: 0.02248 } },
      { ...line("干瞪眼了", 0.57551, 0.47750), bounds: { x: 0.57551, y: 0.47750, width: 0.06846, height: 0.02281 } },
    ], "file-transfer", new Date("2026-08-19T10:19:00.000Z"));

    expect(messages.map(({ direction, text }) => ({ direction, text }))).toEqual([
      { direction: "outgoing", text: "好家伙昨晚你一锁屏我就只能在旁边干瞪眼了" },
    ]);
  });

  test("preserves repeated file-transfer control instances in visual order", () => {
    const messages = parseVisibleWechatMessages([
      line("停止继续生成", 0.76, 0.78),
      line("继续生成", 0.76, 0.68),
      line("停止继续生成", 0.76, 0.58),
    ], "file-transfer", new Date("2026-08-21T09:00:00.000Z"));

    expect(messages.map((message) => message.text)).toEqual([
      "停止继续生成",
      "继续生成",
      "停止继续生成",
    ]);
    expect(messages[0]?.id).toBe(messages[2]?.id);
  });

  test("preserves repeated target-message occurrences so the latest direction is not lost", () => {
    const messages = parseVisibleWechatMessages([
      line("第一条", 0.43, 0.78),
      line("第二条", 0.43, 0.68),
      line("第一条", 0.43, 0.58),
    ], "example-contact", new Date("2026-08-21T09:00:00.000Z"));

    expect(messages.map((message) => message.text)).toEqual(["第一条", "第二条", "第一条"]);
    expect(messages[0]?.id).toBe(messages[2]?.id);
  });

  test("binds one fresh target-row preview to the latest incoming pane message", () => {
    const lines = [
      line("示例联系人", 0.14, 0.62),
      line("02:12", 0.26, 0.62),
      line("测试账号消息 0209", 0.14, 0.58),
      line("示例联系人", 0.40, 0.89),
      line("02:12", 0.60, 0.54),
      line("测试账号消息0209", 0.42, 0.46),
    ];
    const capturedAt = new Date("2026-08-31T02:12:30+08:00");
    const messages = parseVisibleWechatMessages(lines, "example-contact", capturedAt);

    const evidence = parseLatestIncomingEvidence(lines, {
      conversationId: "example-contact",
      visibleName: "示例联系人",
      messages,
      capturedAt,
      windowRevision: "a".repeat(64),
    });

    expect(evidence).toMatchObject({
      version: 1,
      messageId: messages.at(-1)?.id,
      observedMinute: "02:12",
      confidence: 1,
    });
    expect(evidence?.proofId).toMatch(/^[a-f0-9]{64}$/u);
  });

  test.each([
    {
      label: "stale row time",
      mutate: (lines: OCRLine[]) => { const rowTime = lines[1]; if (rowTime !== undefined) rowTime.text = "01:40"; },
    },
    {
      label: "ambiguous row preview",
      mutate: (lines: OCRLine[]) => { lines.push(line("另一条预览", 0.14, 0.56)); },
    },
    {
      label: "preview mismatch",
      mutate: (lines: OCRLine[]) => { const preview = lines[2]; if (preview !== undefined) preview.text = "其他消息"; },
    },
    {
      label: "latest outgoing",
      mutate: (lines: OCRLine[]) => { const bubble = lines[5]; if (bubble !== undefined) bubble.bounds.x = 0.76; },
    },
  ])("rejects fresh incoming evidence with $label", ({ mutate }) => {
    const lines = [
      line("示例联系人", 0.14, 0.62),
      line("02:12", 0.26, 0.62),
      line("测试账号消息 0209", 0.14, 0.58),
      line("示例联系人", 0.40, 0.89),
      line("02:12", 0.60, 0.54),
      line("测试账号消息0209", 0.42, 0.46),
    ];
    mutate(lines);
    const capturedAt = new Date("2026-08-31T02:12:30+08:00");
    const messages = parseVisibleWechatMessages(lines, "example-contact", capturedAt);

    expect(parseLatestIncomingEvidence(lines, {
      conversationId: "example-contact",
      visibleName: "示例联系人",
      messages,
      capturedAt,
      windowRevision: "a".repeat(64),
    })).toBeNull();
  });
});
