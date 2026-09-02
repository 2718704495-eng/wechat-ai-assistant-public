import type { ContactRecord } from "../contacts/contact-schema.js";

export interface EffectiveContactStyle {
  readonly salutation: string | null;
  readonly tone: "natural" | "gentle" | "professional";
  readonly preferredLength: "short" | "medium";
  readonly emojiPolicy: "none" | "light";
  readonly bannedTopics: readonly string[];
  readonly appendSignature: false;
}

export const defaultEffectiveContactStyle: EffectiveContactStyle = Object.freeze({
  salutation: null,
  tone: "natural",
  preferredLength: "medium",
  emojiPolicy: "none",
  bannedTopics: Object.freeze([]),
  appendSignature: false,
});

export function mergeContactStyle(
  globalStyle: Omit<EffectiveContactStyle, "appendSignature">,
  override: ContactRecord["styleOverride"],
): EffectiveContactStyle {
  return Object.freeze({
    salutation: override.salutation ?? globalStyle.salutation,
    tone: override.tone ?? globalStyle.tone,
    preferredLength: override.preferredLength ?? globalStyle.preferredLength,
    emojiPolicy: override.emojiPolicy ?? globalStyle.emojiPolicy,
    bannedTopics: Object.freeze([...new Set([
      ...globalStyle.bannedTopics,
      ...override.bannedTopics,
    ])]),
    appendSignature: false,
  });
}
