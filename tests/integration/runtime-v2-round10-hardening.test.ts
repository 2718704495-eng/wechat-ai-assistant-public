import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
import { closeSync, constants, openSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { validateBroadcastCandidate } from "../../src/daily-care/message-policy.js";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const roots: string[] = [];
const children = new Set<ChildProcess>();
let testAddonRoot = "";
let testAddonPath = "";

beforeAll(async () => {
  testAddonRoot = await mkdtemp(path.join(os.tmpdir(), "round10-kernel-addon-"));
  testAddonPath = path.join(testAddonRoot, "kernel_lock_test.node");
  const headers = path.resolve(path.dirname(process.execPath), "..", "include", "node");
  await execFileAsync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-fPIC",
    ...(process.platform === "darwin"
      ? ["-dynamiclib", "-undefined", "dynamic_lookup"]
      : ["-shared"]),
    "-DKERNEL_LOCK_TEST_INTERLOCK=1",
    `-I${headers}`,
    path.join(projectRoot, "native/kernel-lock/kernel_lock.c"),
    "-o", testAddonPath,
  ]);
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(async () => {
  if (testAddonRoot !== "") await rm(testAddonRoot, { recursive: true, force: true });
});

describe("runtime-v2 Fix Round 10 hardening", () => {
  it("creates and captures a private snapshot through one fd-bound Native operation", async () => {
    const source = await readFile("scripts/runtime-v2-clean-install.mjs", "utf8");
    expect(source).not.toMatch(/\bmkdtemp\(/u);
    expect(source).toContain("createPrivateDirectoryAtNoReplace");

    const addon = loadProductionAddon() as {
      createPrivateDirectoryAtNoReplace(
        parentFd: number,
        name: string,
        mode: number,
      ): { ok: boolean; fd: number; dev: number; ino: number; uid: number; name: string };
      closeFd(fd: number): { ok: boolean };
      removePrivateTreeAtExpected(
        parentFd: number, name: string, dev: number, ino: number, uid: number,
      ): { ok: boolean };
    };
    expect(typeof addon.createPrivateDirectoryAtNoReplace).toBe("function");
    const parent = await mkdtemp(path.join(os.tmpdir(), "round10-atomic-snapshot-"));
    roots.push(parent);
    const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const created = addon.createPrivateDirectoryAtNoReplace(
        parentFd,
        `wechat-runtime-v2-candidate-${randomUUID()}`,
        0o700,
      );
      expect(created.ok).toBe(true);
      const snapshot = path.join(parent, created.name);
      const displaced = `${snapshot}.owned-displaced`;
      await rename(snapshot, displaced);
      await mkdir(snapshot, { mode: 0o700 });
      const foreign = await lstat(snapshot);
      expect(addon.removePrivateTreeAtExpected(
        parentFd, created.name, created.dev, created.ino, created.uid,
      ).ok).toBe(false);
      await expect(lstat(snapshot)).resolves.toMatchObject({ dev: foreign.dev, ino: foreign.ino });
      expect(addon.closeFd(created.fd).ok).toBe(true);
    } finally {
      closeSync(parentFd);
    }
  });

  it("records every successful fd-backed materialization open before later work can throw", async () => {
    const source = await readFile("scripts/runtime-v2-payload-container.mjs", "utf8");
    expect(source).toMatch(
      /const child\s*=\s*bindOpenedDirectory\(opened, input\.addon\);\s*directories\.set\([\s\S]*?openedDirectories\.push/su,
    );
    expect(source).toMatch(
      /const opened\s*=\s*input\.addon\.openReadFileAtNoFollow[\s\S]*?let fileOperationError\s*=\s*null[\s\S]*?beforeResourceClose[\s\S]*?closeErrors\.push\(error\)[\s\S]*?closeFd\(opened\.fd\)[\s\S]*?combineErrors\(fileOperationError, \.\.\.closeErrors\)/su,
    );
    expect(source).toContain("for (const value of [...openedDirectories].reverse())");
  });

  it.each(["regular", "symlink"] as const)(
    "retains a real foreign %s replacement between initial and final no-follow checks",
    { timeout: 30_000 },
    async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `round10-${kind}-replacement-`));
      roots.push(root);
      const basename = "snapshot";
      const snapshot = path.join(root, basename);
      const target = path.join(snapshot, `round10-${kind}-target`);
      const displaced = `${target}.owned-displaced`;
      const ready = path.join(root, "ready");
      const receipt = path.join(root, "receipt.json");
      await mkdir(snapshot, { mode: 0o700 });
      if (kind === "regular") await writeFile(target, "owned\n", { mode: 0o600 });
      else await symlink("owned-target", target);

      const child = spawnEntryWorker({ root, basename, ready, receipt });
      await waitForPath(ready);
      await waitForStopped(child);
      await rename(target, displaced);
      if (kind === "regular") await writeFile(target, "foreign\n", { mode: 0o600 });
      else await symlink("foreign-target", target);
      const foreign = await lstat(target);
      child.kill("SIGCONT");
      const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
      children.delete(child);
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ ok: false });
      await expect(lstat(target)).resolves.toMatchObject({ dev: foreign.dev, ino: foreign.ino });
      if (kind === "regular") await expect(readFile(target, "utf8")).resolves.toBe("foreign\n");
      else await expect(readlink(target)).resolves.toBe("foreign-target");
    },
  );

  it("default-denies unseen concrete preparation objects when weather is unavailable", () => {
    for (const fragment of [
      "手机临出门前记得带上",
      "MagSafe虽然没写进清单，离开前也要拿好",
      "星环能量模块放进随身袋再出门",
      "把Q7便携终端稳妥地装好",
      "把折叠数据舱收好再出门",
      "出门前记得准备好星标卡",
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

  it("default-denies unclassified or qualifier-mismatched same-day personal facts", () => {
    const unavailable = context("unavailable", [], []);
    const cold = context("available", ["stated-discomfort"], ["我今天感冒了"]);
    const lowMood = context("available", [], ["我今天心情不太好"]);
    const nightShift = context("available", [], ["我今天上夜班"]);
    const limitedBreakfast = context("available", [], ["我今天早餐只吃了两口"]);
    const stomachFromMissedMeal = context(
      "available", ["stated-discomfort"], ["我今天胃不舒服，因为没吃午饭"],
    );

    for (const claim of [
      "知道你今天感冒了",
      "知道你今天心情不太好",
      "知道你今天临时换了班次",
      "你今天临时换了班次",
    ]) {
      expect(() => validateNightClaim(claim, unavailable), claim)
        .toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    }
    expect(() => validateNightClaim("知道你今天感冒了", cold)).not.toThrow();
    expect(() => validateNightClaim(
      "知道你今天感冒了，也知道你今天临时换了班次",
      cold,
    )).toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateNightClaim("知道你今天感冒了", lowMood))
      .toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateNightClaim("知道你今天心情不太好", lowMood)).not.toThrow();
    expect(() => validateNightClaim("知道你今天连续上了十二个小时夜班", nightShift))
      .toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateNightClaim("知道你今天晚饭只吃了两口", limitedBreakfast))
      .toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateNightClaim("知道你今天胃不舒服是因为空调吹久了", stomachFromMissedMeal))
      .toThrow("BROADCAST_UNBOUND_PERSONAL_FACT");
    expect(() => validateNightClaim("知道你今天胃不舒服是因为没吃午饭", stomachFromMissedMeal))
      .not.toThrow();
  });
});

function loadProductionAddon(): unknown {
  return createRequire(import.meta.url)(path.join(
    projectRoot, "native/kernel-lock/build", `${process.platform}-${process.arch}`, "kernel_lock.node",
  ));
}

function spawnEntryWorker(input: {
  root: string; basename: string; ready: string; receipt: string;
}): ChildProcess {
  const child = spawn(process.execPath, [
    path.resolve("tests/fixtures/runtime-v2-round10-private-entry-worker.mjs"),
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RUNTIME_V2_ROUND10_PRIVATE_PARENT: input.root,
      RUNTIME_V2_ROUND10_PRIVATE_BASENAME: input.basename,
      RUNTIME_V2_ROUND10_PRIVATE_READY: input.ready,
      RUNTIME_V2_ROUND10_PRIVATE_RECEIPT: input.receipt,
      RUNTIME_V2_ROUND10_TEST_ADDON: testAddonPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function waitForPath(target: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(target);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("ROUND10_WORKER_READY_TIMEOUT");
}

async function waitForStopped(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) throw new Error("ROUND10_WORKER_PID_REQUIRED");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("ROUND10_INTERLOCK_NOT_REACHED");
    }
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "state=", "-p", String(child.pid)]);
    if (stdout.trim().startsWith("T")) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("ROUND10_INTERLOCK_TIMEOUT");
}

function morningCandidate(fragment: string): string {
  return `早呀，今日份的关心也准时送到啦。上班前先吃点东西，喝点温水，别空着肚子忙起来。${fragment}，愿你今天顺顺利利，也记得照顾好身体。☀️💛\n——示例用户`;
}

function validateNightClaim(claim: string, sameDayCareContext: ReturnType<typeof context>): void {
  validateBroadcastCandidate({
    kind: "night",
    text: `想认真和你说声晚安。${claim}，希望这会儿能慢慢放松下来，也知道有人在惦记你。现在就安心休息，不必急着回应。愿你今晚睡得安稳，醒来时轻松一些，晚安🌙\n——示例用户`,
    weather: null,
    recentVerifiedTexts: [],
    sameDayCareContext,
  } as never);
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
    proofHash: "a".repeat(64),
  } as const;
}
