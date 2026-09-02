import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateBroadcastCandidate } from "../../src/daily-care/message-policy.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime-v2 Fix Round 9 hardening", () => {
  it("revalidates every nested named entry immediately before private-tree deletion", async () => {
    const source = await readFile("native/kernel-lock/kernel_lock.c", "utf8");
    expect(source).toContain("revalidate_named_entry_no_follow");
    expect(source.match(/revalidate_named_entry_no_follow\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(source).toMatch(/S_ISREG[\s\S]*revalidate_named_entry_no_follow[\s\S]*unlinkat/u);
    expect(source).toMatch(/S_ISLNK[\s\S]*revalidate_named_entry_no_follow[\s\S]*unlinkat/u);
    const directoryBranch = source.slice(source.indexOf("if (S_ISDIR(identity.st_mode))"));
    expect(directoryBranch.indexOf("unlinkat(directory_fd, entry->d_name, AT_REMOVEDIR)"))
      .toBeLessThan(directoryBranch.indexOf("close(child)"));
  });

  it("retains a real foreign nested-directory replacement during private-tree cleanup", {
    timeout: 60_000,
  }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "round9-private-tree-"));
    roots.push(root);
    const basename = "snapshot";
    const privateRoot = path.join(root, basename);
    const victim = path.join(privateRoot, "nested");
    const displaced = path.join(root, "owned-nested-displaced");
    const ready = path.join(root, "ready");
    const receipt = path.join(root, "receipt.json");
    await mkdir(victim, { recursive: true, mode: 0o700 });
    const fileCount = 30_000;
    for (let offset = 0; offset < fileCount; offset += 500) {
      await Promise.all(Array.from({ length: Math.min(500, fileCount - offset) }, (_, index) =>
        writeFile(path.join(victim, `f-${String(offset + index).padStart(6, "0")}`), "", {
          mode: 0o600,
        })
      ));
    }

    const child = spawnPrivateTreeWorker({ root, basename, ready, receipt });
    await waitForPath(ready);
    await waitForEntryCountBetween(victim, 2_000, fileCount - 1_000);
    await rename(victim, displaced);
    await mkdir(victim, { mode: 0o700 });
    const foreign = await lstat(victim);

    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    children.delete(child);
    const nativeReceipt = JSON.parse(await readFile(receipt, "utf8")) as unknown;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(nativeReceipt).toMatchObject({ ok: false });
    await expect(lstat(victim)).resolves.toMatchObject({ dev: foreign.dev, ino: foreign.ino });
  });

  it("rejects cross-script, digit-heavy and long multi-clause weather-null object advice", () => {
    for (const fragment of [
      "20W USB-C power bank已经放在玄关了，出门前记得带上",
      "AirPods Pro 2如果上午开会可能会用到，临走前别忘了拿好",
      "N95口罩虽然只是备用，但经过很长一段完全与天气无关的说明以后，还是建议戴好",
      "钥匙在桌上；即便今天有很多别的安排，也请在离开家门以前稳妥地携带",
    ]) {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: morningCandidate(fragment),
        weather: null,
        recentVerifiedTexts: [],
      }), fragment).toThrow("BROADCAST_FALLBACK_WEATHER_FORBIDDEN");
    }
    for (const fragment of ["把烦恼放一放", "放下心事", "带着好心情", "记得吃饭，也喝点温水"]) {
      expect(() => validateBroadcastCandidate({
        kind: "morning",
        text: morningCandidate(fragment),
        weather: null,
        recentVerifiedTexts: [],
      }), fragment).not.toThrow();
    }
  });

  it("matches bounded night facts by exact kind and subtype", () => {
    const unavailable = context("unavailable", [], []);
    const stomach = context("available", ["stated-discomfort"], ["今天胃有点不舒服"]);
    const head = context("available", ["stated-discomfort"], ["今天头有点疼"]);
    const fever = context("available", ["stated-discomfort"], ["今天发烧了"]);

    for (const claim of [
      "知道你今天发烧了",
      "知道你今天上了夜班",
      "知道你今天只吃了一顿饭",
    ]) {
      expect(() => validateBroadcastCandidate({
        kind: "night",
        text: nightCandidate(claim),
        weather: null,
        recentVerifiedTexts: [],
        sameDayCareContext: unavailable,
      } as never), claim).toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    }

    expect(() => validateBroadcastCandidate({
      kind: "night", text: nightCandidate("知道你今天头有点疼"), weather: null,
      recentVerifiedTexts: [], sameDayCareContext: stomach,
    } as never)).toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateBroadcastCandidate({
      kind: "night", text: nightCandidate("知道你今天胃不舒服是因为没吃午饭"), weather: null,
      recentVerifiedTexts: [], sameDayCareContext: stomach,
    } as never)).toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateBroadcastCandidate({
      kind: "night", text: nightCandidate("知道你今天头有点疼"), weather: null,
      recentVerifiedTexts: [], sameDayCareContext: head,
    } as never)).not.toThrow();
    expect(() => validateBroadcastCandidate({
      kind: "night", text: nightCandidate("知道你今天发烧了"), weather: null,
      recentVerifiedTexts: [], sameDayCareContext: fever,
    } as never)).not.toThrow();
  });
});

function morningCandidate(fragment: string): string {
  return `早呀，今日份的关心也准时送到啦。上班前先吃点东西，喝点温水，别空着肚子忙起来。${fragment}，给自己留一点从容，愿你今天顺顺利利，也记得照顾好身体。☀️💛\n——示例用户`;
}

function nightCandidate(claim: string): string {
  return `想认真和你说声晚安。${claim}，希望这会儿能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应什么。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙\n——示例用户`;
}

function context(
  availability: "available" | "unavailable",
  explicitSignals: readonly string[],
  safeExcerpts: readonly string[],
) {
  return {
    localDate: "2026-08-27",
    availability,
    explicitSignals,
    safeExcerpts,
    proofHash: "9".repeat(64),
  } as const;
}

function spawnPrivateTreeWorker(input: {
  root: string;
  basename: string;
  ready: string;
  receipt: string;
}): ChildProcess {
  const child = spawn(process.execPath, [
    path.resolve("tests/fixtures/runtime-v2-round9-private-tree-worker.mjs"),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUNTIME_V2_ROUND9_PRIVATE_TREE_WORKER: "1",
      RUNTIME_V2_ROUND9_PRIVATE_PARENT: input.root,
      RUNTIME_V2_ROUND9_PRIVATE_BASENAME: input.basename,
      RUNTIME_V2_ROUND9_PRIVATE_READY: input.ready,
      RUNTIME_V2_ROUND9_PRIVATE_RECEIPT: input.receipt,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function waitForPath(target: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(target);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error("ROUND9_WORKER_READY_TIMEOUT");
}

async function waitForEntryCountBetween(
  directory: string,
  minimum: number,
  maximum: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = (await readdir(directory)).length;
    if (count >= minimum && count <= maximum) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("ROUND9_PRIVATE_TREE_PROGRESS_TIMEOUT");
}
