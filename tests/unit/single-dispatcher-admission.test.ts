import { describe, expect, it, vi } from "vitest";

import {
  SingleDispatcherAdmission,
  type DispatcherOwner,
} from "../../src/runtime-v2/single-dispatcher-admission.js";

describe("single dispatcher admission", () => {
  it("admits exactly one P0/P1 owner and never queues the competing lane", async () => {
    const p0 = owner();
    const p1 = owner();
    const acquireOwner = vi.fn((lane: "p0" | "p1" | "acceptance") =>
      Promise.resolve(lane === "p0" ? p0 : p1),
    );
    const admission = new SingleDispatcherAdmission({ acquireOwner });

    const active = await admission.admit("p0");
    await expect(admission.admit("p1")).rejects.toThrow(
      "SINGLE_DISPATCHER_BUSY",
    );
    expect(acquireOwner).toHaveBeenCalledTimes(1);

    await expect(active.close()).resolves.toEqual({
      closed: true,
      gateReleased: true,
    });
    const next = await admission.admit("p1");
    expect(acquireOwner).toHaveBeenCalledTimes(2);
    await next.close();
    expect(p0.close).toHaveBeenCalledTimes(1);
    expect(p1.close).toHaveBeenCalledTimes(1);
  });

  it("releases the synchronous reservation when owner acquisition fails", async () => {
    const recovered = owner();
    const acquireOwner = vi
      .fn()
      .mockRejectedValueOnce(new Error("LIVE_RUNTIME_BUSY"))
      .mockResolvedValueOnce(recovered);
    const admission = new SingleDispatcherAdmission({ acquireOwner });

    await expect(admission.admit("p0")).rejects.toThrow("LIVE_RUNTIME_BUSY");
    const session = await admission.admit("p1");
    await session.close();
    expect(recovered.close).toHaveBeenCalledTimes(1);
  });

  it("requires a proven gate release before allowing another owner", async () => {
    const bad = owner(false);
    const good = owner();
    const admission = new SingleDispatcherAdmission({
      acquireOwner: vi
        .fn()
        .mockResolvedValueOnce(bad)
        .mockResolvedValueOnce(good),
    });
    const session = await admission.admit("p0");

    await expect(session.close()).rejects.toThrow(
      "SINGLE_DISPATCHER_GATE_RELEASE_UNPROVEN",
    );
    await expect(admission.admit("p1")).rejects.toThrow(
      "SINGLE_DISPATCHER_QUARANTINED",
    );
    expect(bad.close).toHaveBeenCalledTimes(1);
    expect(good.close).not.toHaveBeenCalled();
  });

  it("shares one reservation without accepting a per-call owner factory", async () => {
    const p0 = owner();
    const p1 = owner();
    const admission = new SingleDispatcherAdmission({
      acquireOwner: vi.fn((lane) => Promise.resolve(lane === "p0" ? p0 : p1)),
    });

    const active = await admission.admit("p1");
    await expect(admission.admit("p0")).rejects.toThrow(
      "SINGLE_DISPATCHER_BUSY",
    );
    await active.close();
    const next = await admission.admit("p0");
    await next.close();

    expect(p1.close).toHaveBeenCalledTimes(1);
    expect(p0.close).toHaveBeenCalledTimes(1);
  });

  it("gives an announced incoming reply priority over a not-yet-admitted P0 slot", async () => {
    const p0 = owner();
    const admission = new SingleDispatcherAdmission({
      acquireOwner: vi.fn().mockResolvedValue(p0),
    });
    const releasePending = admission.announcePending("p1");

    await expect(admission.admit("p0")).rejects.toThrow(
      "SINGLE_DISPATCHER_INCOMING_PENDING",
    );
    const incoming = await admission.admit("p1");
    releasePending();
    await incoming.close();
  });

  it("consults persistent P1 work before admitting P0", async () => {
    const acquireOwner = vi.fn().mockResolvedValue(owner());
    const hasPendingPriorityLane = vi
      .fn()
      .mockImplementation((lane) => Promise.resolve(lane === "p1"));
    const admission = new SingleDispatcherAdmission({
      acquireOwner,
      hasPendingPriorityLane,
    });

    await expect(admission.admit("p0")).rejects.toThrow(
      "SINGLE_DISPATCHER_INCOMING_PENDING",
    );
    expect(acquireOwner).not.toHaveBeenCalled();
    expect(hasPendingPriorityLane).toHaveBeenCalledWith("p1");
  });

  it("lets P1 preempt a provisional P0 reservation across the durable-query gap", async () => {
    let resolvePersistent!: (value: boolean) => void;
    const persistent = new Promise<boolean>((resolve) => {
      resolvePersistent = resolve;
    });
    const p0 = owner();
    const p1 = owner();
    const acquireOwner = vi.fn((lane: "p0" | "p1" | "acceptance") =>
      Promise.resolve(lane === "p0" ? p0 : p1),
    );
    const admission = new SingleDispatcherAdmission({
      acquireOwner,
      hasPendingPriorityLane: (lane) =>
        lane === "p1" ? persistent : Promise.resolve(false),
    });

    const p0Attempt = admission.admit("p0");
    await Promise.resolve();
    const releasePending = admission.announcePending("p1");
    const p1Session = await admission.admit("p1");
    resolvePersistent(false);

    await expect(p0Attempt).rejects.toThrow(
      "SINGLE_DISPATCHER_INCOMING_PENDING",
    );
    expect(acquireOwner).toHaveBeenCalledTimes(1);
    expect(acquireOwner).toHaveBeenCalledWith("p1");
    releasePending();
    await p1Session.close();
  });

  it("rechecks durable P1 work after acquiring the P0 owner", async () => {
    const p0 = owner();
    const pendingChecks = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const admission = new SingleDispatcherAdmission({
      acquireOwner: vi.fn().mockResolvedValue(p0),
      hasPendingPriorityLane: pendingChecks,
    });

    await expect(admission.admit("p0")).rejects.toThrow(
      "SINGLE_DISPATCHER_INCOMING_PENDING",
    );
    expect(pendingChecks).toHaveBeenCalledTimes(2);
    expect(p0.close).toHaveBeenCalledTimes(1);
  });

  it("never lets P1 preempt after the P0 owner is acquired", async () => {
    let releaseSecondCheck!: (value: boolean) => void;
    const secondCheck = new Promise<boolean>((resolve) => {
      releaseSecondCheck = resolve;
    });
    const p0 = owner();
    const p1 = owner();
    let activeOwners = 0;
    let maximumActiveOwners = 0;
    const wrap = (value: DispatcherOwner): DispatcherOwner => ({
      close: async () => {
        const result = await value.close();
        activeOwners -= 1;
        return result;
      },
    });
    const acquireOwner = vi.fn((lane: "p0" | "p1" | "acceptance") => {
      activeOwners += 1;
      maximumActiveOwners = Math.max(maximumActiveOwners, activeOwners);
      return Promise.resolve(wrap(lane === "p0" ? p0 : p1));
    });
    const pendingChecks = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => secondCheck)
      .mockResolvedValue(false);
    const admission = new SingleDispatcherAdmission({
      acquireOwner,
      hasPendingPriorityLane: pendingChecks,
    });

    const p0Attempt = admission.admit("p0");
    await vi.waitFor(() => expect(acquireOwner).toHaveBeenCalledWith("p0"));
    const releasePending = admission.announcePending("p1");
    await expect(admission.admit("p1")).rejects.toThrow(
      "SINGLE_DISPATCHER_BUSY",
    );
    releaseSecondCheck(true);
    await expect(p0Attempt).rejects.toThrow(
      "SINGLE_DISPATCHER_INCOMING_PENDING",
    );
    const p1Session = await admission.admit("p1");
    releasePending();
    await p1Session.close();

    expect(maximumActiveOwners).toBe(1);
  });

  it("keeps an owner-acquired timeout reservation until the late owner closes", async () => {
    let releaseCheck!: (value: boolean) => void;
    const secondCheck = new Promise<boolean>((resolve) => {
      releaseCheck = resolve;
    });
    const first = owner();
    const second = owner();
    const acquireOwner = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const admission = new SingleDispatcherAdmission({
      acquireOwner,
      hasPendingPriorityLane: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(() => secondCheck)
        .mockResolvedValue(false),
    });
    const late = admission.admit("p0");
    await vi.waitFor(() => expect(acquireOwner).toHaveBeenCalledTimes(1));
    admission.cancelPendingAcquisition();
    await expect(admission.admit("p1")).rejects.toThrow(
      "SINGLE_DISPATCHER_BUSY",
    );
    releaseCheck(true);
    await expect(late).rejects.toThrow(
      "SINGLE_DISPATCHER_ACQUISITION_CANCELED",
    );
    expect(first.close).toHaveBeenCalledTimes(1);
    const retry = await admission.admit("p1");
    await retry.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("cancels a hung post-owner priority query, closes that owner, and releases only afterwards", async () => {
    const never = new Promise<boolean>(() => undefined);
    const first = owner();
    const second = owner();
    const priority = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockReturnValueOnce(never)
      .mockResolvedValue(false);
    const admission = new SingleDispatcherAdmission({
      acquireOwner: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
      hasPendingPriorityLane: priority,
    });
    const pending = admission.admit("p0");
    await vi.waitFor(() => expect(priority).toHaveBeenCalledTimes(2));

    admission.cancelPendingAcquisition();
    await expect(pending).rejects.toThrow(
      "SINGLE_DISPATCHER_ACQUISITION_CANCELED",
    );
    expect(first.close).toHaveBeenCalledTimes(1);

    const retry = await admission.admit("p1");
    await retry.close();
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});

function owner(gateReleased = true): DispatcherOwner {
  return { close: vi.fn(() => Promise.resolve({ gateReleased })) };
}
