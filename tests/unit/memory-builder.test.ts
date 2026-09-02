import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../src/domain/types.js";
import {
  buildMemoryBundle,
  selectStyleExamples,
} from "../../src/memory/builder.js";
import {
  memoryDocumentNames,
  type MemoryEntry,
  type MemorySeedEntry,
} from "../../src/memory/schema.js";
import { hashMessageSource } from "../../src/storage/memory-repository.js";

const generatedAt = "2026-08-19T03:00:00.000Z";

function message(
  id: string,
  text: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    conversationId: "example-contact",
    direction: "incoming",
    kind: "text",
    text,
    occurredAt: "2026-08-19T00:00:00.000Z",
    source: "wechat",
    confidence: 0.99,
    ...overrides,
  };
}

function correction(id: string, summary: string): MemoryEntry {
  return {
    id,
    kind: "style-rule",
    subject: "user",
    summary,
    sourceType: "user-correction",
    sourceMessageIds: [],
    observedAt: generatedAt,
    confidence: "high",
    sensitivity: "normal",
    status: "active",
    supersedes: [],
  };
}

function seed(document: MemorySeedEntry["document"], entry: MemoryEntry): MemorySeedEntry {
  return { document, entry };
}

describe("buildMemoryBundle", () => {
  it("builds one deterministic generation and records known source gaps", () => {
    const messages = [
      message("later", "普通消息", { occurredAt: "2026-08-18T02:00:00.000Z" }),
      message("earlier", "另一条普通消息", { occurredAt: "2026-08-18T01:00:00.000Z" }),
    ];
    const sourceHash = hashMessageSource(["earlier", "later"]);
    const expectedBundleId = createHash("sha256")
      .update(`${sourceHash}\0${generatedAt}`)
      .digest("hex");

    const bundle = buildMemoryBundle({
      messages,
      onboardingEntries: [],
      now: new Date(generatedAt),
    });

    expect(Object.keys(bundle.documents)).toEqual(memoryDocumentNames);
    expect(
      memoryDocumentNames.map((name) => bundle.documents[name].bundleId),
    ).toEqual(Array.from({ length: 10 }, () => expectedBundleId));
    expect(bundle.documents["00-memory-index"].metadata).toEqual({
      sourceHash,
      totalMessages: 2,
      startAt: "2026-08-18T01:00:00.000Z",
      endAt: "2026-08-18T02:00:00.000Z",
      sourceCoverageComplete: false,
      missingSources: ["pre-2025-11-02-wechat", "douyin", "non-text-media"],
      formatVersion: 1,
    });
  });

  it("keeps historical evidence but applies current user corrections", () => {
    const bundle = buildMemoryBundle({
      messages: [
        message("out-1", "哈哈 行啊", { direction: "outgoing" }),
        message("in-1", "我今天上夜班"),
      ],
      onboardingEntries: [
        seed("01-user-voice", correction("ban-laughter", "禁止使用哈哈")),
        seed("01-user-voice", correction("ban-a", "禁止使用啊字")),
      ],
      now: new Date(generatedAt),
    });

    const voice = bundle.documents["01-user-voice"].entries;
    expect(voice).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ban-laughter",
          sourceType: "user-correction",
          status: "active",
        }),
        expect.objectContaining({
          id: "ban-a",
          sourceType: "user-correction",
          status: "active",
        }),
      ]),
    );
    expect(voice.some((entry) => entry.sourceMessageIds.includes("out-1"))).toBe(true);
    expect(
      voice
        .filter((entry) => entry.status === "active")
        .map((entry) => entry.summary)
        .join(" "),
    ).not.toMatch(/推荐使用哈哈|风格样本.*哈哈|风格样本.*啊/u);
  });

  it("stores monthly shift patterns only as low-confidence expiring inferences", () => {
    const bundle = buildMemoryBundle({
      messages: [
        message("march", "我这个月夜班", { occurredAt: "2026-03-05T00:00:00.000Z" }),
        message("april", "我本月上白班", { occurredAt: "2026-04-05T00:00:00.000Z" }),
      ],
      onboardingEntries: [],
      now: new Date(generatedAt),
    });

    const timing = bundle.documents["05-contact-timing"].entries;
    expect(timing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "inference",
          sourceType: "derived-statistic",
          sourceMessageIds: ["march", "april"],
          confidence: "low",
          expiresAt: "2026-08-31T16:00:00.000Z",
        }),
      ]),
    );
    expect(timing.some((entry) => entry.kind === "fact")).toBe(false);
  });

  it("promotes only narrow direct self-statements to sourced facts", () => {
    const bundle = buildMemoryBundle({
      messages: [
        message("direct", "我在工厂工作"),
        message("keyword-only", "工厂工作确实辛苦"),
      ],
      onboardingEntries: [],
      now: new Date(generatedAt),
    });

    const facts = memoryDocumentNames.flatMap((name) =>
      bundle.documents[name].entries.filter((entry) => entry.kind === "fact"),
    );
    expect(facts).toEqual([
      expect.objectContaining({
        subject: "contact",
        sourceType: "wechat-message",
        sourceMessageIds: ["direct"],
      }),
    ]);
    expect(JSON.stringify(facts)).not.toContain("keyword-only");
  });

  it("does not treat questions or uncertainty as profile or timeline claims", () => {
    const bundle = buildMemoryBundle({
      messages: [
        message("preference-question", "我喜欢这款游戏吗"),
        message("uncertain-preference", "我好像喜欢这款游戏"),
        message("timeline-question", "以前我们是不是见过"),
        message("punctuated-preference-question", "我喜欢这款游戏吗。"),
        message("punctuated-timeline-question", "以前我们见过吗。"),
        message("punctuated-topic-question", "我明天要加班吗。"),
      ],
      onboardingEntries: [],
      now: new Date(generatedAt),
    });

    const claimKinds = new Set(["fact", "preference", "timeline-event", "open-loop"]);
    const factualClaims = memoryDocumentNames.flatMap((name) =>
      bundle.documents[name].entries.filter((entry) => claimKinds.has(entry.kind)),
    );
    expect(factualClaims).toEqual([]);
  });

  it("rejects non-declarative or non-self monthly shift evidence", () => {
    const bundle = buildMemoryBundle({
      messages: [
        message("monthly-question", "这个月是不是夜班"),
        message("monthly-uncertain", "本月可能白班"),
        message("monthly-cooccurrence", "这个月夜班的人挺多"),
      ],
      onboardingEntries: [],
      now: new Date(generatedAt),
    });

    expect(bundle.documents["05-contact-timing"].entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "monthly-shift-pattern" }),
      ]),
    );
  });

  it("limits build-time supersession to user-voice evidence", () => {
    const correctionEntry = {
      ...correction("voice-correction", "禁止使用哈哈"),
      supersedes: [
        "style-example:voice-evidence",
        "profile-seed",
        "timing-seed",
        "care-seed",
      ],
    };
    const profileSeed: MemoryEntry = {
      id: "profile-seed",
      kind: "fact",
      subject: "contact",
      summary: "用户补充的背景事实",
      sourceType: "user-onboarding",
      sourceMessageIds: [],
      confidence: "high",
      sensitivity: "normal",
      status: "active",
      supersedes: [],
    };
    const timingSeed: MemoryEntry = {
      ...profileSeed,
      id: "timing-seed",
      kind: "inference",
      summary: "用户补充的时间推断",
      confidence: "low",
    };
    const careSeed: MemoryEntry = {
      ...profileSeed,
      id: "care-seed",
      kind: "open-loop",
      summary: "用户补充的关心事项",
    };

    const bundle = buildMemoryBundle({
      messages: [message("voice-evidence", "哈哈 行", { direction: "outgoing" })],
      onboardingEntries: [
        seed("01-user-voice", correctionEntry),
        seed("02-contact-profile", profileSeed),
        seed("05-contact-timing", timingSeed),
        seed("09-care-playbook", careSeed),
      ],
      now: new Date(generatedAt),
    });

    expect(
      bundle.documents["01-user-voice"].entries.find(
        ({ id }) => id === "style-example:voice-evidence",
      )?.status,
    ).toBe("superseded");
    expect(bundle.documents["02-contact-profile"].entries[0]?.status).toBe("active");
    expect(bundle.documents["05-contact-timing"].entries[0]?.status).toBe("active");
    expect(bundle.documents["09-care-playbook"].entries[0]?.status).toBe("active");
  });

  it("expires shift evidence on Asia/Shanghai natural-day boundaries", () => {
    const bundle = buildMemoryBundle({
      messages: [
        message("today-shift", "我今天上夜班", {
          occurredAt: "2026-08-18T16:30:00.000Z",
        }),
        message("tonight-shift", "我今晚上夜班", {
          occurredAt: "2026-08-19T14:30:00.000Z",
        }),
        message("tomorrow-shift", "我明天上白班", {
          occurredAt: "2026-08-19T14:30:00.000Z",
        }),
      ],
      onboardingEntries: [],
      now: new Date(generatedAt),
    });

    const expiries = Object.fromEntries(
      bundle.documents["05-contact-timing"].entries.map((entry) => [
        entry.id,
        entry.expiresAt,
      ]),
    );
    expect(expiries).toMatchObject({
      "current-shift:today-shift": "2026-08-19T16:00:00.000Z",
      "current-shift:tonight-shift": "2026-08-19T16:00:00.000Z",
      "current-shift:tomorrow-shift": "2026-08-20T16:00:00.000Z",
    });
  });
});

describe("selectStyleExamples", () => {
  it("bounds and truncates outgoing examples while excluding sensitive content", () => {
    const safe = Array.from({ length: 14 }, (_, index) =>
      message(`safe-${index}`, `第${index}条普通口吻${"好".repeat(90)}`, {
        direction: "outgoing",
      }),
    );
    const sensitive = [
      "借你500块钱",
      "我家地址发你",
      "手机号是13800138000",
      "密码先告诉你",
      "身份证号码给你",
      "聊点性话题",
      "我前任以前这样",
    ].map((text, index) =>
      message(`sensitive-${index}`, text, { direction: "outgoing" }),
    );

    const selected = selectStyleExamples(
      [...safe, ...sensitive, message("incoming", "对方的口吻不能作为用户样本")],
      99,
    );

    expect(selected).toHaveLength(12);
    expect(selected.map(({ id }) => id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `safe-${index}`),
    );
    expect(selected.every(({ text }) => Array.from(text).length <= 80)).toBe(true);
  });

  it("rejects bare phone, identity-card and address patterns", () => {
    const sensitive = [
      "13800000000",
      "138 0013 8000",
      "138-0013-8000",
      "025-12345678",
      "320102199001011234",
      "32010219900101123X",
      "示例城市示例城区某某路12号",
    ].map((text, index) =>
      message(`bare-sensitive-${index}`, text, { direction: "outgoing" }),
    );

    const selected = selectStyleExamples(
      [...sensitive, message("safe", "普通口吻样本", { direction: "outgoing" })],
      12,
    );

    expect(selected.map(({ id }) => id)).toEqual(["safe"]);
  });
});
