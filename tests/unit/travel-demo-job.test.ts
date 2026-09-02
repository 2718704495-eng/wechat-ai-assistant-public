import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveTravelDemoArtifactDirectory,
  TravelDemoJobRunner,
} from "../../src/artifacts/travel-demo-job.js";
import type { ChatMessage } from "../../src/domain/types.js";
import type { KeyProvider } from "../../src/security/keychain.js";
import { EncryptedStore } from "../../src/storage/encrypted-store.js";

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}
  public getOrCreate(): Promise<Buffer> { return Promise.resolve(Buffer.from(this.key)); }
}

describe("travel Demo durable job", () => {
  let rootDir: string;
  let store: EncryptedStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "travel-demo-"));
    store = new EncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32)));
  });

  afterEach(async () => {
    await makeTreeWritable(rootDir);
    await rm(rootDir, { recursive: true, force: true });
  });

  it("renders one offline validated artifact and escapes hostile destination text", async () => {
    const runner = createRunner();

    const result = await runner.run(jobInput(
      "帮我做一份<script>alert(1)</script>三天旅行攻略",
    ));

    if (result.kind !== "artifact") throw new Error("EXPECTED_ARTIFACT");
    expect(result.status).toBe("delivery-blocked");
    expect(result.deliveryCode).toBe("NATIVE_FILE_ATTACHMENT_UNAVAILABLE");
    expect(result.manifest.version).toBe(1);
    expect(result.manifest.factsStatus).toBe("unverified");
    expect(result.manifest.files["index.html"].bytes).toBeGreaterThan(0);
    expect(result.manifest.files["index.html"].sha256).toMatch(/^[a-f0-9]{64}$/u);
    const artifactDirectory = resolveTravelDemoArtifactDirectory(rootDir, result.jobId);
    expect((await readdir(artifactDirectory)).sort()).toEqual(["index.html", "manifest.json"]);
    const html = await readFile(path.join(artifactDirectory, "index.html"), "utf8");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("待核实");
    expect(html).not.toMatch(/<script|<iframe|javascript:|\son[a-z]+\s*=/iu);
    expect((await lstat(path.join(artifactDirectory, "index.html"))).isFile()).toBe(true);
  });

  it("does not claim a job for ordinary, incomplete, outgoing, or trigger-mismatched input", async () => {
    const runner = createRunner();

    await expect(runner.run(jobInput("今天辛苦了"))).resolves.toEqual({
      kind: "not-applicable",
      reason: "NOT_A_TRAVEL_REQUEST",
    });
    await expect(runner.run(jobInput("帮我做一份示例城市旅行攻略"))).resolves.toEqual({
      kind: "not-applicable",
      reason: "TRAVEL_REQUEST_INCOMPLETE",
    });
    await expect(runner.run({
      ...jobInput("帮我做一份示例城市三天旅行攻略"),
      latestMessage: { ...incoming("帮我做一份示例城市三天旅行攻略"), direction: "outgoing" },
    })).resolves.toEqual({ kind: "not-applicable", reason: "LATEST_NOT_INCOMING" });
    await expect(runner.run({
      ...jobInput("帮我做一份示例城市三天旅行攻略"),
      triggerMessageId: "f".repeat(64),
    })).rejects.toThrow("TRAVEL_DEMO_TRIGGER_MISMATCH");
    await expect(lstat(path.join(rootDir, "artifacts", "travel-demo")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses one immutable job across retries and fails closed after tampering", async () => {
    const runner = createRunner();
    const input = jobInput("帮我做一份示例城市三天旅行攻略");

    const [first, second] = await Promise.all([runner.run(input), createRunner().run(input)]);

    expect(first).toEqual(second);
    if (first.kind !== "artifact") throw new Error("EXPECTED_ARTIFACT");
    const artifactRoot = path.join(rootDir, "artifacts", "travel-demo");
    expect((await readdir(artifactRoot)).filter((name) => !name.startsWith(".")))
      .toEqual([first.jobId]);
    await chmod(path.join(artifactRoot, first.jobId, "index.html"), 0o600);
    await writeFile(path.join(artifactRoot, first.jobId, "index.html"), "tampered", { mode: 0o400 });
    await expect(runner.run(input)).rejects.toThrow("TRAVEL_DEMO_ARTIFACT_TAMPERED");
  });

  it("does not replace the durable manifest trust anchor after paired file tampering", async () => {
    const runner = createRunner();
    const input = jobInput("帮我做一份示例城市三天旅行攻略");
    const first = await runner.run(input);
    if (first.kind !== "artifact") throw new Error("EXPECTED_ARTIFACT");
    const artifactDirectory = resolveTravelDemoArtifactDirectory(rootDir, first.jobId);
    const htmlPath = path.join(artifactDirectory, "index.html");
    const manifestPath = path.join(artifactDirectory, "manifest.json");
    await chmod(artifactDirectory, 0o700);
    await Promise.all([chmod(htmlPath, 0o600), chmod(manifestPath, 0o600)]);
    const forgedHtml = "<!doctype html><html><body>伪造内容，待核实</body></html>\n";
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: { "index.html": { bytes: number; sha256: string } };
    };
    manifest.files["index.html"] = {
      bytes: Buffer.byteLength(forgedHtml, "utf8"),
      sha256: createHash("sha256").update(forgedHtml).digest("hex"),
    };
    await Promise.all([
      writeFile(htmlPath, forgedHtml),
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    ]);
    await Promise.all([chmod(htmlPath, 0o400), chmod(manifestPath, 0o400)]);
    await chmod(artifactDirectory, 0o500);

    await expect(runner.run(input)).rejects.toThrow("TRAVEL_DEMO_ARTIFACT_TAMPERED");
  });

  it("rejects path traversal and symlinked artifact roots", async () => {
    expect(() => resolveTravelDemoArtifactDirectory(rootDir, "../escape"))
      .toThrow("TRAVEL_DEMO_JOB_ID_INVALID");
    const outside = path.join(rootDir, "outside");
    await mkdir(outside);
    await mkdir(path.join(rootDir, "artifacts"));
    await symlink(outside, path.join(rootDir, "artifacts", "travel-demo"));

    await expect(createRunner().run(jobInput("帮我做一份示例城市三天旅行攻略")))
      .rejects.toThrow("TRAVEL_DEMO_UNSAFE_FILESYSTEM");
  });

  function createRunner(): TravelDemoJobRunner {
    return new TravelDemoJobRunner({
      dataDir: rootDir,
      store,
      now: () => new Date("2026-08-24T15:00:00+08:00"),
    });
  }
});

function jobInput(text: string) {
  const latestMessage = incoming(text);
  return {
    conversationId: "example-contact" as const,
    triggerId: "a".repeat(64),
    triggerMessageId: latestMessage.id,
    latestMessage,
  };
}

function incoming(text: string): ChatMessage {
  return {
    id: "b".repeat(64),
    conversationId: "example-contact",
    direction: "incoming",
    kind: "text",
    text,
    occurredAt: "2026-08-24T06:59:00.000Z",
    source: "wechat",
    confidence: 0.99,
  };
}

async function makeTreeWritable(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await chmod(directory, 0o700);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeTreeWritable(target);
    } else if (!entry.isSymbolicLink()) {
      await chmod(target, 0o600);
    }
  }
}
