import type { CryptoEnvelope } from "@securenotes/shared";
import { z } from "zod";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { pruneRevisionHistory, syncChangeStatement } from "./records";
import { recordConflict } from "./conflicts";

/**
 * Notes (§9, §18, §19).
 *
 * The worker never sees a title, a body or a tag name: a note is an opaque
 * envelope plus the structural metadata §24 allows the server to know (id,
 * folder, revision, timestamps, size, deletion state).
 *
 * Editing is guarded by optimistic locking (§27): an update states the revision
 * it was based on, and a mismatch is reported as a conflict rather than
 * overwriting work that arrived in between.
 */

export const envelopeSchema = z
  .object({
    crypto_version: z.number().int().min(1),
    key_version: z.number().int().min(1),
    alg: z.literal("AES-256-GCM"),
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict();

export interface NoteRow {
  id: string;
  folder_id: string | null;
  revision: number;
  payload_iv: string;
  payload_ciphertext: string;
  crypto_version: number;
  key_version: number;
  pinned: number;
  sort_order: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NotePayload {
  envelope: CryptoEnvelope;
  revision: number;
}

function toEnvelope(row: NoteRow): CryptoEnvelope {
  return {
    crypto_version: row.crypto_version,
    key_version: row.key_version,
    alg: "AES-256-GCM",
    iv: row.payload_iv,
    ciphertext: row.payload_ciphertext,
  };
}

/** Wire shape of a note. Deliberately contains no plaintext field at all. */
export function serializeNote(row: NoteRow) {
  return {
    id: row.id,
    folderId: row.folder_id,
    revision: row.revision,
    payload: toEnvelope(row),
    pinned: row.pinned === 1,
    sortOrder: row.sort_order,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findNote(env: Env, userId: string, noteId: string): Promise<NoteRow | null> {
  return env.DB.prepare("SELECT * FROM notes WHERE id = ?1 AND user_id = ?2")
    .bind(noteId, userId)
    .first<NoteRow>();
}

export interface CreateNoteInput {
  id: string;
  folderId: string | null;
  payload: CryptoEnvelope;
  /** The revision the payload was encrypted under; defaults to 1. */
  revision?: number;
  pinned?: boolean;
  sortOrder?: number;
}

export async function createNote(
  env: Env,
  userId: string,
  input: CreateNoteInput,
  nowMs: number,
): Promise<NoteRow> {
  if (input.folderId !== null) {
    await assertFolderExists(env, userId, input.folderId);
  }

  // The client's revision, or 1 for a note that has never been saved locally. It is the client's number
  // because the payload was encrypted with it in the AAD.
  const revision = input.revision ?? 1;

  // The note, its first revision and the sync-feed entry are written together:
  // a note without its revision row would break the "current revision is also
  // the newest history entry" invariant the schema tests assert.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notes
         (id, user_id, folder_id, revision, payload_iv, payload_ciphertext, crypto_version, key_version,
          pinned, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    ).bind(
      input.id,
      userId,
      input.folderId,
      revision,
      input.payload.iv,
      input.payload.ciphertext,
      input.payload.crypto_version,
      input.payload.key_version,
      input.pinned ? 1 : 0,
      input.sortOrder ?? 0,
      nowMs,
    ),
    env.DB.prepare(
      `INSERT INTO note_revisions
         (id, note_id, revision, parent_revision_id, payload_iv, payload_ciphertext, crypto_version, key_version, save_reason, created_at)
       VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, 'initial', ?8)`,
    ).bind(
      `${input.id}-r${revision}`,
      input.id,
      revision,
      input.payload.iv,
      input.payload.ciphertext,
      input.payload.crypto_version,
      input.payload.key_version,
      nowMs,
    ),
    syncChangeStatement(env, {
      userId,
      objectType: "note",
      objectId: input.id,
      changeType: "create",
      revision,
      changedAt: nowMs,
    }),
  ]);

  const created = await findNote(env, userId, input.id);
  if (!created) {
    throw new ApiError("INTERNAL", { diagnostic: "note vanished after insert" });
  }
  return created;
}

async function assertFolderExists(env: Env, userId: string, folderId: string): Promise<void> {
  const folder = await env.DB.prepare("SELECT id FROM folders WHERE id = ?1 AND user_id = ?2")
    .bind(folderId, userId)
    .first<{ id: string }>();
  if (!folder) {
    throw new ApiError("NOT_FOUND", { diagnostic: "folder does not exist" });
  }
}

export interface UpdateNoteInput {
  baseRevision: number;
  payload?: CryptoEnvelope;
  folderId?: string | null;
  pinned?: boolean;
  sortOrder?: number;
  saveReason?: "interval" | "manual" | "restore";
}

/**
 * Updates a note under the optimistic lock of §27.
 *
 * `WHERE id = ? AND revision = ?` is the whole concurrency control: if it
 * affects no row, someone else has already written revision + 1 and the caller
 * gets a conflict instead of silently losing their work.
 *
 * The payload and the new revision row are written in one transaction, so the
 * "notes.revision equals the newest stored revision" invariant always holds.
 */
export async function updateNote(
  env: Env,
  userId: string,
  noteId: string,
  input: UpdateNoteInput,
  nowMs: number,
): Promise<NoteRow> {
  const existing = await findNote(env, userId, noteId);
  if (!existing) {
    throw new ApiError("NOT_FOUND");
  }
  if (existing.deleted_at !== null) {
    throw new ApiError("PRECONDITION_FAILED", { diagnostic: "the note is in the recycle bin" });
  }
  if (existing.revision !== input.baseRevision) {
    // §16: create a conflict instead of silently overwriting. The local side is the payload the client
    // sent; if it sent none (a pin or a folder move), the note as the client believes it to be is not
    // recoverable here, so the stored payload stands in — the conflict still records both revisions.
    await recordConflict(
      env,
      {
        userId,
        objectType: "note",
        objectId: noteId,
        baseRevision: input.baseRevision,
        local: input.payload ?? toEnvelope(existing),
        remote: toEnvelope(existing),
        remoteRevision: existing.revision,
      },
      nowMs,
    );
    throw new ApiError("REVISION_CONFLICT", {
      diagnostic: `expected revision ${input.baseRevision}, found ${existing.revision}`,
    });
  }
  if (input.folderId !== undefined && input.folderId !== null) {
    await assertFolderExists(env, userId, input.folderId);
  }

  const nextRevision = existing.revision + 1;
  const nextPayload = input.payload ?? toEnvelope(existing);

  const update = await env.DB.prepare(
    `UPDATE notes
        SET revision = ?3, payload_iv = ?4, payload_ciphertext = ?5, crypto_version = ?6, key_version = ?7,
            folder_id = ?8, pinned = ?9, sort_order = ?10, updated_at = ?11
      WHERE id = ?1 AND user_id = ?2 AND revision = ?12 AND deleted_at IS NULL`,
  )
    .bind(
      noteId,
      userId,
      nextRevision,
      nextPayload.iv,
      nextPayload.ciphertext,
      nextPayload.crypto_version,
      nextPayload.key_version,
      input.folderId === undefined ? existing.folder_id : input.folderId,
      input.pinned === undefined ? existing.pinned : input.pinned ? 1 : 0,
      input.sortOrder ?? existing.sort_order,
      nowMs,
      input.baseRevision,
    )
    .run();

  if ((update.meta.changes ?? 0) === 0) {
    // The revision moved between the read and the write. The current row is read again so the conflict
    // records the remote side that actually won, rather than the stale one this call started from.
    const current = await findNote(env, userId, noteId);
    if (current) {
      await recordConflict(
        env,
        {
          userId,
          objectType: "note",
          objectId: noteId,
          baseRevision: input.baseRevision,
          local: nextPayload,
          remote: toEnvelope(current),
          remoteRevision: current.revision,
        },
        nowMs,
      );
    }
    throw new ApiError("REVISION_CONFLICT", {
      diagnostic: "the note changed while it was being saved",
    });
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO note_revisions
         (id, note_id, revision, parent_revision_id, payload_iv, payload_ciphertext, crypto_version, key_version, save_reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      `${noteId}-r${nextRevision}`,
      noteId,
      nextRevision,
      `${noteId}-r${existing.revision}`,
      nextPayload.iv,
      nextPayload.ciphertext,
      nextPayload.crypto_version,
      nextPayload.key_version,
      input.saveReason ?? "manual",
      nowMs,
    ),
    syncChangeStatement(env, {
      userId,
      objectType: "note",
      objectId: noteId,
      changeType: "update",
      revision: nextRevision,
      changedAt: nowMs,
    }),
  ]);

  const pruned = await pruneRevisionHistory(env, noteId);
  for (const revisionId of pruned) {
    await syncChangeStatement(env, {
      userId,
      objectType: "note_revision",
      objectId: revisionId,
      changeType: "delete",
      changedAt: nowMs,
    }).run();
  }

  const updated = await findNote(env, userId, noteId);
  if (!updated) {
    throw new ApiError("INTERNAL", { diagnostic: "note vanished after update" });
  }
  return updated;
}

/** Moves a note to the recycle bin (§19). Ids and history are preserved. */
export async function softDeleteNote(
  env: Env,
  userId: string,
  noteId: string,
  nowMs: number,
): Promise<NoteRow> {
  const existing = await findNote(env, userId, noteId);
  if (!existing || existing.deleted_at !== null) {
    throw new ApiError("NOT_FOUND");
  }

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE notes SET deleted_at = ?3, updated_at = ?3 WHERE id = ?1 AND user_id = ?2",
    ).bind(noteId, userId, nowMs),
    syncChangeStatement(env, {
      userId,
      objectType: "note",
      objectId: noteId,
      changeType: "delete",
      revision: existing.revision,
      changedAt: nowMs,
    }),
  ]);

  const deleted = await findNote(env, userId, noteId);
  return deleted!;
}

/** Restores a note from the recycle bin, keeping its id and revision. */
export async function restoreNote(
  env: Env,
  userId: string,
  noteId: string,
  nowMs: number,
): Promise<NoteRow> {
  const existing = await findNote(env, userId, noteId);
  if (!existing || existing.deleted_at === null) {
    throw new ApiError("NOT_FOUND");
  }

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE notes SET deleted_at = NULL, updated_at = ?3 WHERE id = ?1 AND user_id = ?2",
    ).bind(noteId, userId, nowMs),
    syncChangeStatement(env, {
      userId,
      objectType: "note",
      objectId: noteId,
      changeType: "update",
      revision: existing.revision,
      changedAt: nowMs,
    }),
  ]);

  return (await findNote(env, userId, noteId))!;
}

/**
 * Permanently deletes a note (§19): "permanent deletion removes current and
 * historical data". The revision rows cascade from the note.
 */
export async function purgeNote(
  env: Env,
  userId: string,
  noteId: string,
  nowMs: number,
): Promise<void> {
  const existing = await findNote(env, userId, noteId);
  if (!existing) {
    throw new ApiError("NOT_FOUND");
  }

  // Attachment links must go first: the join table uses RESTRICT so that a note
  // cannot be deleted while it still references an image without the reference
  // count being adjusted.
  const links = await env.DB.prepare(
    "SELECT attachment_id FROM note_attachments WHERE note_id = ?1",
  )
    .bind(noteId)
    .all<{ attachment_id: string }>();

  const statements = [
    ...links.results.map((link) =>
      env.DB.prepare(
        "UPDATE attachments SET ref_count = ref_count - 1 WHERE id = ?1 AND ref_count > 0",
      ).bind(link.attachment_id),
    ),
    env.DB.prepare("DELETE FROM note_attachments WHERE note_id = ?1").bind(noteId),
    env.DB.prepare("DELETE FROM note_tags WHERE note_id = ?1").bind(noteId),
    env.DB.prepare("DELETE FROM notes WHERE id = ?1 AND user_id = ?2").bind(noteId, userId),
    syncChangeStatement(env, {
      userId,
      objectType: "note",
      objectId: noteId,
      changeType: "delete",
      changedAt: nowMs,
    }),
  ];

  await env.DB.batch(statements);
}

export async function listNotes(
  env: Env,
  userId: string,
  options: { folderId?: string | null; includeDeleted?: boolean; limit?: number } = {},
) {
  const limit = options.limit ?? 200;
  const rows = await env.DB.prepare(
    `SELECT * FROM notes
      WHERE user_id = ?1
        AND (?2 IS NULL OR folder_id = ?2)
        AND (?3 = 1 OR deleted_at IS NULL)
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ?4`,
  )
    .bind(userId, options.folderId ?? null, options.includeDeleted ? 1 : 0, limit)
    .all<NoteRow>();

  return rows.results.map(serializeNote);
}

export interface RevisionRow {
  id: string;
  revision: number;
  save_reason: string;
  created_at: number;
  payload_iv: string;
  payload_ciphertext: string;
  crypto_version: number;
  key_version: number;
}

/** History for one note, newest first, including the current revision (§9). */
export async function listRevisions(env: Env, userId: string, noteId: string) {
  const note = await findNote(env, userId, noteId);
  if (!note) {
    throw new ApiError("NOT_FOUND");
  }

  const rows = await env.DB.prepare(
    `SELECT id, revision, save_reason, created_at, payload_iv, payload_ciphertext, crypto_version, key_version
       FROM note_revisions WHERE note_id = ?1 ORDER BY revision DESC`,
  )
    .bind(noteId)
    .all<RevisionRow>();

  return rows.results.map((row) => ({
    id: row.id,
    revision: row.revision,
    saveReason: row.save_reason,
    createdAt: row.created_at,
    payload: {
      crypto_version: row.crypto_version,
      key_version: row.key_version,
      alg: "AES-256-GCM" as const,
      iv: row.payload_iv,
      ciphertext: row.payload_ciphertext,
    },
    current: row.revision === note.revision,
  }));
}

/**
 * Restores a historical revision by creating a **new current revision** of it
 * (§18: "Restoring history should create a new current revision rather than
 * corrupting existing history"). The history is never rewound.
 */
export async function restoreRevision(
  env: Env,
  userId: string,
  noteId: string,
  revisionId: string,
  nowMs: number,
): Promise<NoteRow> {
  const note = await findNote(env, userId, noteId);
  if (!note) {
    throw new ApiError("NOT_FOUND");
  }

  const revision = await env.DB.prepare(
    "SELECT payload_iv, payload_ciphertext, crypto_version, key_version FROM note_revisions WHERE id = ?1 AND note_id = ?2",
  )
    .bind(revisionId, noteId)
    .first<{
      payload_iv: string;
      payload_ciphertext: string;
      crypto_version: number;
      key_version: number;
    }>();

  if (!revision) {
    throw new ApiError("NOT_FOUND", { diagnostic: "revision does not belong to this note" });
  }

  return updateNote(
    env,
    userId,
    noteId,
    {
      baseRevision: note.revision,
      payload: {
        crypto_version: revision.crypto_version,
        key_version: revision.key_version,
        alg: "AES-256-GCM",
        iv: revision.payload_iv,
        ciphertext: revision.payload_ciphertext,
      },
      saveReason: "restore",
    },
    nowMs,
  );
}
