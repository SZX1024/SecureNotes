import type { SecureNotesDatabase } from "./schema";

/**
 * Cache eviction under storage pressure (§8).
 *
 * "When storage pressure occurs, oldest already-synced data may be evicted.
 * Synced attachments may be evicted and re-downloaded. Unsynced data must never
 * be automatically evicted."
 *
 * Two rules follow, and both are enforced here rather than left to callers:
 *
 * 1. only a row that is **synced** may be dropped — `syncedAt` must be set;
 * 2. only a row with **no pending queue entry** may be dropped, because a queued
 *    change means the user's intent has not reached the server yet.
 *
 * The second rule is the one that matters: `syncedAt` can be stale while an edit
 * is queued, and evicting then would silently lose the edit.
 */

export interface EvictionReport {
  /** Attachments whose cached ciphertext blob was dropped. */
  evictedAttachmentCaches: number;
  /** Bytes reclaimed, as reported by the cached blobs. */
  reclaimedBytes: number;
}

/** Object ids with work still queued, which must never be evicted. */
export async function pendingObjectIds(db: SecureNotesDatabase): Promise<Set<string>> {
  const queued = await db.syncQueue.toArray();
  return new Set(queued.map((item) => item.objectId));
}

/**
 * Bytes a cached blob occupies.
 *
 * The row's own `sizeBytes` is authoritative rather than `blob.size`: it is the
 * size the server reported, it survives every storage round trip, and it does not
 * depend on how a particular IndexedDB implementation clones a `Blob`.
 */
function cachedSize(row: { cachedBlob: Blob | null; sizeBytes: number }): number {
  return row.cachedBlob === null ? 0 : row.sizeBytes;
}

/**
 * Drops cached attachment ciphertext until the cached total is at or below
 * `maxBytes`, oldest first.
 *
 * Attachments are the only thing evicted, and only their *cached blob*: the row
 * itself stays, so the note still references the image and it can be re-fetched
 * from R2. Notes, folders and tags are tiny and are what make the app usable
 * offline, so they are not candidates at all.
 */
export async function evictAttachmentCaches(
  db: SecureNotesDatabase,
  options: { maxBytes: number },
): Promise<EvictionReport> {
  const cached = await db.attachments.filter((row) => row.cachedBlob !== null).toArray();
  if (cached.length === 0) {
    return { evictedAttachmentCaches: 0, reclaimedBytes: 0 };
  }

  const pending = await pendingObjectIds(db);
  let total = cached.reduce((sum, row) => sum + cachedSize(row), 0);
  if (total <= options.maxBytes) {
    return { evictedAttachmentCaches: 0, reclaimedBytes: 0 };
  }

  // Oldest cache first, so the most recently viewed images survive.
  const candidates = cached
    .filter((row) => row.syncedAt !== null && !pending.has(row.id))
    .sort((a, b) => (a.cachedAt ?? 0) - (b.cachedAt ?? 0));

  let evicted = 0;
  let reclaimed = 0;

  for (const row of candidates) {
    if (total <= options.maxBytes) {
      break;
    }
    const size = cachedSize(row);
    await db.attachments.update(row.id, { cachedBlob: null, cachedAt: null });
    total -= size;
    reclaimed += size;
    evicted += 1;
  }

  return { evictedAttachmentCaches: evicted, reclaimedBytes: reclaimed };
}

/** Whether one row may be evicted, exposed so the rule can be asserted directly. */
export function isEvictable(
  row: { syncedAt: number | null },
  pending: ReadonlySet<string>,
  id: string,
): boolean {
  return row.syncedAt !== null && !pending.has(id);
}
