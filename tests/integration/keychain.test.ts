import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { MacOSKeychainKeyProvider } from "../../src/security/keychain.js";

const execFileAsync = promisify(execFile);

describe("MacOSKeychainKeyProvider", () => {
  const service = `Codex.WeChatChatAssistant.test.${randomUUID()}`;
  const account = `integration-${randomUUID()}`;

  afterEach(async () => {
    await execFileAsync("/usr/bin/security", [
      "delete-generic-password",
      "-a",
      account,
      "-s",
      service,
    ]).catch(() => undefined);
  });

  test("creates one 32-byte key and reads the same key on later calls", async () => {
    const firstProvider = new MacOSKeychainKeyProvider({ service, account });
    const secondProvider = new MacOSKeychainKeyProvider({ service, account });

    const first = await firstProvider.getOrCreate();
    const second = await secondProvider.getOrCreate();

    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
  });
});
