import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startDailyCareSupervisor } from "../../src/mcp/daily-care-supervisor-main.js";
import { acquireLiveOperationCoordinator } from "../../src/mcp/live-operation-coordinator.js";
import { initializeTestKernelLockCatalog } from "../helpers/kernel-lock-catalog.js";

describe("daily-care production supervisor lifecycle", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each(["close", "EOF", "SIGINT", "SIGTERM"] as const)(
    "releases the same live lock on %s without opening Native UI",
    async (trigger) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "daily-care-main-"));
      roots.push(root);
      const dataDir = path.join(root, "runtime");
      await mkdir(dataDir, { mode: 0o700 });
      await initializeTestKernelLockCatalog(dataDir);
      const input = new EventEmitter();
      const signals = new EventEmitter();
      let closeRequested: (() => Promise<void> | void) | undefined;
      const server = {
        server: { onclose: undefined as (() => void) | undefined },
        close: vi.fn().mockResolvedValue(undefined),
      };

      await startDailyCareSupervisor({
        environment: {
          HOME: root,
          CHAT_ASSISTANT_DATA_DIR: dataDir,
        },
        input,
        signals,
        createRuntime: async () => {
          const coordinator = await acquireLiveOperationCoordinator({
            dataDir,
            ownerKind: "mcp",
          });
          return {
            dependencies: {} as never,
            close: () => coordinator.close(),
          };
        },
        connect: (_runtime, lifecycle) => {
          closeRequested = () => lifecycle.onCloseRequested();
          return Promise.resolve(server);
        },
      });

      const lockPath = path.join(dataDir, "state", ".kernel-lock-v1");
      await expect(access(lockPath)).resolves.toBeUndefined();
      if (trigger === "close") {
        await closeRequested?.();
      } else if (trigger === "EOF") {
        input.emit("end");
      } else {
        signals.emit(trigger);
      }

      await vi.waitFor(async () => {
        const successor = await acquireLiveOperationCoordinator({ dataDir, ownerKind: "cli" });
        await successor.close();
      });
      expect(server.close).toHaveBeenCalledTimes(1);
    },
  );

  it("always closes the runtime and aggregates shutdown errors when server.close throws", async () => {
    const input = new EventEmitter();
    const signals = new EventEmitter();
    const runtimeClose = vi.fn().mockResolvedValue(undefined);
    const serverClose = vi.fn().mockRejectedValue(new Error("PRIVATE_SERVER_CLOSE_FAILURE"));
    const supervisor = await startDailyCareSupervisor({
      environment: {},
      input,
      signals,
      createRuntime: vi.fn().mockResolvedValue({
        dependencies: {} as never,
        close: runtimeClose,
      }),
      connect: vi.fn().mockResolvedValue({
        server: { onclose: undefined },
        close: serverClose,
      }),
    });

    const error = await supervisor.close().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "PRIVATE_SERVER_CLOSE_FAILURE" }),
    ]);
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(runtimeClose).toHaveBeenCalledTimes(1);
  });
});
