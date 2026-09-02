import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ChatMessage } from "../domain/types.js";
import { decideResearch, type ResearchDecision } from "../memory/research-policy.js";
import type {
  ControlBoundaryCheckpoint,
  MessageRepository,
  PersistentStopGate,
  StateRepository,
  TargetReplyState,
} from "../storage/repositories.js";
import type { LiveResearchBroker } from "./live-research-broker.js";
import type {
  OfficialResearchExecutor,
  VerifiedResearchResult,
} from "./official-research-executor.js";

const RESEARCH_TRIGGER_MISMATCH = "RESEARCH_TRIGGER_MISMATCH";
const OFFICIAL_RESEARCH_FAILED = "OFFICIAL_RESEARCH_FAILED";

export interface OfficialResearchMcpDependencies {
  researchLatestTrigger(): Promise<unknown>;
}

interface OfficialResearchRuntimeOptions {
  state: Pick<
    StateRepository,
    "getTargetReplyState" | "getPersistentStopGate" | "claimOwnerNotice"
  >;
  messages: Pick<MessageRepository, "list">;
  broker: LiveResearchBroker;
  executor: OfficialResearchExecutor;
  now?: () => number;
}

interface ResolvedTrigger {
  message: ChatMessage;
  proofHash: string;
  triggerIdHash: string;
}

type OwnerNoticeReason =
  | "SENSITIVE_MEDICAL_REQUEST"
  | "SENSITIVE_LEGAL_REQUEST"
  | "SENSITIVE_FINANCIAL_REQUEST"
  | "SENSITIVE_APPOINTMENT_REQUEST"
  | "SENSITIVE_PURCHASE_REQUEST"
  | "SENSITIVE_RELATIONSHIP_REQUEST"
  | "SENSITIVE_PRIVATE_REQUEST";

export function createOfficialResearchRuntimeDependencies(
  options: OfficialResearchRuntimeOptions,
): OfficialResearchMcpDependencies {
  const now = options.now ?? Date.now;

  return {
    researchLatestTrigger: async (): Promise<unknown> => {
      const resolved = await resolveLatestTrigger(options);
      const decision = decideResearch({
        scenario: "ordinary-reply",
        query: resolved.message.text,
      });
      const reasonCode = sensitiveReason(resolved.message.text, decision);

      if (reasonCode !== null) {
        await assertTriggerUnchanged(options, resolved.proofHash);
        const ownerNotice = await options.state.claimOwnerNotice({
          triggerIdHash: resolved.triggerIdHash,
          reasonCode,
        });
        if (ownerNotice === null) return noSafeResult(now());
        await assertTriggerUnchanged(options, resolved.proofHash);
        return { status: "OWNER_NOTICE_REQUIRED", ownerNotice };
      }

      const authorized = options.broker.authorizeLatestTrigger({
        triggerIdHash: resolved.triggerIdHash,
        messageText: resolved.message.text,
      });
      if (authorized.status !== "AUTHORIZED") return noSafeResult(now());

      await assertTriggerUnchanged(options, resolved.proofHash);
      const result = await options.executor.execute(authorized.capability);
      await assertTriggerUnchanged(options, resolved.proofHash);
      return result;
    },
  };
}

export function createOfficialResearchMcpServer(
  dependencies: OfficialResearchMcpDependencies,
): McpServer {
  const server = new McpServer({ name: "official-research", version: "0.1.0" });
  const inputSchema = z.object({}).strict();
  server.registerTool<typeof inputSchema, typeof inputSchema>(
    "research_latest_trigger",
    {
      description: "对仍有效的当前消息触发执行固定官方来源研究",
      inputSchema,
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await dependencies.researchLatestTrigger();
        return {
          content: [{ type: "text", text: JSON.stringify(result) ?? "null" }],
        };
      } catch (error: unknown) {
        const text = error instanceof Error && error.message === RESEARCH_TRIGGER_MISMATCH
          ? RESEARCH_TRIGGER_MISMATCH
          : OFFICIAL_RESEARCH_FAILED;
        return { isError: true, content: [{ type: "text", text }] };
      }
    },
  );
  return server;
}

export async function connectOfficialResearchMcpStdio(
  dependencies: OfficialResearchMcpDependencies,
): Promise<McpServer> {
  const server = createOfficialResearchMcpServer(dependencies);
  await server.connect(new StdioServerTransport());
  return server;
}

async function resolveLatestTrigger(
  options: OfficialResearchRuntimeOptions,
): Promise<ResolvedTrigger> {
  const state = await options.state.getTargetReplyState();
  const gate = await options.state.getPersistentStopGate();
  const trigger = state.pendingTrigger;
  const baseline = state.baseline;
  if (
    trigger === null ||
    baseline === null ||
    baseline.latestMessageId !== trigger.triggerMessageId ||
    baseline.latestDirection !== "incoming" ||
    baseline.epoch !== trigger.baselineEpoch ||
    baseline.orderedSequenceHash !== trigger.orderedSequenceHash ||
    trigger.gateRevision !== gate.gateRevision ||
    !sameCheckpoint(trigger.controlCheckpoint, gate.checkpoint)
  ) {
    throw new Error(RESEARCH_TRIGGER_MISMATCH);
  }

  const matching = (await options.messages.list()).filter(
    (message) => message.id === trigger.triggerMessageId,
  );
  const message = matching[0];
  if (
    matching.length !== 1 ||
    message === undefined ||
    message.conversationId !== "example-contact" ||
    message.source !== "wechat" ||
    message.direction !== "incoming"
  ) {
    throw new Error(RESEARCH_TRIGGER_MISMATCH);
  }

  return {
    message,
    proofHash: triggerProofHash(state, gate),
    triggerIdHash: sha256(trigger.triggerId),
  };
}

async function assertTriggerUnchanged(
  options: OfficialResearchRuntimeOptions,
  expectedProofHash: string,
): Promise<void> {
  const state = await options.state.getTargetReplyState();
  const gate = await options.state.getPersistentStopGate();
  if (triggerProofHash(state, gate) !== expectedProofHash) {
    throw new Error(RESEARCH_TRIGGER_MISMATCH);
  }
}

function triggerProofHash(
  state: TargetReplyState,
  gate: PersistentStopGate,
): string {
  return sha256(JSON.stringify({
    baseline: state.baseline,
    pendingTrigger: state.pendingTrigger,
    checkpoint: gate.checkpoint,
    gateRevision: gate.gateRevision,
  }));
}

function sameCheckpoint(
  first: ControlBoundaryCheckpoint,
  second: ControlBoundaryCheckpoint,
): boolean {
  return (
    first.epoch === second.epoch &&
    first.boundaryMessageId === second.boundaryMessageId &&
    first.consumedCount === second.consumedCount &&
    first.prefixChainHash === second.prefixChainHash
  );
}

function sensitiveReason(
  messageText: string,
  decision: ResearchDecision,
): OwnerNoticeReason | null {
  if (/医院|就医|看病|住院|病史|治疗|诊断|药物|用药|手术/u.test(messageText)) {
    return "SENSITIVE_MEDICAL_REQUEST";
  }
  if (/合同|法律|律师|违法|合法|诉讼|起诉/u.test(messageText)) {
    return "SENSITIVE_LEGAL_REQUEST";
  }
  if (/股票|基金|投资|理财|贷款|借款|保险/u.test(messageText)) {
    return "SENSITIVE_FINANCIAL_REQUEST";
  }
  if (/预约|挂号|预订/u.test(messageText)) return "SENSITIVE_APPOINTMENT_REQUEST";
  if (/购买|买票|下单|付款/u.test(messageText)) return "SENSITIVE_PURCHASE_REQUEST";
  if (/关系|分手|复合|结婚|离婚/u.test(messageText)) {
    return "SENSITIVE_RELATIONSHIP_REQUEST";
  }
  if (
    decision.privacyMode === "local-personal-only" ||
    decision.privacyMode === "mixed-sanitized"
  ) {
    return "SENSITIVE_PRIVATE_REQUEST";
  }
  return null;
}

function noSafeResult(now: number): VerifiedResearchResult {
  return {
    status: "NO_SAFE_RESEARCH_RESULT",
    checkedAt: new Date(now).toISOString(),
    evidence: [],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
