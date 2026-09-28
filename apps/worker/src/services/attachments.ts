import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_RETENTION_MS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type CryptoEnvelope,
} from "@securenotes/shared";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { syncChangeStatement } from "./records";

/**
 * Attachments (§9).
 *
 * Any file, at most 60 MB. The object key is random, the original filename is
 * encrypted, and the bytes stored in R2 are the client's ciphertext — the worker never
 * sees the file itself, and the media type is the only thing about a file's content
 * that it learns.
 *
 * An attachment is an independent entity because one file can be referenced by
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
  content_iv: string | null;
  plaintext_size_bytes: number | null;
  ref_count: number;
  deletion_enqueued_at: number | null;
  /** Null for an attachment that is kept; a timestamp for one that is temporary. */
  expires_at: number | null;
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
    /**
     * The IV the content was encrypted with.
     *
     * It is not part of the content response, which returns bare ciphertext, so without this a device cannot
     * assemble the envelope and the attachment's bytes can never be decrypted by anyone — which is what a note
     * full of broken images looks like.
     */
    expiresAt: row.expires_at,
    contentIv: row.content_iv,
    /**
     * The versions the content envelope was encrypted with.
     *
     * The row's columns, which the name envelope uses as well: both were written by the same client with the
     * same key. They are named here rather than left inside `name` because assembling the content envelope
     * needs them, and a client that guessed would fail to decrypt every attachment.
     */
    cryptoVersion: row.crypto_version,
    keyVersion: row.key_version,
    sizeBytes: row.size_bytes,
    plaintextSizeBytes: row.plaintext_size_bytes,
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
  /** IV of the content envelope. Without it the stored bytes cannot be decrypted. */
  contentIv: string;
  /** Size of the plaintext the ciphertext was produced from. */
  plaintextSizeBytes: number;
  /** When the attachment should be removed, or null to keep it. */
  expiresAt: number | null;
  blob: ArrayBuffer;
}

/**
 * A media type, and nothing else. The stored value is echoed back in a response
 * header, so it must not be able to carry anything but a type: `text/plain\r\nX-…`
 * would be a header injection, and it is exactly what a check that only tests for a
 * `/` would let through. Keeping the grammar strict is what makes widening the rule
 * from `image/%` to "any type" safe.
 */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/**
 * Whether an upload would exceed what the account may store.
 *
 * Separate from the query that produces `usedBytes` so the boundary can be tested without filling a database, and
 * separate from the caller so the message that describes it lives in one place.
 */
export function attachmentQuotaProblem(usedBytes: number, addingBytes: number): string | null {
  if (usedBytes + addingBytes <= MAX_ATTACHMENT_TOTAL_BYTES) {
    return null;
  }
  return `this account stores at most ${Math.round(MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024 * 1024))} GB of attachments, and ${Math.round(
    usedBytes / (1024 * 1024),
  )} MB of it is in use`;
}

/** Everything the account currently stores, in bytes. */
export async function attachmentUsageBytes(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM attachments WHERE user_id = ?1",
  )
    .bind(userId)
    .first<number>("used");
  return row ?? 0;
}

/**
 * Stores an uploaded attachment.
 *
 * The declared size and the real size must agree: the limit is only meaningful if the
 * client cannot understate what it sent, and `size_bytes` is what the eviction and
 * quota logic later trusts.
 */
export async function storeAttachment(
  env: Env,
  userId: string,
  input: UploadInput,
  nowMs: number,
): Promise<AttachmentRow> {
  if (!MEDIA_TYPE.test(input.contentType)) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", {
      diagnostic: "the content type is not a media type",
    });
  }
  if (input.blob.byteLength === 0) {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "the upload is empty" });
  }
  if (input.blob.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new ApiError("PAYLOAD_TOO_LARGE", {
      diagnostic: `attachments are limited to ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`,
    });
  }
  // AES-GCM appends a 16-byte tag, so ciphertext = plaintext + 16 exactly. Checking it
  // binds the two declared numbers to each other: a client cannot claim a small
  // plaintext for a large upload, and a mismatch means the envelope is inconsistent.
  if (input.contentIv.length === 0) {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "a content IV is required" });
  }
  if (input.sizeBytes - input.plaintextSizeBytes !== 16) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: "plaintextSizeBytes and sizeBytes are inconsistent with AES-GCM",
    });
  }
  if (input.sizeBytes !== input.blob.byteLength) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: "sizeBytes does not match the uploaded bytes",
    });
  }
  // An expiry in the past would delete the file the moment the sweep ran, and one far in the future is a policy
  // mistake rather than a long-lived file. Both are rejected here rather than silently accepted.
  if (input.expiresAt !== null) {
    if (input.expiresAt <= nowMs) {
      throw new ApiError("VALIDATION_FAILED", { diagnostic: "the expiry is in the past" });
    }
    if (input.expiresAt - nowMs > MAX_ATTACHMENT_RETENTION_MS) {
      throw new ApiError("VALIDATION_FAILED", { diagnostic: "the expiry is too far away" });
    }
  }

  const existing = await findAttachment(env, userId, input.id);
  if (existing) {
    throw new ApiError("CONFLICT", { diagnostic: "an attachment with that id already exists" });
  }

  // Checked before the object is written: a rejected upload should not cost a round trip to R2 and a delete.
  const quotaProblem = attachmentQuotaProblem(
    await attachmentUsageBytes(env, userId),
    input.sizeBytes,
  );
  if (quotaProblem !== null) {
    throw new ApiError("PAYLOAD_TOO_LARGE", { diagnostic: quotaProblem });
  }

  const r2Key = r2KeyFor(input.id);
  await env.ATTACHMENTS.put(r2Key, input.blob, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO attachments
           (id, user_id, r2_key, name_iv, name_ciphertext, crypto_version, key_version, content_type, size_bytes, content_iv, plaintext_size_bytes, ref_count, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?13)`,
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
        input.contentIv,
        input.plaintextSizeBytes,
        input.expiresAt,
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
 * Deletes the R2 objects of attachments that were asked for or whose time is up, then
 * their rows.
 *
 * Two conditions, one sweep: an attachment whose references reached zero, and one whose expiry has passed. The second
 * deletes regardless of references, because that is what an expiry means — the note that mentions it keeps the text and
 * loses the file, which is the honest outcome of asking for a temporary copy.
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
      WHERE (ref_count = 0 AND deletion_enqueued_at IS NOT NULL)
         OR (expires_at IS NOT NULL AND expires_at <= ?2)
      ORDER BY deletion_enqueued_at ASC LIMIT ?1`,
  )
    .bind(batchSize, nowMs)
    .all<{ id: string; r2_key: string; user_id: string }>();

  let removed = 0;
  for (const row of rows.results) {
    await env.ATTACHMENTS.delete(row.r2_key);
    await env.DB.batch([
      // Before the row: `note_attachments` references it with ON DELETE RESTRICT, so a reference would stop the delete.
      env.DB.prepare("DELETE FROM note_attachments WHERE attachment_id = ?1").bind(row.id),
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
