import { describe, expect, it } from "vitest";

import { analyzeArtifactTurn } from "../../src/artifacts/artifact-intent.js";
import {
  artifactManifestSchema,
  artifactRequestSchema,
  artifactRequestStatusSchema,
  artifactSectionSchema,
  artifactSourceSchema,
  artifactWorkflowResultSchema,
  htmlArtifactModelSchema,
} from "../../src/artifacts/artifact-schema.js";

describe("artifact intent analysis", () => {
  it.each([
    ["帮我做一份示例城市三天攻略", "explicit", { destination: "示例城市", days: 3 }],
    ["请整理示例城市五天旅行路线", "explicit", { destination: "示例城市", days: 5 }],
    ["示例城市和苏州玩五天怎么安排比较顺", "implicit", { destination: "示例城市和苏州", days: 5 }],
    ["去示例城市玩3天怎么安排", "implicit", { destination: "示例城市", days: 3 }],
    ["示例城市有什么好吃的", null, null],
  ] as const)("classifies artifact intent for %s", (text, trigger, fields) => {
    const result = analyzeArtifactTurn(text);

    expect(result.intent?.trigger ?? null).toBe(trigger);
    expect(result.fields).toEqual(fields);
  });

  it.each([
    ["帮我做旅行攻略", ["destination", "days"]],
    ["帮我做示例城市攻略", ["days"]],
    ["帮我做三天攻略", ["destination"]],
    ["帮我做五天旅行攻略", ["destination"]],
  ] as const)("asks only for missing minimum fields: %s", (text, missing) => {
    const result = analyzeArtifactTurn(text);

    expect(result.missingInformation).toEqual(missing);
    expect(result.clarificationQuestions.length).toBeLessThanOrEqual(2);
  });

  it.each([
    ["帮我做一份示例城市三天攻略", "explicit"],
    ["我看了一份示例城市三天攻略", null],
    ["请整理示例城市五天旅行路线", "explicit"],
    ["这份示例城市五天旅行路线挺好", null],
    ["我想起一份示例城市三天旅行攻略", null],
    ["我有一份示例城市三天旅行攻略，怎么备份比较安全", null],
    ["示例城市和苏州玩五天怎么安排比较顺", "implicit"],
    ["示例城市和苏州玩得怎么样", null],
    ["去示例城市玩两天怎么安排", "implicit"],
    ["去示例城市玩一天感觉怎么样", null],
  ] as const)("distinguishes an artifact request from a nearby non-request: %s", (text, trigger) => {
    expect(analyzeArtifactTurn(text).intent?.trigger ?? null).toBe(trigger);
  });

  it.each([
    ["帮我做示例城市1天攻略", { destination: "示例城市", days: 1 }],
    ["帮我做示例城市30天攻略", { destination: "示例城市", days: 30 }],
    ["帮我做示例城市一天攻略", { destination: "示例城市", days: 1 }],
    ["帮我做示例城市两天攻略", { destination: "示例城市", days: 2 }],
    ["帮我做示例城市十天攻略", { destination: "示例城市", days: 10 }],
    ["帮我做示例城市十一天攻略", { destination: "示例城市", days: 11 }],
    ["帮我做示例城市二十天攻略", { destination: "示例城市", days: 20 }],
    ["帮我做示例城市二十一天攻略", { destination: "示例城市", days: 21 }],
    ["帮我做示例城市三十天攻略", { destination: "示例城市", days: 30 }],
  ] as const)("parses a supported day count without a destination whitelist: %s", (text, fields) => {
    expect(analyzeArtifactTurn(text).fields).toEqual(fields);
  });

  it.each([
    ["帮我做三天旅行攻略", { days: 3 }],
    ["帮我做旅行三天攻略", { days: 3 }],
    ["帮我做示例城市玩三天攻略", { destination: "示例城市", days: 3 }],
    ["青海湖和祁连玩七天怎么安排", { destination: "青海湖和祁连", days: 7 }],
  ] as const)("does not treat request vocabulary as the destination: %s", (text, fields) => {
    expect(analyzeArtifactTurn(text).fields).toEqual(fields);
  });

  it.each([
    ["帮我做示例城市和示例城市酒店对比", "comparison"],
    ["帮我做出发前清单", "checklist"],
    ["帮我做一份项目规划", "plan"],
    ["帮我做示例城市三天旅行规划", "travel-guide"],
  ] as const)("maps an explicit output request to its artifact kind: %s", (text, kind) => {
    expect(analyzeArtifactTurn(text).intent).toEqual({ kind, trigger: "explicit" });
  });

  it.each([
    ["帮我看看这份示例城市三天攻略怎么样", null],
    ["帮我做这份示例城市三天攻略", "explicit"],
    ["我有示例城市三天旅行攻略，聚餐座位怎么安排", null],
    ["示例城市玩三天怎么安排", "implicit"],
  ] as const)("requires request and artifact cues in the same structure: %s", (text, trigger) => {
    expect(analyzeArtifactTurn(text).intent?.trigger ?? null).toBe(trigger);
  });

  it.each([
    ["帮我做示例城市攻略，三天", { destination: "示例城市", days: 3 }],
    ["帮我做三天示例城市攻略", { destination: "示例城市", days: 3 }],
    ["帮我做三天后出发的示例城市五天攻略", { destination: "示例城市", days: 5 }],
    ["帮我做示例城市二十二三天攻略", { destination: "示例城市" }],
  ] as const)("binds destination and duration to the requested travel artifact: %s", (text, fields) => {
    expect(analyzeArtifactTurn(text).fields).toEqual(fields);
  });

  it.each([
    ["帮我做完作业再看看这份示例城市三天攻略怎么样", null, null],
    ["帮我做完作业再做一份示例城市三天攻略", "explicit", { destination: "示例城市", days: 3 }],
    ["帮我做完早餐再看看这份青岛四天路线怎么样", null, null],
    ["帮我做完早餐再做一份青岛四天路线", "explicit", { destination: "青岛", days: 4 }],
  ] as const)("anchors creation to the requested artifact span: %s", (text, trigger, fields) => {
    const result = analyzeArtifactTurn(text);

    expect(result.intent?.trigger ?? null).toBe(trigger);
    expect(result.fields).toEqual(fields);
  });

  it.each([
    ["帮我做示例城市五天攻略参考这份三天路线", { destination: "示例城市", days: 5 }],
    ["请整理示例城市六天旅行路线参考现有两天攻略", { destination: "示例城市", days: 6 }],
  ] as const)("does not let a referenced artifact replace the requested span: %s", (text, fields) => {
    const result = analyzeArtifactTurn(text);

    expect(result.intent).toEqual({ kind: "travel-guide", trigger: "explicit" });
    expect(result.fields).toEqual(fields);
  });

  it.each([
    ["给我示例城市三天攻略", "explicit", { destination: "示例城市", days: 3 }],
    ["发我示例城市五天路线", "explicit", { destination: "示例城市", days: 5 }],
    ["给我的示例城市三天攻略很好看", null, null],
    ["发我的示例城市五天路线已经过期", null, null],
  ] as const)("distinguishes a direct recipient request from possession: %s", (text, trigger, fields) => {
    const result = analyzeArtifactTurn(text);

    expect(result.intent?.trigger ?? null).toBe(trigger);
    expect(result.fields).toEqual(fields);
  });

  it.each([
    ["帮我做完作业之后看看这份示例城市三天攻略怎么样", null, null],
    ["作业完成之后请做一份示例城市三天攻略", "explicit", { destination: "示例城市", days: 3 }],
    ["帮我做完早餐以后看看这份青岛四天路线怎么样", null, null],
    ["早餐完成以后发我青岛四天路线", "explicit", { destination: "青岛", days: 4 }],
  ] as const)("assigns the target artifact to the correct request head: %s", (text, trigger, fields) => {
    const result = analyzeArtifactTurn(text);

    expect(result.intent?.trigger ?? null).toBe(trigger);
    expect(result.fields).toEqual(fields);
  });

  it.each([
    ["请做参考这份三天路线的示例城市五天攻略", { destination: "示例城市", days: 5 }],
    ["请做示例城市五天攻略，参考这份三天路线", { destination: "示例城市", days: 5 }],
    ["请做参考现有两天攻略的示例城市六天旅行路线", { destination: "示例城市", days: 6 }],
    ["请做示例城市六天旅行路线，参考现有两天攻略", { destination: "示例城市", days: 6 }],
  ] as const)("separates a reference modifier from the target artifact: %s", (text, fields) => {
    const result = analyzeArtifactTurn(text);

    expect(result.intent).toEqual({ kind: "travel-guide", trigger: "explicit" });
    expect(result.fields).toEqual(fields);
  });
});

describe("artifact schemas", () => {
  const request = {
    id: "018f47b6-6c9d-7f31-a780-c3b6447336bd",
    conversationId: "example-contact" as const,
    kind: "travel-guide" as const,
    trigger: "explicit" as const,
    status: "collecting" as const,
    fields: {
      destination: "示例城市",
      days: 3,
      preferences: ["清淡饮食"],
    },
    assumptions: ["公共交通为主"],
    createdAt: "2026-08-21T09:00:00+08:00",
    updatedAt: "2026-08-21T09:01:00+08:00",
    expiresAt: "2026-08-22T09:00:00+08:00",
    failureCode: null,
    failureCounts: {},
    attemptsStopped: false,
  };

  const source = {
    id: "source-1",
    title: "目的地官方信息",
    url: "https://example.com/guide",
    accessedAt: "2026-08-21T09:02:00+08:00",
  };

  const model = {
    title: "示例城市三日指南",
    summary: "一份可离线查看的三日安排。",
    assumptions: ["公共交通为主"],
    sections: [{
      id: "day-1",
      heading: "第一天",
      paragraphs: ["上午游览西湖。"],
      sourceIds: ["source-1"],
    }],
    checklist: ["携带雨具"],
    sources: [source],
    generatedAt: "2026-08-21T09:03:00+08:00",
  };

  const manifest = {
    requestId: request.id,
    filename: "hangzhou-three-days.html",
    path: "/tmp/hangzhou-three-days.html",
    bytes: 1024,
    sha256: "a".repeat(64),
    generatedAt: "2026-08-21T09:04:00+08:00",
  };

  it("defines every request status and applies only the documented request defaults", () => {
    expect(artifactRequestStatusSchema.options).toEqual([
      "collecting",
      "ready",
      "researching",
      "rendered",
      "validated",
      "failed",
      "cancelled",
    ]);
    expect(artifactRequestSchema.parse({
      ...request,
      fields: { destination: "示例城市", days: 3 },
      failureCounts: undefined,
      attemptsStopped: undefined,
    })).toEqual({
      ...request,
      fields: { destination: "示例城市", days: 3, preferences: [] },
      failureCounts: {},
      attemptsStopped: false,
    });
  });

  it("rejects undocumented request and field properties", () => {
    expect(artifactRequestSchema.safeParse({ ...request, debug: true }).success).toBe(false);
    expect(artifactRequestSchema.safeParse({
      ...request,
      fields: { ...request.fields, city: "示例城市" },
    }).success).toBe(false);
  });

  it("accepts a fully linked model and rejects insecure or unknown sources", () => {
    expect(htmlArtifactModelSchema.parse(model)).toEqual(model);
    expect(htmlArtifactModelSchema.safeParse({
      ...model,
      sources: [{ ...source, url: "http://example.com/guide" }],
    }).success).toBe(false);
    expect(htmlArtifactModelSchema.safeParse({
      ...model,
      sections: [{ ...model.sections[0], sourceIds: ["missing-source"] }],
    }).success).toBe(false);
  });

  it("normalizes nonblank source IDs and rejects duplicate normalized IDs", () => {
    expect(artifactSourceSchema.parse({ ...source, id: " source-1 " }).id).toBe("source-1");
    expect(artifactSourceSchema.safeParse({ ...source, id: "   " }).success).toBe(false);
    expect(artifactSectionSchema.parse({
      ...model.sections[0],
      sourceIds: [" source-1 "],
    }).sourceIds).toEqual(["source-1"]);
    expect(htmlArtifactModelSchema.safeParse({
      ...model,
      sources: [source, { ...source, id: " source-1 " }],
    }).success).toBe(false);
  });

  it("rejects undocumented source, section, model, and manifest properties", () => {
    expect(artifactSourceSchema.safeParse({ ...source, debug: true }).success).toBe(false);
    expect(artifactSectionSchema.safeParse({
      ...model.sections[0],
      debug: true,
    }).success).toBe(false);
    expect(htmlArtifactModelSchema.safeParse({ ...model, debug: true }).success).toBe(false);
    expect(artifactManifestSchema.safeParse({ ...manifest, debug: true }).success).toBe(false);
  });

  it.each([
    ["Hangzhou.html", "a".repeat(64)],
    ["../hangzhou.html", "a".repeat(64)],
    ["hangzhou.html", "a".repeat(63)],
    ["hangzhou.html", "A".repeat(64)],
  ])("rejects an unsafe manifest filename or hash: %s", (filename, sha256) => {
    expect(artifactManifestSchema.safeParse({
      ...manifest,
      filename,
      sha256,
    }).success).toBe(false);
  });

  it("keeps the manifest and workflow result contracts strict", () => {
    expect(artifactManifestSchema.parse(manifest)).toEqual(manifest);
    expect(artifactWorkflowResultSchema.parse({
      kind: "artifact",
      requestId: request.id,
      status: "validated",
      manifest,
    })).toEqual({
      kind: "artifact",
      requestId: request.id,
      status: "validated",
      manifest,
    });
    expect(artifactManifestSchema.safeParse({ ...manifest, bytes: 0 }).success).toBe(false);
    expect(artifactWorkflowResultSchema.safeParse({
      kind: "clarification",
      requestId: request.id,
      status: "collecting",
      questions: ["想去哪里", "准备玩几天", "预算多少"],
    }).success).toBe(false);
    expect(artifactWorkflowResultSchema.safeParse({
      kind: "not-applicable",
      reason: "ordinary question",
    }).success).toBe(false);
  });

  it("accepts every positive workflow branch", () => {
    expect(artifactWorkflowResultSchema.parse({
      kind: "not-applicable",
    })).toEqual({ kind: "not-applicable" });
    expect(artifactWorkflowResultSchema.parse({
      kind: "clarification",
      requestId: request.id,
      status: "collecting",
      questions: ["想去哪里", "准备玩几天"],
    })).toEqual({
      kind: "clarification",
      requestId: request.id,
      status: "collecting",
      questions: ["想去哪里", "准备玩几天"],
    });
    expect(artifactWorkflowResultSchema.parse({
      kind: "failure",
      requestId: request.id,
      status: "failed",
      code: "RENDER_FAILED",
    })).toEqual({
      kind: "failure",
      requestId: request.id,
      status: "failed",
      code: "RENDER_FAILED",
    });
  });

  it("rejects an artifact workflow whose request IDs disagree", () => {
    expect(artifactWorkflowResultSchema.safeParse({
      kind: "artifact",
      requestId: "118f47b6-6c9d-7f31-a780-c3b6447336bd",
      status: "validated",
      manifest,
    }).success).toBe(false);
  });
});
