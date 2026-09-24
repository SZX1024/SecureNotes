import { RECYCLE_BIN_RETENTION_MS, TOMBSTONE_RETENTION_MS } from "@securenotes/shared";

import type { Env } from "../env";
import { purgeDeletedAttachments } from "./attachments";
import { syncChangeStatement } from "./records";

/**
 * Retention sweeps (§5, §16, §19).
 *
 * All three are the same shape: something is kept for a fixed window and then
 * removed by the scheduled handler, never by a user action.
 */

/**
 * Permanently deletes notes that have been in the recycle bin for longer than the
 * 30-day retention window (§19). The revision history cascades with the note.
 */
export async function purgeExpiredRecycleBin(
  env: Env,
  nowMs: number,
  batchSize = 100,
): Promise<number> {
  const cutoff = nowMs - RECYCLE_BIN_RETENTION_MS;
  const rows = await env.DB.prepare(
    `SELECT id, user_id FROM notes
      WHERE deleted_at IS NOT NULL AND deleted_at < ?1
      ORDER BY deleted_at ASC LIMIT ?2`,
  )
    .bind(cutoff, batchSize)
    .all<{ id: string; user_id: string }>();

  let removed = 0;
  for (const row of rows.results) {
    // Attachment links go first so the reference counts stay exact.
    const links = await env.DB.prepare(
      "SELECT attachment_id FROM note_attachments WHERE note_id = ?1",
    )
      .bind(row.id)
      .all<{ attachment_id: string }>();

    const statements = [
      ...links.results.map((link) =>
        env.DB.prepare(
          "UPDATE attachments SET ref_count = ref_count - 1 WHERE id = ?1 AND ref_count > 0",
        ).bind(link.attachment_id),
      ),
      env.DB.prepare("DELETE FROM note_attachments WHERE note_id = ?1").bind(row.id),
      env.DB.prepare("DELETE FROM note_tags WHERE note_id = ?1").bind(row.id),
      env.DB.prepare("DELETE FROM notes WHERE id = ?1").bind(row.id),
      syncChangeStatement(env, {
        userId: row.user_id,
        objectType: "note",
        objectId: row.id,
        changeType: "delete",
        changedAt: nowMs,
      }),
    ];

    await env.DB.batch(statements);
    removed += 1;
  }

  return removed;
}

/** Deletes attachment objects whose reference count reached zero (§9). */
export async function purgeExpiredAttachments(env: Env, nowMs: number): Promise<number> {
  return purgeDeletedAttachments(env, nowMs);
}

/**
 * Drops sync-feed rows older than the tombstone window (§16).
 *
 * A client that has been offline for longer than 30 days cannot be brought up to
 * date incrementally, which is why the window is the documented guarantee rather
 * than an arbitrary cleanup interval.
 */
export async function purgeExpiredTombstones(
  env: Env,
  nowMs: number,
  batchSize = 500,
): Promise<number> {
  const cutoff = nowMs - TOMBSTONE_RETENTION_MS;
  const result = await env.DB.prepare(
    `DELETE FROM sync_changes WHERE seq IN (
       SELECT seq FROM sync_changes WHERE changed_at < ?1 ORDER BY changed_at LIMIT ?2
     )`,
  )
    .bind(cutoff, batchSize)
    .run();

  return result.meta.changes ?? 0;
}
