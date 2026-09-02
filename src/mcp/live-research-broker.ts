import { randomBytes } from "node:crypto";

import {
  decideResearch,
  type ResearchTopic,
} from "../memory/research-policy.js";

const CAPABILITY_TTL_MS = 120_000;
const capabilityBrand: unique symbol = Symbol("research-capability");

export interface ResearchCapability {
  readonly [capabilityBrand]: true;
}

export interface InternalResearchIntent {
  readonly topic: ResearchTopic;
  readonly normalizedQuery: string;
  readonly triggerIdHash: string;
}

export type ResearchBrokerDecision =
  | { status: "AUTHORIZED"; capability: ResearchCapability }
  | { status: "NO_SAFE_RESEARCH_RESULT" };

interface CapabilityRecord {
  readonly secret: string;
  readonly expiresAt: number;
  readonly intent: InternalResearchIntent;
}

interface LiveResearchBrokerOptions {
  now?: () => number;
}

export class LiveResearchBroker {
  readonly #now: () => number;
  readonly #capabilities = new Map<ResearchCapability, CapabilityRecord>();

  constructor(options: LiveResearchBrokerOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  authorizeLatestTrigger(input: unknown): ResearchBrokerDecision {
    if (!isValidTriggerEnvelope(input)) return noSafeResult();
    if (hasMismatchedWeatherLocation(input.messageText)) return noSafeResult();

    const decision = decideResearch({
      scenario: "ordinary-reply",
      query: input.messageText,
    });
    if (
      !decision.required ||
      decision.privacyMode !== "sanitized-external" ||
      decision.externalQuery === null ||
      decision.topic === null
    ) {
      return noSafeResult();
    }

    const capability = Object.freeze({
      [capabilityBrand]: true as const,
    });
    this.#capabilities.set(capability, {
      secret: randomBytes(32).toString("hex"),
      expiresAt: this.#now() + CAPABILITY_TTL_MS,
      intent: Object.freeze({
        topic: decision.topic,
        normalizedQuery: decision.externalQuery,
        triggerIdHash: input.triggerIdHash,
      }),
    });

    return { status: "AUTHORIZED", capability };
  }

  redeemForExecutor(capability: ResearchCapability): InternalResearchIntent | null {
    const record = this.#capabilities.get(capability);
    if (record === undefined) return null;

    this.#capabilities.delete(capability);
    if (record.expiresAt <= this.#now()) return null;

    // Reading the secret keeps capability creation cryptographically random while
    // leaving no token field on the object that crosses the broker boundary.
    if (record.secret.length !== 64) return null;
    return record.intent;
  }
}

function hasMismatchedWeatherLocation(messageText: string): boolean {
  const normalized = messageText.normalize("NFC").replace(/\s+/gu, "").trim();
  return /天气/u.test(normalized) && /^上海(?:市)?/u.test(normalized);
}

function isValidTriggerEnvelope(input: unknown): input is {
  triggerIdHash: string;
  messageText: string;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === 2 &&
    Object.hasOwn(record, "triggerIdHash") &&
    Object.hasOwn(record, "messageText") &&
    typeof record.triggerIdHash === "string" &&
    /^[a-f0-9]{64}$/u.test(record.triggerIdHash) &&
    typeof record.messageText === "string" &&
    record.messageText.length > 0 &&
    record.messageText.length <= 2_000
  );
}

function noSafeResult(): ResearchBrokerDecision {
  return { status: "NO_SAFE_RESEARCH_RESULT" };
}
