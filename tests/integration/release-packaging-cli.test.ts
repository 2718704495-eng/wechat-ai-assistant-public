import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("release shell entry path isolation", () => {
  it.each(["install-local.sh", "rollback-local.sh", "recover-local.sh"])(
    "%s refuses every destination outside its temporary HOME",
    async (scriptName) => {
      const home = await temporaryRoot("release CLI HOME with spaces-");
      const allowedDestination = path.join(home, "Desktop", "聊天助手", "bin");
      const forbiddenDestination = path.join(path.dirname(home), "other runtime", "bin");

      await expect(execFileAsync("bash", [
        path.join(projectRoot, "scripts", scriptName),
        "--destination",
        forbiddenDestination,
      ], {
        cwd: path.dirname(home),
        env: {
          HOME: home,
          LANG: "en_US.UTF-8",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      })).rejects.toThrow("DESTINATION_NOT_ALLOWED");

      await expect(lstat(allowedDestination)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(forbiddenDestination)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
