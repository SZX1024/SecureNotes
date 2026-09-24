import { MAX_HISTORICAL_REVISIONS } from "@securenotes/shared";

import type { Env } from "../env";

/**
 * Shared write-path helpers for the data domain.
 *
 * Two things every mutation must do, kept here so no route can forget them:
 * record a change in the sync feed (§16) and keep the revision history bounded
 * (§9, §18).
 */

export type SyncObjectType =
  "note" | "note_revision" | "folder" | "tag" | "note_tag_link" | "attachment" | "note_attachment";

export interface SyncChange {
  userId: string;
  objectType: SyncObjectType;
  objectId: string;
  changeType: "create" | "update" | "delete";
  revision?: number | null;
  changedAt: number;
}

/**
 * Appends a change to the sync feed.
 *
 * `seq` is an AUTOINCREMENT cursor, so a client that holds a cursor sees every
 * change exactly once and can never skip one — including deletions, which are
 * recorded as `delete` rows that act as tombstones for 30 days (§16).
 */
export function syncChangeStatement(env: Env, change: SyncChange) {
  return env.DB.prepare(
    `INSERT INTO sync_changes (user_id, object_type, object_id, change_type, revision, changed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(
    change.userId,
    change.objectType,
    change.objectId,
    change.changeType,
    change.revision ?? null,
    change.changedAt,
  );
}

/**
 * Prunes a note's history to the current revision plus at most ten historical
 * ones (§9: "keep current revision plus at most 10 historical versions").
 *
 * Deleting a historical version is permanent and never touches the current
 * revision, so an over-limit history loses the oldest entries and nothing else.
 * Returns the ids that were removed, so the caller can record them in the feed.
 */
export async function pruneRevisionHistory(
  env: Env,
  noteId: string,
  keep: number = MAX_HISTORICAL_REVISIONS,
): Promise<string[]> {
  const doomed = await env.DB.prepare(
    `SELECT id FROM note_revisions
      WHERE note_id = ?1
      ORDER BY revision DESC
      LIMIT -1 OFFSET ?2`,
  )
    .bind(noteId, keep + 1)
    .all<{ id: string }>();

  const ids = doomed.results.map((row) => row.id);
  if (ids.length === 0) {
    return [];
  }

  // `parent_revision_id` uses ON DELETE SET NULL, so removing the oldest entries
  // cannot be blocked by their children.
  await env.DB.prepare(`DELETE FROM note_revisions WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .run();

  return ids;
}

/** SQL fragment for "this object belongs to the caller". Never trust an id alone (§26). */
export const OWNED_BY_USER = "user_id = ?";
