import { describe, expect, it } from "vitest";

import { SKIP_WAITING_MESSAGE, decideUpdate } from "./update-gate";

/**
 * Service-worker update gating (§21).
 *
 * The rule being protected: an update must never be applied while unsynced work
 * exists, because the new worker may load a different app version underneath
 * changes that have not reached the server yet.
 */

describe("service-worker update gating", () => {
  it("does nothing when no update is waiting", () => {
    expect(decideUpdate({ updateWaiting: false, pendingChanges: 0 })).toEqual({
      apply: false,
      reason: "no-update",
    });
    // Even with unsynced data, the reason reported is still "no update".
    expect(decideUpdate({ updateWaiting: false, pendingChanges: 5 }).apply).toBe(false);
  });

  it("applies an update when there is nothing unsynced", () => {
    expect(decideUpdate({ updateWaiting: true, pendingChanges: 0 })).toEqual({
      apply: true,
      reason: "no-unsynced-data",
    });
  });

  it("defers while unsynced changes exist", () => {
    const decision = decideUpdate({ updateWaiting: true, pendingChanges: 1 });

    expect(decision).toEqual({ apply: false, reason: "unsynced-data" });
  });

  it("defers while a sync is running, even with an empty queue", () => {
    // A sync in flight means the queue is about to change; activating now would
    // hand the new version a half-applied state.
    expect(decideUpdate({ updateWaiting: true, pendingChanges: 0, syncInProgress: true })).toEqual({
      apply: false,
      reason: "sync-in-progress",
    });
  });

  it("fails closed on an unknown pending count", () => {
    // A negative or NaN count means the caller could not read the queue; the
    // safe reading of "unknown" is "assume there is work".
    expect(decideUpdate({ updateWaiting: true, pendingChanges: Number.NaN }).apply).toBe(false);
  });

  it("uses a namespaced activation message", () => {
    expect(SKIP_WAITING_MESSAGE).toBe("securenotes:skip-waiting");
  });
});
