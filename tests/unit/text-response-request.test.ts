import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ContactDirectory } from "../../src/contacts/contact-directory.js";
import { ContactRegistryRepository } from "../../src/contacts/contact-registry-repository.js";
import type { ContactId, ContactRecord } from "../../src/contacts/contact-schema.js";
import type { ChatMessage } from "../../src/domain/types.js";
import type { MemoryEntry } from "../../src/memory/schema.js";
import { validateReplyStyle } from "../../src/memory/style-guard.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";
import {
  WechatIdentityEnrollmentRepository,
  wechatIdentityEnrollmentFingerprint,
} from "../../src/storage/wechat-identity-enrollment-repository.js";
import type { ResponsePlan } from "../../src/conversation/response-plan.js";
import {
  buildTextResponseRequest,
  type TextResponseRequest,
  validateTextResponseCandidate,
} from "../../src/conversation/text-response-request.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}

  public getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

const now = new Date("2026-08-31T03:00:00.000Z");
const baseContactId = "contact-0123456789abcdef0123456789abcdef" as const;
let rootDir: string;
let registry: ContactRegistryRepository;
let enrollments: WechatIdentityEnrollmentRepository;
let directory: ContactDirectory;
let baseContact: ContactRecord;

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "text-response-request-"));
  await initializeTestKernelLockCatalog(rootDir);
  const store = new EncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32)));
  registry = new ContactRegistryRepository(store);
  enrollments = new WechatIdentityEnrollmentRepository(store);
  directory = new ContactDirectory(registry, enrollments);
  baseContact = await seedActiveContact(baseContactId, "示例联系人", 7);
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function featureSample(byte: number): string {
  const sample = Buffer.alloc(64, byte);
  sample.write("bplist00", 0, "ascii");
  return sample.toString("base64");
}

async function seedActiveContact(
  contactId: ContactId,
  displayName: string,
  revision = 1,
): Promise<ContactRecord> {
  const enrollment = {
    version: 2 as const,
    contactId,
    displayName,
    fingerprintVersion: "vision-featureprint-v1" as const,
    referenceSamples: [featureSample(1), featureSample(2), featureSample(3)],
    enrolledAt: now.toISOString(),
  };
  await enrollments.enrollSupervised(enrollment);
  let contact = await registry.createConfirmed({
    contactId,
    displayName,
    identityBinding: {
      fingerprintVersion: "vision-featureprint-v1",
      enrollmentFingerprint: wechatIdentityEnrollmentFingerprint(enrollment),
      leftPaneProofHash: "a".repeat(64),
      headerProofHash: "b".repeat(64),
      confidence: 0.99,
      confirmedAt: now.toISOString(),
    },
    now,
  });
  while (contact.revision < revision) {
    contact = await registry.update(contactId, contact.revision, {}, now);
  }
  return contact;
}

function memoryEntry(
  id: string,
  kind: MemoryEntry["kind"],
  summary: string,
  overrides: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    id,
    kind,
    subject: "user",
    summary,
    sourceType: "wechat-message",
    sourceMessageIds: ["outgoing-7"],
    observedAt: "2026-08-20T09:00:00.000Z",
    confidence: "high",
    sensitivity: "normal",
    status: "active",
    supersedes: [],
    ...overrides,
  };
}

function fixture(
  contactId: ContactId = baseContactId,
  expectedRevision = baseContact.revision,
) {
  const current: ChatMessage = {
    id: "incoming-8",
    conversationId: contactId as ChatMessage["conversationId"],
    direction: "incoming",
    kind: "text",
    text: "今天碰到个特别离谱的人",
    occurredAt: "2026-08-20T09:01:00.000Z",
    source: "wechat",
    confidence: 0.99,
  };
  const plan: ResponsePlan = {
    emotionalState: "negative",
    intensity: "medium",
    storyComplete: false,
    orderedActs: [
      { kind: "colloquial-connect", evidenceMessageIds: ["incoming-8"] },
      { kind: "open-invite", evidenceMessageIds: ["incoming-8"] },
    ],
    voiceBlend: {
      userVoicePriority: "equal",
      gentlePriority: "equal",
    },
    artifactIntent: null,
    missingInformation: ["发生了什么"],
    evidenceMessageIds: ["incoming-8"],
  };

  return {
    directory,
    contactId,
    expectedRevision,
    effectiveStyle: {
      salutation: null,
      tone: "natural" as const,
      preferredLength: "short" as const,
      emojiPolicy: "none" as const,
      bannedTopics: ["转账"],
      appendSignature: false as const,
    },
    current,
    plan,
    voiceExamples: [
      memoryEntry("voice-1", "style-example", "短句、自然接话", {
        confidence: "medium",
      }),
    ],
    interactionRules: [
      memoryEntry(
        "interaction-1",
        "interaction-pattern",
        "负面语境先接住再问下一步",
        { confidence: "medium" },
      ),
    ],
    hardRules: ["不使用哈哈", "不催促回复"],
  };
}

function fixtureWithMixedMemory() {
  const base = fixture();
  return {
    ...base,
    voiceExamples: [
      ...base.voiceExamples,
      memoryEntry("voice-sensitive", "style-example", "敏感语料", {
        sensitivity: "sensitive",
      }),
      memoryEntry("voice-unconfirmed", "style-example", "待确认语料", {
        status: "needs-confirmation",
      }),
      memoryEntry("voice-low", "style-example", "低置信语料", {
        confidence: "low",
      }),
      memoryEntry("voice-wrong-kind", "interaction-pattern", "不是语气示例"),
    ],
    interactionRules: [
      ...base.interactionRules,
      memoryEntry("interaction-sensitive", "interaction-pattern", "敏感规则", {
        sensitivity: "sensitive",
      }),
      memoryEntry("interaction-expired", "interaction-pattern", "过期规则", {
        status: "expired",
      }),
      memoryEntry("interaction-low", "interaction-pattern", "低置信规则", {
        confidence: "low",
      }),
      memoryEntry("interaction-wrong-kind", "style-example", "不是互动规则"),
    ],
  };
}

function request() {
  return buildTextResponseRequest(fixture());
}

describe("buildTextResponseRequest", () => {
  it("binds a request to an immutable contact style snapshot", async () => {
    const input = fixture();
    const result = await buildTextResponseRequest(input);
    input.effectiveStyle.bannedTopics.push("后续变更");
    input.plan.missingInformation.push("可写输入仍可继续使用");
    input.voiceExamples[0]!.sourceMessageIds.push("outgoing-8");

    expect(result.contactId).toBe(baseContactId);
    expect(result.contactRevision).toBe(7);
    expect(result.effectiveStyle).toEqual({
      salutation: null,
      tone: "natural",
      preferredLength: "short",
      emojiPolicy: "none",
      bannedTopics: ["转账"],
      appendSignature: false,
    });
    expect(result.plan.missingInformation).toEqual(["发生了什么"]);
    expect(result.voiceEvidence[0]?.sourceMessageIds).toEqual(["outgoing-7"]);
    expect(Object.isFrozen(input.plan)).toBe(false);
    expect(Object.isFrozen(input.voiceExamples[0]!.sourceMessageIds)).toBe(false);
    expect(result).not.toHaveProperty("displayName");
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as unknown as { contactRevision: number }).contactRevision = 99;
    }).toThrow();
  });

  it("does not trust a caller-supplied target for an unregistered contact", async () => {
    const missingContactId = "contact-ffffffffffffffffffffffffffffffff" as const;
    const forgedInput = {
      ...fixture(missingContactId, 1),
      target: {
        contactId: missingContactId,
        revision: 1,
        displayName: "伪造联系人",
      },
    };

    await expect(buildTextResponseRequest(forgedInput))
      .rejects.toThrowError("CONTACT_NOT_FOUND");
  });

  it("rejects a resolver-shaped object that is not a real ContactDirectory", async () => {
    const input = fixture();
    const resolver = {
      requireActiveAutoReplyTarget: () => Promise.resolve({
        contactId: input.contactId,
        revision: input.expectedRevision,
      }),
    } as unknown as ContactDirectory;

    await expect(buildTextResponseRequest({ ...input, directory: resolver }))
      .rejects.toThrowError("TEXT_RESPONSE_DIRECTORY_REQUIRED");
  });

  it("rejects an object created from ContactDirectory.prototype without constructor state", async () => {
    const prototypeOnly = Object.create(ContactDirectory.prototype) as ContactDirectory;

    await expect(buildTextResponseRequest({ ...fixture(), directory: prototypeOnly }))
      .rejects.toThrowError("CONTACT_DIRECTORY_PROVENANCE_REQUIRED");
  });

  it("rejects an instance method override that returns a fake target", async () => {
    const input = fixture();
    Object.defineProperty(directory, "requireActiveAutoReplyTarget", {
      configurable: true,
      value: () => Promise.resolve({
        contactId: input.contactId,
        displayName: "伪造联系人",
        revision: input.expectedRevision,
        enrollment: {},
        enrollmentFingerprint: "a".repeat(64),
        bindingHash: "b".repeat(64),
      }),
    });

    try {
      await expect(buildTextResponseRequest(input))
        .rejects.toThrowError("CONTACT_DIRECTORY_METHOD_OVERRIDDEN");
    } finally {
      delete (directory as unknown as Record<string, unknown>)
        .requireActiveAutoReplyTarget;
    }
  });

  it("re-resolves an active automatic-reply target at the request boundary", async () => {
    const pausedId = "contact-11111111111111111111111111111111" as const;
    const paused = await seedActiveContact(pausedId, "暂停联系人");
    const pausedRevision = await registry.update(
      pausedId,
      paused.revision,
      { lifecycle: "paused" },
      now,
    );
    await expect(buildTextResponseRequest(fixture(pausedId, pausedRevision.revision)))
      .rejects.toThrowError("CONTACT_NOT_ACTIVE");

    const disabledId = "contact-22222222222222222222222222222222" as const;
    const enabled = await seedActiveContact(disabledId, "禁用自动回复");
    const disabled = await registry.update(
      disabledId,
      enabled.revision,
      { autoReplyEnabled: false },
      now,
    );
    await expect(buildTextResponseRequest(fixture(disabledId, disabled.revision)))
      .rejects.toThrowError("CONTACT_AUTO_REPLY_DISABLED");
  });

  it("rejects revision drift and a current conversation mismatch", async () => {
    const driftedId = "contact-33333333333333333333333333333333" as const;
    const original = await seedActiveContact(driftedId, "修订漂移");
    await registry.update(driftedId, original.revision, {}, now);

    await expect(buildTextResponseRequest(fixture(driftedId, original.revision)))
      .rejects.toThrowError("CONTACT_REVISION_MISMATCH");
    await expect(buildTextResponseRequest({
      ...fixture(),
      current: {
        ...fixture().current,
        conversationId: "file-transfer",
      },
    })).rejects.toThrowError("TEXT_RESPONSE_TARGET_INVALID");
  });

  it("deep-freezes mutable children even when the input shell is already frozen", async () => {
    const mutableInput = fixture();
    const frozenShell = Object.freeze({ ...mutableInput });

    const result = await buildTextResponseRequest(frozenShell);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.orderedActs)).toBe(true);
    expect(Object.isFrozen(result.plan.orderedActs[0]!.evidenceMessageIds)).toBe(true);
    expect(Object.isFrozen(result.voiceEvidence[0]!.sourceMessageIds)).toBe(true);
    expect(Object.isFrozen(frozenShell.plan)).toBe(false);
    expect(Object.isFrozen(frozenShell.voiceExamples[0]!.sourceMessageIds)).toBe(false);
  });

  it("keeps user voice and gentle behavior at equal priority with source ids", async () => {
    const result = await request();

    expect(result.constraints.map(({ id, priority, enforcement }) => [
      id,
      priority,
      enforcement,
    ])).toEqual([
      ["user-voice", "equal", "generation-only"],
      ["gentle", "equal", "generation-only"],
      ["hard-rules", "required", "generation-only"],
    ]);
    expect(result.constraints.every(({ instruction }) => instruction.length > 0)).toBe(true);
    expect(result.voiceEvidence).toEqual([
      {
        memoryEntryId: "voice-1",
        sourceMessageIds: ["outgoing-7"],
        summary: "短句、自然接话",
      },
    ]);
    expect(result.interactionRules).toEqual([
      {
        memoryEntryId: "interaction-1",
        summary: "负面语境先接住再问下一步",
      },
    ]);
    expect(result.hardRules).toEqual(["不使用哈哈", "不催促回复"]);
    expect(result.hardRuleEnforcement).toBe("generation-only");
  });

  it("drops sensitive, inactive, low-confidence, and wrong-kind routed memory", async () => {
    const result = await buildTextResponseRequest(fixtureWithMixedMemory());

    expect(result.voiceEvidence.map(({ memoryEntryId }) => memoryEntryId)).toEqual([
      "voice-1",
    ]);
    expect(result.interactionRules.map(({ memoryEntryId }) => memoryEntryId)).toEqual([
      "interaction-1",
    ]);
  });

  it("accepts user voice only from user-authored allowed provenance", async () => {
    const result = await buildTextResponseRequest({
      ...fixture(),
      voiceExamples: [
        memoryEntry("voice-wechat", "style-example", "微信语气"),
        memoryEntry("voice-onboarding", "style-example", "用户确认语气", {
          sourceType: "user-onboarding",
          sourceMessageIds: [],
        }),
        memoryEntry("voice-correction", "style-example", "用户纠正语气", {
          sourceType: "user-correction",
          sourceMessageIds: [],
        }),
        memoryEntry("voice-wrong-subject", "style-example", "他人语气", {
          subject: "contact",
        }),
        memoryEntry("voice-external", "style-example", "外部来源语气", {
          sourceType: "external-source",
          sourceMessageIds: [],
        }),
      ],
    });

    expect(result.voiceEvidence.map(({ memoryEntryId }) => memoryEntryId)).toEqual([
      "voice-wechat",
      "voice-onboarding",
      "voice-correction",
    ]);
  });

  it("preserves the existing subject semantics for eligible interaction rules", async () => {
    const result = await buildTextResponseRequest({
      ...fixture(),
      interactionRules: [
        memoryEntry("interaction-relationship", "interaction-pattern", "关系互动规则", {
          subject: "relationship",
          sourceType: "external-source",
          sourceMessageIds: [],
        }),
      ],
    });

    expect(result.interactionRules).toEqual([
      { memoryEntryId: "interaction-relationship", summary: "关系互动规则" },
    ]);
  });

  it("transmits routed custom corrections as required generation-only rules", async () => {
    const result = await buildTextResponseRequest({
      ...fixture(),
      hardRules: ["禁止使用哈哈", "避免使用旧称呼"],
    });

    expect(result.constraints).toContainEqual({
      id: "hard-rules",
      priority: "required",
      enforcement: "generation-only",
      instruction: "禁止使用哈哈；避免使用旧称呼",
    });
    expect(result.hardRules).toEqual([
      "禁止使用哈哈",
      "避免使用旧称呼",
    ]);
    expect(result.hardRuleEnforcement).toBe("generation-only");
  });

  it.each([
    { label: "an empty list", hardRules: [] },
    { label: "whitespace-only rules", hardRules: [" ", "\t"] },
  ])("rejects $label at the required hard-rule boundary", async ({ hardRules }) => {
    await expect(buildTextResponseRequest({
        ...fixture(),
        hardRules,
      })).rejects.toThrowError("HARD_RULES_REQUIRED");
  });
});

describe("validateTextResponseCandidate", () => {
  it("rejects automatic-reply signatures and rejects a forged P0 marker", async () => {
    const signed = {
      text: "咋啦，今天碰到啥事了呀\n——示例用户",
      segments: [
        { act: "colloquial-connect" as const, text: "咋啦" },
        { act: "open-invite" as const, text: "今天碰到啥事了呀\n——示例用户" },
      ],
    };
    const responseRequest = await request();

    expect(validateTextResponseCandidate(responseRequest, signed).reasons)
      .toContain("AUTOMATIC_REPLY_SIGNATURE_FORBIDDEN");
    expect(validateTextResponseCandidate(
      { ...responseRequest, replyKind: "p0-scheduled-care" } as unknown as TextResponseRequest,
      signed,
    ).reasons).toContain("AUTOMATIC_REPLY_SIGNATURE_FORBIDDEN");
  });
  it.each(["咋啦，今天碰到啥事了呀", "去哪玩呀，我给你理一理"])(
    "allows a short low-pressure candidate: %s",
    (text) => {
      expect(validateReplyStyle(text)).toEqual({ ok: true, reasons: [] });
    },
  );

  it("accepts explicit segments that follow the plan and reconstruct the text", async () => {
    expect(
      validateTextResponseCandidate(await request(), {
        text: "咋啦，今天碰到啥事了呀",
        segments: [
          { act: "colloquial-connect", text: "咋啦" },
          { act: "open-invite", text: "今天碰到啥事了呀" },
        ],
      }),
    ).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    {
      text: "我理解你的负面情绪，请详细描述发生了什么",
      segments: [
        { act: "colloquial-connect" as const, text: "我理解你的负面情绪" },
        { act: "open-invite" as const, text: "请详细描述发生了什么" },
      ],
    },
    {
      text: "怎么还没回我啊，后来呢",
      segments: [
        { act: "colloquial-connect" as const, text: "怎么还没回我啊" },
        { act: "open-invite" as const, text: "后来呢" },
      ],
    },
  ])(
    "rejects a long formal connection or an existing hard-rule violation",
    async (candidate) => {
      expect(validateTextResponseCandidate(await request(), candidate).ok).toBe(false);
    },
  );

  it("rejects segments whose act order differs from the plan", async () => {
    const result = validateTextResponseCandidate(await request(), {
      text: "今天碰到啥事了呀，咋啦",
      segments: [
        { act: "open-invite", text: "今天碰到啥事了呀" },
        { act: "colloquial-connect", text: "咋啦" },
      ],
    });

    expect(result).toEqual({ ok: false, reasons: ["ACT_ORDER_MISMATCH"] });
  });

  it("rejects text that is not the exact joined segment text", async () => {
    const result = validateTextResponseCandidate(await request(), {
      text: "咋啦。今天碰到啥事了呀",
      segments: [
        { act: "colloquial-connect", text: "咋啦" },
        { act: "open-invite", text: "今天碰到啥事了呀" },
      ],
    });

    expect(result).toEqual({ ok: false, reasons: ["SEGMENT_TEXT_MISMATCH"] });
  });

  it.each([
    {
      label: "empty reflection",
      text: "咋啦，，后来呢",
      segments: [
        { act: "colloquial-connect" as const, text: "咋啦" },
        { act: "gentle-reflect" as const, text: "" },
        { act: "open-invite" as const, text: "后来呢" },
      ],
    },
    {
      label: "whitespace-only invitation",
      text: "咋啦， \t",
      segments: [
        { act: "colloquial-connect" as const, text: "咋啦" },
        { act: "open-invite" as const, text: " \t" },
      ],
    },
  ])("rejects a $label segment", async ({ text, segments }) => {
    const candidateRequest = await buildTextResponseRequest({
      ...fixture(),
      plan: {
        ...fixture().plan,
        storyComplete: true,
        orderedActs: [
          { kind: "colloquial-connect", evidenceMessageIds: ["incoming-8"] },
          { kind: "gentle-reflect", evidenceMessageIds: ["incoming-8"] },
          { kind: "open-invite", evidenceMessageIds: ["incoming-8"] },
        ],
      },
    });
    expect(validateTextResponseCandidate(candidateRequest, { text, segments }).reasons)
      .toContain("SEGMENT_EMPTY");
  });

  it("rejects a candidate that omits the required invitation segment", async () => {
    expect(validateTextResponseCandidate(await request(), {
      text: "咋啦",
      segments: [{ act: "colloquial-connect", text: "咋啦" }],
    })).toEqual({ ok: false, reasons: ["ACT_ORDER_MISMATCH"] });
  });

  it.each([
    { label: "empty", text: "，后来呢", connection: "" },
    { label: "whitespace-only", text: " \t ，后来呢", connection: " \t " },
  ])("rejects a $label colloquial connection", async ({ text, connection }) => {
    const result = validateTextResponseCandidate(await request(), {
      text,
      segments: [
        { act: "colloquial-connect", text: connection },
        { act: "open-invite", text: "后来呢" },
      ],
    });

    expect(result).toEqual({ ok: false, reasons: ["SEGMENT_EMPTY"] });
  });

  it("checks every colloquial connection when the plan repeats the act", async () => {
    const repeatedConnectRequest = await buildTextResponseRequest({
      ...fixture(),
      plan: {
        ...fixture().plan,
        orderedActs: [
          { kind: "colloquial-connect", evidenceMessageIds: ["incoming-8"] },
          { kind: "colloquial-connect", evidenceMessageIds: ["incoming-8"] },
          { kind: "open-invite", evidenceMessageIds: ["incoming-8"] },
        ],
      },
    });

    const result = validateTextResponseCandidate(repeatedConnectRequest, {
      text: "咋啦，我理解你的负面情绪，后来呢",
      segments: [
        { act: "colloquial-connect", text: "咋啦" },
        { act: "colloquial-connect", text: "我理解你的负面情绪" },
        { act: "open-invite", text: "后来呢" },
      ],
    });

    expect(result).toEqual({ ok: false, reasons: ["CONNECT_NOT_SHORT"] });
  });

  it.each([
    {
      label: "eight supplementary-plane code points",
      text: "🙂🙂🙂🙂🙂🙂🙂🙂，后来呢",
      connection: "🙂🙂🙂🙂🙂🙂🙂🙂",
      expected: { ok: true, reasons: [] },
    },
    {
      label: "nine supplementary-plane code points",
      text: "🙂🙂🙂🙂🙂🙂🙂🙂🙂，后来呢",
      connection: "🙂🙂🙂🙂🙂🙂🙂🙂🙂",
      expected: { ok: false, reasons: ["CONNECT_NOT_SHORT"] },
    },
  ])("enforces the connect boundary at $label", async ({ text, connection, expected }) => {
    expect(
      validateTextResponseCandidate(await request(), {
        text,
        segments: [
          { act: "colloquial-connect", text: connection },
          { act: "open-invite", text: "后来呢" },
        ],
      }),
    ).toEqual(expected);
  });
});
