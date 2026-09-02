import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AuthorizedWechatTarget } from "../contacts/contact-directory.js";
import type { ContactId } from "../contacts/contact-schema.js";
import { MacOSKeychainKeyProvider, type KeyProvider } from "./keychain.js";

export const nativeTextTargetCapabilityActions = [
  "select-conversation",
  "focus-composer",
  "replace-draft",
  "clear-draft",
  "submit-draft",
] as const;

export type NativeTextTargetCapabilityAction =
  (typeof nativeTextTargetCapabilityActions)[number];

export interface NativeTextTargetCapabilityV2 {
  readonly version: 2;
  readonly capabilityId: string;
  readonly action: NativeTextTargetCapabilityAction;
  readonly contactId: ContactId;
  readonly contactRevision: number;
  readonly conversationTitle: string;
  readonly enrollmentFingerprint: string;
  readonly bindingHash: string;
  readonly candidateHash: string;
  readonly slotHash: string;
  readonly windowRevision: string;
  readonly expiresAt: string;
  readonly authorizationMac: string;
}

export const defaultNativeTextTargetCapabilityKeyProvider = new MacOSKeychainKeyProvider({
  service: "Codex.WeChatChatAssistant.NativeCapability.v1",
});

export interface IssueNativeTextTargetCapabilityInput {
  readonly target: AuthorizedWechatTarget;
  readonly action: NativeTextTargetCapabilityAction;
  readonly draftText: string;
  readonly slotKey: string;
  readonly windowRevision: string;
  readonly expiresAt: string;
  readonly keyProvider?: KeyProvider;
  readonly capabilityId?: string;
  readonly now?: () => Date;
}

export interface VerifyNativeTextTargetCapabilityInput {
  readonly capability: NativeTextTargetCapabilityV2;
  readonly action: NativeTextTargetCapabilityAction;
  readonly target: NativeTextTargetBinding;
  readonly draftText: string;
  readonly slotKey: string;
  readonly windowRevision: string;
  readonly keyProvider?: KeyProvider;
  readonly now?: () => Date;
}

export interface NativeTextTargetBinding {
  readonly contactId: ContactId;
  readonly displayName: string;
  readonly revision: number;
  readonly enrollmentFingerprint: string;
  readonly bindingHash: string;
}

const domain = "wechat-native-text-target-capability";
const invalid = "WECHAT_CONTACT_CAPABILITY_INVALID";
const hashPattern = /^[a-f0-9]{64}$/u;
const contactIdPattern = /^(?:example-contact|contact-[a-f0-9]{32})$/u;
const capabilityIdPattern = /^[a-f0-9]{64}$/u;
const actionSet = new Set<string>(nativeTextTargetCapabilityActions);

export async function issueNativeTextTargetCapability(
  input: IssueNativeTextTargetCapabilityInput,
): Promise<NativeTextTargetCapabilityV2> {
  const now = input.now?.() ?? new Date();
  const target = assertTarget(input.target);
  const action = assertAction(input.action);
  const capabilityId = input.capabilityId ?? randomBytes(32).toString("hex");
  const expiresAt = assertExpiry(input.expiresAt, now);
  if (!capabilityIdPattern.test(capabilityId) || !isNfc(capabilityId)) throw invalidError();
  const capability: Omit<NativeTextTargetCapabilityV2, "authorizationMac"> = {
    version: 2,
    capabilityId,
    action,
    contactId: target.contactId,
    contactRevision: target.revision,
    conversationTitle: target.displayName,
    enrollmentFingerprint: target.enrollmentFingerprint,
    bindingHash: target.bindingHash,
    candidateHash: sha256(canonicalText(input.draftText)),
    slotHash: sha256(input.slotKey),
    windowRevision: assertHash(input.windowRevision),
    expiresAt,
  };
  const key = await keyFor(input.keyProvider);
  return Object.freeze({
    ...capability,
    authorizationMac: createHmac("sha256", key)
      .update(canonicalNativeTextTargetCapabilityBytes(capability))
      .digest("hex"),
  });
}

export async function verifyNativeTextTargetCapability(
  input: VerifyNativeTextTargetCapabilityInput,
): Promise<void> {
  const now = input.now?.() ?? new Date();
  const capability = input.capability;
  const target = assertTarget(input.target);
  const expiresAt = assertExpiry(capability.expiresAt, now);
  if (capability.version !== 2 || !capabilityIdPattern.test(capability.capabilityId) ||
      !isAction(capability.action) || capability.action !== input.action ||
      capability.contactId !== target.contactId || capability.contactRevision !== target.revision ||
      capability.conversationTitle !== target.displayName ||
      capability.enrollmentFingerprint !== target.enrollmentFingerprint ||
      capability.bindingHash !== target.bindingHash ||
      capability.candidateHash !== sha256(canonicalText(input.draftText)) ||
      capability.slotHash !== sha256(input.slotKey) ||
      capability.windowRevision !== input.windowRevision ||
      capability.expiresAt !== expiresAt || !hashPattern.test(capability.authorizationMac) ||
      !allCanonicalStrings(capability)) {
    throw invalidError();
  }
  const key = await keyFor(input.keyProvider);
  const expected = createHmac("sha256", key)
    .update(canonicalNativeTextTargetCapabilityBytes(capability))
    .digest();
  const actual = Buffer.from(capability.authorizationMac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidError();
}

export function canonicalNativeTextTargetCapabilityBytes(
  capability: Omit<NativeTextTargetCapabilityV2, "authorizationMac"> | NativeTextTargetCapabilityV2,
): Buffer {
  return Buffer.from([
    domain,
    "2",
    String(capability.version),
    capability.capabilityId,
    capability.action,
    capability.contactId,
    String(capability.contactRevision),
    capability.conversationTitle,
    capability.enrollmentFingerprint,
    capability.bindingHash,
    capability.candidateHash,
    capability.slotHash,
    capability.windowRevision,
    capability.expiresAt,
  ].map((part) => part.normalize("NFC")).join("\0"), "utf8");
}

function assertTarget<T extends NativeTextTargetBinding>(target: T): T & NativeTextTargetBinding {
  const displayName = target.displayName.normalize("NFC");
  if (!contactIdPattern.test(target.contactId) || !Number.isSafeInteger(target.revision) ||
      target.revision < 1 || displayName.trim() === "" ||
      !hashPattern.test(target.enrollmentFingerprint) || !hashPattern.test(target.bindingHash) ||
      !isNfc(target.enrollmentFingerprint) || !isNfc(target.bindingHash)) {
    throw invalidError();
  }
  return { ...target, displayName };
}

function assertAction(action: NativeTextTargetCapabilityAction): NativeTextTargetCapabilityAction {
  if (!isAction(action)) throw invalidError();
  return action;
}

function isAction(value: string): value is NativeTextTargetCapabilityAction {
  return actionSet.has(value);
}

function assertHash(value: string): string {
  if (!hashPattern.test(value) || !isNfc(value)) throw invalidError();
  return value;
}

function assertExpiry(value: string, now: Date): string {
  const expiry = new Date(value);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiry.getTime()) ||
      expiry.getTime() <= now.getTime() || expiry.getTime() - now.getTime() > 180_000 ||
      !isNfc(value) || expiry.toISOString() !== value) {
    throw invalidError();
  }
  return value;
}

function allCanonicalStrings(capability: NativeTextTargetCapabilityV2): boolean {
  return [
    capability.capabilityId,
    capability.action,
    capability.contactId,
    capability.conversationTitle,
    capability.enrollmentFingerprint,
    capability.bindingHash,
    capability.candidateHash,
    capability.slotHash,
    capability.windowRevision,
    capability.expiresAt,
    capability.authorizationMac,
  ].every(isNfc);
}

async function keyFor(provider: KeyProvider | undefined): Promise<Buffer> {
  const key = await (provider ?? defaultNativeTextTargetCapabilityKeyProvider).getOrCreate();
  if (!Buffer.isBuffer(key) || key.length !== 32) throw invalidError();
  return Buffer.from(key);
}

function canonicalText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNfc(value: string): boolean {
  return value === value.normalize("NFC");
}

function invalidError(): Error {
  return new Error(invalid);
}
