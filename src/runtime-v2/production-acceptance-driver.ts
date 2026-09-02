import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { NativeBridge } from "../adapters/native-bridge.js";
import { NativeWechatSurface } from "../adapters/native-wechat-surface.js";
import type { ConversationSnapshot, WeChatSurface } from "../adapters/wechat.js";
import { acquireLiveOperationCoordinator } from "../mcp/live-operation-coordinator.js";
import {
  FIXED_ACCEPTANCE_MESSAGE,
  type AcceptanceDriver,
  type OutgoingMessageBaseline,
} from "./supervised-acceptance.js";

const expectedNames: Record<"file-transfer" | "example-contact", string> = {
  "file-transfer": "文件传输助手",
  "example-contact": "示例联系人",
};

export interface ProductionAcceptanceDriverOptions {
  readonly surface: WeChatSurface;
  readonly listTools: () => Promise<string[]>;
  readonly release: () => Promise<void>;
}

export async function createProductionAcceptanceDriver(options: {
  readonly releaseRoot: string;
  readonly dataDir: string;
  readonly home: string;
  readonly environment?: Record<string, string | undefined>;
}): Promise<ProductionAcceptanceDriver> {
  const runtimeRoot = path.join(options.dataDir, "runtime-v2");
  const coordinator = await acquireLiveOperationCoordinator({
    dataDir: runtimeRoot,
    ownerKind: "cli",
  });
  try {
    const executablePath = path.join(
      options.releaseRoot,
      "native/WechatVisionBridge/.build/arm64-apple-macosx/debug/WechatVisionBridge",
    );
    const surface = new NativeWechatSurface(new NativeBridge({
      executablePath,
      dataDir: runtimeRoot,
    }));
    return new ProductionAcceptanceDriver({
      surface,
      listTools: () => listPackagedSupervisorTools({
        releaseRoot: options.releaseRoot,
        home: options.home,
        environment: options.environment ?? process.env,
      }),
      release: () => coordinator.close(),
    });
  } catch (error: unknown) {
    try {
      await coordinator.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [asError(error), asError(closeError)],
        "PRODUCTION_ACCEPTANCE_CONSTRUCTION_FAILED",
      );
    }
    throw error;
  }
}

export class ProductionAcceptanceDriver implements AcceptanceDriver {
  private target: "file-transfer" | "example-contact" | null = null;
  private candidateToken: string | null = null;
  private candidateMessage: string | null = null;
  private draftWritten = false;
  private submitted = false;
  private closePromise: Promise<{ readonly gateReleased: boolean }> | null = null;

  public constructor(private readonly options: ProductionAcceptanceDriverOptions) {}

  public listTools(): Promise<string[]> {
    return this.options.listTools();
  }

  public async locateFixedTarget(
    target: "file-transfer" | "example-contact",
    expectedMessage: string | null,
  ): Promise<{ unique: boolean; outgoingBaseline: OutgoingMessageBaseline }> {
    assertAcceptanceMessage(target, expectedMessage);
    const snapshot = await this.options.surface.locateConversation(target);
    const unique = hasExactIdentity(snapshot, target);
    if (unique) {
      this.target = target;
    }
    return {
      unique,
      outgoingBaseline: createOutgoingBaseline(snapshot.messages, expectedMessage),
    };
  }

  public async readLatestDirection(): Promise<"incoming" | "outgoing"> {
    const snapshot = await this.currentSnapshot();
    const direction = snapshot.messages.at(-1)?.direction;
    if (direction !== "incoming" && direction !== "outgoing") {
      throw new Error("ACCEPTANCE_LATEST_DIRECTION_UNAVAILABLE");
    }
    return direction;
  }

  public async readComposer(): Promise<string> {
    // replaceDraft already returns only after the Native mutation command proves
    // the exact text.  Preserve that atomic proof for the immediate acceptance
    // check instead of downgrading it to lossy screenshot OCR (notably for the
    // release-bound ASCII suffix).  submitDraft performs its own final exact
    // Native binding check before the irreversible action.
    if (this.draftWritten) {
      if (this.candidateMessage === null) {
        throw new Error("ACCEPTANCE_DRAFT_CAPABILITY_INVALID");
      }
      return this.candidateMessage;
    }
    const snapshot = await this.currentSnapshot();
    if (snapshot.composerEvidence === "ambiguous") {
      throw new Error("ACCEPTANCE_COMPOSER_AMBIGUOUS");
    }
    return snapshot.composerEvidence === "proven-empty" ? "" : snapshot.draftText;
  }

  public async replaceComposerWithFixedMessage(message: string): Promise<void> {
    const target = this.requireTarget();
    assertAcceptanceMessage(target, message);
    const token = randomBytes(32).toString("hex");
    await this.options.surface.replaceDraft(target, message, token);
    this.candidateToken = token;
    this.candidateMessage = message;
    this.draftWritten = true;
  }

  public async clearComposer(): Promise<void> {
    const target = this.requireTarget();
    await this.options.surface.clearDraft(target, randomBytes(32).toString("hex"));
    this.candidateToken = null;
    this.candidateMessage = null;
    this.draftWritten = false;
  }

  public async submitOnce(): Promise<void> {
    const target = this.requireTarget();
    const token = this.candidateToken;
    if (token === null || !this.draftWritten || this.submitted) {
      throw new Error("ACCEPTANCE_SUBMIT_CAPABILITY_INVALID");
    }
    await this.options.surface.submitDraft(target, token);
    this.submitted = true;
    this.candidateMessage = null;
    this.draftWritten = false;
  }

  public async readOutgoingFixedMessageAfterBaseline(
    baseline: OutgoingMessageBaseline,
    expectedMessage: string,
  ): Promise<boolean> {
    const target = this.requireTarget();
    assertAcceptanceMessage(target, expectedMessage);
    const snapshot = await this.currentSnapshot();
    const fixedOutgoingCount = countFixedOutgoing(snapshot.messages, expectedMessage);
    if (fixedOutgoingCount <= baseline.fixedOutgoingCount) return false;
    if (baseline.anchor === null) {
      return baseline.fixedOutgoingCount === 0 && fixedOutgoingCount > 0;
    }
    const anchorIndex = findMessageOccurrence(
      snapshot.messages,
      baseline.anchor.messageId,
      baseline.anchor.occurrenceOrdinal,
    );
    if (anchorIndex < 0) {
      return isReleaseBoundAcceptanceMessage(target, expectedMessage) &&
        baseline.fixedOutgoingCount === 0 && fixedOutgoingCount === 1;
    }
    return snapshot.messages.slice(anchorIndex + 1).some((message) =>
      message.direction === "outgoing" && message.text === expectedMessage);
  }

  public async close(): Promise<{ readonly gateReleased: boolean }> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<{ readonly gateReleased: boolean }> {
    const errors: Error[] = [];
    if (this.draftWritten && !this.submitted && this.target !== null) {
      try {
        await this.clearComposer();
      } catch (error: unknown) {
        errors.push(asError(error));
      }
    }
    try {
      await this.options.release();
    } catch (error: unknown) {
      errors.push(asError(error));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "PRODUCTION_ACCEPTANCE_CLOSE_FAILED");
    }
    return { gateReleased: true };
  }

  private async currentSnapshot(): Promise<ConversationSnapshot> {
    const target = this.requireTarget();
    const snapshot = await this.options.surface.locateConversation(target);
    if (!hasExactIdentity(snapshot, target)) throw new Error("ACCEPTANCE_TARGET_NOT_UNIQUE");
    return snapshot;
  }

  private requireTarget(): "file-transfer" | "example-contact" {
    if (this.target === null) throw new Error("ACCEPTANCE_TARGET_REQUIRED");
    return this.target;
  }
}

function createOutgoingBaseline(
  messages: ConversationSnapshot["messages"],
  expectedMessage: string | null,
): OutgoingMessageBaseline {
  const fixedOutgoingCount = expectedMessage === null
    ? 0
    : countFixedOutgoing(messages, expectedMessage);
  const last = messages.at(-1);
  if (last === undefined) return { fixedOutgoingCount, anchor: null };
  const messageId = opaqueMessageId(last.id);
  return {
    fixedOutgoingCount,
    anchor: {
      messageId,
      occurrenceOrdinal: messages.reduce((count, message) =>
        opaqueMessageId(message.id) === messageId ? count + 1 : count, 0),
    },
  };
}

function countFixedOutgoing(
  messages: ConversationSnapshot["messages"],
  expectedMessage: string,
): number {
  return messages.filter((message) =>
    message.direction === "outgoing" && message.text === expectedMessage).length;
}

function findMessageOccurrence(
  messages: ConversationSnapshot["messages"],
  messageId: string,
  occurrenceOrdinal: number,
): number {
  let observed = 0;
  return messages.findIndex((message) => {
    if (opaqueMessageId(message.id) !== messageId) return false;
    observed += 1;
    return observed === occurrenceOrdinal;
  });
}

function opaqueMessageId(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

function assertAcceptanceMessage(
  target: "file-transfer" | "example-contact",
  message: string | null,
): void {
  if (message === null) return;
  const valid = target === "example-contact"
    ? /^测试信息 R-[a-f0-9]{12}$/u.test(message)
    : message === FIXED_ACCEPTANCE_MESSAGE || /^测试信息 A-[a-f0-9]{12}$/u.test(message);
  if (!valid) throw new Error("ACCEPTANCE_MESSAGE_INVALID");
}

function isReleaseBoundAcceptanceMessage(
  target: "file-transfer" | "example-contact",
  message: string,
): boolean {
  return target === "file-transfer"
    ? /^测试信息 A-[a-f0-9]{12}$/u.test(message)
    : /^测试信息 R-[a-f0-9]{12}$/u.test(message);
}

function hasExactIdentity(
  snapshot: ConversationSnapshot,
  target: "file-transfer" | "example-contact",
): boolean {
  return snapshot.conversationId === target &&
    snapshot.identity.conversationId === target &&
    snapshot.identity.visibleName === expectedNames[target] &&
    snapshot.identity.confidence >= 0.95;
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("PRODUCTION_ACCEPTANCE_UNKNOWN_FAILURE", { cause: error });
}

async function listPackagedSupervisorTools(options: {
  readonly releaseRoot: string;
  readonly home: string;
  readonly environment: Record<string, string | undefined>;
}): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: path.join(options.releaseRoot, "bin", "chat-assistant-supervisor"),
    args: [],
    cwd: options.releaseRoot,
    env: {
      CHAT_ASSISTANT_MODE: "live",
      HOME: options.home,
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      NODE_OPTIONS: "",
      NODE_PATH: "",
      PATH: options.environment.PATH ?? "/usr/bin:/bin",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "wechat-runtime-activation-acceptance",
    version: "1.0.0",
  });
  let operationError: unknown;
  let tools: string[] = [];
  try {
    await client.connect(transport);
    tools = (await client.listTools()).tools.map(({ name }) => name);
  } catch (error: unknown) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    await client.close();
  } catch (error: unknown) {
    closeError = error;
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [asError(operationError), asError(closeError)],
      "ACCEPTANCE_TOOL_INVENTORY_FAILED",
    );
  }
  if (operationError !== undefined) throw asError(operationError);
  if (closeError !== undefined) throw asError(closeError);
  return tools;
}
