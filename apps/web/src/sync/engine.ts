import type { SecureNotesDatabase, SyncQueueItem } from "../local/schema";
import { acknowledgeChange, pendingChangeCount, recordSyncFailure } from "../local/sync-queue";

/**
 * The sync engine (§16, §17).
 *
 * Everything here is expressed as pure functions plus one orchestrator that takes its side effects as
 * parameters, so the rules — which edits may be compressed, what backoff is, when an object is paused,
 * which state the UI should show — are tested directly rather than inferred from a network trace.
 *
 * Two invariants run through the whole file:
 * - **a queued change is only removed by a server acknowledgement.** Dropping one on any other
 *   condition is how an edit is silently lost;
 * - **the local text is the truth for local work.** A remote change never overwrites an object that has
 *   unsynced local edits; that situation is a conflict, per §16's "delete-vs-modify is always a conflict".
 */

export const SYNC_CURSOR_KEY = "sync-cursor";
export const SYNC_CONFLICT_PREFIX = "sync-conflict:";

/** §17: the states the interface has to be able to show. */
export type SyncState =
  "synced" | "pending" | "syncing" | "conflict" | "offline" | "sync-error" | "auth-required";

/**
 * Collapses repeated edits to the same object.
 *
 * §16 allows compressing continuous edits during upload, and requires that unsynced intent is never
 * discarded. Both hold here: a run of changes to one object becomes a single entry carrying the newest
 * operation and the **first** entry's base revision, because that is the revision the object was
 * actually based on. A create followed by updates compresses to a create, and a delete anywhere in the
 * run wins, since it supersedes everything before it.
 */
/**
 * Reduces what has to be uploaded, without ever discarding intent.
 *
 * The one reduction that is provably safe is a **create followed by a delete**: the object never existed
 * on the server, so neither operation needs to be sent. Everything else is uploaded in order, one
 * request per queued change.
 *
 * Compressing a run of edits is *not* safe here, and this is worth spelling out because it looks like an
 * easy win: a note's revision is inside the envelope's AAD, so the payload of the third edit can only be
 * stored as revision 3. Merging three edits into one upload would store that payload as the revision
 * after the first, and every other device would then fail to decrypt the note — silently, since a row
 * that cannot be decrypted is skipped rather than shown as broken. The revision the client encrypts
 * under and the revision the server records have to stay in lockstep, which means one upload per edit.
 *
 * §16 permits compression ("may be compressed") and requires that unsynced intent is never discarded;
 * this satisfies both by only dropping work that has no effect.
 */
export function compressQueue(items: readonly SyncQueueItem[]): SyncQueueItem[] {
  const groups = new Map<string, SyncQueueItem[]>();
  const order: string[] = [];

  for (const item of items) {
    const key = `${item.objectType}:${item.objectId}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(item);
  }

  const kept: SyncQueueItem[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const first = group[0]!;
    const last = group[group.length - 1]!;

    if (first.operation === "create") {
      if (last.operation === "delete") {
        // Created and deleted before either reached the server: it has never heard of this object, so
        // neither operation has anything to say to it.
        continue;
      }
      // The create uploads the object as it is *now*, including the revision the current payload was
      // encrypted under. Every queued edit after it is therefore already inside that upload, and
      // replaying them would send base revisions the server has already moved past — which is exactly
      // how a conflict gets created out of nothing.
      kept.push(first);
      continue;
    }

    if (last.operation === "delete") {
      // The object is gone; the edits on the way there do not need to be replayed for the outcome to be
      // the same, and the delete carries no payload to mismatch.
      kept.push(last);
      continue;
    }

    // The object already exists on the server, so each edit is uploaded in order: the revision is part of
    // the ciphertext's AAD, and the server's revision has to advance one step per edit to stay in step
    // with it.
    kept.push(...group);
  }

  return kept;
}

/** Exponential backoff with a cap (§16). */
export function backoffDelayMs(attempts: number, baseMs = 2_000, capMs = 300_000): number {
  const exponent = Math.max(0, attempts - 1);
  // Capped before the shift so the exponent cannot overflow into a useless number.
  return Math.min(baseMs * 2 ** Math.min(exponent, 20), capMs);
}

/** §16: after repeated failures automatic retry pauses and the user is offered Sync Now. */
export const MAX_AUTOMATIC_ATTEMPTS = 5;

export function isDue(item: SyncQueueItem, nowMs: number): boolean {
  if (item.attempts >= MAX_AUTOMATIC_ATTEMPTS && item.nextAttemptAt !== null) {
    // Paused: only an explicit Sync Now may retry it.
    return false;
  }
  return item.nextAttemptAt === null || item.nextAttemptAt <= nowMs;
}

export function isPaused(item: SyncQueueItem): boolean {
  return item.attempts >= MAX_AUTOMATIC_ATTEMPTS;
}

export interface SyncStateInput {
  pending: number;
  syncing: boolean;
  conflicts: number;
  online: boolean;
  authRequired: boolean;
  /** True when at least one queued change has given up on automatic retry. */
  paused: boolean;
}

/**
 * Derives the state the interface shows (§17).
 *
 * Ordered by what the user needs to act on: an expired session first, then a conflict, then being
 * offline, then a paused queue, then work in flight.
 */
export function deriveSyncState(input: SyncStateInput): SyncState {
  if (input.authRequired) {
    return "auth-required";
  }
  if (input.conflicts > 0) {
    return "conflict";
  }
  if (!input.online) {
    return "offline";
  }
  if (input.paused) {
    return "sync-error";
  }
  if (input.syncing) {
    return "syncing";
  }
  return input.pending > 0 ? "pending" : "synced";
}

/** What a push attempt means. */
export type PushResult = "ok" | "conflict" | "auth" | "retry";

export interface SyncFeedChange {
  seq: number;
  objectType: string;
  objectId: string;
  changeType: "create" | "update" | "delete";
  revision: number | null;
  changedAt: number;
  payload: Record<string, unknown> | null;
}

export interface SyncDependencies {
  db: SecureNotesDatabase;
  /** Uploads one change. The engine decides order, compression and retry. */
  push: (change: SyncQueueItem) => Promise<PushResult>;
  /** Reads one batch of remote changes from a cursor. */
  pull: (since: number) => Promise<{ cursor: number; changes: SyncFeedChange[]; hasMore: boolean }>;
  /** Applies one remote change locally. Returns "conflict" when local work must keep priority. */
  apply: (change: SyncFeedChange) => Promise<"applied" | "conflict" | "ignored">;
  now?: () => number;
  /** How many pull batches to accept before yielding, so a huge backlog cannot hang the tab. */
  maxPullBatches?: number;
}

export interface SyncOutcome {
  pushed: number;
  pulled: number;
  conflicts: number;
  state: SyncState;
  /** Why syncing stopped early, when it did. */
  stoppedBy: "auth" | "none";
}

/**
 * Removes the edits a successful create has already carried.
 *
 * Only create and update entries go: those describe states the uploaded payload already reflects. A
 * delete stays, because it is an instruction about the future rather than a state of the object.
 */
async function discardSubsumedEdits(
  db: SecureNotesDatabase,
  objectType: string,
  objectId: string,
): Promise<void> {
  const queued = await db.syncQueue.where("objectId").equals(objectId).toArray();
  const subsumed = queued.filter(
    (entry) => entry.objectType === objectType && entry.operation !== "delete",
  );
  for (const entry of subsumed) {
    if (entry.id !== undefined) {
      await acknowledgeChange(db, entry.id);
    }
  }
}

/** Reads the stored cursor. */
export async function readCursor(db: SecureNotesDatabase): Promise<number> {
  const row = await db.meta.get(SYNC_CURSOR_KEY);
  const value = row?.value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Stores the cursor. Only ever called with a cursor the server itself returned. */
export async function writeCursor(db: SecureNotesDatabase, cursor: number): Promise<void> {
  await db.meta.put({ key: SYNC_CURSOR_KEY, value: cursor });
}

/** Marks an object as paused by a conflict, so the UI can list it (§16). */
export async function recordLocalConflict(
  db: SecureNotesDatabase,
  objectType: string,
  objectId: string,
  detail: { remoteRevision: number | null; reason: string },
): Promise<void> {
  await db.meta.put({
    key: `${SYNC_CONFLICT_PREFIX}${objectType}:${objectId}`,
    value: { ...detail, at: Date.now() },
  });
}

export async function listLocalConflicts(
  db: SecureNotesDatabase,
): Promise<
  Array<{ objectType: string; objectId: string; reason: string; remoteRevision: number | null }>
> {
  const rows = await db.meta.toArray();
  return rows
    .filter((row) => row.key.startsWith(SYNC_CONFLICT_PREFIX))
    .map((row) => {
      const [objectType = "", objectId = ""] = row.key
        .slice(SYNC_CONFLICT_PREFIX.length)
        .split(":");
      const value = (row.value ?? {}) as { reason?: string; remoteRevision?: number | null };
      return {
        objectType,
        objectId,
        reason: value.reason ?? "conflict",
        remoteRevision: value.remoteRevision ?? null,
      };
    });
}

export async function clearLocalConflict(
  db: SecureNotesDatabase,
  objectType: string,
  objectId: string,
): Promise<void> {
  await db.meta.delete(`${SYNC_CONFLICT_PREFIX}${objectType}:${objectId}`);
}

/**
 * Runs one sync pass: push what is queued, then pull what is new.
 *
 * Push first on purpose. Uploading before downloading means the local state a conflict is judged
 * against is the one the server has, rather than a remote state applied a moment ago. Each object is
 * pushed serially — its compressed run is one request — while different objects proceed in parallel,
 * which is what §16 asks for.
 */
export async function syncNow(deps: SyncDependencies): Promise<SyncOutcome> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  let pushed = 0;
  let conflicts = 0;
  let stoppedBy: "auth" | "none" = "none";

  const queued = await deps.db.syncQueue.orderBy("queuedAt").toArray();
  const compressed = compressQueue(queued);

  // One compressed run per object, each awaited in turn within its own group.
  const groups = new Map<string, SyncQueueItem[]>();
  for (const item of compressed) {
    const key = `${item.objectType}:${item.objectId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const results = await Promise.all(
    [...groups.entries()].map(async ([key, items]) => {
      for (const item of items) {
        if (!isDue(item, startedAt)) {
          continue;
        }
        const outcome = await deps.push(item);
        if (outcome === "ok") {
          if (item.id !== undefined) {
            await acknowledgeChange(deps.db, item.id);
          }
          if (item.operation === "create") {
            // A create uploads the object as it is now, at the revision its payload was encrypted under, so
            // the edits queued after it are already inside it. Leaving them queued would replay base
            // revisions the server has moved past, and each replay would be answered with a conflict. A
            // pending delete is kept: the object has to be deleted on the server too.
            await discardSubsumedEdits(deps.db, item.objectType, item.objectId);
          }
          pushed += 1;
          continue;
        }
        if (outcome === "auth") {
          return { key, outcome: "auth" as const };
        }
        if (outcome === "conflict") {
          // §16: the object is paused until the conflict is resolved; the entry stays queued, because
          // the local work it carries is still the user's.
          await recordLocalConflict(deps.db, item.objectType, item.objectId, {
            remoteRevision: null,
            reason: "revision",
          });
          return { key, outcome: "conflict" as const };
        }
        // A transient failure: keep the entry and schedule the next attempt.
        if (item.id !== undefined) {
          const attempts = item.attempts + 1;
          await recordSyncFailure(deps.db, item.id, now() + backoffDelayMs(attempts));
        }
        return { key, outcome: "retry" as const };
      }
      return { key, outcome: "ok" as const };
    }),
  );

  for (const result of results) {
    if (result.outcome === "conflict") {
      conflicts += 1;
    }
  }
  if (results.some((result) => result.outcome === "auth")) {
    stoppedBy = "auth";
  }

  // Pull unless the session is gone: without a session every request would fail anyway.
  let pulled = 0;
  let cursor = await readCursor(deps.db);
  if (stoppedBy !== "auth") {
    const maxBatches = deps.maxPullBatches ?? 10;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const feed = await deps.pull(cursor);
      for (const change of feed.changes) {
        const applied = await deps.apply(change);
        if (applied === "conflict") {
          conflicts += 1;
        }
        if (applied !== "ignored") {
          pulled += 1;
        }
      }
      // The cursor only moves over changes that were handled, so an interruption re-reads nothing and
      // skips nothing.
      cursor = feed.cursor;
      await writeCursor(deps.db, cursor);
      if (!feed.hasMore) {
        break;
      }
    }
  }

  const pending = await pendingChangeCount(deps.db);
  const allQueued = await deps.db.syncQueue.toArray();
  const state = deriveSyncState({
    pending,
    syncing: false,
    conflicts,
    online: true,
    authRequired: stoppedBy === "auth",
    paused: allQueued.some(isPaused),
  });

  return { pushed, pulled, conflicts, state, stoppedBy };
}
