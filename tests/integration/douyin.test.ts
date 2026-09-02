import { describe, expect, it, vi } from "vitest";

import {
  DouyinAdapter,
  type DouyinSnapshot,
  type DouyinSurface,
} from "../../src/adapters/douyin.js";

function snapshot(overrides: Partial<DouyinSnapshot> = {}): DouyinSnapshot {
  return {
    loggedIn: true,
    navigationRevision: "direct-message:example-contact",
    identity: {
      visibleName: "示例联系人",
      avatarFingerprint: "avatar-01",
      recentMessageFingerprint: "recent-01",
      confidence: 0.99,
    },
    items: [
      {
        id: "dy-1",
        text: "你看这个",
        occurredAt: "2026-08-19T08:00:00.000Z",
        kind: "shared-link",
        url: "https://www.douyin.com/video/redacted",
        confidence: 0.98,
      },
    ],
    ...overrides,
  };
}

function surface(value: DouyinSnapshot): DouyinSurface {
  return { readTargetConversation: vi.fn().mockResolvedValue(value) };
}

const identity = {
  visibleName: "示例联系人",
  avatarFingerprint: "avatar-01",
  recentMessageFingerprint: "recent-01",
};

describe("DouyinAdapter", () => {
  it("reads only the configured conversation and maps shares to links", async () => {
    const readTargetConversation = vi.fn().mockResolvedValue(snapshot());
    const readOnlySurface: DouyinSurface = { readTargetConversation };
    const adapter = new DouyinAdapter(readOnlySurface, identity);

    await expect(adapter.readTargetDirectMessages()).resolves.toEqual([
      expect.objectContaining({
        id: "dy-1",
        conversationId: "example-contact",
        direction: "incoming",
        kind: "link",
        source: "douyin",
      }),
    ]);
    expect(readTargetConversation).toHaveBeenCalledOnce();
    expect(Object.keys(adapter)).not.toContain("send");
  });

  it.each([
    ["not logged in", snapshot({ loggedIn: false }), "DOUYIN_LOGIN_REQUIRED"],
    [
      "navigation changed",
      snapshot({ navigationRevision: "home" }),
      "DOUYIN_NAVIGATION_CHANGED",
    ],
    [
      "identity confidence is low",
      snapshot({ identity: { ...snapshot().identity, confidence: 0.8 } }),
      "IDENTITY_VERIFICATION_FAILED",
    ],
    [
      "visible identity changed",
      snapshot({ identity: { ...snapshot().identity, visibleName: "其他人" } }),
      "IDENTITY_VERIFICATION_FAILED",
    ],
  ])("blocks when %s", async (_name, value, code) => {
    const adapter = new DouyinAdapter(surface(value), identity);
    await expect(adapter.readTargetDirectMessages()).rejects.toThrow(code);
  });
});

type HasWriteMethod<T> = Extract<keyof T, "send" | "like" | "comment" | "follow">;
const noWriteMethod: HasWriteMethod<DouyinSurface> = undefined as never;
void noWriteMethod;
