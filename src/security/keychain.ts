import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface KeyProvider {
  getOrCreate(): Promise<Buffer>;
}

export interface MacOSKeychainKeyProviderOptions {
  service?: string;
  account?: string;
}

export class MacOSKeychainKeyProvider implements KeyProvider {
  private readonly service: string;
  private readonly account: string;

  public constructor(options: MacOSKeychainKeyProviderOptions = {}) {
    this.service = options.service ?? "Codex.WeChatChatAssistant.v1";
    this.account = options.account ?? os.userInfo().username;
  }

  public async getOrCreate(): Promise<Buffer> {
    const existing = await this.find();
    if (existing !== null) {
      return existing;
    }

    const generated = randomBytes(32);
    try {
      await execFileAsync("/usr/bin/security", [
        "add-generic-password",
        "-a",
        this.account,
        "-s",
        this.service,
        "-w",
        generated.toString("base64"),
      ]);
      return generated;
    } catch (error: unknown) {
      const raced = await this.find();
      if (raced !== null) {
        return raced;
      }
      throw new Error("KEYCHAIN_WRITE_FAILED", { cause: error });
    }
  }

  private async find(): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", [
        "find-generic-password",
        "-a",
        this.account,
        "-s",
        this.service,
        "-w",
      ]);
      const key = Buffer.from(stdout.trim(), "base64");
      if (key.length !== 32) {
        throw new Error("INVALID_KEYCHAIN_KEY");
      }
      return key;
    } catch (error: unknown) {
      if (isMissingKeychainItem(error)) {
        return null;
      }
      throw error;
    }
  }
}

function isMissingKeychainItem(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: number }).code === 44
  );
}
