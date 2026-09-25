import type { SecureNotesDatabase, SyncQueueItem } from "../local/schema";
import { apiRequest, readCsrfToken } from "../api/client";
import { ApiError } from "../api/client";
import type { SyncFeedChange } from "./engine";

/**
 * Binding the sync engine to the API and the local database (§16).
 *
 * The engine decides *when* and *in what order*; this module knows *how*. Keeping them apart is what
 * lets the retry, compression and conflict rules be tested without a network.
 *
 * The uploaded payload is the one already in the local row: it is an envelope the browser produced when
 * the note was saved, so nothing is re-encrypted for sync and no plaintext is involved.
 */

/** A note's local row as the upload needs it. */
async function noteBody(db: SecureNotesDatabase, objectId: string, baseRevision: number | null) {
  const note = await db.notes.get(objectId);
  if (!note) {
    return null;
  }
  return {
    folderId: note.folderId,
    payload: note.payload,
    pinned: note.pinned,
    sortOrder: note.sortOrder,
    // The revision the edit was based on. The update contract requires it and the server derives the new
    // revision from it, which is what lets a stale edit become a conflict instead of an overwrite.
    ...(baseRevision === null ? {} : { baseRevision }),
  };
}

/**
 * Uploads one queued change.
 *
 * `create` on the server is a create; everything else is a patch carrying the base revision the edit
 * was based on, which is what lets the server detect a conflict instead of overwriting (§16).
 */
export async function pushChange(
  db: SecureNotesDatabase,
  change: SyncQueueItem,
): Promise<"ok" | "conflict" | "auth" | "retry"> {
  try {
    if (change.objectType === "note") {
      if (change.operation === "delete") {
        await apiRequest(`/notes/${change.objectId}`, { method: "DELETE" });
        return "ok";
      }
      const body = await noteBody(db, change.objectId, change.baseRevision);
      if (!body) {
        // The row is gone locally: there is nothing to upload, and holding the queue entry forever
        // would block the queue behind it.
        return "ok";
      }
      if (change.operation === "create") {
        // The revision travels only with the create: the payload was encrypted under it, so the server
        // must store that number rather than assuming 1, or every other device fails to decrypt. A patch
        // must not carry it — the update contract is strict, and the server derives the new revision from
        // the base it is given.
        const note = await db.notes.get(change.objectId);
        await apiRequest("/notes", {
          method: "POST",
          body: { id: change.objectId, revision: note?.revision ?? 1, ...body },
        });
      } else {
        await apiRequest(`/notes/${change.objectId}`, { method: "PATCH", body });
      }
      return "ok";
    }

    if (change.objectType === "folder") {
      if (change.operation === "delete") {
        await apiRequest(`/folders/${change.objectId}`, { method: "DELETE" });
        return "ok";
      }
      const folder = await db.folders.get(change.objectId);
      if (!folder) {
        return "ok";
      }
      const body = { parentId: folder.parentId, name: folder.name, sortOrder: folder.sortOrder };
      if (change.operation === "create") {
        await apiRequest("/folders", { method: "POST", body: { id: change.objectId, ...body } });
      } else {
        await apiRequest(`/folders/${change.objectId}`, {
          method: "PATCH",
          body: { ...body, baseRevision: change.baseRevision },
        });
      }
      return "ok";
    }

    if (change.objectType === "tag") {
      if (change.operation === "delete") {
        await apiRequest(`/tags/${change.objectId}`, { method: "DELETE" });
        return "ok";
      }
      const tag = await db.tags.get(change.objectId);
      if (!tag) {
        return "ok";
      }
      if (change.operation === "create") {
        await apiRequest("/tags", {
          method: "POST",
          body: { id: change.objectId, name: tag.name },
        });
      } else {
        await apiRequest(`/tags/${change.objectId}`, { method: "PATCH", body: { name: tag.name } });
      }
      return "ok";
    }

    // An object type this client does not upload: dropping the entry would be a silent loss, so it is
    // reported as a retryable failure and stays queued.
    return "retry";
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        return "auth";
      }
      if (error.status === 409) {
        return "conflict";
      }
      // 4xx other than those is a request the server will keep rejecting; retrying forever would block
      // the queue, so it is treated as a conflict for a human to look at.
      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        return "conflict";
      }
    }
    return "retry";
  }
}

/** Reads one batch of remote changes. */
export async function pullChanges(
  since: number,
  limit?: number,
): Promise<{ cursor: number; changes: SyncFeedChange[]; hasMore: boolean }> {
  const query = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`;
  return apiRequest(`/sync/changes?${query}`);
}

/** True when the browser reports a connection. */
export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * True when the session is unusable.
 *
 * A CSRF cookie is set alongside the session cookie and cleared with it, so its absence means the
 * session is gone as far as writes are concerned — worth checking before a push, because otherwise the
 * first upload fails and the queue entry is marked with a retry it cannot succeed at.
 */
export function hasSessionCookie(): boolean {
  return readCsrfToken() !== null;
}
