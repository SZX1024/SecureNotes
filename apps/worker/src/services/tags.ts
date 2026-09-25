import { MAX_TAGS_PER_NOTE, type CryptoEnvelope } from "@securenotes/shared";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { syncChangeStatement } from "./records";

/**
 * Tags (§9, §10).
 *
 * Tags are flat and their names are encrypted. Deleting a tag removes
 * relationships only, so the `note_tags` rows cascade and no note is touched.
 *
 * The limit of ten tags per note is enforced here; the database cannot express
 * it, which is exactly why it is a tested invariant rather than a comment.
 */

export interface TagRow {
  id: string;
  name_iv: string;
  name_ciphertext: string;
  crypto_version: number;
  key_version: number;
  created_at: number;
  updated_at: number;
}

export function serializeTag(row: TagRow) {
  return {
    id: row.id,
    name: {
      crypto_version: row.crypto_version,
      key_version: row.key_version,
      alg: "AES-256-GCM" as const,
      iv: row.name_iv,
      ciphertext: row.name_ciphertext,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findTag(env: Env, userId: string, id: string): Promise<TagRow | null> {
  return env.DB.prepare("SELECT * FROM tags WHERE id = ?1 AND user_id = ?2")
    .bind(id, userId)
    .first<TagRow>();
}

export async function createTag(
  env: Env,
  userId: string,
  input: { id: string; name: CryptoEnvelope },
  nowMs: number,
): Promise<TagRow> {
  // Idempotent, like every other create: the id is the client's, and a replayed upload must succeed rather
  // than turn into a conflict. A rename afterwards is queued as its own update.
  const existing = await findTag(env, userId, input.id);
  if (existing) {
    return existing;
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tags (id, user_id, name_iv, name_ciphertext, crypto_version, key_version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(
      input.id,
      userId,
      input.name.iv,
      input.name.ciphertext,
      input.name.crypto_version,
      input.name.key_version,
      nowMs,
    ),
    syncChangeStatement(env, {
      userId,
      objectType: "tag",
      objectId: input.id,
      changeType: "create",
      changedAt: nowMs,
    }),
  ]);

  return (await findTag(env, userId, input.id))!;
}

export async function listTags(env: Env, userId: string): Promise<TagRow[]> {
  const rows = await env.DB.prepare("SELECT * FROM tags WHERE user_id = ?1 ORDER BY created_at ASC")
    .bind(userId)
    .all<TagRow>();

  return rows.results;
}

export async function renameTag(
  env: Env,
  userId: string,
  id: string,
  name: CryptoEnvelope,
  nowMs: number,
): Promise<TagRow> {
  const existing = await findTag(env, userId, id);
  if (!existing) {
    throw new ApiError("NOT_FOUND");
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tags SET name_iv = ?3, name_ciphertext = ?4, crypto_version = ?5, key_version = ?6, updated_at = ?7
        WHERE id = ?1 AND user_id = ?2`,
    ).bind(id, userId, name.iv, name.ciphertext, name.crypto_version, name.key_version, nowMs),
    syncChangeStatement(env, {
      userId,
      objectType: "tag",
      objectId: id,
      changeType: "update",
      changedAt: nowMs,
    }),
  ]);

  return (await findTag(env, userId, id))!;
}

/** Deletes a tag. Relationships are removed; notes are never touched (§9). */
export async function deleteTag(
  env: Env,
  userId: string,
  id: string,
  nowMs: number,
): Promise<{ relationships: number }> {
  const existing = await findTag(env, userId, id);
  if (!existing) {
    throw new ApiError("NOT_FOUND");
  }

  const links = await env.DB.prepare("SELECT note_id FROM note_tags WHERE tag_id = ?1")
    .bind(id)
    .all<{ note_id: string }>();

  await env.DB.batch([
    env.DB.prepare("DELETE FROM tags WHERE id = ?1 AND user_id = ?2").bind(id, userId),
    syncChangeStatement(env, {
      userId,
      objectType: "tag",
      objectId: id,
      changeType: "delete",
      changedAt: nowMs,
    }),
  ]);

  for (const link of links.results) {
    await syncChangeStatement(env, {
      userId,
      objectType: "note_tag_link",
      objectId: `${link.note_id}:${id}`,
      changeType: "delete",
      changedAt: nowMs,
    }).run();
  }

  return { relationships: links.results.length };
}

export async function listNoteTagIds(env: Env, userId: string, noteId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT note_tags.tag_id AS tag_id FROM note_tags
       JOIN notes ON notes.id = note_tags.note_id
      WHERE note_tags.note_id = ?1 AND notes.user_id = ?2`,
  )
    .bind(noteId, userId)
    .all<{ tag_id: string }>();

  return rows.results.map((row) => row.tag_id);
}

/**
 * Replaces a note's tags.
 *
 * Set semantics, as §16 asks for tag changes: the submitted set becomes the
 * note's set. Every tag must belong to the caller and the count is capped, so a
 * request can neither attach another account's tag nor exceed the limit.
 */
export async function setNoteTags(
  env: Env,
  userId: string,
  noteId: string,
  tagIds: string[],
  nowMs: number,
): Promise<string[]> {
  if (tagIds.length > MAX_TAGS_PER_NOTE) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: `a note may have at most ${MAX_TAGS_PER_NOTE} tags`,
    });
  }
  if (new Set(tagIds).size !== tagIds.length) {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "duplicate tag id" });
  }

  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ?1 AND user_id = ?2")
    .bind(noteId, userId)
    .first<{ id: string }>();
  if (!note) {
    throw new ApiError("NOT_FOUND", { diagnostic: "note does not exist" });
  }

  for (const tagId of tagIds) {
    const tag = await findTag(env, userId, tagId);
    if (!tag) {
      throw new ApiError("NOT_FOUND", { diagnostic: "tag does not exist" });
    }
  }

  const existing = await listNoteTagIds(env, userId, noteId);
  const toRemove = existing.filter((tagId) => !tagIds.includes(tagId));
  const toAdd = tagIds.filter((tagId) => !existing.includes(tagId));

  const statements = [
    ...toRemove.map((tagId) =>
      env.DB.prepare("DELETE FROM note_tags WHERE note_id = ?1 AND tag_id = ?2").bind(
        noteId,
        tagId,
      ),
    ),
    ...toAdd.map((tagId) =>
      env.DB.prepare(
        "INSERT INTO note_tags (note_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
      ).bind(noteId, tagId, nowMs),
    ),
  ];

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  for (const tagId of toRemove) {
    await syncChangeStatement(env, {
      userId,
      objectType: "note_tag_link",
      objectId: `${noteId}:${tagId}`,
      changeType: "delete",
      changedAt: nowMs,
    }).run();
  }
  for (const tagId of toAdd) {
    await syncChangeStatement(env, {
      userId,
      objectType: "note_tag_link",
      objectId: `${noteId}:${tagId}`,
      changeType: "create",
      changedAt: nowMs,
    }).run();
  }

  return listNoteTagIds(env, userId, noteId);
}
