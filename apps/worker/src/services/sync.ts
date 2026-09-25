import type { CryptoEnvelope } from "@securenotes/shared";

import type { Env } from "../env";
import { serializeFolder, type FolderRow } from "./folders";
import { serializeNote, type NoteRow } from "./notes";
import type { SyncObjectType } from "./records";
import { serializeTag, type TagRow } from "./tags";

/**
 * The incremental sync feed (§16).
 *
 * `sync_changes.seq` is an AUTOINCREMENT cursor, so a client holding a cursor sees every change
 * exactly once and can never skip one — including deletions, which are `delete` rows that act as
 * tombstones for thirty days.
 *
 * The feed carries the **encrypted payload** of each changed object. That is what makes the pull
 * incremental in one round trip rather than "learn which ids changed, then fetch them all": the
 * payload is a ciphertext envelope the worker cannot read, so including it costs nothing in privacy
 * and saves a second pass. A `delete` carries no payload, and neither does a change whose object is
 * already gone (a purged note), which the client treats as a tombstone.
 *
 * Payloads are never decrypted here, and nothing in this module touches plaintext.
 */

export interface SyncFeedChange {
  seq: number;
  objectType: SyncObjectType;
  objectId: string;
  changeType: "create" | "update" | "delete";
  revision: number | null;
  changedAt: number;
  /** The object as it is now, encrypted, or null when it no longer exists. */
  payload: Record<string, unknown> | null;
}

export interface SyncFeedBatch {
  /** The cursor to send back next time: the last sequence included, or the request's own value. */
  cursor: number;
  changes: SyncFeedChange[];
  hasMore: boolean;
}

export interface FeedRow {
  seq: number;
  object_type: SyncObjectType;
  object_id: string;
  change_type: "create" | "update" | "delete";
  revision: number | null;
  changed_at: number;
}

export const SYNC_FEED_DEFAULT_LIMIT = 200;
export const SYNC_FEED_MAX_LIMIT = 500;

/**
 * Reads one batch of changes.
 *
 * A `limit + 1` row fetch decides `hasMore` without a second count query: if one extra row came back,
 * there is more to read and the extra is dropped.
 */
export async function readSyncFeed(
  env: Env,
  userId: string,
  since: number,
  limit: number,
): Promise<SyncFeedBatch> {
  const capped = Math.min(Math.max(1, limit), SYNC_FEED_MAX_LIMIT);

  const rows = await env.DB.prepare(
    `SELECT seq, object_type, object_id, change_type, revision, changed_at
       FROM sync_changes
      WHERE user_id = ?1 AND seq > ?2
      ORDER BY seq ASC
      LIMIT ?3`,
  )
    .bind(userId, since, capped + 1)
    .all<FeedRow>();

  const hasMore = rows.results.length > capped;
  const page = hasMore ? rows.results.slice(0, capped) : rows.results;

  // One lookup per object type for the whole batch, rather than one per change.
  const payloads = await loadPayloads(env, userId, page);

  const changes: SyncFeedChange[] = page.map((row) => ({
    seq: row.seq,
    objectType: row.object_type,
    objectId: row.object_id,
    changeType: row.change_type,
    revision: row.revision,
    changedAt: row.changed_at,
    payload:
      row.change_type === "delete"
        ? null
        : (payloads.get(`${row.object_type}:${row.object_id}`) ?? null),
  }));

  return {
    // The cursor only moves past changes that were actually returned, so an interrupted pull resumes
    // exactly where it stopped.
    cursor: changes.length > 0 ? changes[changes.length - 1]!.seq : since,
    changes,
    hasMore,
  };
}

/** Fetches the current encrypted state of every object named by a batch, by type. */
async function loadPayloads(
  env: Env,
  userId: string,
  rows: readonly FeedRow[],
): Promise<Map<string, Record<string, unknown>>> {
  const idsByType = new Map<SyncObjectType, Set<string>>();
  for (const row of rows) {
    if (row.change_type === "delete") {
      continue;
    }
    const set = idsByType.get(row.object_type) ?? new Set<string>();
    set.add(row.object_id);
    idsByType.set(row.object_type, set);
  }

  const payloads = new Map<string, Record<string, unknown>>();

  const noteIds = [...(idsByType.get("note") ?? [])];
  if (noteIds.length > 0) {
    const notes = await env.DB.prepare(
      `SELECT * FROM notes WHERE user_id = ?1 AND id IN (${placeholders(noteIds.length, 2)})`,
    )
      .bind(userId, ...noteIds)
      .all<NoteRow>();
    for (const row of notes.results) {
      payloads.set(`note:${row.id}`, serializeNote(row) as unknown as Record<string, unknown>);
    }
  }

  const folderIds = [...(idsByType.get("folder") ?? [])];
  if (folderIds.length > 0) {
    const folders = await env.DB.prepare(
      `SELECT * FROM folders WHERE user_id = ?1 AND id IN (${placeholders(folderIds.length, 2)})`,
    )
      .bind(userId, ...folderIds)
      .all<FolderRow>();
    for (const row of folders.results) {
      payloads.set(`folder:${row.id}`, serializeFolder(row) as unknown as Record<string, unknown>);
    }
  }

  const tagIds = [...(idsByType.get("tag") ?? [])];
  if (tagIds.length > 0) {
    const tags = await env.DB.prepare(
      `SELECT * FROM tags WHERE user_id = ?1 AND id IN (${placeholders(tagIds.length, 2)})`,
    )
      .bind(userId, ...tagIds)
      .all<TagRow>();
    for (const row of tags.results) {
      payloads.set(`tag:${row.id}`, serializeTag(row) as unknown as Record<string, unknown>);
    }
  }

  return payloads;
}

/** Builds `?2, ?3, …` for an `IN` list, continuing from a starting index. */
function placeholders(count: number, from: number): string {
  return Array.from({ length: count }, (_, index) => `?${from + index}`).join(", ");
}

/** The envelope carried by a feed payload, for the client's benefit and for tests. */
export function envelopeOf(payload: Record<string, unknown> | null): CryptoEnvelope | null {
  if (!payload) {
    return null;
  }
  const candidate = (payload["payload"] ?? payload["name"]) as CryptoEnvelope | undefined;
  return candidate ?? null;
}
