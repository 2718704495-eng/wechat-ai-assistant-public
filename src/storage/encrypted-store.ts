import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type { KeyProvider } from "../security/keychain.js";
import { acquireKernelLease, assertNoLegacyArtifacts } from "./kernel-lock.js";

const retentionMilliseconds = 30 * 24 * 60 * 60 * 1000;
const transactionLockWaitMilliseconds = 5_000;
const transactionLockPollMilliseconds = 5;

const envelopeSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

interface FilesystemRootIdentity {
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}

const encryptedStoreRoots = new WeakMap<EncryptedStore, FilesystemRootIdentity>();

/** Process-local provenance for storage used by production composition roots. */
export function assertEncryptedStoreRoot(
  store: EncryptedStore,
  expectedRoot: string,
): void {
  const observed = encryptedStoreRoots.get(store);
  if (observed === undefined) throw new Error("ENCRYPTED_STORE_PROVENANCE_INVALID");
  assertCurrentFilesystemIdentity(observed);
  const expected = canonicalFilesystemRoot(expectedRoot);
  if (
    observed.canonicalPath !== expected.canonicalPath ||
    observed.device !== expected.device ||
    observed.inode !== expected.inode
  ) throw new Error("ENCRYPTED_STORE_ROOT_MISMATCH");
}

export function encryptedStoreRoot(store: EncryptedStore): string {
  const identity = encryptedStoreRoots.get(store);
  if (identity === undefined) throw new Error("ENCRYPTED_STORE_PROVENANCE_INVALID");
  assertCurrentFilesystemIdentity(identity);
  return identity.canonicalPath;
}

export function canonicalFilesystemRoot(root: string): FilesystemRootIdentity {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0"))
    throw new Error("ENCRYPTED_STORE_ROOT_INVALID");
  const configuredPath = path.resolve(root);
  mkdirSync(configuredPath, { recursive: true, mode: 0o700 });
  const canonicalPath = realpathSync.native(configuredPath);
  const metadata = statSync(canonicalPath);
  if (!metadata.isDirectory()) throw new Error("ENCRYPTED_STORE_ROOT_INVALID");
  return Object.freeze({
    configuredPath,
    canonicalPath,
    device: metadata.dev,
    inode: metadata.ino,
  });
}

function assertCurrentFilesystemIdentity(identity: FilesystemRootIdentity): void {
  let current: FilesystemRootIdentity;
  try {
    lstatSync(identity.configuredPath);
    current = canonicalFilesystemRoot(identity.configuredPath);
  } catch (error: unknown) {
    throw new Error("ENCRYPTED_STORE_ROOT_IDENTITY_CHANGED", { cause: error });
  }
  if (
    current.canonicalPath !== identity.canonicalPath ||
    current.device !== identity.device ||
    current.inode !== identity.inode
  ) throw new Error("ENCRYPTED_STORE_ROOT_IDENTITY_CHANGED");
}

export class EncryptedStore {
  private readonly rootDir: string;

  public constructor(
    rootDir: string,
    private readonly keyProvider: KeyProvider,
  ) {
    const identity = canonicalFilesystemRoot(rootDir);
    this.rootDir = identity.canonicalPath;
    encryptedStoreRoots.set(this, identity);
  }

  public async write<T>(relativePath: string, value: T): Promise<void> {
    const target = this.resolvePath(relativePath);
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    const key = await this.getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(relativePath, "utf8"));
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });

    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, envelope, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  public async read<T>(relativePath: string, schema: z.ZodType<T>): Promise<T | null> {
    const target = this.resolvePath(relativePath);
    let serialized: string;
    try {
      serialized = await readFile(target, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }

    const envelope = envelopeSchema.parse(JSON.parse(serialized));
    const key = await this.getKey();
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(relativePath, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      return schema.parse(JSON.parse(plaintext.toString("utf8")));
    } catch (error: unknown) {
      if (error instanceof z.ZodError) throw error;
      throw new Error("AUTHENTICATION_FAILED", { cause: error });
    }
  }

  public async createExclusiveMarker(relativePath: string): Promise<boolean> {
    const target = this.resolvePath(relativePath);
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    let marker;
    try {
      marker = await open(target, "wx", 0o600);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "EEXIST") return false;
      throw error;
    }
    try {
      await marker.sync();
    } finally {
      await marker.close();
    }
    await syncDirectory(directory);
    return true;
  }

  public async runExclusiveTransaction<T>(
    relativeLockPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.resolvePath(relativeLockPath);
    const lease = await this.acquireTransactionLease(relativeLockPath);
    try {
      return await lease.runExclusive(operation);
    } finally {
      await lease.close();
    }
  }

  public async pruneLogs(now: Date): Promise<number> {
    const logsDirectory = this.resolveDirectory("logs");
    let entries;
    try {
      entries = await readdir(logsDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return 0;
      throw error;
    }
    const cutoff = now.getTime() - retentionMilliseconds;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(logsDirectory, entry.name);
      const metadata = await stat(file);
      if (metadata.mtimeMs < cutoff) {
        await unlink(file);
        removed += 1;
      }
    }
    return removed;
  }

  private resolvePath(relativePath: string): string {
    const identity = encryptedStoreRoots.get(this);
    if (identity === undefined) throw new Error("ENCRYPTED_STORE_PROVENANCE_INVALID");
    assertCurrentFilesystemIdentity(identity);
    if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
      throw new Error("PATH_OUTSIDE_DATA_DIR");
    }
    const resolved = path.resolve(this.rootDir, relativePath);
    if (!resolved.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error("PATH_OUTSIDE_DATA_DIR");
    }
    return resolved;
  }

  private resolveDirectory(relativePath: string): string {
    return path.dirname(this.resolvePath(path.join(relativePath, ".directory-marker")));
  }

  private async getKey(): Promise<Buffer> {
    const key = await this.keyProvider.getOrCreate();
    if (key.length !== 32) throw new Error("INVALID_ENCRYPTION_KEY");
    return key;
  }

  private async acquireTransactionLease(relativeLockPath: string) {
    await assertNoLegacyArtifacts(
      path.join(this.rootDir, "state"),
      `encrypted-store-transaction:${relativeLockPath}`,
    );
    const deadline = Date.now() + transactionLockWaitMilliseconds;
    while (true) {
      try {
        return await acquireKernelLease({
          dataRoot: this.rootDir,
          purpose: "encrypted-store-global",
        });
      } catch (error) {
        if (!(error instanceof Error && error.message === "KERNEL_LOCK_BUSY")) throw error;
        if (Date.now() >= deadline) throw error;
        await delay(transactionLockPollMilliseconds);
      }
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
