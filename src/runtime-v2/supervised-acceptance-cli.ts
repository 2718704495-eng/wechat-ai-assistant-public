import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import type {
  AcceptanceReceipt,
  ReleaseBinding,
  SupervisedAcceptanceService,
} from "./supervised-acceptance.js";

interface AcceptanceCliService {
  runA(binding: ReleaseBinding): Promise<unknown>;
  runB0(binding: ReleaseBinding): Promise<unknown>;
  runB1(binding: ReleaseBinding, decision: "approve" | "abort"): Promise<unknown>;
}

export interface SupervisedAcceptanceCliOptions {
  readonly argv: string[];
  readonly input: Readable;
  readonly output: Writable;
  readonly testOnlyService?: AcceptanceCliService | Pick<SupervisedAcceptanceService, "runA" | "runB0" | "runB1">;
  readonly releaseBinding?: ReleaseBinding;
}

export async function runSupervisedAcceptanceCli(
  options: SupervisedAcceptanceCliOptions,
): Promise<unknown> {
  const stage = parseStage(options?.argv);
  if (options.testOnlyService === undefined || options.releaseBinding === undefined) {
    throw new Error("ACCEPTANCE_LIVE_EXECUTION_DISABLED");
  }
  let result: unknown;
  if (stage === "A") result = await options.testOnlyService.runA(options.releaseBinding);
  else if (stage === "B0") result = await options.testOnlyService.runB0(options.releaseBinding);
  else {
    const decision = await readDecision(options.input);
    result = await options.testOnlyService.runB1(options.releaseBinding, decision);
  }
  await writeReceipt(options.output, result as AcceptanceReceipt);
  return result;
}

function parseStage(argv: unknown): "A" | "B0" | "B1" {
  if (!Array.isArray(argv)) throw new Error("ACCEPTANCE_ARGUMENTS_INVALID");
  const tokens = argv as unknown[];
  const stage = tokens[1];
  if (tokens.length !== 2 || tokens[0] !== "--stage" ||
      (stage !== "A" && stage !== "B0" && stage !== "B1")) {
    throw new Error("ACCEPTANCE_ARGUMENTS_INVALID");
  }
  return stage;
}

async function readDecision(input: Readable): Promise<"approve" | "abort"> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += buffer.length;
    if (length > 256) throw new Error("ACCEPTANCE_DECISION_TOO_LARGE");
    chunks.push(buffer);
  }
  const serialized = Buffer.concat(chunks).toString("utf8");
  const lines = serialized.endsWith("\n")
    ? serialized.slice(0, -1).split("\n")
    : serialized.split("\n");
  const line = lines[0];
  if (lines.length !== 1 || line === undefined || line.length === 0) {
    throw new Error("ACCEPTANCE_DECISION_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error("ACCEPTANCE_DECISION_INVALID");
  }
  if (!isPlainRecord(parsed) || Reflect.ownKeys(parsed).length !== 1) {
    throw new Error("ACCEPTANCE_DECISION_INVALID");
  }
  const decision = parsed["decision"];
  if (decision !== "approve" && decision !== "abort") {
    throw new Error("ACCEPTANCE_DECISION_INVALID");
  }
  return decision;
}

async function writeReceipt(output: Writable, result: AcceptanceReceipt): Promise<void> {
  const serialized = JSON.stringify(result);
  if (typeof serialized !== "string" || serialized.includes("\n")) {
    throw new Error("ACCEPTANCE_RECEIPT_INVALID");
  }
  if (!output.write(`${serialized}\n`, "utf8")) await once(output, "drain");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
