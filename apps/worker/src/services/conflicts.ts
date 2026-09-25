import type { CryptoEnvelope } from "@securenotes/shared";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { syncChangeStatement } from "./records";

/**
 * Conflicts (§16).
 *
 * When a client submits an edit whose `base_revision` no longer matches, the server records a conflict
 * rather than rejecting the edit outright or overwriting: the local side is kept so the user's work is
 * never lost, and the remote side is kept so the diff has something to compare against. Resolving it is
 * the client's decision — keep local, keep remote, or merge.
 */

export type ConflictObjectType = "note" | "folder";
export type ConflictResolution = "local" | "remote" | "merged";

export interface ConflictRow {
  id: string;
  user_id: string;
  object_type: ConflictObjectType;
  object_id: string;
  base_revision: number | null;
  local_iv: string;
  local_ciphertext: string;
  local_crypto_version: number;
  local_key_version: number;
  remote_revision: number;
  remote_iv: string;
  remote_ciphertext: string;
  remote_crypto_version: number;
  remote_key_version: number;
  created_at: number;
  resolved_at: number | null;
  resolution: ConflictResolution | null;
}

/** Wire shape of a conflict. Contains two ciphertext envelopes and no plaintext. */
export function serializeConflict(row: ConflictRow) {
  return {
    id: row.id,
    objectType: row.object_type,
    objectId: row.object_id,
    baseRevision: row.base_revision,
    /**
     * The revision the remote envelope is stored under.
     *
     * The client needs it twice: it is part of the AAD the remote side must be decrypted with, and the
     * resolution is written as the revision after it.
     */
    remoteRevision: row.remote_revision,
    local: {
      crypto_version: row.local_crypto_version,
      key_version: row.local_key_version,
      alg: "AES-256-GCM" as const,
      iv: row.local_iv,
      ciphertext: row.local_ciphertext,
    },
    remote: {
      crypto_version: row.remote_crypto_version,
      key_version: row.remote_key_version,
      alg: "AES-256-GCM" as const,
      iv: row.remote_iv,
      ciphertext: row.remote_ciphertext,
    },
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  };
}

export interface RecordConflictInput {
  userId: string;
  objectType: ConflictObjectType;
  objectId: string;
  baseRevision: number | null;
  local: CryptoEnvelope;
  remote: CryptoEnvelope;
  remoteRevision: number;
}

/**
 * Records a conflict, or returns the one already open for that object.
 *
 * The second case is not an error: §16 pauses an object once it conflicts, so further edits to it
 * cannot happen, and a retried upload must not create a second row. The unique partial index enforces
 * that; this reads it back rather than failing.
 */
export async function recordConflict(
  env: Env,
  input: RecordConflictInput,
  nowMs: number,
): Promise<ConflictRow> {
  const existing = await findOpenConflict(env, input.userId, input.objectType, input.objectId);
  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  // `DO NOTHING` because two callers can reach this at once — a retried upload and a scheduled sync will
  // both find no open conflict and both insert — and the partial unique index makes the second one a
  // constraint violation, which surfaced as a 500 on a request that should have been a plain conflict.
  await env.DB.prepare(
    `INSERT INTO conflicts
       (id, user_id, object_type, object_id, base_revision,
        local_iv, local_ciphertext, local_crypto_version, local_key_version,
        remote_revision, remote_iv, remote_ciphertext, remote_crypto_version, remote_key_version,
        created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      id,
      input.userId,
      input.objectType,
      input.objectId,
      input.baseRevision,
      input.local.iv,
      input.local.ciphertext,
      input.local.crypto_version,
      input.local.key_version,
      input.remoteRevision,
      input.remote.iv,
      input.remote.ciphertext,
      input.remote.crypto_version,
      input.remote.key_version,
      nowMs,
    )
    .run();

  // Read back by object rather than by id: if the insert was ignored, the row that exists is the winner's,
  // and every caller must be given the same conflict.
  const created = await findOpenConflict(env, input.userId, input.objectType, input.objectId);
  if (!created) {
    throw new ApiError("INTERNAL", { diagnostic: "the conflict could not be recorded" });
  }
  return created;
}

export async function findOpenConflict(
  env: Env,
  userId: string,
  objectType: ConflictObjectType,
  objectId: string,
): Promise<ConflictRow | null> {
  return env.DB.prepare(
    "SELECT * FROM conflicts WHERE user_id = ?1 AND object_type = ?2 AND object_id = ?3 AND resolved_at IS NULL",
  )
    .bind(userId, objectType, objectId)
    .first<ConflictRow>();
}

export async function findConflictById(
  env: Env,
  userId: string,
  id: string,
): Promise<ConflictRow | null> {
  return env.DB.prepare("SELECT * FROM conflicts WHERE id = ?1 AND user_id = ?2")
    .bind(id, userId)
    .first<ConflictRow>();
}

/** Every open conflict, oldest first: what a client pulls to find out what is blocked. */
export async function listOpenConflicts(env: Env, userId: string): Promise<ConflictRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM conflicts WHERE user_id = ?1 AND resolved_at IS NULL ORDER BY created_at ASC",
  )
    .bind(userId)
    .all<ConflictRow>();
  return rows.results;
}

/**
 * Marks a conflict resolved.
 *
 * Only the bookkeeping lives here: applying the chosen side is the caller's job, because for a note it
 * means writing a new revision, which has its own service and its own tests.
 */
export async function markConflictResolved(
  env: Env,
  userId: string,
  id: string,
  resolution: ConflictResolution,
  nowMs: number,
): Promise<ConflictRow | null> {
  await env.DB.prepare(
    "UPDATE conflicts SET resolved_at = ?3, resolution = ?4 WHERE id = ?1 AND user_id = ?2 AND resolved_at IS NULL",
  )
    .bind(id, userId, nowMs, resolution)
    .run();

  return findConflictById(env, userId, id);
}

export type ConflictResolutionResult =
  | { kind: "ok"; conflict: ConflictRow }
  | { kind: "not_found" }
  | { kind: "already_resolved" }
  | { kind: "stale" };

/**
 * Applies a resolution and closes the conflict.
 *
 * `remote` needs no write: the client already holds that payload. `local` and `merged` write the
 * supplied payload as a new revision of the note, based on the revision the conflict recorded. The
 * write is guarded by that revision, so a note that moved again leaves the conflict open instead of
 * discarding the newer edit — a resolution must never lose work either.
 */
export async function resolveConflict(
  env: Env,
  userId: string,
  conflictId: string,
  resolution: ConflictResolution,
  payload: CryptoEnvelope | undefined,
  nowMs: number,
): Promise<ConflictResolutionResult> {
  const conflict = await findConflictById(env, userId, conflictId);
  if (!conflict) {
    return { kind: "not_found" };
  }
  if (conflict.resolved_at !== null) {
    return { kind: "already_resolved" };
  }

  if (resolution !== "remote") {
    if (!payload) {
      throw new ApiError("VALIDATION_FAILED", {
        diagnostic: "keeping or merging requires the payload to keep",
      });
    }
    // A folder's content is its name envelope; a note's is its payload. Either way the write is the
    // revision after the one the conflict recorded, which is the revision the client re-encrypted under —
    // and it is guarded by that revision, so a third state cannot be overwritten by a resolution.
    if (conflict.object_type !== "note" && conflict.object_type !== "folder") {
      throw new ApiError("VALIDATION_FAILED", {
        diagnostic: "only notes and folders can be resolved this way",
      });
    }

    const nextRevision = conflict.remote_revision + 1;
    const written =
      conflict.object_type === "folder"
        ? await env.DB.batch([
            env.DB.prepare(
              `UPDATE folders
                  SET revision = ?4, name_iv = ?5, name_ciphertext = ?6,
                      crypto_version = ?7, key_version = ?8, updated_at = ?9
                WHERE id = ?1 AND user_id = ?2 AND revision = ?3 AND deleted_at IS NULL`,
            ).bind(
              conflict.object_id,
              userId,
              conflict.remote_revision,
              nextRevision,
              payload.iv,
              payload.ciphertext,
              payload.crypto_version,
              payload.key_version,
              nowMs,
            ),
            syncChangeStatement(env, {
              userId,
              objectType: "folder",
              objectId: conflict.object_id,
              changeType: "update",
              revision: nextRevision,
              changedAt: nowMs,
            }),
          ])
        : await env.DB.batch([
            env.DB.prepare(
              `UPDATE notes
                  SET revision = ?4, payload_iv = ?5, payload_ciphertext = ?6,
                      crypto_version = ?7, key_version = ?8, updated_at = ?9
                WHERE id = ?1 AND user_id = ?2 AND revision = ?3 AND deleted_at IS NULL`,
            ).bind(
              conflict.object_id,
              userId,
              conflict.remote_revision,
              nextRevision,
              payload.iv,
              payload.ciphertext,
              payload.crypto_version,
              payload.key_version,
              nowMs,
            ),
            // The resolution is a mutation like any other: without a change row, the devices that were
            // not involved in the conflict would never learn that the object moved on.
            /**
             * The history row is not optional.
             *
             * note_revisions.parent_revision_id is a foreign key, and the next edit of this note points at
             * the revision it was based on. A resolution that moved the note's revision without recording it
             * left the next write referring to a row that did not exist, which the database answered with a
             * foreign-key failure: a 500 on an ordinary save, and a queue entry that could then never clear.
             */
            // Conditional on the note actually being at the revision this resolution writes. A resolution
            // that arrives too late changes nothing, and recording history for a revision the note never took
            // would leave a row that later writes could point at as their parent.
            env.DB.prepare(
              `INSERT INTO note_revisions
                 (id, note_id, revision, save_reason, payload_iv, payload_ciphertext, crypto_version, key_version, created_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
                WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?2 AND revision = ?3)
               ON CONFLICT DO NOTHING`,
            ).bind(
              // Derived, not random: the next write names its parent as `${noteId}-r${revision}`.
              `${conflict.object_id}-r${nextRevision}`,
              conflict.object_id,
              nextRevision,
              "restore",
              payload.iv,
              payload.ciphertext,
              payload.crypto_version,
              payload.key_version,
              nowMs,
            ),
            syncChangeStatement(env, {
              userId,
              objectType: "note",
              objectId: conflict.object_id,
              changeType: "update",
              revision: nextRevision,
              changedAt: nowMs,
            }),
          ]);

    const affected = written[0]?.meta.changes ?? 0;
    if (affected === 0) {
      return { kind: "stale" };
    }
  }

  const resolved = await markConflictResolved(env, userId, conflictId, resolution, nowMs);
  if (!resolved) {
    return { kind: "not_found" };
  }
  return { kind: "ok", conflict: resolved };
}
