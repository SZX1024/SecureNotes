/**
 * When a sync happens (§17).
 *
 * "Automatic sync occurs: approximately 5 seconds after the user stops editing; on application startup;
 * on page resume; immediately after network recovery. Provide manual Sync Now."
 *
 * This module owns that schedule and nothing else, so the timing rules can be tested without a browser
 * or a network. It never lets two passes overlap: a trigger that fires while a pass is running sets a
 * flag and runs once more at the end, because dropping the trigger would lose the edits that caused it.
 */

/** How long after the last edit a sync is scheduled (§17: "approximately 5 seconds"). */
export const IDLE_SYNC_DELAY_MS = 5_000;

export interface SchedulerOptions {
  /** Runs one pass. The scheduler only cares whether it finished. */
  run: () => Promise<void>;
  delayMs?: number;
  setTimeoutFn?: (handler: () => void, timeout: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export class SyncScheduler {
  readonly #run: () => Promise<void>;
  readonly #delayMs: number;
  readonly #setTimeout: (handler: () => void, timeout: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;

  #timer: unknown = null;
  #running = false;
  #runAgain = false;
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#run = options.run;
    this.#delayMs = options.delayMs ?? IDLE_SYNC_DELAY_MS;
    this.#setTimeout = options.setTimeoutFn ?? ((handler, timeout) => setTimeout(handler, timeout));
    this.#clearTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
  }

  /** True while a pass is in flight. */
  get isRunning(): boolean {
    return this.#running;
  }

  /** Schedules a pass after the idle delay, replacing any pending one. */
  scheduleAfterIdle(): void {
    if (this.#stopped) {
      return;
    }
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer);
    }
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.syncNow();
    }, this.#delayMs);
  }

  /**
   * Runs a pass immediately.
   *
   * Called on startup, on page resume, after network recovery and by the manual button. Concurrent
   * callers are coalesced rather than queued up: one extra pass is run at most, which is enough to cover
   * whatever arrived while the previous one was working.
   */
  async syncNow(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    if (this.#running) {
      this.#runAgain = true;
      return;
    }

    this.#running = true;
    try {
      await this.#run();
    } finally {
      this.#running = false;
    }

    if (this.#runAgain) {
      this.#runAgain = false;
      await this.syncNow();
    }
  }

  /** Stops scheduling. Used when the app locks, so a locked app does not sync. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** Whether a pass is scheduled for later. */
  get hasPendingSchedule(): boolean {
    return this.#timer !== null;
  }
}

/**
 * The browser events §17 names, wired to the scheduler.
 *
 * Returns a function that removes every listener, so a locked app leaves nothing behind.
 */
export function attachSyncTriggers(scheduler: SyncScheduler, target?: Window): () => void {
  const host = target ?? (typeof window === "undefined" ? undefined : window);
  if (!host) {
    return () => undefined;
  }

  const onResume = () => void scheduler.syncNow();
  const onVisible = () => {
    if (host.document.visibilityState === "visible") {
      void scheduler.syncNow();
    }
  };
  const onOnline = () => void scheduler.syncNow();

  host.addEventListener("online", onOnline);
  host.addEventListener("focus", onResume);
  host.document.addEventListener("visibilitychange", onVisible);

  return () => {
    host.removeEventListener("online", onOnline);
    host.removeEventListener("focus", onResume);
    host.document.removeEventListener("visibilitychange", onVisible);
  };
}
