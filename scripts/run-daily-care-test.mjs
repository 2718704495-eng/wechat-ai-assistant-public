import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const DEFAULT_DECISION_TIMEOUT_MS = 5 * 60 * 1000;
const MAXIMUM_DECISION_BYTES = 8_192;

export async function runDailyCareTestSession(options) {
  assertSessionOptions(options);
  let phase = "idle";
  let closed = false;
  const safeClose = async () => {
    if (closed) return;
    closed = true;
    await options.rpc.callTool("close", {});
  };
  try {
    const begin = assertBeginResult(
      await options.rpc.callTool("begin-test-preview", { kind: options.kind }),
      options.kind,
    );
    phase = "begun";
    const weather = options.kind === "morning"
      ? assertWeatherResult(await options.rpc.callTool("research-morning-weather", {}))
      : undefined;
    if (weather !== undefined) phase = "researched";
    await writeLine(options.output, {
      type: "awaiting-candidate",
      kind: options.kind,
      constraints: {
        bodyLength: begin.bodyLength,
        signature: begin.signature,
        maximumRegenerations: begin.maximumRegenerations,
      },
      ...(weather === undefined ? {} : { weather }),
    });
    const decision = await readDecision(
      options.input,
      options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    );
    if (decision.decision === "abort") {
      await safeClose();
      return { status: "aborted" };
    }
    assertExactResult(
      await options.rpc.callTool("prepare-broadcast", { text: decision.text }),
      { prepared: true, conversationId: "file-transfer" },
    );
    phase = "prepared";
    assertExactResult(await options.rpc.callTool("verify-draft", {}), {
      draftVerified: true,
      conversationId: "file-transfer",
    });
    phase = "draft-verified";
    assertExactResult(await options.rpc.callTool("submit-authorized-broadcast", {}), {
      submitted: true,
      conversationId: "file-transfer",
    });
    phase = "submitted";
    assertExactResult(await options.rpc.callTool("verify-send", {}), {
      status: "verified",
      conversationId: "file-transfer",
    });
    phase = "verified";
    await safeClose();
    return {
      status: "verified",
      messageHash: createHash("sha256").update(decision.text).digest("hex"),
    };
  } catch (error) {
    if (phase === "prepared" || phase === "draft-verified") {
      await options.rpc.callTool("abort-draft", {}).catch(() => undefined);
    }
    await safeClose().catch(() => undefined);
    throw error;
  }
}

function assertSessionOptions(options) {
  if (options === null || typeof options !== "object" ||
      (options.kind !== "morning" && options.kind !== "night") ||
      options.rpc === null || typeof options.rpc?.callTool !== "function" ||
      options.input === null || typeof options.input?.on !== "function" ||
      options.output === null || typeof options.output?.write !== "function") {
    throw new Error("DAILY_CARE_TEST_OPTIONS_INVALID");
  }
}

function assertPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("TEST_PROTOCOL_INVALID");
  }
  return value;
}

function assertKeys(record, expected) {
  const keys = Object.keys(record).sort();
  if (keys.join("\0") !== [...expected].sort().join("\0")) {
    if (keys.some((key) => /token|capability|candidate|history|contact|query|url/iu.test(key))) {
      throw new Error("TEST_PROTOCOL_SECRET_LEAK");
    }
    throw new Error("TEST_PROTOCOL_INVALID");
  }
}

function assertBeginResult(value, kind) {
  const record = assertPlainRecord(value);
  assertKeys(record, ["kind", "target", "weatherRequired", "bodyLength", "signature", "maximumRegenerations"]);
  const length = assertPlainRecord(record.bodyLength);
  assertKeys(length, ["minimum", "maximum"]);
  const expectedLength = kind === "morning" ? { minimum: 60, maximum: 120 } : { minimum: 120, maximum: 220 };
  if (record.kind !== kind || record.target !== "file-transfer" ||
      record.weatherRequired !== (kind === "morning") ||
      record.signature !== "——示例用户" || record.maximumRegenerations !== 2 ||
      length.minimum !== expectedLength.minimum || length.maximum !== expectedLength.maximum) {
    throw new Error("TEST_PROTOCOL_INVALID");
  }
  return { ...record, bodyLength: expectedLength };
}

function assertWeatherResult(value) {
  const record = assertPlainRecord(value);
  assertKeys(record, ["localDate", "condition", "temperature", "rainExpected", "clothingConcepts", "checkedAt"]);
  const temperature = assertTemperatureResult(record.temperature);
  if (typeof record.localDate !== "string" || typeof record.condition !== "string" ||
      typeof record.rainExpected !== "boolean" || !Array.isArray(record.clothingConcepts) ||
      !record.clothingConcepts.every((item) => typeof item === "string") ||
      typeof record.checkedAt !== "string") {
    throw new Error("TEST_PROTOCOL_INVALID");
  }
  return { ...record, temperature };
}

function assertTemperatureResult(value) {
  const record = assertPlainRecord(value);
  if (record.kind === "range") {
    assertKeys(record, ["kind", "highC", "lowC"]);
    if (!isValidTemperature(record.highC) || !isValidTemperature(record.lowC) ||
        record.highC < record.lowC) {
      throw new Error("TEST_PROTOCOL_INVALID");
    }
    return { kind: "range", highC: record.highC, lowC: record.lowC };
  }
  if (record.kind === "low-only") {
    assertKeys(record, ["kind", "lowC"]);
    if (!isValidTemperature(record.lowC)) throw new Error("TEST_PROTOCOL_INVALID");
    return { kind: "low-only", lowC: record.lowC };
  }
  throw new Error("TEST_PROTOCOL_INVALID");
}

function isValidTemperature(value) {
  return Number.isInteger(value) && value >= -50 && value <= 60;
}

function assertExactResult(value, expected) {
  const record = assertPlainRecord(value);
  assertKeys(record, Object.keys(expected));
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (record[key] !== expectedValue) throw new Error("TEST_PROTOCOL_INVALID");
  }
}

function readDecision(input, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_DECISION_TIMEOUT_MS) {
    return Promise.reject(new Error("DAILY_CARE_TEST_TIMEOUT_INVALID"));
  }
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("DAILY_CARE_TEST_STDIN_TIMEOUT")), timeoutMs);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.length > MAXIMUM_DECISION_BYTES) finish(new Error("DAILY_CARE_TEST_DECISION_TOO_LARGE"));
    };
    const onEnd = () => {
      const serialized = buffer.toString("utf8");
      const lines = serialized.split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (lines.length !== 1 || lines[0]?.length === 0) {
        finish(new Error("DAILY_CARE_TEST_STDIN_INVALID"));
        return;
      }
      try {
        const value = JSON.parse(lines[0]);
        const record = assertPlainRecord(value);
        if (record.decision === "abort") {
          assertKeys(record, ["decision"]);
          finish(undefined, { decision: "abort" });
        } else if (record.decision === "send" && typeof record.text === "string") {
          assertKeys(record, ["decision", "text"]);
          finish(undefined, { decision: "send", text: record.text });
        } else {
          finish(new Error("DAILY_CARE_TEST_DECISION_INVALID"));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error("DAILY_CARE_TEST_DECISION_INVALID"));
      }
    };
    const onError = () => finish(new Error("DAILY_CARE_TEST_STDIN_FAILED"));
    const finish = (error, value) => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

async function writeLine(output, value) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || serialized.includes("\n")) {
    throw new Error("TEST_PROTOCOL_INVALID");
  }
  if (!output.write(`${serialized}\n`, "utf8")) await once(output, "drain");
}

async function runCli() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--kind" || (args[1] !== "morning" && args[1] !== "night")) {
    throw new Error("DAILY_CARE_TEST_ARGUMENTS_INVALID");
  }
  const kind = args[1];
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const entry = path.join(root, "dist", "src", "mcp", "daily-care-test-main.js");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
  environment.CHAT_ASSISTANT_MODE = "supervised-send";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: environment,
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "daily-care-test-runner", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await runDailyCareTestSession({
      kind,
      input: process.stdin,
      output: process.stdout,
      rpc: {
        callTool: async (name, arguments_) => decodeToolResult(await client.callTool({
          name,
          arguments: arguments_,
        })),
      },
    });
    await writeLine(process.stdout, { type: "result", ...result, kind });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function decodeToolResult(result) {
  if (result.isError === true || !Array.isArray(result.content) || result.content.length !== 1) {
    throw new Error("DAILY_CARE_TEST_RPC_FAILED");
  }
  const block = result.content[0];
  if (block?.type !== "text" || typeof block.text !== "string") {
    throw new Error("DAILY_CARE_TEST_RPC_FAILED");
  }
  try {
    return JSON.parse(block.text);
  } catch {
    throw new Error("DAILY_CARE_TEST_RPC_FAILED");
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli().catch(() => {
    process.stderr.write("DAILY_CARE_TEST_FAILED\n");
    process.exitCode = 1;
  });
}
