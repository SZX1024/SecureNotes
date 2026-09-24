import type { SecureNotesDatabase } from "../local/schema";

/**
 * Sync-queue helpers.
 *
 * The queue is the only record of work that has not reached the server yet, so
 * everything here is read-only or additive: nothing in the client removes a
 * queued change except a confirmed upload (§8, §16).
 */

/** How many changes are waiting to be uploaded. */
export async function pendingChangeCount(db: SecureNotesDatabase): Promise<number> {
  return db.syncQueue.count();
}

/** Queues a change, returning the queue id. */
export async function enqueueChange(
  db: SecureNotesDatabase,
  change: {
    objectType: string;
    objectId: string;
    operation: "create" | "update" | "delete";
    baseRevision: number | null;
  },
): Promise<number> {
  const id = await db.syncQueue.add({
    ...change,
    queuedAt: Date.now(),
    attempts: 0,
    nextAttemptAt: null,
  });
  if (typeof id !== "number") {
    // An auto-incremented key is always assigned; a missing one would mean the
    // entry cannot be acknowledged later, which must not pass silently.
    throw new Error("the sync queue did not return a key for the new entry");
  }
  return id;
}

/**
 * Removes a queued change after the server confirmed it.
 *
 * Only ever called with a server acknowledgement: dropping a queue entry on any
 * other condition is how an edit gets silently lost.
 */
export async function acknowledgeChange(db: SecureNotesDatabase, queueId: number): Promise<void> {
  await db.syncQueue.delete(queueId);
}

/** Records a failed attempt and schedules the next try with backoff (§16). */
export async function recordSyncFailure(
  db: SecureNotesDatabase,
  queueId: number,
  retryAt: number,
): Promise<void> {
  const item = await db.syncQueue.get(queueId);
  if (!item) {
    return;
  }
  await db.syncQueue.update(queueId, {
    attempts: item.attempts + 1,
    nextAttemptAt: retryAt,
  });
}
