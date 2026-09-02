import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import {
  assertEncryptedStoreRoot,
  encryptedStoreRoot,
  EncryptedStore,
} from "../../src/storage/encrypted-store.js";
import type { KeyProvider } from "../../src/security/keychain.js";

const documentSchema = z.object({ message: z.string(), count: z.number() });

class FixedKeyProvider implements KeyProvider {
  public constructor(private readonly key: Buffer) {}

  public async getOrCreate(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.key));
  }
}

describe("EncryptedStore", () => {
  let rootDir: string;
  let store: EncryptedStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "chat-assistant-store-"));
    store = new EncryptedStore(rootDir, new FixedKeyProvider(randomBytes(32)));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("encrypts document content and reads the validated value back", async () => {
    await store.write("vault/messages.enc", { message: "只存在于明文对象", count: 2 });

    const disk = await readFile(path.join(rootDir, "vault/messages.enc"), "utf8");
    expect(disk).not.toContain("只存在于明文对象");
    await expect(store.read("vault/messages.enc", documentSchema)).resolves.toEqual({
      message: "只存在于明文对象",
      count: 2,
    });
  });

  test("rejects authenticated ciphertext after it is tampered with", async () => {
    await store.write("vault/messages.enc", { message: "safe", count: 1 });
    const file = path.join(rootDir, "vault/messages.enc");
    const envelope = JSON.parse(await readFile(file, "utf8")) as {
      ciphertext: string;
    };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    envelope.ciphertext = bytes.toString("base64");
    await writeFile(file, JSON.stringify(envelope));

    await expect(store.read("vault/messages.enc", documentSchema)).rejects.toThrow(
      "AUTHENTICATION_FAILED",
    );
  });

  test("leaves no temporary file after an atomic replacement", async () => {
    await store.write("state/control.enc", { message: "first", count: 1 });
    await store.write("state/control.enc", { message: "second", count: 2 });

    const entries = await readdir(path.join(rootDir, "state"));
    expect(entries).toEqual(["control.enc"]);
    await expect(store.read("state/control.enc", documentSchema)).resolves.toEqual({
      message: "second",
      count: 2,
    });
  });

  test("rejects paths that escape the configured data directory", async () => {
    await expect(store.write("../outside.enc", { message: "escape", count: 1 })).rejects.toThrow(
      "PATH_OUTSIDE_DATA_DIR",
    );
  });

  test("carries unforgeable canonical root provenance", async () => {
    expect(encryptedStoreRoot(store)).toBe(await realpath(rootDir));
    expect(() => assertEncryptedStoreRoot(store, path.join(rootDir, "."))).not.toThrow();
    expect(() => assertEncryptedStoreRoot(store, path.join(rootDir, "other"))).toThrow(
      "ENCRYPTED_STORE_ROOT_MISMATCH",
    );
    expect(() =>
      assertEncryptedStoreRoot(
        { rootDir: path.resolve(rootDir) } as unknown as EncryptedStore,
        rootDir,
      ),
    ).toThrow("ENCRYPTED_STORE_PROVENANCE_INVALID");
  });

  test("uses filesystem identity for symlink aliases and fails closed after alias replacement", async () => {
    const alias = `${rootDir}-alias`;
    const replacement = `${rootDir}-replacement`;
    await mkdir(replacement, { recursive: true, mode: 0o700 });
    await symlink(rootDir, alias, "dir");
    const aliased = new EncryptedStore(alias, new FixedKeyProvider(randomBytes(32)));
    expect(encryptedStoreRoot(aliased)).toBe(encryptedStoreRoot(store));
    expect(() => assertEncryptedStoreRoot(aliased, rootDir)).not.toThrow();

    await unlink(alias);
    await symlink(replacement, alias, "dir");
    await expect(aliased.read("vault/messages.enc", documentSchema)).rejects.toThrow(
      "ENCRYPTED_STORE_ROOT_IDENTITY_CHANGED",
    );
    await unlink(alias);
    await rm(replacement, { recursive: true, force: true });
  });

  test("removes only log files older than thirty days", async () => {
    await store.write("logs/old.enc", { message: "old", count: 1 });
    await store.write("logs/recent.enc", { message: "recent", count: 1 });
    await store.write("vault/permanent.enc", { message: "vault", count: 1 });
    const now = new Date("2026-08-19T00:00:00.000Z");
    const old = new Date("2026-07-19T23:59:59.000Z");
    await utimes(path.join(rootDir, "logs/old.enc"), old, old);

    await expect(store.pruneLogs(now)).resolves.toBe(1);
    await expect(readdir(path.join(rootDir, "logs"))).resolves.toEqual(["recent.enc"]);
    await expect(readFile(path.join(rootDir, "vault/permanent.enc"))).resolves.toBeInstanceOf(
      Buffer,
    );
  });
});
