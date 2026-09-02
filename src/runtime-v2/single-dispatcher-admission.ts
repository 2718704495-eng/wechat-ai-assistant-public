export type DispatcherLane = "p0" | "p1" | "acceptance";

export interface DispatcherOwner {
  readonly close: () => Promise<{ readonly gateReleased: boolean }>;
}

export interface DispatcherSession<
  TOwner extends DispatcherOwner = DispatcherOwner,
> {
  readonly lane: DispatcherLane;
  readonly owner: TOwner;
  readonly close: () => Promise<{
    readonly closed: true;
    readonly gateReleased: true;
  }>;
}

export interface SingleDispatcherAdmissionOptions<
  TOwner extends DispatcherOwner,
> {
  readonly acquireOwner: (lane: DispatcherLane) => Promise<TOwner>;
  readonly hasPendingPriorityLane?: (
    lane: DispatcherLane,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}

export class SingleDispatcherAdmission<
  TOwner extends DispatcherOwner = DispatcherOwner,
> {
  private reservation: symbol | null = null;
  private pendingReservation: {
    token: symbol;
    lane: DispatcherLane;
    phase: "pre-owner" | "owner-acquired";
    cancellation: AbortController | null;
  } | null = null;
  private quarantined = false;
  private readonly pendingLanes = new Map<DispatcherLane, number>();

  public constructor(
    private readonly options: SingleDispatcherAdmissionOptions<TOwner>,
  ) {}

  public async admit(lane: DispatcherLane): Promise<DispatcherSession<TOwner>> {
    if (!isLane(lane)) throw new Error("SINGLE_DISPATCHER_LANE_INVALID");
    if (this.quarantined) throw new Error("SINGLE_DISPATCHER_QUARANTINED");
    if (
      lane === "p1" &&
      this.pendingReservation?.lane === "p0" &&
      this.pendingReservation.phase === "pre-owner" &&
      this.reservation === this.pendingReservation.token
    ) {
      this.reservation = null;
      this.pendingReservation = null;
    }
    if (this.reservation !== null) throw new Error("SINGLE_DISPATCHER_BUSY");
    const reservation = Symbol(lane);
    this.reservation = reservation;
    this.pendingReservation = {
      token: reservation,
      lane,
      phase: "pre-owner",
      cancellation: null,
    };
    if (lane === "p0") {
      let durablePending: boolean;
      try {
        durablePending =
          (await this.options.hasPendingPriorityLane?.("p1")) === true;
      } catch (error: unknown) {
        this.releaseReservation(reservation);
        throw error;
      }
      if (
        (this.pendingLanes.get("p1") ?? 0) > 0 ||
        durablePending ||
        this.reservation !== reservation
      ) {
        this.releaseReservation(reservation);
        throw new Error("SINGLE_DISPATCHER_INCOMING_PENDING");
      }
    }
    if (this.quarantined) {
      this.releaseReservation(reservation);
      throw new Error("SINGLE_DISPATCHER_QUARANTINED");
    }
    if (this.reservation !== reservation) {
      throw new Error(
        lane === "p0"
          ? "SINGLE_DISPATCHER_INCOMING_PENDING"
          : "SINGLE_DISPATCHER_ACQUISITION_CANCELED",
      );
    }
    let owner: TOwner;
    try {
      owner = await this.options.acquireOwner(lane);
    } catch (error: unknown) {
      if (this.reservation === reservation) this.reservation = null;
      if (this.pendingReservation?.token === reservation)
        this.pendingReservation = null;
      throw error;
    }
    if (this.reservation !== reservation) {
      const lateClose = await owner.close();
      if (lateClose.gateReleased !== true) this.quarantined = true;
      throw new Error("SINGLE_DISPATCHER_ACQUISITION_CANCELED");
    }
    if (this.pendingReservation?.token === reservation) {
      this.pendingReservation = {
        token: reservation,
        lane,
        phase: "owner-acquired",
        cancellation: new AbortController(),
      };
    }
    if (lane === "p0") {
      let durablePending: boolean;
      try {
        const cancellation =
          this.pendingReservation?.token === reservation
            ? this.pendingReservation.cancellation
            : null;
        durablePending =
          (await this.queryPriorityLane("p1", cancellation?.signal)) === true;
      } catch (error: unknown) {
        await this.closeRejectedOwner(owner, reservation);
        if (isAdmissionCancellation(error)) {
          throw new Error("SINGLE_DISPATCHER_ACQUISITION_CANCELED", {
            cause: error,
          });
        }
        throw error;
      }
      if (
        (this.pendingLanes.get("p1") ?? 0) > 0 ||
        durablePending ||
        this.reservation !== reservation
      ) {
        await this.closeRejectedOwner(owner, reservation);
        throw new Error("SINGLE_DISPATCHER_INCOMING_PENDING");
      }
    }
    if (this.pendingReservation?.token === reservation)
      this.pendingReservation = null;
    let closePromise: Promise<{ closed: true; gateReleased: true }> | null =
      null;
    return Object.freeze({
      lane,
      owner,
      close: () => {
        closePromise ??= this.closeOwner(reservation, owner);
        return closePromise;
      },
    });
  }

  public announcePending(lane: DispatcherLane): () => void {
    if (!isLane(lane)) throw new Error("SINGLE_DISPATCHER_LANE_INVALID");
    this.pendingLanes.set(lane, (this.pendingLanes.get(lane) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pendingLanes.get(lane) ?? 1) - 1;
      if (remaining === 0) this.pendingLanes.delete(lane);
      else this.pendingLanes.set(lane, remaining);
    };
  }

  public cancelPendingAcquisition(): void {
    const pending = this.pendingReservation;
    if (pending === null) return;
    if (pending.phase === "owner-acquired") {
      pending.cancellation?.abort(
        new Error("SINGLE_DISPATCHER_ACQUISITION_CANCELED"),
      );
      return;
    }
    if (this.reservation === pending.token) this.reservation = null;
    this.pendingReservation = null;
  }

  public isQuarantined(): boolean {
    return this.quarantined;
  }

  public quarantine(): void {
    this.quarantined = true;
  }

  private releaseReservation(reservation: symbol): void {
    if (this.reservation === reservation) this.reservation = null;
    if (this.pendingReservation?.token === reservation)
      this.pendingReservation = null;
  }

  private queryPriorityLane(
    lane: DispatcherLane,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const query =
      this.options.hasPendingPriorityLane?.(lane, signal) ??
      Promise.resolve(false);
    if (signal === undefined) return query;
    if (signal.aborted)
      return Promise.reject(priorityQueryError(signal.reason));
    return new Promise<boolean>((resolve, reject) => {
      const cancel = (): void => reject(priorityQueryError(signal.reason));
      signal.addEventListener("abort", cancel, { once: true });
      query.then(
        (value) => {
          signal.removeEventListener("abort", cancel);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel);
          reject(priorityQueryError(error));
        },
      );
    });
  }

  private async closeRejectedOwner(
    owner: DispatcherOwner,
    reservation: symbol,
  ): Promise<void> {
    try {
      const result = await owner.close();
      if (result.gateReleased !== true) {
        this.quarantined = true;
        throw new Error("SINGLE_DISPATCHER_GATE_RELEASE_UNPROVEN");
      }
    } catch (error: unknown) {
      this.quarantined = true;
      throw error;
    } finally {
      this.releaseReservation(reservation);
    }
  }

  private async closeOwner(
    reservation: symbol,
    owner: DispatcherOwner,
  ): Promise<{ closed: true; gateReleased: true }> {
    let result: { readonly gateReleased: boolean };
    try {
      result = await owner.close();
    } catch (error: unknown) {
      this.quarantined = true;
      throw error;
    }
    if (result.gateReleased !== true) {
      this.quarantined = true;
      throw new Error("SINGLE_DISPATCHER_GATE_RELEASE_UNPROVEN");
    }
    if (this.reservation !== reservation) {
      this.quarantined = true;
      throw new Error("SINGLE_DISPATCHER_RESERVATION_MISMATCH");
    }
    this.reservation = null;
    return { closed: true, gateReleased: true };
  }
}

function isAdmissionCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "SINGLE_DISPATCHER_ACQUISITION_CANCELED"
  );
}

function priorityQueryError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("SINGLE_DISPATCHER_PRIORITY_QUERY_FAILED", { cause: reason });
}

function isLane(value: unknown): value is DispatcherLane {
  return value === "p0" || value === "p1" || value === "acceptance";
}
