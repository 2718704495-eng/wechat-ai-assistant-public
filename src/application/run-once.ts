import { z } from "zod";

import type { ControlCommandResult } from "../adapters/wechat.js";
import type { ChatMessage, GeneratedReply, RunResult } from "../domain/types.js";
import { classifyMessage } from "../policy/classifier.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";

export interface RunOnceDependencies {
  readControlCommand(): Promise<ControlCommandResult | null>;
  preflight(): Promise<void>;
  readMessages(): Promise<ChatMessage[]>;
  persistMessages(messages: ChatMessage[]): Promise<string[]>;
  generateReply(current: ChatMessage): Promise<GeneratedReply>;
  sendReply(text: string): Promise<{ status: "verified" | "duplicate" | "uncertain" }>;
  notifyUser(input: { reason: string; latestMessage: string; todo: string }): Promise<void>;
  audit(type: string, details?: Record<string, unknown>): Promise<void>;
  runDailyReview(now: Date): Promise<void>;
  failures?: FailureRepository;
}

const failureStateSchema = z.object({
  byCode: z.record(z.string(), z.number().int().nonnegative()),
  stopped: z.boolean(),
});

export class FailureRepository {
  public constructor(private readonly store: EncryptedStore) {}

  public async record(code: string): Promise<{
    count: number;
    stopped: boolean;
    strategy: "retry-after-preflight" | "capture-window-and-permission-state" | "request-user-intervention";
  }> {
    const state =
      (await this.store.read("state/failures.enc", failureStateSchema)) ?? {
        byCode: {},
        stopped: false,
      };
    const count = (state.byCode[code] ?? 0) + 1;
    state.byCode[code] = count;
    state.stopped = count >= 3;
    await this.store.write("state/failures.enc", state);
    return {
      count,
      stopped: state.stopped,
      strategy:
        count >= 3
          ? "request-user-intervention"
          : count === 2
            ? "capture-window-and-permission-state"
            : "retry-after-preflight",
    };
  }
}

export async function runOnce(
  dependencies: RunOnceDependencies,
  now = new Date(),
): Promise<RunResult> {
  try {
    const control = await dependencies.readControlCommand();
    if (control?.command === "stop") {
      return result("blocked", "stopped-by-user", [control.messageId]);
    }
    await dependencies.preflight();
    const visible = await dependencies.readMessages();
    const addedIds = await dependencies.persistMessages(visible);
    const current = [...visible]
      .reverse()
      .find((message) => addedIds.includes(message.id) && message.direction === "incoming");
    if (current === undefined) {
      await dependencies.runDailyReview(now);
      return result("success", "no-new-message");
    }

    const decision = classifyMessage(current, {});
    if (decision.action !== "reply") {
      await dependencies.notifyUser({
        reason: decision.reason,
        latestMessage: current.text,
        todo: "请本人处理后再发送继续生成",
      });
      await dependencies.audit("reply-paused", { messageId: current.id, reason: decision.reason });
      return result("blocked", "sensitive-message-paused", [current.id, decision.reason]);
    }

    const generated = await dependencies.generateReply(current);
    const sent = await dependencies.sendReply(generated.text);
    if (sent.status === "uncertain") {
      await dependencies.audit("reply-uncertain", { messageId: current.id });
      return result("blocked", "send-result-uncertain", [current.id]);
    }
    await dependencies.audit("reply-verified", {
      messageId: current.id,
      citedMessageIds: generated.citedMessageIds,
      sendStatus: sent.status,
    });
    await dependencies.runDailyReview(now);
    return result("success", sent.status === "duplicate" ? "reply-already-processed" : "reply-verified", [current.id]);
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const failure = await dependencies.failures?.record(code);
    if (failure?.stopped === true) {
      await dependencies.notifyUser({ reason: code, latestMessage: "", todo: "连续三次失败，请本人检查权限或窗口状态" });
      return result("blocked", "repeated-failure-stopped", [code, failure.strategy]);
    }
    return result("error", "run-once-failed", [code, failure?.strategy ?? "not-recorded"]);
  }
}

function result(
  status: RunResult["status"],
  summary: string,
  evidence: string[] = [],
): RunResult {
  return { status, summary, evidence, nextActions: [], artifacts: [] };
}
