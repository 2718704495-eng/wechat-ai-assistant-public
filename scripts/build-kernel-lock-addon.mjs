import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repositoryRoot, "native", "kernel-lock", "kernel_lock.c");
const outputDirectory = path.join(
  repositoryRoot,
  "native",
  "kernel-lock",
  "build",
  `${process.platform}-${process.arch}`,
);
const addonPath = path.join(outputDirectory, "kernel_lock.node");
const manifestPath = path.join(outputDirectory, "kernel_lock.manifest.json");

await main();

async function main() {
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error("KERNEL_LOCK_PLATFORM_UNSUPPORTED");
  }
  const headersPath = path.resolve(path.dirname(process.execPath), "..", "include", "node");
  await access(path.join(headersPath, "node_api.h"));
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const arguments_ = [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fPIC",
    ...(process.platform === "darwin"
      ? ["-dynamiclib", "-undefined", "dynamic_lookup"]
      : ["-shared"]),
    `-I${headersPath}`,
    sourcePath,
    "-o",
    addonPath,
  ];
  await execFileAsync("clang", arguments_, {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  await assertExpectedArchitecture(addonPath);
  const sha256 = createHash("sha256").update(await readFile(addonPath)).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify({
    version: 2,
    platform: process.platform,
    arch: process.arch,
    napi: Number(process.versions.napi),
    sha256,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ addonPath, manifestPath, sha256 })}\n`);
}

async function assertExpectedArchitecture(binaryPath) {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", binaryPath], {
      env: { PATH: "/usr/bin:/bin" },
    });
    if (stdout.trim().split(/\s+/u).length !== 1 || stdout.trim() !== process.arch) {
      throw new Error("KERNEL_LOCK_ADDON_ARCH_INVALID");
    }
    return;
  }
  const { stdout } = await execFileAsync("/usr/bin/readelf", ["-h", binaryPath], {
    env: { PATH: "/usr/bin:/bin" },
  });
  const expected = process.arch === "x64" ? "X86-64" : process.arch === "arm64" ? "AArch64" : null;
  if (expected === null || !stdout.includes(`Machine:                           ${expected}`)) {
    throw new Error("KERNEL_LOCK_ADDON_ARCH_INVALID");
  }
}
