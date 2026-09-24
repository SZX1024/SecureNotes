import { MAX_ATTACHMENT_BYTES, type CryptoEnvelope } from "@securenotes/shared";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { syncChangeStatement } from "./records";

/**
 * Attachments (§9).
 *
 * Only images, at most 20 MB. The object key is random, the original filename is
 * encrypted, and the bytes stored in R2 are the client's ciphertext — the worker
 * never sees the image itself.
 *
 * An attachment is an independent entity because one image can be referenced by
 * several notes, so deletion is reference-counted: reaching zero enqueues an
 * asynchronous R2 deletion rather than blocking the user's operation (§9).
 */

export interface AttachmentRow {
  id: string;
  r2_key: string;
  name_iv: string;
  name_ciphertext: string;
  crypto_version: number;
  key_version: number;
  content_type: string;
  size_bytes: number;
  ref_count: number;
  deletion_enqueued_at: number | null;
  created_at: number;
  updated_at: number;
}

export function serializeAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    name: {
      crypto_version: row.crypto_version,
      key_version: row.key_version,
      alg: "AES-256-GCM" as const,
      iv: row.name_iv,
      ciphertext: row.name_ciphertext,
    },
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    refCount: row.ref_count,
    pendingDeletion: row.deletion_enqueued_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function r2KeyFor(attachmentId: string): string {
  return `attachments/${attachmentId}`;
}

export async function findAttachment(
  env: Env,
  userId: string,
  id: string,
): Promise<AttachmentRow | null> {
  return env.DB.prepare("SELECT * FROM attachments WHERE id = ?1 AND user_id = ?2")
    .bind(id, userId)
    .first<AttachmentRow>();
}

export interface UploadInput {
  id: string;
  name: CryptoEnvelope;
  contentType: string;
  /** Declared plaintext-equivalent size; must agree with the uploaded bytes. */
  sizeBytes: number;
  blob: ArrayBuffer;
}

/**
 * Stores an uploaded attachment.
 *
 * The declared size and the real size must agree: the 20 MB limit is only
 * meaningful if the client cannot understate what it sent, and `size_bytes` is
 * what the eviction and quota logic later trusts.
 */
export async function storeAttachment(
  env: Env,
  userId: string,
  input: UploadInput,
  nowMs: number,
): Promise<AttachmentRow> {
  if (!input.contentType.toLowerCase().startsWith("image/")) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", { diagnostic: "only images are supported" });
  }
  if (input.blob.byteLength === 0) {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "the upload is empty" });
  }
  if (input.blob.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new ApiError("PAYLOAD_TOO_LARGE", { diagnostic: "attachments are limited to 20 MB" });
  }
  if (input.sizeBytes !== input.blob.byteLength) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: "sizeBytes does not match the uploaded bytes",
    });
  }

  const existing = await findAttachment(env, userId, input.id);
  if (existing) {
    throw new ApiError("CONFLICT", { diagnostic: "an attachment with that id already exists" });
  }

  const r2Key = r2KeyFor(input.id);
  await env.ATTACHMENTS.put(r2Key, input.blob, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO attachments
           (id, user_id, r2_key, name_iv, name_ciphertext, crypto_version, key_version, content_type, size_bytes, ref_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)`,
      ).bind(
        input.id,
        userId,
        r2Key,
        input.name.iv,
        input.name.ciphertext,
        input.name.crypto_version,
        input.name.key_version,
        input.contentType,
        input.sizeBytes,
        nowMs,
      ),
      syncChangeStatement(env, {
        userId,
        objectType: "attachment",
        objectId: input.id,
        changeType: "create",
        changedAt: nowMs,
      }),
    ]);
  } catch (error) {
    // Do not leave an orphan object behind if the row could not be written.
    await env.ATTACHMENTS.delete(r2Key);
    throw error;
  }

  return (await findAttachment(env, userId, input.id))!;
}

/** The stored ciphertext, for a client that is allowed to see the attachment. */
export async function readAttachmentBytes(
  env: Env,
  userId: string,
  id: string,
): Promise<{ row: AttachmentRow; body: ReadableStream } | null> {
  const row = await findAttachment(env, userId, id);
  if (!row) {
    return null;
  }
  const object = await env.ATTACHMENTS.get(row.r2_key);
  if (!object) {
    return null;
  }
  return { row, body: object.body };
}

/** Links an attachment to a note, incrementing the reference count (§9). */
export async function linkAttachment(
  env: Env,
  userId: string,
  noteId: string,
  attachmentId: string,
  nowMs: number,
): Promise<void> {
  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ?1 AND user_id = ?2")
    .bind(noteId, userId)
    .first<{ id: string }>();
  if (!note) {
    throw new ApiError("NOT_FOUND", { diagnostic: "note does not exist" });
  }
  const attachment = await findAttachment(env, userId, attachmentId);
  if (!attachment) {
    throw new ApiError("NOT_FOUND", { diagnostic: "attachment does not exist" });
  }
  if (attachment.deletion_enqueued_at !== null) {
    throw new ApiError("PRECONDITION_FAILED", { diagnostic: "the attachment is pending deletion" });
  }

  const already = await env.DB.prepare(
    "SELECT 1 AS present FROM note_attachments WHERE note_id = ?1 AND attachment_id = ?2",
  )
    .bind(noteId, attachmentId)
    .first<number>("present");
  if (already) {
    return;
  }

  // The link and the count move together, so the count always equals the number
  // of link rows.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO note_attachments (note_id, attachment_id, created_at) VALUES (?1, ?2, ?3)",
    ).bind(noteId, attachmentId, nowMs),
    env.DB.prepare(
      "UPDATE attachments SET ref_count = ref_count + 1, updated_at = ?2 WHERE id = ?1",
    ).bind(attachmentId, nowMs),
    syncChangeStatement(env, {
      userId,
      objectType: "note_attachment",
      objectId: `${noteId}:${attachmentId}`,
      changeType: "create",
      changedAt: nowMs,
    }),
  ]);
}

/**
 * Unlinks an attachment. Reaching zero references enqueues the R2 deletion
 * instead of performing it inline, so a user operation is never blocked on
 * object storage (§9).
 */
export async function unlinkAttachment(
  env: Env,
  userId: string,
  noteId: string,
  attachmentId: string,
  nowMs: number,
): Promise<{ refCount: number; deletionEnqueued: boolean }> {
  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ?1 AND user_id = ?2")
    .bind(noteId, userId)
    .first<{ id: string }>();
  if (!note) {
    throw new ApiError("NOT_FOUND");
  }

  const link = await env.DB.prepare(
    "SELECT 1 AS present FROM note_attachments WHERE note_id = ?1 AND attachment_id = ?2",
  )
    .bind(noteId, attachmentId)
    .first<number>("present");
  if (!link) {
    throw new ApiError("NOT_FOUND", { diagnostic: "the note does not reference that attachment" });
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM note_attachments WHERE note_id = ?1 AND attachment_id = ?2").bind(
      noteId,
      attachmentId,
    ),
    env.DB.prepare(
      "UPDATE attachments SET ref_count = ref_count - 1, updated_at = ?2 WHERE id = ?1 AND ref_count > 0",
    ).bind(attachmentId, nowMs),
    syncChangeStatement(env, {
      userId,
      objectType: "note_attachment",
      objectId: `${noteId}:${attachmentId}`,
      changeType: "delete",
      changedAt: nowMs,
    }),
  ]);

  const row = await env.DB.prepare("SELECT ref_count AS c FROM attachments WHERE id = ?1")
    .bind(attachmentId)
    .first<number>("c");
  const refCount = row ?? 0;

  let deletionEnqueued = false;
  if (refCount === 0) {
    const enqueued = await env.DB.prepare(
      "UPDATE attachments SET deletion_enqueued_at = ?2 WHERE id = ?1 AND deletion_enqueued_at IS NULL",
    )
      .bind(attachmentId, nowMs)
      .run();
    deletionEnqueued = (enqueued.meta.changes ?? 0) > 0;
  }

  return { refCount, deletionEnqueued };
}

export async function listNoteAttachments(env: Env, userId: string, noteId: string) {
  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ?1 AND user_id = ?2")
    .bind(noteId, userId)
    .first<{ id: string }>();
  if (!note) {
    throw new ApiError("NOT_FOUND");
  }

  const rows = await env.DB.prepare(
    `SELECT attachments.* FROM attachments
       JOIN note_attachments ON note_attachments.attachment_id = attachments.id
      WHERE note_attachments.note_id = ?1 AND attachments.user_id = ?2`,
  )
    .bind(noteId, userId)
    .all<AttachmentRow>();

  return rows.results.map(serializeAttachment);
}

/**
 * Deletes the R2 objects of attachments whose reference count reached zero, then
 * their rows.
 *
 * Idempotent by construction: `R2.delete` of a missing key succeeds, and the row
 * is only removed after the object is gone, so a retry after a partial failure
 * simply repeats the same work.
 */
export async function purgeDeletedAttachments(
  env: Env,
  nowMs: number,
  batchSize = 50,
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, r2_key, user_id FROM attachments
      WHERE ref_count = 0 AND deletion_enqueued_at IS NOT NULL
      ORDER BY deletion_enqueued_at ASC LIMIT ?1`,
  )
    .bind(batchSize)
    .all<{ id: string; r2_key: string; user_id: string }>();

  let removed = 0;
  for (const row of rows.results) {
    await env.ATTACHMENTS.delete(row.r2_key);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM attachments WHERE id = ?1").bind(row.id),
      syncChangeStatement(env, {
        userId: row.user_id,
        objectType: "attachment",
        objectId: row.id,
        changeType: "delete",
        changedAt: nowMs,
      }),
    ]);
    removed += 1;
  }

  return removed;
}
