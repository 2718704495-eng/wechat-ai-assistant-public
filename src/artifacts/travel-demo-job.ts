import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { ChatMessage } from "../domain/types.js";
import type { EncryptedStore } from "../storage/encrypted-store.js";
import { analyzeArtifactTurn } from "./artifact-intent.js";

const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeDestinationSchema = z.string().trim().min(1).max(80);
const supportedDaysSchema = z.number().int().min(1).max(30);
const fileMetadataSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: hex64Schema,
}).strict();

export const travelDemoManifestSchema = z.object({
  version: z.literal(1),
  jobId: hex64Schema,
  triggerMessageIdHash: hex64Schema,
  inputHash: hex64Schema,
  factsStatus: z.literal("unverified"),
  generatedAt: z.iso.datetime({ offset: true }),
  files: z.object({ "index.html": fileMetadataSchema }).strict(),
  delivery: z.object({
    status: z.literal("blocked"),
    code: z.literal("NATIVE_FILE_ATTACHMENT_UNAVAILABLE"),
  }).strict(),
}).strict();

const travelDemoJobStateSchema = z.object({
  version: z.literal(1),
  jobId: hex64Schema,
  triggerMessageIdHash: hex64Schema,
  inputHash: hex64Schema,
  destination: safeDestinationSchema,
  days: supportedDaysSchema,
  status: z.enum(["claimed", "delivery-blocked"]),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  manifestSha256: hex64Schema.nullable(),
  deliveryCode: z.literal("NATIVE_FILE_ATTACHMENT_UNAVAILABLE"),
}).strict();

const jobInputSchema = z.object({
  conversationId: z.literal("example-contact"),
  triggerId: hex64Schema,
  triggerMessageId: z.string().min(1).max(512),
  latestMessage: z.object({
    id: z.string().min(1).max(512),
    conversationId: z.literal("example-contact"),
    direction: z.enum(["incoming", "outgoing"]),
    kind: z.enum(["text", "emoji", "link", "image-ocr", "voice-transcript"]),
    text: z.string().max(4_000),
    occurredAt: z.string().min(1),
    source: z.enum(["wechat", "douyin"]),
    confidence: z.number().min(0).max(1),
  }).strict(),
}).strict();

type TravelDemoManifest = z.infer<typeof travelDemoManifestSchema>;
type TravelDemoJobState = z.infer<typeof travelDemoJobStateSchema>;

export type TravelDemoJobResult =
  | { kind: "not-applicable"; reason: "LATEST_NOT_INCOMING" | "NOT_A_TRAVEL_REQUEST" | "TRAVEL_REQUEST_INCOMPLETE" }
  | {
    kind: "artifact";
    jobId: string;
    status: "delivery-blocked";
    deliveryCode: "NATIVE_FILE_ATTACHMENT_UNAVAILABLE";
    manifest: TravelDemoManifest;
    manifestSha256: string;
  };

export interface TravelDemoJobInput {
  conversationId: "example-contact";
  triggerId: string;
  triggerMessageId: string;
  latestMessage: ChatMessage;
}

interface TravelDemoJobRunnerOptions {
  dataDir: string;
  store: EncryptedStore;
  now?: () => Date;
}

const indexFilename = "index.html";
const manifestFilename = "manifest.json";
const artifactFilenames = [indexFilename, manifestFilename] as const;
const deliveryCode = "NATIVE_FILE_ATTACHMENT_UNAVAILABLE" as const;

export class TravelDemoJobRunner {
  private readonly dataDir: string;
  private readonly artifactRoot: string;
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: TravelDemoJobRunnerOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.artifactRoot = path.join(this.dataDir, "artifacts", "travel-demo");
    this.now = options.now ?? (() => new Date());
  }

  public run(input: TravelDemoJobInput): Promise<TravelDemoJobResult> {
    const operation = this.tail.then(
      () => this.runInternal(input),
      () => this.runInternal(input),
    );
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async runInternal(inputValue: TravelDemoJobInput): Promise<TravelDemoJobResult> {
    const input = jobInputSchema.parse(inputValue);
    if (input.latestMessage.direction !== "incoming") {
      return { kind: "not-applicable", reason: "LATEST_NOT_INCOMING" };
    }
    if (input.latestMessage.id !== input.triggerMessageId) {
      throw new Error("TRAVEL_DEMO_TRIGGER_MISMATCH");
    }

    const analysis = analyzeArtifactTurn(input.latestMessage.text);
    if (analysis.intent?.kind !== "travel-guide") {
      return { kind: "not-applicable", reason: "NOT_A_TRAVEL_REQUEST" };
    }
    const destinationResult = safeDestinationSchema.safeParse(analysis.fields?.destination);
    const daysResult = supportedDaysSchema.safeParse(analysis.fields?.days);
    if (!destinationResult.success || !daysResult.success) {
      return { kind: "not-applicable", reason: "TRAVEL_REQUEST_INCOMPLETE" };
    }

    const destination = destinationResult.data;
    const days = daysResult.data;
    const jobId = sha256(`travel-demo-v1\0${input.triggerId}\0${input.triggerMessageId}`);
    const triggerMessageIdHash = sha256(input.triggerMessageId);
    const inputHash = sha256(JSON.stringify({ destination, days }));
    const statePath = `state/travel-demo/jobs/${jobId}.enc`;
    const existingState = await this.options.store.read(statePath, travelDemoJobStateSchema);
    assertSameJob(existingState, { jobId, triggerMessageIdHash, inputHash, destination, days });

    const timestamp = this.now().toISOString();
    const claimedState: TravelDemoJobState = existingState ?? {
      version: 1,
      jobId,
      triggerMessageIdHash,
      inputHash,
      destination,
      days,
      status: "claimed",
      createdAt: timestamp,
      updatedAt: timestamp,
      manifestSha256: null,
      deliveryCode,
    };
    if (existingState === null) {
      await this.options.store.write(statePath, claimedState);
    }

    await ensureSafeDirectoryTree(this.dataDir, ["artifacts", "travel-demo"]);
    const finalDirectory = resolveTravelDemoArtifactDirectory(this.dataDir, jobId);
    const existingArtifact = await validateIfPresent(finalDirectory, {
      jobId,
      triggerMessageIdHash,
      inputHash,
    });
    const validated = existingArtifact ?? await this.renderAndPublish({
      jobId,
      triggerMessageIdHash,
      inputHash,
      destination,
      days,
      generatedAt: claimedState.createdAt,
      finalDirectory,
    });
    if (
      existingState?.manifestSha256 !== null
      && existingState?.manifestSha256 !== undefined
      && existingState.manifestSha256 !== validated.manifestSha256
    ) {
      throw new Error("TRAVEL_DEMO_ARTIFACT_TAMPERED");
    }

    const completedState: TravelDemoJobState = {
      ...claimedState,
      status: "delivery-blocked",
      createdAt: validated.manifest.generatedAt,
      updatedAt: timestamp,
      manifestSha256: validated.manifestSha256,
    };
    if (
      existingState?.status !== completedState.status
      || existingState.manifestSha256 !== completedState.manifestSha256
    ) {
      await this.options.store.write(statePath, completedState);
    }

    return {
      kind: "artifact",
      jobId,
      status: "delivery-blocked",
      deliveryCode,
      manifest: validated.manifest,
      manifestSha256: validated.manifestSha256,
    };
  }

  private async renderAndPublish(input: {
    jobId: string;
    triggerMessageIdHash: string;
    inputHash: string;
    destination: string;
    days: number;
    generatedAt: string;
    finalDirectory: string;
  }): Promise<{ manifest: TravelDemoManifest; manifestSha256: string }> {
    const stagingDirectory = path.join(
      this.artifactRoot,
      `.staging-${input.jobId}-${randomUUID()}`,
    );
    await mkdir(stagingDirectory, { mode: 0o700 });
    try {
      const html = renderTravelDemoHtml(input.destination, input.days);
      validateOfflineHtml(html);
      const htmlBytes = Buffer.byteLength(html, "utf8");
      const manifest = travelDemoManifestSchema.parse({
        version: 1,
        jobId: input.jobId,
        triggerMessageIdHash: input.triggerMessageIdHash,
        inputHash: input.inputHash,
        factsStatus: "unverified",
        generatedAt: input.generatedAt,
        files: {
          [indexFilename]: { bytes: htmlBytes, sha256: sha256(html) },
        },
        delivery: { status: "blocked", code: deliveryCode },
      });
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeDurableFile(path.join(stagingDirectory, indexFilename), html);
      await writeDurableFile(path.join(stagingDirectory, manifestFilename), manifestText);
      await Promise.all([
        chmod(path.join(stagingDirectory, indexFilename), 0o400),
        chmod(path.join(stagingDirectory, manifestFilename), 0o400),
      ]);
      await syncDirectory(stagingDirectory);
      await validateArtifactDirectory(stagingDirectory, {
        jobId: input.jobId,
        triggerMessageIdHash: input.triggerMessageIdHash,
        inputHash: input.inputHash,
      }, 0o700);
      try {
        await rename(stagingDirectory, input.finalDirectory);
      } catch (error: unknown) {
        if (!isNodeError(error) || !["EACCES", "EEXIST", "ENOTEMPTY"].includes(error.code ?? "")) {
          throw error;
        }
        const concurrent = await waitForPublishedArtifact(input.finalDirectory, {
          jobId: input.jobId,
          triggerMessageIdHash: input.triggerMessageIdHash,
          inputHash: input.inputHash,
        });
        await makeOwnedStagingWritable(stagingDirectory);
        await rm(stagingDirectory, { recursive: true, force: true });
        return concurrent;
      }
      await chmod(input.finalDirectory, 0o500);
      await syncDirectory(input.finalDirectory);
      await syncDirectory(this.artifactRoot);
      return await validateArtifactDirectory(input.finalDirectory, {
        jobId: input.jobId,
        triggerMessageIdHash: input.triggerMessageIdHash,
        inputHash: input.inputHash,
      });
    } catch (error: unknown) {
      await makeOwnedStagingWritable(stagingDirectory).catch(() => undefined);
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function resolveTravelDemoArtifactDirectory(dataDir: string, jobId: string): string {
  const parsedJobId = hex64Schema.safeParse(jobId);
  if (!parsedJobId.success) throw new Error("TRAVEL_DEMO_JOB_ID_INVALID");
  const root = path.resolve(dataDir, "artifacts", "travel-demo");
  const resolved = path.resolve(root, parsedJobId.data);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("TRAVEL_DEMO_PATH_OUTSIDE_ROOT");
  }
  return resolved;
}

function renderTravelDemoHtml(destination: string, days: number): string {
  const safeDestination = escapeHtml(destination);
  const daySections = Array.from({ length: days }, (_unused, index) => `
      <section class="day">
        <h2>第 ${index + 1} 天</h2>
        <p>按体力安排一段主要活动，并预留交通、吃饭和休息时间。</p>
        <p class="unverified">待核实：具体地点、开放时间、预约规则、交通方式和费用。</p>
      </section>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeDestination}${days}天旅行规划 Demo</title>
  <style>
    body { max-width: 760px; margin: 0 auto; padding: 32px 20px; color: #243027; background: #f6f4ec; font: 16px/1.7 system-ui, sans-serif; }
    main { background: #fff; border-radius: 20px; padding: 28px; box-shadow: 0 8px 28px rgba(26, 48, 35, .08); }
    h1, h2 { line-height: 1.25; }
    .notice, .unverified { color: #765c20; background: #fff6d8; border-radius: 10px; padding: 10px 12px; }
    .day { border-top: 1px solid #dfe6df; margin-top: 22px; padding-top: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>${safeDestination}${days}天旅行规划 Demo</h1>
    <p class="notice"><strong>事实状态：待核实。</strong> 本页未联网查询，请在出发前核实地点、营业、预约、交通、天气和费用。</p>${daySections}
    <section class="day">
      <h2>出发前清单</h2>
      <p>确认身份证件、住宿、往返交通、天气、常用药和紧急联系人；所有目的地事实均待核实。</p>
    </section>
  </main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateOfflineHtml(html: string): void {
  const disallowed = [
    /<\s*(?:script|iframe|object|embed|base|form)\b/iu,
    /<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/iu,
    /<\s*a\b[^>]*href\s*=/iu,
    /<\s*(?:link|img|audio|video|source)\b[^>]*(?:src|href)\s*=/iu,
    /<[^>]+\son[a-z]+\s*=/iu,
    /javascript\s*:/iu,
    /@import\b/iu,
    /url\s*\(/iu,
  ];
  if (disallowed.some((pattern) => pattern.test(html)) || !html.includes("待核实")) {
    throw new Error("TRAVEL_DEMO_HTML_POLICY_VIOLATION");
  }
}

async function validateIfPresent(
  directory: string,
  expected: { jobId: string; triggerMessageIdHash: string; inputHash: string },
): Promise<{ manifest: TravelDemoManifest; manifestSha256: string } | null> {
  try {
    await lstat(directory);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  return validateArtifactDirectory(directory, expected);
}

async function waitForPublishedArtifact(
  directory: string,
  expected: { jobId: string; triggerMessageIdHash: string; inputHash: string },
): Promise<{ manifest: TravelDemoManifest; manifestSha256: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await validateArtifactDirectory(directory, expected);
    } catch (error: unknown) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("TRAVEL_DEMO_ARTIFACT_TAMPERED", { cause: lastError });
}

async function validateArtifactDirectory(
  directory: string,
  expected: { jobId: string; triggerMessageIdHash: string; inputHash: string },
  expectedDirectoryMode = 0o500,
): Promise<{ manifest: TravelDemoManifest; manifestSha256: string }> {
  try {
    const directoryIdentity = await lstat(directory);
    if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink() ||
        (directoryIdentity.mode & 0o777) !== expectedDirectoryMode) {
      throw new Error("TRAVEL_DEMO_ARTIFACT_TAMPERED");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    if (
      entries.length !== artifactFilenames.length
      || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
      || entries.map((entry) => entry.name).sort().join("\0") !== [...artifactFilenames].sort().join("\0")
    ) {
      throw new Error("TRAVEL_DEMO_ARTIFACT_TAMPERED");
    }
    const [htmlIdentity, manifestIdentity, html, manifestText] = await Promise.all([
      lstat(path.join(directory, indexFilename)),
      lstat(path.join(directory, manifestFilename)),
      readFile(path.join(directory, indexFilename), "utf8"),
      readFile(path.join(directory, manifestFilename), "utf8"),
    ]);
    if (
      !htmlIdentity.isFile() || htmlIdentity.isSymbolicLink()
      || !manifestIdentity.isFile() || manifestIdentity.isSymbolicLink()
      || (htmlIdentity.mode & 0o777) !== 0o400
      || (manifestIdentity.mode & 0o777) !== 0o400
    ) {
      throw new Error("TRAVEL_DEMO_ARTIFACT_TAMPERED");
    }
    validateOfflineHtml(html);
    const manifest = travelDemoManifestSchema.parse(JSON.parse(manifestText));
    if (
      manifest.jobId !== expected.jobId
      || manifest.triggerMessageIdHash !== expected.triggerMessageIdHash
      || manifest.inputHash !== expected.inputHash
      || manifest.files[indexFilename].bytes !== Buffer.byteLength(html, "utf8")
      || manifest.files[indexFilename].sha256 !== sha256(html)
    ) {
      throw new Error("TRAVEL_DEMO_ARTIFACT_TAMPERED");
    }
    return { manifest, manifestSha256: sha256(manifestText) };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "TRAVEL_DEMO_ARTIFACT_TAMPERED") {
      throw error;
    }
    throw new Error("TRAVEL_DEMO_ARTIFACT_TAMPERED", { cause: error });
  }
}

async function ensureSafeDirectoryTree(dataDir: string, segments: string[]): Promise<void> {
  let current = path.resolve(dataDir);
  await assertSafeDirectory(current);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    await assertSafeDirectory(current);
  }
}

async function assertSafeDirectory(directory: string): Promise<void> {
  try {
    const identity = await lstat(directory);
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new Error("TRAVEL_DEMO_UNSAFE_FILESYSTEM");
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "TRAVEL_DEMO_UNSAFE_FILESYSTEM") throw error;
    throw new Error("TRAVEL_DEMO_UNSAFE_FILESYSTEM", { cause: error });
  }
}

async function makeOwnedStagingWritable(stagingDirectory: string): Promise<void> {
  const identity = await lstat(stagingDirectory);
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("TRAVEL_DEMO_UNSAFE_FILESYSTEM");
  }
  await chmod(stagingDirectory, 0o700);
  await Promise.all(artifactFilenames.map(async (filename) => {
    const file = path.join(stagingDirectory, filename);
    try {
      const fileIdentity = await lstat(file);
      if (!fileIdentity.isFile() || fileIdentity.isSymbolicLink()) {
        throw new Error("TRAVEL_DEMO_UNSAFE_FILESYSTEM");
      }
      await chmod(file, 0o600);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }));
}

async function writeDurableFile(file: string, content: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertSameJob(
  state: TravelDemoJobState | null,
  expected: Pick<TravelDemoJobState, "jobId" | "triggerMessageIdHash" | "inputHash" | "destination" | "days">,
): void {
  if (state === null) return;
  if (
    state.jobId !== expected.jobId
    || state.triggerMessageIdHash !== expected.triggerMessageIdHash
    || state.inputHash !== expected.inputHash
    || state.destination !== expected.destination
    || state.days !== expected.days
  ) {
    throw new Error("TRAVEL_DEMO_JOB_CONFLICT");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
