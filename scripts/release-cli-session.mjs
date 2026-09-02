import { Buffer } from "node:buffer";
import { once } from "node:events";
import { clearTimeout, setTimeout } from "node:timers";

const maximumDecisionBytes = 16_384;
const decisionQuietPeriodMs = 10;
const defaultDecisionTimeoutMs = 60_000;
const maximumDecisionTimeoutMs = 300_000;

export async function runReleaseCliSession(options) {
  if (
    options === null
    || typeof options !== "object"
    || typeof options.operation !== "function"
    || options.input === null
    || typeof options.input?.on !== "function"
    || options.output === null
    || typeof options.output?.write !== "function"
  ) {
    throw new Error("RELEASE_CLI_SESSION_INVALID");
  }
  const decisionTimeoutMs = options.decisionTimeoutMs ?? defaultDecisionTimeoutMs;
  if (
    !Number.isInteger(decisionTimeoutMs)
    || decisionTimeoutMs <= 0
    || decisionTimeoutMs > maximumDecisionTimeoutMs
  ) {
    throw new Error("RELEASE_CLI_SESSION_INVALID");
  }

  const inbox = new DecisionInbox(options.input);
  try {
    return await options.operation({
      readDecision: async (request) => {
        inbox.assertReadyForRequest();
        await writeLine(options.output, request);
        return inbox.readOneLine(decisionTimeoutMs);
      },
    });
  } finally {
    inbox.close();
  }
}

class DecisionInbox {
  constructor(input) {
    this.input = input;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.ended = false;
    this.failure = null;
    this.unsolicited = false;
    this.settleTimer = null;
    this.decisionTimer = null;
    this.onData = (chunk) => this.acceptChunk(chunk);
    this.onEnd = () => this.acceptEnd();
    this.onError = (error) => this.acceptError(error);
    input.on("data", this.onData);
    input.once("end", this.onEnd);
    input.once("error", this.onError);
  }

  assertReadyForRequest() {
    if (this.waiter !== null) throw new Error("RELEASE_CLI_DECISION_CONCURRENT");
    if (this.failure !== null) throw this.failure;
    if (this.unsolicited || this.buffer.length > 0) {
      throw new Error("RELEASE_CLI_UNSOLICITED_INPUT");
    }
    if (this.ended) throw new Error("RELEASE_CLI_STDIN_CLOSED");
  }

  readOneLine(timeoutMs) {
    if (this.waiter !== null) {
      return Promise.reject(new Error("RELEASE_CLI_DECISION_CONCURRENT"));
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.ended) return Promise.reject(new Error("RELEASE_CLI_STDIN_CLOSED"));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.decisionTimer = setTimeout(() => {
        this.fail(new Error("RELEASE_CLI_DECISION_TIMEOUT"));
      }, timeoutMs);
      this.drain();
    });
  }

  acceptChunk(chunk) {
    if (this.failure !== null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.waiter === null || this.settleTimer !== null) this.unsolicited = true;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > maximumDecisionBytes + 1) {
      this.fail(new Error("RELEASE_CLI_DECISION_TOO_LARGE"));
      return;
    }
    this.drain();
  }

  acceptEnd() {
    this.ended = true;
    if (this.waiter !== null && this.settleTimer === null) {
      this.fail(new Error("RELEASE_CLI_STDIN_CLOSED"));
    }
  }

  acceptError(error) {
    this.fail(new Error("RELEASE_CLI_STDIN_FAILED", { cause: error }));
  }

  drain() {
    if (this.waiter === null || this.failure !== null) return;
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) return;
    const lineBytes = this.buffer.subarray(0, newline);
    const remainder = this.buffer.subarray(newline + 1);
    if (
      lineBytes.length === 0
      || lineBytes.length > maximumDecisionBytes
      || lineBytes.includes(0)
      || remainder.length > 0
    ) {
      this.fail(new Error("RELEASE_CLI_UNSOLICITED_INPUT"));
      return;
    }
    this.buffer = Buffer.alloc(0);
    const line = lineBytes.toString("utf8").replace(/\r$/u, "");
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.failure !== null || this.unsolicited || this.buffer.length > 0) {
        this.fail(this.failure ?? new Error("RELEASE_CLI_UNSOLICITED_INPUT"));
        return;
      }
      const waiter = this.waiter;
      this.waiter = null;
      if (this.decisionTimer !== null) {
        clearTimeout(this.decisionTimer);
        this.decisionTimer = null;
      }
      waiter.resolve(line);
    }, decisionQuietPeriodMs);
  }

  fail(error) {
    if (this.failure === null) this.failure = error;
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.decisionTimer !== null) {
      clearTimeout(this.decisionTimer);
      this.decisionTimer = null;
    }
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(this.failure);
    }
  }

  close() {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.decisionTimer !== null) {
      clearTimeout(this.decisionTimer);
      this.decisionTimer = null;
    }
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onError);
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(new Error("RELEASE_CLI_SESSION_CLOSED"));
    }
  }
}

async function writeLine(output, value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error("RELEASE_CLI_REQUEST_INVALID", { cause: error });
  }
  if (typeof serialized !== "string" || serialized.includes("\n")) {
    throw new Error("RELEASE_CLI_REQUEST_INVALID");
  }
  if (!output.write(`${serialized}\n`, "utf8")) await once(output, "drain");
}
