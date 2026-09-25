import type { SecureNotesDatabase, SyncQueueItem } from "../local/schema";
import type { SyncFeedChange } from "./engine";

/**
 * Applying remote changes locally (§16).
 *
 * The rule that shapes this file: **local unsynced work wins**. A remote change is applied only when
 * the object has nothing queued, because overwriting an object the user has edited but not uploaded is
 * how their work would disappear. A remote deletion against a locally modified object is not applied at
 * all — §16 calls that case a conflict, and it is always one.
 *
 * Payloads are stored exactly as they arrive: they are ciphertext envelopes the client cannot read
 * without the DEK, and it has no reason to read them here. Decryption happens when a note is opened.
 */

export interface ApplyDependencies {
  db: SecureNotesDatabase;
  now?: () => number;
}

export interface ApplyOutcome {
  result: "applied" | "conflict" | "ignored";
  /** Set when the change was skipped because local work is pending. */
  reason?: "local-edits-pending";
}

/** Queued changes for one object, oldest first. */
async function pendingFor(db: SecureNotesDatabase, objectId: string): Promise<SyncQueueItem[]> {
  return db.syncQueue.where("objectId").equals(objectId).toArray();
}

export async function applyRemoteChange(
  change: SyncFeedChange,
  deps: ApplyDependencies,
): Promise<ApplyOutcome> {
  const { db } = deps;

  // Only objects with a local representation are handled: an unknown object type is not an error, it is
  // simply something this client version does not store.
  if (
    change.objectType !== "note" &&
    change.objectType !== "folder" &&
    change.objectType !== "tag"
  ) {
    return { result: "ignored" };
  }

  const queued = await pendingFor(db, change.objectId);
  if (queued.length > 0) {
    // Something local has not been uploaded yet. Applying the remote side now would discard it, so the
    // object is left alone and reported as needing attention.
    if (change.changeType === "delete") {
      return { result: "conflict", reason: "local-edits-pending" };
    }
    return { result: "conflict", reason: "local-edits-pending" };
  }

  if (change.objectType === "note") {
    if (change.changeType === "delete") {
      // A tombstone: the note exists in the recycle bin until it is purged, and the local row records
      // that it is gone rather than disappearing, so the deletion survives a restart.
      const existing = await db.notes.get(change.objectId);
      if (existing) {
        await db.notes.put({
          ...existing,
          deletedAt: change.changedAt,
          syncedAt: change.changedAt,
        });
      }
      return { result: existing ? "applied" : "ignored" };
    }

    const payload = change.payload as { payload?: unknown; deletedAt?: number | null } | null;
    const envelope = payload?.payload;
    if (!envelope) {
      return { result: "ignored" };
    }

    const existing = await db.notes.get(change.objectId);
    await db.notes.put({
      id: change.objectId,
      folderId: (payload as { folderId?: string | null }).folderId ?? null,
      revision: change.revision ?? existing?.revision ?? 1,
      payload: envelope as never,
      deletedAt: payload.deletedAt ?? null,
      pinned: (payload as { pinned?: boolean }).pinned ?? false,
      sortOrder: (payload as { sortOrder?: number }).sortOrder ?? 0,
      createdAt:
        (payload as { createdAt?: number }).createdAt ?? existing?.createdAt ?? change.changedAt,
      updatedAt: change.changedAt,
      // Marked as synced: it came from the server, so it has nothing pending.
      syncedAt: change.changedAt,
    });
    return { result: "applied" };
  }

  if (change.objectType === "folder") {
    const existing = await db.folders.get(change.objectId);
    if (change.changeType === "delete") {
      if (existing) {
        await db.folders.delete(change.objectId);
      }
      return { result: existing ? "applied" : "ignored" };
    }
    const payload = change.payload as {
      name?: unknown;
      parentId?: string | null;
      depth?: number;
      sortOrder?: number;
    } | null;
    if (!payload?.name) {
      return { result: "ignored" };
    }
    await db.folders.put({
      id: change.objectId,
      parentId: payload.parentId ?? null,
      depth: payload.depth ?? existing?.depth ?? 1,
      name: payload.name as never,
      deletedAt: null,
      sortOrder: payload.sortOrder ?? 0,
      createdAt: existing?.createdAt ?? change.changedAt,
      updatedAt: change.changedAt,
      syncedAt: change.changedAt,
    });
    return { result: "applied" };
  }

  // Tags.
  const existing = await db.tags.get(change.objectId);
  if (change.changeType === "delete") {
    if (existing) {
      await db.tags.delete(change.objectId);
    }
    return { result: existing ? "applied" : "ignored" };
  }
  const payload = change.payload as { name?: unknown } | null;
  if (!payload?.name) {
    return { result: "ignored" };
  }
  await db.tags.put({
    id: change.objectId,
    name: payload.name as never,
    createdAt: existing?.createdAt ?? change.changedAt,
    updatedAt: change.changedAt,
    syncedAt: change.changedAt,
  });
  return { result: "applied" };
}

/**
 * Binds `applyRemoteChange` to the engine's dependency shape.
 *
 * The engine only needs to know the outcome, not the reason, so this unwraps it in one place instead of
 * at every call site.
 */
export function applyRemote(
  db: SecureNotesDatabase,
): (change: SyncFeedChange) => Promise<"applied" | "conflict" | "ignored"> {
  return async (change) => (await applyRemoteChange(change, { db })).result;
}
