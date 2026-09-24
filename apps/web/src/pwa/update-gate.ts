/**
 * Service-worker update gating (§21).
 *
 * "Service Worker updates are automatic when safe. If unsynced data exists,
 * delay update until synchronization is safe."
 *
 * An update means activating a new worker that may clean caches and, more
 * importantly, load a different app version underneath the running one. Doing
 * that while edits are still queued risks losing them, so the decision is made
 * here, as a pure function, and the service worker only activates when the page
 * tells it to.
 */

export interface UpdateDecisionInput {
  /** A new service worker finished installing and is waiting to activate. */
  updateWaiting: boolean;
  /** Number of queued changes that have not reached the server. */
  pendingChanges: number;
  /**
   * Whether a sync is currently in flight. Updating mid-sync would leave the
   * queue in a state the new version has to guess at.
   */
  syncInProgress?: boolean;
}

export type UpdateDecision =
  | { apply: true; reason: "no-unsynced-data" }
  | { apply: false; reason: "no-update" }
  | { apply: false; reason: "unsynced-data" }
  | { apply: false; reason: "sync-in-progress" };

/**
 * Decides whether the waiting service worker may take over.
 *
 * Fail-closed: anything that could mean unfinished work keeps the current worker
 * alive, because applying an update is never urgent and losing an edit is not
 * recoverable.
 */
export function decideUpdate(input: UpdateDecisionInput): UpdateDecision {
  if (!input.updateWaiting) {
    return { apply: false, reason: "no-update" };
  }
  if (input.syncInProgress === true) {
    return { apply: false, reason: "sync-in-progress" };
  }
  // A count that is not a finite number means the queue could not be read, and
  // "unknown" must be treated as "there is work": applying an update is never
  // urgent, losing a queued edit is not recoverable.
  const pending = Number.isFinite(input.pendingChanges) ? input.pendingChanges : 1;
  if (pending > 0) {
    return { apply: false, reason: "unsynced-data" };
  }
  return { apply: true, reason: "no-unsynced-data" };
}

/** Message the page sends to a waiting service worker to let it activate. */
export const SKIP_WAITING_MESSAGE = "securenotes:skip-waiting" as const;
