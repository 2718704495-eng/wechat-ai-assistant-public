import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AuthorizedWechatTarget } from "../../src/contacts/contact-directory.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import {
  canonicalNativeTextTargetCapabilityBytes,
  issueNativeTextTargetCapability,
  verifyNativeTextTargetCapability,
  type NativeTextTargetCapabilityV2,
} from "../../src/security/native-capability-mac.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const now = new Date("2026-08-31T04:00:00.000Z");
const target: AuthorizedWechatTarget = {
  contactId: "contact-0123456789abcdef0123456789abcdef",
  displayName: "é小号",
  revision: 3,
  enrollment: {
    version: 2,
    contactId: "contact-0123456789abcdef0123456789abcdef",
    displayName: "é小号",
    fingerprintVersion: "vision-featureprint-v1",
    referenceSamples: ["c2FtcGxlLTE=", "c2FtcGxlLTI=", "c2FtcGxlLTM="],
    enrolledAt: "2026-08-31T03:00:00.000Z",
  },
  enrollmentFingerprint: "1".repeat(64),
  bindingHash: "2".repeat(64),
};

const baseInput = {
  target,
  action: "replace-draft" as const,
  draftText: "回复 é\r\n第二行",
  slotKey: `non-daily/${"3".repeat(64)}`,
  windowRevision: "013bc50c91aeebcdf9c7de6b1dc533f624379a0e0ca3fd4e8dc859f4cc2d2e05",
  expiresAt: "2026-08-31T04:02:00.000Z",
  keyProvider: new FixedKeyProvider(key),
  now: () => now,
  capabilityId: "5".repeat(64),
};

describe("native text target capability v2", () => {
  it("issues the hand-derived canonical HMAC bound to every declared field", async () => {
    const capability = await issueNativeTextTargetCapability(baseInput);
    const canonical = [
      "wechat-native-text-target-capability",
      "2",
      "2",
      "5".repeat(64),
      "replace-draft",
      target.contactId,
      "3",
      "é小号",
      "1".repeat(64),
      "2".repeat(64),
      "bae79ae779df36322566b7173c17d0373440fed453d82083a63ffc8bbfa76975",
      "d04a67fae257299f6c22a4594bb37d14c847c70926ca701fd77d0e9cf3993728",
      "013bc50c91aeebcdf9c7de6b1dc533f624379a0e0ca3fd4e8dc859f4cc2d2e05",
      "2026-08-31T04:02:00.000Z",
    ].join("\0");
    const expectedMac = createHmac("sha256", key).update(canonical).digest("hex");

    expect(capability).toEqual({
      version: 2,
      capabilityId: "5".repeat(64),
      action: "replace-draft",
      contactId: target.contactId,
      contactRevision: 3,
      conversationTitle: "é小号",
      enrollmentFingerprint: "1".repeat(64),
      bindingHash: "2".repeat(64),
      candidateHash: "bae79ae779df36322566b7173c17d0373440fed453d82083a63ffc8bbfa76975",
      slotHash: "d04a67fae257299f6c22a4594bb37d14c847c70926ca701fd77d0e9cf3993728",
      windowRevision: "013bc50c91aeebcdf9c7de6b1dc533f624379a0e0ca3fd4e8dc859f4cc2d2e05",
      expiresAt: "2026-08-31T04:02:00.000Z",
      authorizationMac: expectedMac,
    });
    expect(canonicalNativeTextTargetCapabilityBytes(capability).toString("utf8"))
      .toBe(canonical);
  });

  it("normalizes title and draft to NFC before signing", async () => {
    const capability = await issueNativeTextTargetCapability({
      ...baseInput,
      target: { ...target, displayName: "e\u0301小号" },
      draftText: "回复 e\u0301\n第二行",
    });

    expect(capability.conversationTitle).toBe("é小号");
    await expect(verifyNativeTextTargetCapability({
      capability,
      action: "replace-draft",
      target,
      draftText: "回复 é\n第二行",
      slotKey: baseInput.slotKey,
      windowRevision: baseInput.windowRevision,
      keyProvider: baseInput.keyProvider,
      now: () => now,
    })).resolves.toBeUndefined();
  });

  it("rejects every tampered field, wrong keys, expiry and non-canonical strings", async () => {
    const capability = await issueNativeTextTargetCapability(baseInput);
    const mutations: Array<[string, NativeTextTargetCapabilityV2]> = [
      ["version", { ...capability, version: 1 as 2 }],
      ["capability", { ...capability, capabilityId: "6".repeat(64) }],
      ["action", { ...capability, action: "clear-draft" }],
      ["contact", { ...capability, contactId: "contact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      ["revision", { ...capability, contactRevision: 4 }],
      ["title", { ...capability, conversationTitle: "别的标题" }],
      ["enrollment", { ...capability, enrollmentFingerprint: "7".repeat(64) }],
      ["binding", { ...capability, bindingHash: "8".repeat(64) }],
      ["candidate", { ...capability, candidateHash: "9".repeat(64) }],
      ["slot", { ...capability, slotHash: "a".repeat(64) }],
      ["window", { ...capability, windowRevision: "b".repeat(64) }],
      ["expiry", { ...capability, expiresAt: "2026-08-31T04:01:59.000Z" }],
      ["mac", { ...capability, authorizationMac: "c".repeat(64) }],
      ["non-nfc", { ...capability, conversationTitle: "e\u0301小号" }],
    ];
    for (const [label, mutated] of mutations) {
      await expect(verifyNativeTextTargetCapability({
        capability: mutated,
        action: baseInput.action,
        target,
        draftText: baseInput.draftText,
        slotKey: baseInput.slotKey,
        windowRevision: baseInput.windowRevision,
        keyProvider: baseInput.keyProvider,
        now: () => now,
      }), label).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
    }

    await expect(verifyNativeTextTargetCapability({
      capability,
      action: baseInput.action,
      target,
      draftText: baseInput.draftText,
      slotKey: baseInput.slotKey,
      windowRevision: baseInput.windowRevision,
      keyProvider: new FixedKeyProvider(Buffer.alloc(32, 0xff)),
      now: () => now,
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
    await expect(verifyNativeTextTargetCapability({
      capability,
      action: baseInput.action,
      target,
      draftText: baseInput.draftText,
      slotKey: baseInput.slotKey,
      windowRevision: baseInput.windowRevision,
      keyProvider: baseInput.keyProvider,
      now: () => new Date(capability.expiresAt),
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  it.each([Buffer.alloc(31), Buffer.alloc(33)])("rejects a non-32-byte key", async (invalidKey) => {
    await expect(issueNativeTextTargetCapability({
      ...baseInput,
      keyProvider: new FixedKeyProvider(invalidKey),
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  it.each([
    "2026-08-31T04:02:00Z",
    "2026-08-31T12:02:00.000+08:00",
    " 2026-08-31T04:02:00.000Z",
    "2026-08-31T04:02:00.000Z ",
  ])("rejects a non-canonical ISO-8601 expiry: %s", async (expiresAt) => {
    await expect(issueNativeTextTargetCapability({ ...baseInput, expiresAt }))
      .rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });

  it("allows the enrolled legacy ExampleContact contact ID but rejects a tampered ID", async () => {
    const capability = await issueNativeTextTargetCapability({
      ...baseInput,
      target: { ...target, contactId: "example-contact" },
    });
    await expect(verifyNativeTextTargetCapability({
      capability,
      action: capability.action,
      target: { ...target, contactId: "example-contact" },
      draftText: baseInput.draftText,
      slotKey: baseInput.slotKey,
      windowRevision: baseInput.windowRevision,
      keyProvider: baseInput.keyProvider,
      now: () => now,
    })).resolves.toBeUndefined();
    await expect(verifyNativeTextTargetCapability({
      capability: { ...capability, contactId: "contact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      action: capability.action,
      target: { ...target, contactId: "example-contact" },
      draftText: baseInput.draftText,
      slotKey: baseInput.slotKey,
      windowRevision: baseInput.windowRevision,
      keyProvider: baseInput.keyProvider,
      now: () => now,
    })).rejects.toThrow("WECHAT_CONTACT_CAPABILITY_INVALID");
  });
});
