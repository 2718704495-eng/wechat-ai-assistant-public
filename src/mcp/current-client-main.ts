import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { readCurrentWechatForAdvice } from "./current-client.js";

const home = process.env.HOME;
if (home === undefined || home.length === 0) {
  throw new Error("INVALID_RUNTIME_CONFIG");
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "../../..");
const serverEntry = path.join(moduleDirectory, "current-server-main.js");
const client = new Client({ name: "wechat-current-compatibility-client", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: projectRoot,
  env: {
    CHAT_ASSISTANT_MODE: "observe",
    HOME: home,
    PATH: process.env.PATH ?? "",
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const result = await readCurrentWechatForAdvice(client);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error: unknown) {
  process.exitCode = 1;
  const reason = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  process.stderr.write(`WECHAT_CURRENT_READ_FAILED: ${reason}\n`);
} finally {
  await client.close().catch(() => undefined);
}
