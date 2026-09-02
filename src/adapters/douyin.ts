import type { ChatMessage } from "../domain/types.js";

export interface DouyinIdentityProfile {
  visibleName: string;
  avatarFingerprint: string;
  recentMessageFingerprint: string;
}

export interface DouyinSnapshot {
  loggedIn: boolean;
  navigationRevision: string;
  identity: DouyinIdentityProfile & { confidence: number };
  items: Array<{
    id: string;
    text: string;
    occurredAt: string;
    kind: "text" | "shared-link";
    url?: string;
    confidence: number;
  }>;
}

/** Deliberately read-only: no send, like, comment, follow, or navigation API. */
export interface DouyinSurface {
  readTargetConversation(): Promise<DouyinSnapshot>;
}

const minimumIdentityConfidence = 0.95;
const expectedNavigationRevision = "direct-message:example-contact";

export class DouyinAdapter {
  public constructor(
    private readonly surface: DouyinSurface,
    private readonly identity: DouyinIdentityProfile,
  ) {}

  public async readTargetDirectMessages(): Promise<ChatMessage[]> {
    const snapshot = await this.surface.readTargetConversation();
    if (!snapshot.loggedIn) {
      throw new Error("DOUYIN_LOGIN_REQUIRED");
    }
    if (snapshot.navigationRevision !== expectedNavigationRevision) {
      throw new Error("DOUYIN_NAVIGATION_CHANGED");
    }
    if (!this.matchesIdentity(snapshot)) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }

    return snapshot.items.map((item) => ({
      id: item.id,
      conversationId: "example-contact",
      direction: "incoming",
      kind: item.kind === "shared-link" ? "link" : "text",
      text: item.url === undefined ? item.text : `${item.text}\n${item.url}`,
      occurredAt: item.occurredAt,
      source: "douyin",
      confidence: item.confidence,
    }));
  }

  private matchesIdentity(snapshot: DouyinSnapshot): boolean {
    return (
      snapshot.identity.confidence >= minimumIdentityConfidence &&
      snapshot.identity.visibleName === this.identity.visibleName &&
      snapshot.identity.avatarFingerprint === this.identity.avatarFingerprint &&
      snapshot.identity.recentMessageFingerprint ===
        this.identity.recentMessageFingerprint
    );
  }
}
