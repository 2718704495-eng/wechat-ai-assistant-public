import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import type { RuntimeActivationService } from "./runtime-activation.js";

export async function runRuntimeActivationCli(options: {
  readonly argv: readonly string[];
  readonly input: Readable;
  readonly output: Writable;
  readonly service: RuntimeActivationService;
}): Promise<unknown> {
  const stage = parseStage(options.argv);
  let receipt: unknown;
  if (stage === "prepare-report") {
    const result = await options.service.prepareReport();
    receipt = { stage, status: "prepared", reportHash: result.hash };
  } else if (stage === "approve-report") {
    const input = await readExactInput(options.input, ["reportHash"]);
    const reportHash = requireSha256(input["reportHash"]);
    await options.service.approveReport(reportHash);
    receipt = { stage, status: "approved", reportHash };
  } else if (stage === "boundary") {
    await options.service.establishBoundary();
    receipt = { stage, status: "verified" };
  } else if (stage === "A") {
    receipt = await options.service.runA();
  } else if (stage === "B0") {
    receipt = await options.service.runB0();
  } else if (stage === "B1") {
    const input = await readExactInput(options.input, ["decision"]);
    const decision = requireDecision(input["decision"]);
    receipt = await options.service.runB1(decision);
  } else if (stage === "finalize") {
    const input = await readExactInput(options.input, ["decision", "reportHash"]);
    const decision = requireDecision(input["decision"]);
    const reportHash = requireSha256(input["reportHash"]);
    receipt = await options.service.finalize({ decision, reportHash });
  } else if (stage === "accept-card") {
    receipt = await options.service.acceptComfortStationCard();
  } else if (stage === "recover-image-quarantine") {
    receipt = await options.service.recoverImageAttachmentQuarantine();
  } else {
    receipt = { stage, status: "inspected", ...(await options.service.inspect()) };
  }
  await writeReceipt(options.output, receipt);
  return receipt;
}

function parseStage(argv: readonly string[]):
  "prepare-report" | "approve-report" | "boundary" | "A" | "B0" | "B1" |
  "finalize" | "recover-image-quarantine" | "accept-card" | "inspect" {
  const stage = argv[1];
  if (argv.length !== 2 || argv[0] !== "--stage" || ![
    "prepare-report", "approve-report", "boundary", "A", "B0", "B1", "finalize",
    "recover-image-quarantine", "accept-card", "inspect",
  ].includes(stage ?? "")) {
    throw new Error("ACTIVATION_ARGUMENTS_INVALID");
  }
  return stage as ReturnType<typeof parseStage>;
}

async function readExactInput(
  input: Readable,
  exactKeys: string[],
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > 256) throw new Error("ACTIVATION_INPUT_TOO_LARGE");
    chunks.push(buffer);
  }
  const serialized = Buffer.concat(chunks).toString("utf8");
  if (!serialized.endsWith("\n") || serialized.slice(0, -1).includes("\n")) {
    throw new Error("ACTIVATION_INPUT_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized.slice(0, -1)) as unknown;
  } catch {
    throw new Error("ACTIVATION_INPUT_INVALID");
  }
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !==
      [...exactKeys].sort().join("\0")) {
    throw new Error("ACTIVATION_INPUT_INVALID");
  }
  return value;
}

function requireDecision(value: unknown): "approve" | "abort" {
  if (value !== "approve" && value !== "abort") throw new Error("ACTIVATION_INPUT_INVALID");
  return value;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("ACTIVATION_INPUT_INVALID");
  }
  return value;
}

async function writeReceipt(output: Writable, receipt: unknown): Promise<void> {
  const serialized = JSON.stringify(receipt);
  if (serialized.length > 4_096 || serialized.includes("\n")) {
    throw new Error("ACTIVATION_RECEIPT_INVALID");
  }
  if (!output.write(`${serialized}\n`, "utf8")) await once(output, "drain");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
