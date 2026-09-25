import { describe, expect, it, vi } from "vitest";

import { IDLE_SYNC_DELAY_MS, SyncScheduler, attachSyncTriggers } from "./scheduler";

/**
 * Sync triggers (§17).
 *
 * Timers are injected so the rules can be checked without waiting five seconds, and without a browser:
 * what is scheduled, what replaces what, and what happens when a trigger fires mid-pass.
 */

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    setTimeoutFn: (handler: () => void) => {
      const id = (next += 1);
      pending.set(id, handler);
      return id;
    },
    clearTimeoutFn: (handle: unknown) => {
      pending.delete(handle as number);
    },
    /** Runs everything currently scheduled. */
    fire: () => {
      const handlers = [...pending.entries()];
      pending.clear();
      for (const [, handler] of handlers) {
        handler();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

describe("idle scheduling (§17)", () => {
  it("waits five seconds after the last edit", async () => {
    expect(IDLE_SYNC_DELAY_MS).toBe(5_000);
    const timers = fakeTimers();
    const delays: number[] = [];
    const run = vi.fn(async () => undefined);

    const scheduler = new SyncScheduler({
      run,
      setTimeoutFn: (handler, timeout) => {
        delays.push(timeout);
        return timers.setTimeoutFn(handler);
      },
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    scheduler.scheduleAfterIdle();
    expect(run).not.toHaveBeenCalled();
    expect(delays).toEqual([5_000]);

    timers.fire();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending pass when the user keeps typing", () => {
    const timers = fakeTimers();
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler({
      run,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    scheduler.scheduleAfterIdle();
    scheduler.scheduleAfterIdle();
    scheduler.scheduleAfterIdle();

    // Only one pass is pending: a burst of edits must not queue a burst of syncs.
    expect(timers.size).toBe(1);
    expect(scheduler.hasPendingSchedule).toBe(true);
  });

  it("runs once more, not twice, when a trigger arrives mid-pass", async () => {
    const timers = fakeTimers();
    let resolveRun: (() => void) | null = null;
    const run = vi.fn(() => {
      if (run.mock.calls.length > 1) {
        // The extra pass finishes on its own; only the first one is held open.
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
    });
    const scheduler = new SyncScheduler({
      run,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const first = scheduler.syncNow();
    // Two triggers while the first pass is in flight.
    await scheduler.syncNow();
    await scheduler.syncNow();

    expect(run).toHaveBeenCalledTimes(1);
    resolveRun!();
    await first;

    // One extra pass covers whatever arrived, which is why the flag is not a counter.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops scheduling once the app locks", () => {
    const timers = fakeTimers();
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler({
      run,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    scheduler.scheduleAfterIdle();
    scheduler.stop();

    expect(scheduler.hasPendingSchedule).toBe(false);
    // A locked app must not sync: its keys are gone and its queue is none of the server's business.
    timers.fire();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("browser triggers (§17)", () => {
  function fakeWindow() {
    const listeners = new Map<string, Array<() => void>>();
    const document = {
      visibilityState: "visible" as string,
      addEventListener: (type: string, handler: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
      },
      removeEventListener: (type: string, handler: () => void) => {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((entry) => entry !== handler),
        );
      },
    };
    return {
      document,
      addEventListener: (type: string, handler: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
      },
      removeEventListener: (type: string, handler: () => void) => {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((entry) => entry !== handler),
        );
      },
      fire: (type: string) => {
        for (const handler of listeners.get(type) ?? []) {
          handler();
        }
      },
      countListeners: () =>
        [...listeners.values()].reduce((total, entries) => total + entries.length, 0),
    };
  }

  it("syncs on network recovery, on focus and when the tab becomes visible", () => {
    const timers = fakeTimers();
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler({
      run,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    const host = fakeWindow();

    attachSyncTriggers(scheduler, host as unknown as Window);

    host.fire("online");
    host.fire("focus");
    host.fire("visibilitychange");

    // Each trigger starts a pass; the scheduler coalesces them.
    return Promise.resolve().then(() => {
      expect(run).toHaveBeenCalled();
    });
  });

  it("removes every listener on teardown", () => {
    const timers = fakeTimers();
    const scheduler = new SyncScheduler({
      run: vi.fn(),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    const host = fakeWindow();

    const detach = attachSyncTriggers(scheduler, host as unknown as Window);
    expect(host.countListeners()).toBeGreaterThan(0);

    detach();
    expect(host.countListeners()).toBe(0);
  });
});
