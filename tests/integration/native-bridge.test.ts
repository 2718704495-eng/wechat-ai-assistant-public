import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AuthorizedWechatTarget } from "../../src/contacts/contact-directory.js";
import {
  bindNativeTextTargetRequest,
  NativeBridge,
  type WechatMutationAction,
  type WechatTextMutationRequest,
  type WechatWindowClickRequest,
} from "../../src/adapters/native-bridge.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import {
  issueNativeTextTargetCapability as issueUnboundNativeTextTargetCapability,
  type IssueNativeTextTargetCapabilityInput,
} from "../../src/security/native-capability-mac.js";

const fakeBridge = path.resolve("tests/fixtures/fake-native-bridge.mjs");

class FixedCapabilityKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

const capabilityKeyProvider = new FixedCapabilityKeyProvider(
  Buffer.alloc(32, 0x42),
);
const dynamicTarget: AuthorizedWechatTarget = {
  contactId: "contact-0123456789abcdef0123456789abcdef",
  displayName: "我",
  revision: 3,
  enrollment: {
    version: 2,
    contactId: "contact-0123456789abcdef0123456789abcdef",
    displayName: "我",
    fingerprintVersion: "vision-featureprint-v1",
    referenceSamples: ["c2FtcGxlMQ==", "c2FtcGxlMg==", "c2FtcGxlMw=="],
    enrolledAt: "2026-08-31T03:00:00.000Z",
  },
  enrollmentFingerprint: "c".repeat(64),
  bindingHash: "d".repeat(64),
};

const testConversationProof = {
  version: 1 as const,
  latestMessageId: "1".repeat(64),
  latestTextHash: "2".repeat(64),
  latestDirection: "incoming" as const,
  controlRevision: "3".repeat(64),
};

async function issueNativeTextTargetCapability(
  input: IssueNativeTextTargetCapabilityInput,
) {
  const capability = await issueUnboundNativeTextTargetCapability(input);
  return bindNativeTextTargetRequest({
    capability,
    windowID: 42,
    bundleID: "com.tencent.xinWeChat",
    title: "微信",
    conversationTitle: input.target.displayName,
    token: capability.capabilityId,
    slotKey: input.slotKey,
    draftText: input.draftText,
    conversationProof: testConversationProof,
    keyProvider: input.keyProvider ?? capabilityKeyProvider,
  });
}

function enrollmentSample(byte: number): string {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

const enrollment = {
  version: 1 as const,
  conversationId: "file-transfer" as const,
  visibleName: "文件传输助手" as const,
  fingerprintVersion: "vision-featureprint-v1" as const,
  referenceSamples: [1, 2, 3].map(enrollmentSample),
  enrolledAt: "2026-08-23T14:00:00.000Z",
};

function submitRequest(
  token = "a1".repeat(32),
  draftText = "逐字节保留\r\n第二行\0🌙 ——示例用户",
) {
  const slotKey = "2026-08-23/night";
  return {
    windowID: 42,
    bundleID: "com.tencent.xinWeChat" as const,
    title: "微信" as const,
    conversationTitle: "文件传输助手" as const,
    token,
    slotKey,
    draftText,
    identityEnrollment: enrollment,
    capability: {
      version: 1 as const,
      capabilityId: token,
      candidateHash: createHash("sha256")
        .update(draftText.normalize("NFC").replace(/\r\n?/gu, "\n"))
        .digest("hex"),
      slotHash: createHash("sha256").update(slotKey).digest("hex"),
      identityFingerprint: titleIdentityFingerprint(
        "文件传输助手",
        createHash("sha256")
          .update(
            ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
          )
          .digest("hex"),
      ),
      windowRevision: createHash("sha256")
        .update(
          ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
        )
        .digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  };
}

function titleIdentityFingerprint(
  title: "文件传输助手" | "示例联系人",
  windowRevision: string,
): string {
  return createHash("sha256")
    .update(["wechat-unique-title-v1", title, windowRevision].join("\0"))
    .digest("hex");
}

function mutationCapability(
  action: WechatMutationAction,
  token: string,
  text: string,
) {
  const slotKey = `non-daily/${createHash("sha256").update(token).digest("hex")}`;
  const windowRevision = createHash("sha256")
    .update(["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"))
    .digest("hex");
  return {
    slotKey,
    capability: {
      version: 1 as const,
      capabilityId: token,
      action,
      candidateHash: createHash("sha256")
        .update(text.normalize("NFC").replace(/\r\n?/gu, "\n"))
        .digest("hex"),
      slotHash: createHash("sha256").update(slotKey).digest("hex"),
      identityFingerprint: titleIdentityFingerprint(
        "文件传输助手",
        windowRevision,
      ),
      windowRevision,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  };
}

function textMutationRequest(
  action: "replace-draft" | "clear-draft",
  token: string,
  text: string,
): WechatTextMutationRequest {
  return {
    windowID: 42,
    bundleID: "com.tencent.xinWeChat",
    title: "微信",
    conversationTitle: "文件传输助手",
    token,
    text,
    ...mutationCapability(action, token, text),
  };
}

function clickMutationRequest(
  token: string,
  normalizedX = 0.7,
  normalizedY = 0.82,
): WechatWindowClickRequest {
  return {
    windowID: 42,
    bundleID: "com.tencent.xinWeChat",
    title: "微信",
    conversationTitle: "文件传输助手",
    region: "composer",
    normalizedX,
    normalizedY,
    token,
    ...mutationCapability("focus-composer", token, ""),
  };
}

describe("NativeBridge", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "chat-native-bridge-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  function bridge(scenario = "success", timeoutMs = 15_000): NativeBridge {
    return new NativeBridge({
      executablePath: process.execPath,
      baseArguments: [fakeBridge],
      dataDir,
      timeoutMs,
      environment: {
        ...process.env,
        TMPDIR: dataDir,
        FAKE_BRIDGE_SCENARIO: scenario,
      },
      nativeCapabilityKeyProvider: capabilityKeyProvider,
    });
  }

  test("parses a validated window descriptor from the native process", async () => {
    await expect(
      bridge().listWindows("com.tencent.xinWeChat"),
    ).resolves.toEqual([
      {
        windowID: 42,
        processID: 100,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        ownerName: "WeChat",
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
      },
    ]);
  });

  test("terminates a native command after the configured timeout", async () => {
    await expect(bridge("hang", 50).diagnosePermissions()).rejects.toThrow(
      "NATIVE_BRIDGE_TIMEOUT",
    );
  });

  test("reports a nonzero exit without trusting stderr as a result", async () => {
    await expect(
      bridge("nonzero").listWindows("com.tencent.xinWeChat"),
    ).rejects.toThrow("NATIVE_BRIDGE_EXIT_7");
  });

  test("rejects malformed JSON from the native boundary", async () => {
    await expect(bridge("invalid-json").diagnosePermissions()).rejects.toThrow(
      "INVALID_NATIVE_BRIDGE_JSON",
    );
  });

  test("returns missing permissions as explicit false values", async () => {
    await expect(
      bridge("missing-accessibility").diagnosePermissions(),
    ).resolves.toEqual({
      accessibility: false,
      screenRecording: true,
    });
    await expect(
      bridge("missing-screen-recording").diagnosePermissions(),
    ).resolves.toEqual({
      accessibility: true,
      screenRecording: false,
    });
  });

  test("captures only inside temp and deletes the image after OCR succeeds", async () => {
    const adapter = bridge();
    const screenshot = await adapter.capture(42);
    await expect(readFile(screenshot, "utf8")).resolves.toBe("synthetic-png");

    await expect(adapter.ocr(screenshot)).resolves.toMatchObject([
      { text: "示例联系人", confidence: 0.99 },
    ]);
    await expect(readdir(path.join(dataDir, "temp"))).resolves.toEqual([]);
  });

  test("deletes the image when OCR exits with an error", async () => {
    const screenshot = await bridge().capture(42);

    await expect(bridge("ocr-failure").ocr(screenshot)).rejects.toThrow(
      "NATIVE_BRIDGE_EXIT_9",
    );
    await expect(readdir(path.join(dataDir, "temp"))).resolves.toEqual([]);
  });

  test("refuses to read or delete an OCR path outside temp", async () => {
    const outside = path.join(dataDir, "outside.png");
    await writeFile(outside, "keep-me");

    await expect(bridge().ocr(outside)).rejects.toThrow(
      "PATH_OUTSIDE_TEMP_DIR",
    );
    await expect(readFile(outside, "utf8")).resolves.toBe("keep-me");
  });

  test("uses one bounded framed stdin channel for every sensitive write without argv/env leakage", async () => {
    const token = "a1".repeat(32);
    const text = "逐字节保留\r\n第二行\0🌙 ——示例用户";
    const submitted = submitRequest(token, text);
    const typedRequest = textMutationRequest("replace-draft", token, text);
    const clickedRequest = clickMutationRequest(token);
    const requests = [
      {
        command: "type-text",
        payload: typedRequest,
        invoke: (adapter: NativeBridge) => adapter.typeText(typedRequest),
        expected: { text, cleared: false },
      },
      {
        command: "press-enter",
        payload: { token },
        invoke: (adapter: NativeBridge) => adapter.pressEnter(token),
        expected: undefined,
      },
      {
        command: "click-wechat-point",
        payload: clickedRequest,
        invoke: (adapter: NativeBridge) =>
          adapter.clickWechatWindowPoint(clickedRequest),
        expected: undefined,
      },
      {
        command: "submit-wechat-draft",
        payload: submitted,
        invoke: (adapter: NativeBridge) => adapter.submitWechatDraft(submitted),
        expected: { attempted: true },
      },
    ] as const;

    for (const [index, request] of requests.entries()) {
      const invocationPath = path.join(dataDir, `sensitive-${index}.json`);
      const adapter = new NativeBridge({
        executablePath: process.execPath,
        baseArguments: [fakeBridge],
        dataDir,
        environment: {
          PATH: process.env.PATH,
          FAKE_BRIDGE_ARGS_PATH: invocationPath,
          SENSITIVE_SHADOW: Object.values(request.payload).find(
            (value) => typeof value === "string",
          ) as string,
        },
      });
      await expect(request.invoke(adapter)).resolves.toEqual(request.expected);
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        arguments: string[];
        stdinBase64: string;
        sensitiveEnvironmentMatches: number;
      };
      const frame = Buffer.from(invocation.stdinBase64, "base64");
      expect(invocation.arguments).toEqual(["write-command"]);
      expect(invocation.sensitiveEnvironmentMatches).toBe(0);
      expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
      expect(JSON.parse(frame.subarray(4).toString("utf8"))).toEqual({
        version: 1,
        command: request.command,
        payload: request.payload,
      });
      expect(JSON.stringify(invocation.arguments)).not.toContain(token);
      expect(JSON.stringify(invocation.arguments)).not.toContain(text);
    }
  });

  test("prepares the reviewed card through one bound file-transfer attachment capability", async () => {
    const token = "c3".repeat(32);
    const slotKey = `non-daily/${createHash("sha256").update(token).digest("hex")}`;
    const windowRevision = createHash("sha256")
      .update(
        ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
      )
      .digest("hex");
    const imageSha256 =
      "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177";
    const imagePath = path.resolve(
      "assets/relationship-care/intro-card.png",
    );
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat" as const,
      title: "微信" as const,
      conversationTitle: "文件传输助手" as const,
      token,
      slotKey,
      imagePath,
      imageSha256,
      width: 1080,
      height: 1350,
      capability: {
        version: 1 as const,
        capabilityId: token,
        action: "attach-image" as const,
        candidateHash: imageSha256,
        slotHash: createHash("sha256").update(slotKey).digest("hex"),
        identityFingerprint: titleIdentityFingerprint(
          "文件传输助手",
          windowRevision,
        ),
        windowRevision,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    };
    const adapter = bridge() as NativeBridge & {
      prepareWechatImageAttachment(input: typeof request): Promise<{
        imageSha256: string;
        width: number;
        height: number;
        attachmentCount: number;
        textEmpty: boolean;
      }>;
    };

    await expect(
      adapter.prepareWechatImageAttachment(request),
    ).resolves.toEqual({
      imageSha256,
      width: 1080,
      height: 1350,
      attachmentCount: 1,
      textEmpty: true,
    });
  });

  test("sends the reviewed comfort-station card once through a dedicated image capability", async () => {
    const token = "d4".repeat(32);
    const deliveryKey = createHash("sha256")
      .update("delivery-key")
      .digest("hex");
    const slotKey = `non-daily/${deliveryKey}`;
    const windowRevision = createHash("sha256")
      .update(
        ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
      )
      .digest("hex");
    const imageSha256 =
      "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177";
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat" as const,
      title: "微信" as const,
      conversationTitle: "示例联系人" as const,
      token,
      slotKey,
      imagePath: path.resolve(
        "assets/relationship-care/intro-card.png",
      ),
      imageSha256,
      width: 1080 as const,
      height: 1350 as const,
      capability: {
        version: 1 as const,
        capabilityId: token,
        action: "send-image" as const,
        candidateHash: imageSha256,
        slotHash: createHash("sha256").update(slotKey).digest("hex"),
        identityFingerprint: titleIdentityFingerprint("示例联系人", windowRevision),
        windowRevision,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    };

    await expect(bridge().sendWechatImage(request)).resolves.toEqual({
      imageSha256,
      width: 1080,
      height: 1350,
      attachmentCount: 1,
      textEmpty: true,
      submitted: true,
      outgoingImageMatched: true,
      visualFingerprintVersion: "vision-featureprint-v1",
    });
    await expect(bridge().sendWechatImage(request)).rejects.toThrow(
      "NATIVE_BRIDGE_EXIT_11",
    );
  });

  test("archives image quarantine only through the exact framed ExampleContact recovery command", async () => {
    await expect(
      bridge().recoverWechatImageQuarantine({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        conversationTitle: "示例联系人",
      }),
    ).resolves.toEqual({
      status: "recovered",
      archiveName: `dirty-archive-${"a".repeat(64)}`,
      composerEmpty: true,
    });
    await expect(
      bridge().recoverWechatImageQuarantine({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        conversationTitle: "文件传输助手" as "示例联系人",
      }),
    ).rejects.toThrow("WECHAT_IMAGE_ATTACHMENT_RECOVERY_TARGET_NOT_ALLOWED");
  });

  test("rejects one attachment capability across two NativeBridge instances", async () => {
    const token = "e5".repeat(32);
    const slotKey = `non-daily/${createHash("sha256").update(token).digest("hex")}`;
    const windowRevision = createHash("sha256")
      .update(
        ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
      )
      .digest("hex");
    const imageSha256 =
      "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177";
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat" as const,
      title: "微信" as const,
      conversationTitle: "文件传输助手" as const,
      token,
      slotKey,
      imagePath: path.resolve(
        "assets/relationship-care/intro-card.png",
      ),
      imageSha256,
      width: 1080 as const,
      height: 1350 as const,
      capability: {
        version: 1 as const,
        capabilityId: token,
        action: "attach-image" as const,
        candidateHash: imageSha256,
        slotHash: createHash("sha256").update(slotKey).digest("hex"),
        identityFingerprint: titleIdentityFingerprint(
          "文件传输助手",
          windowRevision,
        ),
        windowRevision,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    };

    await expect(
      bridge().prepareWechatImageAttachment(request),
    ).resolves.toMatchObject({
      imageSha256,
      attachmentCount: 1,
    });
    await expect(
      bridge().prepareWechatImageAttachment(request),
    ).rejects.toThrow("NATIVE_BRIDGE_EXIT_11");
  });

  test("keeps an attachment capability consumed when the first Native process fails", async () => {
    const token = "f6".repeat(32);
    const slotKey = `non-daily/${createHash("sha256").update(token).digest("hex")}`;
    const windowRevision = createHash("sha256")
      .update(
        ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
      )
      .digest("hex");
    const imageSha256 =
      "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177";
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat" as const,
      title: "微信" as const,
      conversationTitle: "文件传输助手" as const,
      token,
      slotKey,
      imagePath: path.resolve(
        "assets/relationship-care/intro-card.png",
      ),
      imageSha256,
      width: 1080 as const,
      height: 1350 as const,
      capability: {
        version: 1 as const,
        capabilityId: token,
        action: "attach-image" as const,
        candidateHash: imageSha256,
        slotHash: createHash("sha256").update(slotKey).digest("hex"),
        identityFingerprint: titleIdentityFingerprint(
          "文件传输助手",
          windowRevision,
        ),
        windowRevision,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    };

    await expect(
      bridge("attach-after-consume-failure").prepareWechatImageAttachment(
        request,
      ),
    ).rejects.toThrow("NATIVE_BRIDGE_EXIT_12");
    await expect(
      bridge().prepareWechatImageAttachment(request),
    ).rejects.toThrow("NATIVE_BRIDGE_EXIT_11");
  });

  test("rejects an oversized sensitive request before spawning Native", async () => {
    const token = "a1".repeat(32);
    await expect(
      bridge().typeText(
        textMutationRequest("replace-draft", token, "密".repeat(70_000)),
      ),
    ).rejects.toThrow("SENSITIVE_REQUEST_TOO_LARGE");
  });

  test("returns an exact Native composer receipt for replace and clear mutations", async () => {
    const replaceToken = "a1".repeat(32);
    const clearToken = "b2".repeat(32);
    const text = "保留正文换行\n——示例用户";

    await expect(
      bridge().typeText(
        textMutationRequest("replace-draft", replaceToken, text),
      ),
    ).resolves.toEqual({ text, cleared: false });
    await expect(
      bridge().typeText(textMutationRequest("clear-draft", clearToken, "")),
    ).resolves.toEqual({ text: "", cleared: true });
  });

  test("clicks only an allowed region in the verified main WeChat window", async () => {
    await expect(
      bridge().clickWechatWindowPoint(clickMutationRequest("a1".repeat(32))),
    ).resolves.toBeUndefined();

    await expect(
      bridge().clickWechatWindowPoint(
        clickMutationRequest("a1".repeat(32), 0.2, 0.2),
      ),
    ).rejects.toThrow("WECHAT_CLICK_POINT_NOT_ALLOWED");
  });

  test("rejects preliminary mutation requests that carry only a shape-valid nonce", async () => {
    const adapter = bridge();
    const token = "a1".repeat(32);

    await expect(
      (
        adapter.typeText as unknown as (
          text: string,
          token: string,
        ) => Promise<void>
      )("越权草稿", token),
    ).rejects.toThrow("WRITE_CAPABILITY_REQUIRED");
    await expect(
      adapter.clickWechatWindowPoint({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        region: "composer",
        normalizedX: 0.7,
        normalizedY: 0.82,
        token,
      }),
    ).rejects.toThrow("WRITE_CAPABILITY_REQUIRED");
  });

  test("admits one MAC-authorized dynamic text mutation and rejects title drift or replay before Native", async () => {
    const token = "7".repeat(64);
    const slotKey = `non-daily/${"8".repeat(64)}`;
    const windowRevision = createHash("sha256")
      .update(
        ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
      )
      .digest("hex");
    const text = "动态联系人回复";
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "replace-draft",
      draftText: text,
      slotKey,
      windowRevision,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId: token,
      keyProvider: capabilityKeyProvider,
    });
    const request: WechatTextMutationRequest = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat",
      title: "微信",
      conversationTitle: dynamicTarget.displayName,
      token,
      slotKey,
      text,
      capability,
    };
    const adapter = bridge();

    await expect(adapter.typeText(request)).resolves.toEqual({
      text,
      cleared: false,
    });
    await expect(adapter.typeText(request)).rejects.toThrow(
      "WECHAT_CONTACT_CAPABILITY_INVALID",
    );
    await expect(
      bridge().typeText({
        ...request,
        conversationTitle: "伪标题",
      }),
    ).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
    await expect(
      bridge().typeText({
        ...request,
        capability: { ...capability, contactRevision: 4 },
      }),
    ).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  test("rejects a mismatched dynamic submit token without consuming the valid capability", async () => {
    const capabilityId = "6".repeat(64);
    const slotKey = `non-daily/${"8".repeat(64)}`;
    const draftText = "动态提交令牌绑定";
    const windowRevision = createHash("sha256")
      .update(
        ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
      )
      .digest("hex");
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId,
      keyProvider: capabilityKeyProvider,
    });
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat",
      title: "微信",
      conversationTitle: dynamicTarget.displayName,
      token: capabilityId,
      slotKey,
      draftText,
      conversationProof: testConversationProof,
      capability,
    };
    const adapter = bridge();

    await expect(
      adapter.submitWechatDraft({ ...request, token: "7".repeat(64) }),
    ).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
    await expect(
      adapter.submitWechatDraft(
        request,
        {
          signal: new AbortController().signal,
          markSubmitStarted: () => Promise.resolve(true),
        },
      ),
    ).resolves.toEqual({ attempted: true });
  });

  test("rejects every malformed dynamic window before fence or spawn without consuming the capability", async () => {
    const capabilityId = "3".repeat(64);
    const slotKey = `non-daily/${"7".repeat(64)}`;
    const draftText = "strict native window";
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision: createHash("sha256")
        .update(
          ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
        )
        .digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId,
      keyProvider: capabilityKeyProvider,
    });
    const fence = vi.fn().mockResolvedValue(false);
    const adapter = new NativeBridge({
      executablePath: path.join(dataDir, "must-not-spawn"),
      dataDir,
      nativeCapabilityKeyProvider: capabilityKeyProvider,
    });
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat" as const,
      title: "微信" as const,
      conversationTitle: dynamicTarget.displayName,
      token: capabilityId,
      slotKey,
      draftText,
      conversationProof: testConversationProof,
      capability,
    };
    const control = {
      signal: new AbortController().signal,
      markSubmitStarted: fence,
    };
    const missingWindow: Partial<typeof request> = { ...request };
    delete missingWindow.windowID;

    await expect(
      adapter.submitWechatDraft(missingWindow as never, control),
    ).rejects.toThrow();
    for (const windowID of [undefined, Number.NaN, "42", -1, 1.5, 43]) {
      await expect(
        adapter.submitWechatDraft({ ...request, windowID } as never, control),
      ).rejects.toThrow();
    }
    expect(fence).not.toHaveBeenCalled();
    await expect(adapter.submitWechatDraft(request, control)).resolves.toEqual({
      attempted: false,
    });
    expect(fence).toHaveBeenCalledTimes(1);
  });

  test("runs the dynamic submit fence only after preflight and does not spawn when rejected", async () => {
    const capabilityId = "9".repeat(64);
    const slotKey = `non-daily/${"a".repeat(64)}`;
    const draftText = "native exact fence";
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision: createHash("sha256")
        .update(
          ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
        )
        .digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId,
      keyProvider: capabilityKeyProvider,
    });
    const adapter = new NativeBridge({
      executablePath: path.join(dataDir, "must-not-spawn"),
      dataDir,
      nativeCapabilityKeyProvider: capabilityKeyProvider,
    });
    let fenceCalls = 0;
    await expect(
      adapter.submitWechatDraft({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        conversationTitle: dynamicTarget.displayName,
        token: capabilityId,
        slotKey,
        draftText,
        conversationProof: testConversationProof,
        capability,
      }, {
        signal: new AbortController().signal,
        markSubmitStarted: () => {
          fenceCalls += 1;
          return Promise.resolve(false);
        },
      }),
    ).resolves.toEqual({ attempted: false });
    expect(fenceCalls).toBe(1);
    await expect(
      adapter.submitWechatDraft({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        conversationTitle: dynamicTarget.displayName,
        token: capabilityId,
        slotKey,
        draftText,
        conversationProof: testConversationProof,
        capability,
      }, {
        signal: new AbortController().signal,
        markSubmitStarted: () => Promise.resolve(true),
      }),
    ).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  test("reports a post-fence native spawn failure as an attempted uncertain boundary", async () => {
    const capabilityId = "8".repeat(64);
    const slotKey = `non-daily/${"b".repeat(64)}`;
    const draftText = "post fence spawn failure";
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision: createHash("sha256")
        .update(
          ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
        )
        .digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId,
      keyProvider: capabilityKeyProvider,
    });
    const adapter = new NativeBridge({
      executablePath: path.join(dataDir, "spawn-fails-after-fence"),
      dataDir,
      nativeCapabilityKeyProvider: capabilityKeyProvider,
    });
    let fenced = false;
    await expect(
      adapter.submitWechatDraft({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        conversationTitle: dynamicTarget.displayName,
        token: capabilityId,
        slotKey,
        draftText,
        conversationProof: testConversationProof,
        capability,
      }, {
        signal: new AbortController().signal,
        markSubmitStarted: () => {
          fenced = true;
          return Promise.resolve(true);
        },
      }),
    ).rejects.toThrow("NATIVE_BRIDGE_START_FAILED");
    expect(fenced).toBe(true);
  });

  test("does not spawn when service cancellation lands after the fence", async () => {
    const capabilityId = "7".repeat(64);
    const slotKey = `non-daily/${"c".repeat(64)}`;
    const draftText = "cancel after fence";
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision: createHash("sha256")
        .update(["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"))
        .digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId,
      keyProvider: capabilityKeyProvider,
    });
    const controller = new AbortController();
    const adapter = new NativeBridge({
      executablePath: path.join(dataDir, "must-not-spawn-after-abort"),
      dataDir,
      nativeCapabilityKeyProvider: capabilityKeyProvider,
    });
    await expect(adapter.submitWechatDraft({
      windowID: 42,
      bundleID: "com.tencent.xinWeChat",
      title: "微信",
      conversationTitle: dynamicTarget.displayName,
      token: capabilityId,
      slotKey,
      draftText,
      conversationProof: testConversationProof,
      capability,
    }, {
      signal: controller.signal,
      markSubmitStarted: () => {
        queueMicrotask(() => controller.abort(new Error("SERVICE_STOPPING")));
        return Promise.resolve(true);
      },
    })).rejects.toThrow("NATIVE_BRIDGE_ABORTED");
  });

  test("terminates an already spawned sensitive child when service cancellation arrives", async () => {
    const capabilityId = "6".repeat(64);
    const slotKey = `non-daily/${"d".repeat(64)}`;
    const draftText = "cancel spawned child";
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision: createHash("sha256")
        .update(["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"))
        .digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId,
      keyProvider: capabilityKeyProvider,
    });
    const controller = new AbortController();
    const adapter = bridge("hang");
    const attempt = adapter.submitWechatDraft({
      windowID: 42,
      bundleID: "com.tencent.xinWeChat",
      title: "微信",
      conversationTitle: dynamicTarget.displayName,
      token: capabilityId,
      slotKey,
      draftText,
      conversationProof: testConversationProof,
      capability,
    }, {
      signal: controller.signal,
      markSubmitStarted: () => Promise.resolve(true),
    });
    setTimeout(() => controller.abort(new Error("SERVICE_STOPPING")), 20);
    await expect(attempt).rejects.toThrow("NATIVE_BRIDGE_ABORTED");
  });

  test("rejects an oversized dynamic submit frame before the ledger fence or spawn", async () => {
    const capabilityId = "4".repeat(64);
    const slotKey = `non-daily/${"e".repeat(64)}`;
    const draftText = "x".repeat(70_000);
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision: createHash("sha256")
        .update(
          ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
        )
        .digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId,
      keyProvider: capabilityKeyProvider,
    });
    const fence = vi.fn().mockResolvedValue(true);
    const adapter = new NativeBridge({
      executablePath: path.join(dataDir, "must-not-spawn"),
      dataDir,
      nativeCapabilityKeyProvider: capabilityKeyProvider,
    });

    await expect(
      adapter.submitWechatDraft({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        conversationTitle: dynamicTarget.displayName,
        token: capabilityId,
        slotKey,
        draftText,
        conversationProof: testConversationProof,
        capability,
      }, { signal: new AbortController().signal, markSubmitStarted: fence }),
    ).rejects.toThrow("SENSITIVE_REQUEST_TOO_LARGE");
    expect(fence).not.toHaveBeenCalled();
  });

  test("atomically reserves one dynamic submit capability across concurrent HMAC verification", async () => {
    const capabilityId = "5".repeat(64);
    const slotKey = `non-daily/${"f".repeat(64)}`;
    const draftText = "concurrent exact fence";
    const capability = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision: createHash("sha256")
        .update(
          ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
        )
        .digest("hex"),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      capabilityId,
      keyProvider: capabilityKeyProvider,
    });
    let releaseKey!: () => void;
    const keyBarrier = new Promise<void>((resolve) => {
      releaseKey = resolve;
    });
    const delayedKeyProvider: KeyProvider = {
      getOrCreate: async () => {
        await keyBarrier;
        return capabilityKeyProvider.getOrCreate();
      },
    };
    const adapter = new NativeBridge({
      executablePath: process.execPath,
      baseArguments: [fakeBridge],
      dataDir,
      nativeCapabilityKeyProvider: delayedKeyProvider,
      environment: {
        ...process.env,
        TMPDIR: dataDir,
        FAKE_BRIDGE_SCENARIO: "success",
      },
    });
    const fence = vi.fn().mockResolvedValue(true);
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat",
      title: "微信",
      conversationTitle: dynamicTarget.displayName,
      token: capabilityId,
      slotKey,
      draftText,
      conversationProof: testConversationProof,
      capability,
    };

    const control = { signal: new AbortController().signal, markSubmitStarted: fence };
    const first = adapter.submitWechatDraft(request, control);
    const second = adapter.submitWechatDraft(request, control);
    releaseKey();
    const outcomes = await Promise.allSettled([first, second]);

    expect(
      outcomes.map((outcome) =>
        outcome.status === "fulfilled"
          ? "fulfilled"
          : (outcome.reason as Error).message,
      ),
    ).toEqual(["fulfilled", "WECHAT_CONTACT_CAPABILITY_INVALID"]);
    expect(fence).toHaveBeenCalledTimes(1);
  });

  test("bounds pending capabilities and reclaims only trusted expired reservations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const slotKey = `non-daily/${"1".repeat(64)}`;
    const draftText = "bounded capability";
    const windowRevision = createHash("sha256")
      .update(
        ["42", "100", "com.tencent.xinWeChat", "微信", "WeChat"].join("\0"),
      )
      .digest("hex");
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    const capabilities = await Promise.all(
      Array.from({ length: 1_025 }, (_, index) =>
        issueNativeTextTargetCapability({
          target: dynamicTarget,
          action: "submit-draft",
          draftText,
          slotKey,
          windowRevision,
          expiresAt,
          capabilityId: createHash("sha256")
            .update(`capacity-${index}`)
            .digest("hex"),
          keyProvider: capabilityKeyProvider,
        }),
      ),
    );
    let releaseKey!: () => void;
    const keyBarrier = new Promise<void>((resolve) => {
      releaseKey = resolve;
    });
    const adapter = new NativeBridge({
      executablePath: path.join(dataDir, "must-not-spawn"),
      dataDir,
      nativeCapabilityKeyProvider: {
        getOrCreate: async () => {
          await keyBarrier;
          return capabilityKeyProvider.getOrCreate();
        },
      },
    });
    const fence = vi.fn().mockResolvedValue(false);
    const requestFor = (capability: Awaited<ReturnType<typeof issueNativeTextTargetCapability>>) => ({
      windowID: 42,
      bundleID: "com.tencent.xinWeChat" as const,
      title: "微信" as const,
      conversationTitle: dynamicTarget.displayName,
      token: capability.capabilityId,
      slotKey,
      draftText,
      conversationProof: testConversationProof,
      capability,
    });
    const pending = capabilities
      .slice(0, 1_024)
      .map((capability) => adapter.submitWechatDraft(requestFor(capability), {
        signal: new AbortController().signal,
        markSubmitStarted: fence,
      }));

    await expect(
      adapter.submitWechatDraft(requestFor(capabilities[1_024]!), {
        signal: new AbortController().signal,
        markSubmitStarted: fence,
      }),
    ).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_CAPACITY");
    expect(fence).not.toHaveBeenCalled();
    releaseKey();
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 1_024 }, () => ({ attempted: false })),
    );

    vi.advanceTimersByTime(2_000);
    const replacement = await issueNativeTextTargetCapability({
      target: dynamicTarget,
      action: "submit-draft",
      draftText,
      slotKey,
      windowRevision,
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      capabilityId: createHash("sha256").update("capacity-replacement").digest("hex"),
      keyProvider: capabilityKeyProvider,
    });
    await expect(
      adapter.submitWechatDraft(requestFor(replacement), {
        signal: new AbortController().signal,
        markSubmitStarted: fence,
      }),
    ).resolves.toEqual({ attempted: false });
    expect(fence).toHaveBeenCalledTimes(1_025);
  });

  test("reads the focused text value through a typed result", async () => {
    await expect(bridge().readFocusedText()).resolves.toBe("synthetic-draft");
  });

  test("captures bounded identity samples through the framed read-only command", async () => {
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat" as const,
      title: "微信" as const,
      conversationTitle: "我",
      expectedPreviewHash: "a".repeat(64),
      expectedWindowRevision: "b".repeat(64),
      sampleCount: 5 as const,
    };
    const sampleBytes = Buffer.alloc(13_000, 8);
    sampleBytes.write("bplist00", 0, "ascii");
    const sample = sampleBytes.toString("base64");
    const receipt = {
      fingerprintVersion: "vision-featureprint-v1",
      windowRevision: request.expectedWindowRevision,
      leftPaneProofHash: "c".repeat(64),
      headerProofHash: "d".repeat(64),
      referenceSamples: [sample, sample, sample, sample, sample],
      observedFingerprints: [
        "e".repeat(64),
        "f".repeat(64),
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
      ],
      maximumPairwiseDistance: 0.01,
    };
    const executable = path.join(dataDir, "identity-capture-bridge.mjs");
    await writeFile(
      executable,
      `
      import fs from "node:fs";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      const body = JSON.parse(frame.subarray(4).toString("utf8"));
      if (process.argv[2] !== "write-command" || body.command !== "capture-wechat-identity-samples") process.exit(9);
      fs.writeSync(3, ${JSON.stringify(`${JSON.stringify(receipt)}\n`)});
    `,
      { mode: 0o700 },
    );
    const adapter = new NativeBridge({
      executablePath: process.execPath,
      baseArguments: [executable],
      dataDir,
      environment: { ...process.env, TMPDIR: dataDir },
    });
    const captured = await adapter.captureWechatIdentitySamples(request);
    expect(captured.fingerprintVersion).toBe("vision-featureprint-v1");
    expect(captured.windowRevision).toBe(request.expectedWindowRevision);
    expect(captured.referenceSamples).toHaveLength(5);
    expect(captured.referenceSamples[0]).toBe(sample);
    expect(captured.maximumPairwiseDistance).toBe(0.01);
    await expect(
      adapter.captureWechatIdentitySamples({ ...request, sampleCount: 2 as 3 }),
    ).rejects.toThrow("WECHAT_IDENTITY_CAPTURE_REQUEST_INVALID");
  });

  test("keeps pre-click identity receipts distinct and rejects them for a selected-proof request", async () => {
    const executable = path.join(dataDir, "identity-proof-phase-bridge.mjs");
    await writeFile(
      executable,
      `
      import fs from "node:fs";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      const body = JSON.parse(frame.subarray(4).toString("utf8"));
      if (process.argv[2] !== "write-command" || body.command !== "match-wechat-identity") process.exit(9);
      fs.writeSync(3, JSON.stringify([{
        normalizedY: 0.44,
        distance: 0.01,
        observedFingerprint: "${"e".repeat(64)}",
        fingerprintVersion: "vision-featureprint-v1",
        proofPhase: "pre-click",
        selected: false,
        selectedRowTitle: null,
        selectedRowNormalizedY: null,
        selectionProofHash: null
      }]) + "\\n");
    `,
      { mode: 0o700 },
    );
    const adapter = new NativeBridge({
      executablePath: process.execPath,
      baseArguments: [executable],
      dataDir,
      environment: { ...process.env, TMPDIR: dataDir },
    });
    const request = {
      windowID: 42,
      bundleID: "com.tencent.xinWeChat",
      title: "微信",
      conversationTitle: dynamicTarget.displayName,
      enrollment: dynamicTarget.enrollment,
    };

    await expect(
      adapter.matchWechatIdentityRows({ ...request, proofPhase: "pre-click" }),
    ).resolves.toEqual([
      expect.objectContaining({ proofPhase: "pre-click", selected: false }),
    ]);
    await expect(
      adapter.matchWechatIdentityRows({ ...request, proofPhase: "selected" }),
    ).rejects.toThrow("WECHAT_IDENTITY_PROOF_PHASE_MISMATCH");
  });

  test("submits a draft only to the verified main WeChat window", async () => {
    const adapter = bridge();
    const authorized = submitRequest();
    await expect(adapter.submitWechatDraft(authorized)).resolves.toEqual({
      attempted: true,
    });
    await expect(adapter.submitWechatDraft(authorized)).rejects.toThrow(
      "WRITE_CAPABILITY_ALREADY_USED",
    );
    await expect(
      bridge().submitWechatDraft({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        conversationTitle: "文件传输助手",
        token: "a1".repeat(32),
      }),
    ).rejects.toThrow("WRITE_CAPABILITY_REQUIRED");
    await expect(
      bridge().submitWechatDraft({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "其他窗口",
        conversationTitle: "文件传输助手",
        token: "a1".repeat(32),
      }),
    ).rejects.toThrow("WECHAT_SUBMIT_TARGET_NOT_ALLOWED");
    await expect(
      bridge().submitWechatDraft({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        conversationTitle: "任意联系人",
        token: "a1".repeat(32),
      }),
    ).rejects.toThrow("WECHAT_CONVERSATION_TARGET_NOT_ALLOWED");
  });

  test("requests a bounded read-only scroll for the verified history window", async () => {
    await expect(
      bridge().scrollReadOnly({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "与“示例联系人”的聊天记录",
        deltaY: -600,
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects a read-only scroll outside the target history window", async () => {
    await expect(
      bridge().scrollReadOnly({
        windowID: 42,
        bundleID: "com.apple.Safari",
        title: "抖音",
        deltaY: -600,
      }),
    ).rejects.toThrow("READ_ONLY_SCROLL_TARGET_NOT_ALLOWED");
  });

  test("requests a downward scrollbar drag only for the verified history window", async () => {
    await expect(
      bridge().dragScrollbarReadOnly({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "与“示例联系人”的聊天记录",
        fromY: 340,
        toY: 600,
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects an upward scrollbar drag", async () => {
    await expect(
      bridge().dragScrollbarReadOnly({
        windowID: 42,
        bundleID: "com.tencent.xinWeChat",
        title: "与“示例联系人”的聊天记录",
        fromY: 600,
        toY: 340,
      }),
    ).rejects.toThrow("READ_ONLY_SCROLLBAR_DRAG_NOT_ALLOWED");
  });
});
