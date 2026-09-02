import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const project = process.cwd();

describe("local installation scripts", () => {
  let temporaryHome: string;

  beforeEach(async () => {
    temporaryHome = await mkdtemp(path.join(os.tmpdir(), "chat-assistant-home-"));
  });

  afterEach(async () => rm(temporaryHome, { recursive: true, force: true }));

  it("requires an explicit candidate at the exact path without touching runtime data", async () => {
    const runtimeRoot = path.join(temporaryHome, "Desktop", "聊天助手");
    const destination = path.join(runtimeRoot, "bin");
    for (const name of ["vault", "profiles", "logs", "state", "temp"]) {
      await mkdir(path.join(runtimeRoot, name), { recursive: true, mode: 0o700 });
    }
    await writeFile(path.join(runtimeRoot, "vault", "keep.txt"), "keep");

    await expect(run("scripts/install-local.sh", ["--destination", destination]))
      .rejects.toThrow("CANDIDATE_REQUIRED");

    await expect(readFile(path.join(runtimeRoot, "vault", "keep.txt"), "utf8"))
      .resolves.toBe("keep");
    for (const name of ["vault", "profiles", "logs", "state", "temp"]) {
      expect((await stat(path.join(runtimeRoot, name))).mode & 0o777).toBe(0o700);
    }
    await expect(run("scripts/install-local.sh", ["--destination", path.join(temporaryHome, "other")])).rejects.toThrow("DESTINATION_NOT_ALLOWED");
  });

  it("requires an explicit heartbeat mode and approval for sending modes", async () => {
    const output = path.join(temporaryHome, "heartbeat.plist");
    await expect(run("scripts/install-heartbeat.sh", ["--output", output])).rejects.toThrow("MODE_REQUIRED");
    await expect(run("scripts/install-heartbeat.sh", ["--mode", "live", "--output", output])).rejects.toThrow("APPROVED_REPORT_HASH_REQUIRED");
    await run("scripts/install-heartbeat.sh", ["--mode", "observe", "--output", output]);

    const plist = await readFile(output, "utf8");
    expect(plist).toContain("<integer>300</integer>");
    expect(plist).toContain("alarm 60");
    expect(plist).toContain("run-once");
    expect(plist).toContain("observe");
    expect(plist).not.toContain(".env");
  });

  async function run(script: string, args: string[]) {
    return exec("bash", [path.join(project, script), ...args], {
      cwd: project,
      env: { ...process.env, HOME: temporaryHome },
    });
  }
});
