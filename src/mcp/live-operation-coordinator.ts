import { AsyncLocalStorage } from "node:async_hooks";
import {
  acquireKernelLease,
  type KernelLockLease,
} from "../storage/kernel-lock.js";
import { canonicalFilesystemRoot } from "../storage/encrypted-store.js";

export type LiveOwnerKind = "mcp" | "cli";

export interface LiveOperationCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type LiveOperationChildNamespace = "inbound-delivery";

export interface LiveOperationChildAdmission {
  runExclusive<T>(
    operation: (fence: LiveOperationChildFence) => Promise<T>,
  ): Promise<T>;
}

export interface LiveOperationChildFence {
  assertCurrent(): void;
}

interface ProductionOwnerRecord {
  readonly assertOpen: () => void;
  readonly rootIdentity: ReturnType<typeof canonicalFilesystemRoot>;
  readonly lifecycle: OwnerLifecycle;
  readonly children: Map<LiveOperationChildNamespace, ChildAdmissionRecord>;
}

interface ChildAdmissionRecord {
  readonly admission: LiveOperationChildAdmission;
  readonly drain: () => Promise<void>;
}

const productionOwners = new WeakMap<
  LiveOperationCoordinator,
  ProductionOwnerRecord
>();
const childAdmissionBrand = new WeakSet<object>();
interface ParentOperationContext {
  readonly lifecycle: OwnerLifecycle;
  readonly generation: number;
  readonly drainOnClose: boolean;
  active: boolean;
}

interface ChildOperationContext {
  readonly lifecycle: OwnerLifecycle;
  readonly generation: number;
  readonly parentOperation: ParentOperationContext | undefined;
}

const parentOperationContext = new AsyncLocalStorage<ParentOperationContext>();
const childOperationContext = new AsyncLocalStorage<ChildOperationContext>();

export interface AcquireLiveOperationCoordinatorOptions {
  dataDir: string;
  ownerKind: LiveOwnerKind;
}

export async function acquireLiveOperationCoordinator(
  options: AcquireLiveOperationCoordinatorOptions,
): Promise<LiveOperationCoordinator> {
  try {
    const rootIdentity = canonicalFilesystemRoot(options.dataDir);
    const lease = await acquireKernelLease({
      dataRoot: rootIdentity.canonicalPath,
      purpose: "live-operation",
    });
    const lifecycle = new OwnerLifecycle();
    const children = new Map<
      LiveOperationChildNamespace,
      ChildAdmissionRecord
    >();
    const owner = new PersistentLiveOperationCoordinator(
      lease,
      lifecycle,
      children,
    );
    productionOwners.set(owner, {
      assertOpen: () => {
        lifecycle.assertOpen();
      },
      rootIdentity,
      lifecycle,
      children,
    });
    return owner;
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "KERNEL_LOCK_BUSY",
        "KERNEL_LOCK_LEGACY_ARTIFACT_PRESENT",
        "KERNEL_LOCK_COMPATIBILITY_TOMBSTONE_INVALID",
      ].includes(error.message)
    ) {
      throw new Error("LIVE_RUNTIME_BUSY", { cause: error });
    }
    throw error;
  }
}

/** Fail-closed process-local provenance check for production composition roots. */
export function assertLiveOperationCoordinator(
  owner: LiveOperationCoordinator,
  expectedDataDir?: string,
): void {
  const record = productionOwners.get(owner);
  if (record === undefined) throw new Error("LIVE_OPERATION_OWNER_INVALID");
  const current = canonicalFilesystemRoot(record.rootIdentity.configuredPath);
  if (
    current.canonicalPath !== record.rootIdentity.canonicalPath ||
    current.device !== record.rootIdentity.device ||
    current.inode !== record.rootIdentity.inode
  ) {
    throw new Error("LIVE_OPERATION_OWNER_ROOT_IDENTITY_CHANGED");
  }
  if (expectedDataDir !== undefined) {
    const expected = canonicalFilesystemRoot(expectedDataDir);
    if (
      record.rootIdentity.canonicalPath !== expected.canonicalPath ||
      record.rootIdentity.device !== expected.device ||
      record.rootIdentity.inode !== expected.inode
    ) {
      throw new Error("LIVE_OPERATION_OWNER_ROOT_MISMATCH");
    }
  }
}

/**
 * Mints a process-local child queue only for an owner created by this module.
 * Child work has its own queue, generation fence, and drain. It never enters
 * the parent queue, while owner close retains the kernel lease until both
 * parent and already-admitted child work have exited.
 */
export function acquireLiveOperationChildAdmission(
  owner: LiveOperationCoordinator,
  namespace: LiveOperationChildNamespace,
): LiveOperationChildAdmission {
  if (namespace !== "inbound-delivery") {
    throw new Error("LIVE_OPERATION_CHILD_NAMESPACE_INVALID");
  }
  const record = productionOwners.get(owner);
  if (record === undefined) throw new Error("LIVE_OPERATION_OWNER_INVALID");
  record.assertOpen();
  const existing = record.children.get(namespace);
  if (existing !== undefined) return existing.admission;
  let tail: Promise<void> = Promise.resolve();
  const admission: LiveOperationChildAdmission = Object.freeze({
    runExclusive<T>(
      operation: (fence: LiveOperationChildFence) => Promise<T>,
    ): Promise<T> {
      try {
        record.assertOpen();
      } catch {
        return Promise.reject(new Error("LIVE_RUNTIME_CLOSED"));
      }
      const generation = record.lifecycle.currentGeneration();
      const enclosingParent = parentOperationContext.getStore();
      const fence: LiveOperationChildFence = Object.freeze({
        assertCurrent: () => {
          record.lifecycle.assertCurrent(generation);
        },
      });
      const run = async () => {
        fence.assertCurrent();
        const result = await childOperationContext.run(
          {
            lifecycle: record.lifecycle,
            generation,
            parentOperation:
              enclosingParent?.lifecycle === record.lifecycle
                ? enclosingParent
                : undefined,
          },
          () => operation(fence),
        );
        fence.assertCurrent();
        return result;
      };
      const result = tail.then(run, run);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
  childAdmissionBrand.add(admission);
  record.children.set(namespace, { admission, drain: () => tail });
  return admission;
}

export function isLiveOperationChildAdmission(
  value: unknown,
): value is LiveOperationChildAdmission {
  return (
    typeof value === "object" &&
    value !== null &&
    childAdmissionBrand.has(value)
  );
}

class PersistentLiveOperationCoordinator implements LiveOperationCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  public constructor(
    private readonly lease: KernelLockLease,
    private readonly lifecycle: OwnerLifecycle,
    private readonly children: Map<
      LiveOperationChildNamespace,
      ChildAdmissionRecord
    >,
  ) {}

  public runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("LIVE_RUNTIME_CLOSED"));
    const generation = this.lifecycle.currentGeneration();
    const childContext = childOperationContext.getStore();
    const enclosingParent =
      childContext?.lifecycle === this.lifecycle
        ? childContext.parentOperation
        : undefined;
    if (
      enclosingParent?.active === true &&
      enclosingParent.generation === childContext?.generation
    ) {
      return this.runFenced(
        operation,
        enclosingParent.generation,
        enclosingParent.drainOnClose,
      );
    }
    const drainOnClose = childContext === undefined;
    const run = () =>
      this.lease.runExclusive(async () => {
        const context: ParentOperationContext = {
          lifecycle: this.lifecycle,
          generation,
          drainOnClose,
          active: true,
        };
        try {
          return await parentOperationContext.run(context, () =>
            this.runFenced(operation, generation, drainOnClose),
          );
        } finally {
          context.active = false;
        }
      });
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runFenced<T>(
    operation: () => Promise<T>,
    generation: number,
    drainOnClose: boolean,
  ): Promise<T> {
    this.lifecycle.assertAccepted(generation, drainOnClose);
    const result = await operation();
    this.lifecycle.assertAccepted(generation, drainOnClose);
    return result;
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.lifecycle.beginClose();
    const parentDrain = this.tail;
    const childDrains = [...this.children.values()].map(({ drain }) => drain());
    this.closePromise = Promise.allSettled([parentDrain, ...childDrains]).then(
      () => this.lease.close(),
    );
    return this.closePromise;
  }
}

class OwnerLifecycle {
  private generation = 1;
  private closing = false;

  public assertOpen(): void {
    if (this.closing) throw new Error("LIVE_RUNTIME_CLOSED");
  }

  public currentGeneration(): number {
    this.assertOpen();
    return this.generation;
  }

  public assertCurrent(generation: number): void {
    if (this.closing || generation !== this.generation) {
      throw new Error("LIVE_RUNTIME_CLOSED");
    }
  }

  public assertAccepted(generation: number, drainOnClose: boolean): void {
    const acceptedBeforeClose =
      drainOnClose && this.closing && generation + 1 === this.generation;
    if (
      (!this.closing && generation === this.generation) ||
      acceptedBeforeClose
    )
      return;
    throw new Error("LIVE_RUNTIME_CLOSED");
  }

  public beginClose(): void {
    if (this.closing) return;
    this.closing = true;
    this.generation += 1;
  }
}
