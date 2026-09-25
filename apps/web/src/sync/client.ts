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
export interface PushHooks {
  /**
   * The attachment ids a note references.
   *
   * Supplied by the caller because the references live inside the note's encrypted payload, and the sync
   * engine has no key by design: it decides order, compression and retry, and asks for plaintext only when a
   * push genuinely needs it.
   */
  attachmentRefs?: (noteId: string) => Promise<string[]>;
}

export async function pushChange(
  db: SecureNotesDatabase,
  change: SyncQueueItem,
  hooks: PushHooks = {},
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

    if (change.objectType === "note_attachment") {
      if (!hooks.attachmentRefs) {
        // A programming error, and deliberately not a silent success: acknowledging an entry the server was
        // never told about would drop the user's reference with no trace of it having happened.
        throw new Error(
          "pushChange needs the attachment reference reader for note_attachment changes",
        );
      }
      const desired = new Set(await hooks.attachmentRefs(change.objectId));
      // The server keeps one id per link, so the delta is computed against what it has: linking and
      // unlinking are each idempotent, which is what lets a retry of this entry be harmless.
      const { attachments } = await apiRequest<{ attachments: Array<{ id: string }> }>(
        `/notes/${change.objectId}/attachments`,
      ).catch((error: unknown) => {
        // 404 here means the note is not on the server yet, not that anything is wrong: the note's own upload
        // may have been rejected or may still be queued. Retrying is the answer — pausing the note as a
        // conflict would ask the user to resolve a conflict the server never recorded.
        if (error instanceof ApiError && error.status === 404) {
          throw new ApiError("PRECONDITION_FAILED", 412, "the note is not on the server yet");
        }
        throw error;
      });
      const current = new Set(attachments.map((attachment) => attachment.id));

      for (const id of desired) {
        if (!current.has(id)) {
          await apiRequest(`/notes/${change.objectId}/attachments`, {
            method: "POST",
            body: { attachmentId: id },
          });
        }
      }
      for (const id of current) {
        if (!desired.has(id)) {
          await apiRequest(`/notes/${change.objectId}/attachments/${id}`, { method: "DELETE" });
        }
      }
      return "ok";
    }

    if (change.objectType === "note_tag_link") {
      // The note's tag set is uploaded as a whole: the server replaces it, so this is idempotent and a retry
      // cannot double-apply a link (§16: set semantics where they are safe).
      const links = await db.noteTags.where("noteId").equals(change.objectId).toArray();
      try {
        await apiRequest(`/notes/${change.objectId}/tags`, {
          method: "PUT",
          body: { tagIds: links.map((link) => link.tagId) },
        });
      } catch (error) {
        // A 404 means the note is not on the server yet, not that anything is wrong — an imported copy's tags can
        // be pushed before its note. Retrying is the answer; pausing the note as a conflict would ask the user to
        // resolve a conflict the server never recorded.
        if (error instanceof ApiError && error.status === 404) {
          throw new ApiError("PRECONDITION_FAILED", 412, "the note is not on the server yet");
        }
        throw error;
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
      /**
       * A 412 is "not yet" rather than "no": a note can reach the server before the folder it was moved into,
       * because they are separate queued changes. That is answered by retrying — the next pass uploads the
       * folder first, since the engine orders folders before notes — so it must not pause the note as a
       * conflict the user cannot act on.
       */
      const retryable =
        error.status === 408 ||
        error.status === 412 ||
        error.status === 425 ||
        error.status === 429;
      if (error.status >= 400 && error.status < 500 && !retryable) {
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
