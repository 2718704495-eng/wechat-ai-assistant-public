import { describe, expect, it, vi } from "vitest";

interface SupervisorModule {
  createLiveSupervisorSession(
    dependencies: Record<string, unknown>,
    options?: { directTargetStart?: boolean },
  ): {
    execute(command: unknown): Promise<unknown>;
    close(): void;
  };
}

const controlCanary = "CONTROL_CAPABILITY_CANARY";
const triggerCanary = "TRIGGER_CAPABILITY_CANARY";
const candidateCanary = "CANDIDATE_CAPABILITY_CANARY";
const submitCanary = "SUBMIT_CAPABILITY_CANARY";

describe("live supervisor session", () => {
  it("fails closed for out-of-order operations and invalidates every proof on close", async () => {
    const session = (await loadSupervisor()).createLiveSupervisorSession(fakeDependencies());

    await expect(session.execute({ op: "read-target" })).rejects.toThrow(
      "SUPERVISOR_SEQUENCE_ERROR",
    );
    await expect(session.execute({ op: "prepare-latest-reply", text: "收到啦" }))
      .rejects.toThrow("SUPERVISOR_SEQUENCE_ERROR");
    await expect(session.execute({ op: "submit-authorized-draft" })).rejects.toThrow(
      "SUPERVISOR_SEQUENCE_ERROR",
    );

    await session.execute({ op: "read-control" });
    await session.execute({ op: "read-target" });
    session.close();

    await expect(session.execute({ op: "read-control" })).rejects.toThrow(
      "SUPERVISOR_SESSION_CLOSED",
    );
    await expect(session.execute({ op: "prepare-latest-reply", text: "收到啦" }))
      .rejects.toThrow("SUPERVISOR_SESSION_CLOSED");
  });

  it("keeps control, trigger, candidate and submit capabilities internal through one submit", async () => {
    const dependencies = fakeDependencies();
    const session = (await loadSupervisor()).createLiveSupervisorSession(dependencies);
    const publicResults = [];

    publicResults.push(await session.execute({ op: "read-control" }));
    publicResults.push(await session.execute({ op: "read-target" }));
    publicResults.push(await session.execute({ op: "prepare-latest-reply", text: "收到啦" }));
    publicResults.push(await session.execute({ op: "verify-draft" }));
    publicResults.push(await session.execute({ op: "submit-authorized-draft" }));
    await expect(session.execute({ op: "submit-authorized-draft" })).rejects.toThrow(
      "SUPERVISOR_SEQUENCE_ERROR",
    );
    publicResults.push(await session.execute({ op: "verify-send" }));

    const serialized = JSON.stringify(publicResults);
    for (const canary of [controlCanary, triggerCanary, candidateCanary, submitCanary]) {
      expect(serialized).not.toContain(canary);
    }
    expect(dependencies.submitAuthorizedDraftForSupervisor).toHaveBeenCalledTimes(1);
    expect(dependencies.verifySend).toHaveBeenCalledWith(candidateCanary);
  });

  it("starts the fixed heartbeat from one direct target read without reading control UI", async () => {
    const dependencies = fakeDependencies();
    const session = (await loadSupervisor()).createLiveSupervisorSession(
      dependencies,
      { directTargetStart: true },
    );

    await session.execute({ op: "read-target" });
    await session.execute({ op: "prepare-latest-reply", text: "收到啦" });
    await session.execute({ op: "verify-draft" });
    await session.execute({ op: "submit-authorized-draft" });
    await session.execute({ op: "verify-send" });

    expect(dependencies.readTargetDirectForSupervisor).toHaveBeenCalledTimes(1);
    expect(dependencies.readControlForSupervisor).not.toHaveBeenCalled();
    expect(dependencies.readTargetForSupervisor).not.toHaveBeenCalled();
    expect(dependencies.submitAuthorizedDraftForSupervisor).toHaveBeenCalledTimes(1);
  });

  it("uses one target proof for a comfort-station card and exposes no capability", async () => {
    const dependencies = fakeDependencies();
    const session = (await loadSupervisor()).createLiveSupervisorSession(
      dependencies,
      { directTargetStart: true },
    );

    const results = [
      await session.execute({ op: "read-target" }),
      await session.execute({ op: "show-comfort-station" }),
    ];

    expect(results.at(-1)).toEqual({ status: "verified", conversationId: "example-contact" });
    expect(JSON.stringify(results)).not.toContain(controlCanary);
    expect(JSON.stringify(results)).not.toContain(triggerCanary);
    expect(dependencies.showComfortStationCardForSupervisor).toHaveBeenCalledTimes(1);
    await expect(session.execute({ op: "show-comfort-station" }))
      .rejects.toThrow("SUPERVISOR_SEQUENCE_ERROR");
  });

  it("keeps a stopped direct heartbeat out of prepare and submit", async () => {
    const dependencies = fakeDependencies();
    dependencies.readTargetDirectForSupervisor.mockResolvedValueOnce({
      publicResult: {
        stopped: true,
        stopReason: "user-command",
        replyDecision: { action: "wait", reason: "CONTROL_STOPPED" },
      },
      controlProof: null,
      proof: null,
    });
    const session = (await loadSupervisor()).createLiveSupervisorSession(
      dependencies,
      { directTargetStart: true },
    );

    await expect(session.execute({ op: "read-target" })).resolves.toMatchObject({
      stopped: true,
      replyDecision: { action: "wait", reason: "CONTROL_STOPPED" },
    });
    await expect(session.execute({ op: "prepare-latest-reply", text: "禁止发送" }))
      .rejects.toThrow("SUPERVISOR_SEQUENCE_ERROR");
    expect(dependencies.prepareLatestReplyForSupervisor).not.toHaveBeenCalled();
    expect(dependencies.submitAuthorizedDraftForSupervisor).not.toHaveBeenCalled();
  });

  it("returns only the exact active boundary proof and permits idempotent establishment", async () => {
    const dependencies = fakeDependencies();
    const session = (await loadSupervisor()).createLiveSupervisorSession(dependencies);

    const first = await session.execute({ op: "establish-control-boundary" });
    const second = await session.execute({ op: "establish-control-boundary" });

    expect(first).toEqual({
      status: "active",
      epoch: "e".repeat(64),
      boundaryMessageId: "b".repeat(64),
      consumedCount: 0,
      prefixChainHash: "p".repeat(64),
      markerOccurrenceCount: 1,
    });
    expect(second).toEqual(first);
    expect(JSON.stringify([first, second])).not.toContain("聊天助手控制边界");
    expect(JSON.stringify([first, second])).not.toContain("NONCE_CANARY");
  });

  it.each([false, true])(
    "aborts an internal supervisor draft after verify=%s without exposing its token",
    async (verify) => {
      const dependencies = fakeDependencies();
      const session = (await loadSupervisor()).createLiveSupervisorSession(dependencies);
      await session.execute({ op: "read-control" });
      await session.execute({ op: "read-target" });
      await session.execute({ op: "prepare-latest-reply", text: "收到啦" });
      if (verify) await session.execute({ op: "verify-draft" });

      const result = await session.execute({ op: "abort-draft" });

      expect(result).toEqual({ aborted: true, conversationId: "example-contact" });
      expect(JSON.stringify(result)).not.toContain(candidateCanary);
      expect(dependencies.abortPreparedDraftForSupervisor).toHaveBeenCalledWith(
        candidateCanary,
      );
      expect(dependencies.abortDraft).not.toHaveBeenCalled();
    },
  );
});

async function loadSupervisor(): Promise<SupervisorModule> {
  const modulePath = "../../src/mcp/live-supervisor-session.js";
  return import(modulePath) as Promise<SupervisorModule>;
}

function fakeDependencies() {
  return {
    establishControlBoundaryForSupervisor: vi.fn().mockResolvedValue({
      status: "active",
      epoch: "e".repeat(64),
      boundaryMessageId: "b".repeat(64),
      consumedCount: 0,
      prefixChainHash: "p".repeat(64),
      markerOccurrenceCount: 1,
      markerText: "聊天助手控制边界 NONCE_CANARY",
      nonce: "NONCE_CANARY",
    }),
    readControlForSupervisor: vi.fn().mockResolvedValue({
      publicResult: { control: null, checkpointReady: true },
      proof: { capability: controlCanary },
    }),
    readTargetForSupervisor: vi.fn().mockResolvedValue({
      publicResult: {
        replyDecision: {
          action: "reply-latest-incoming",
          triggerMessageId: "incoming-id",
          reason: "LATEST_VISIBLE_INCOMING",
        },
      },
      proof: { capability: triggerCanary },
    }),
    readTargetDirectForSupervisor: vi.fn().mockResolvedValue({
      publicResult: {
        replyDecision: {
          action: "reply-latest-incoming",
          triggerMessageId: "incoming-id",
          reason: "LATEST_VISIBLE_INCOMING",
        },
      },
      controlProof: {
        capability: controlCanary,
        verification: "persistent-stop-gate",
      },
      proof: { capability: triggerCanary },
    }),
    prepareLatestReplyForSupervisor: vi.fn().mockResolvedValue({
      candidateToken: candidateCanary,
      submitProof: submitCanary,
      prepared: true,
      conversationId: "example-contact",
      draftVerified: false,
    }),
    verifyDraft: vi.fn().mockResolvedValue({
      draftVerified: true,
      conversationId: "example-contact",
      readyForComputerUseReturn: true,
    }),
    submitAuthorizedDraftForSupervisor: vi.fn().mockResolvedValue({
      submitted: true,
      conversationId: "example-contact",
    }),
    showComfortStationCardForSupervisor: vi.fn().mockResolvedValue({
      status: "verified",
      conversationId: "example-contact",
    }),
    abortDraft: vi.fn().mockResolvedValue({ aborted: true, conversationId: "example-contact" }),
    abortPreparedDraftForSupervisor: vi.fn().mockResolvedValue({
      aborted: true,
      conversationId: "example-contact",
    }),
    verifySend: vi.fn().mockResolvedValue({ status: "verified", conversationId: "example-contact" }),
  };
}
