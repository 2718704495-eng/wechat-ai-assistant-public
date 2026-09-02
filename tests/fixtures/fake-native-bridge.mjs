import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scenario = process.env.FAKE_BRIDGE_SCENARIO ?? "success";
const arguments_ = process.argv.slice(2);
const command = arguments_[0];

let stdin = Buffer.alloc(0);
if (command === "write-command") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  stdin = Buffer.concat(chunks);
}

let framedRequest = null;
if (stdin.length >= 4) {
  const declaredLength = stdin.readUInt32BE(0);
  if (declaredLength === stdin.length - 4) {
    try { framedRequest = JSON.parse(stdin.subarray(4).toString("utf8")); } catch { framedRequest = null; }
  }
}
const sensitiveValues = framedRequest === null
  ? []
  : Object.values(framedRequest.payload ?? {}).filter((value) => typeof value === "string" && value.length > 0);

if (process.env.FAKE_BRIDGE_ARGS_PATH !== undefined) {
  await writeFile(process.env.FAKE_BRIDGE_ARGS_PATH, JSON.stringify({
    arguments: arguments_,
    stdinBase64: stdin.toString("base64"),
    sensitiveEnvironmentMatches: Object.values(process.env)
      .filter((value) => sensitiveValues.includes(value)).length,
  }));
}

if (scenario === "hang") {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
if (scenario === "nonzero") {
  process.stderr.write("synthetic bridge failure\n");
  process.exit(7);
}
if (scenario === "invalid-json") {
  process.stdout.write("not-json\n");
  process.exit(0);
}

if (command === "list-windows") {
  process.stdout.write(
    `${JSON.stringify([
      {
        windowID: 42,
        processID: 100,
        bundleID: "com.tencent.xinWeChat",
        title: "微信",
        ownerName: "WeChat",
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
      },
    ])}\n`,
  );
} else if (command === "capture") {
  const outputIndex = arguments_.indexOf("--output");
  const output = arguments_[outputIndex + 1];
  if (typeof output !== "string") process.exit(64);
  await writeFile(output, "synthetic-png");
  process.stdout.write(`${JSON.stringify({ output })}\n`);
} else if (command === "ocr") {
  if (scenario === "ocr-failure") process.exit(9);
  process.stdout.write(
    `${JSON.stringify([
      {
        text: "示例联系人",
        confidence: 0.99,
        bounds: { x: 0.1, y: 0.9, width: 0.2, height: 0.1 },
      },
    ])}\n`,
  );
} else if (command === "diagnose-permissions") {
  process.stdout.write(
    `${JSON.stringify({
      accessibility: scenario !== "missing-accessibility",
      screenRecording: scenario !== "missing-screen-recording",
    })}\n`,
  );
} else if (command === "read-focused-text") {
  process.stdout.write(`${JSON.stringify({ text: "synthetic-draft" })}\n`);
} else if (command === "write-command") {
  const textMutation = framedRequest?.command === "type-text"
    ? framedRequest.payload
    : null;
  const imageAttachment = framedRequest?.command === "attach-wechat-image"
    ? framedRequest.payload
    : null;
  const imageSend = framedRequest?.command === "send-wechat-image"
    ? framedRequest.payload
    : null;
  const imageRecovery = framedRequest?.command === "recover-wechat-image-quarantine"
    ? framedRequest.payload
    : null;
  const imageMutation = imageAttachment ?? imageSend;
  if (imageMutation !== null) {
    const receiptRoot = path.join(
      process.env.TMPDIR ?? os.tmpdir(),
      "wechat-ai-assistant-public-image-capabilities-v1",
    );
    await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
    const receiptName = `capability-${createHash("sha256")
      .update(`image-attachment-capability-id-v1\0${imageMutation.capability.capabilityId}`)
      .digest("hex")}`;
    let receiptHandle;
    try {
      receiptHandle = await open(path.join(receiptRoot, receiptName), "wx", 0o600);
      await receiptHandle.writeFile("consumed\n", "utf8");
      await receiptHandle.sync();
    } catch (error) {
      if (error?.code === "EEXIST") process.exit(11);
      throw error;
    } finally {
      await receiptHandle?.close();
    }
    if (scenario === "attach-after-consume-failure") process.exit(12);
  }
  const response = Buffer.from(`${JSON.stringify(imageRecovery !== null
    ? {
        status: "recovered",
        archiveName: `dirty-archive-${"a".repeat(64)}`,
        composerEmpty: true,
      }
    : textMutation === null
    ? imageMutation === null
      ? { ok: true }
      : {
          imageSha256: imageMutation.imageSha256,
          width: 1080,
          height: 1350,
          attachmentCount: 1,
          textEmpty: true,
          ...(imageSend === null ? {} : {
            submitted: true,
            outgoingImageMatched: true,
            visualFingerprintVersion: "vision-featureprint-v1",
          }),
        }
    : {
        text: textMutation.text,
        cleared: textMutation.capability?.action === "clear-draft",
      })}\n`, "utf8");
  try {
    const responseChannel = createWriteStream("/dev/null", { fd: 3, autoClose: false });
    responseChannel.write(response);
    responseChannel.end();
  } catch {
    process.stdout.write(response);
  }
} else {
  process.stdout.write('{"ok":true}\n');
}
