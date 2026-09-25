import { MAX_FOLDER_DEPTH, type CryptoEnvelope } from "@securenotes/shared";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { syncChangeStatement } from "./records";
import { recordConflict } from "./conflicts";

/**
 * Folders (§9, §10).
 *
 * Structural relationships and depth are visible to the server; names are not —
 * they arrive as envelopes and are stored as opaque columns.
 *
 * Depth is enforced here *and* by the database (`CHECK (depth BETWEEN 1 AND 10)`),
 * because the limit is only meaningful if a move cannot silently violate it: a
 * subtree moved under a deep parent would push its leaves past the maximum.
 *
 * Deleting a folder soft-deletes the whole subtree and the notes inside it while
 * preserving ids and relationships (§9), so a restore puts everything back
 * exactly where it was.
 */

export interface FolderRow {
  id: string;
  parent_id: string | null;
  depth: number;
  name_iv: string;
  name_ciphertext: string;
  crypto_version: number;
  key_version: number;
  sort_order: number;
  revision: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export function serializeFolder(row: FolderRow) {
  return {
    id: row.id,
    parentId: row.parent_id,
    depth: row.depth,
    /** The revision an edit has to be based on (§16). */
    revision: row.revision,
    name: {
      crypto_version: row.crypto_version,
      key_version: row.key_version,
      alg: "AES-256-GCM" as const,
      iv: row.name_iv,
      ciphertext: row.name_ciphertext,
    },
    sortOrder: row.sort_order,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findFolder(env: Env, userId: string, id: string): Promise<FolderRow | null> {
  return env.DB.prepare("SELECT * FROM folders WHERE id = ?1 AND user_id = ?2")
    .bind(id, userId)
    .first<FolderRow>();
}

async function nameColumns(envelope: CryptoEnvelope) {
  return [envelope.iv, envelope.ciphertext, envelope.crypto_version, envelope.key_version] as const;
}

export async function createFolder(
  env: Env,
  userId: string,
  input: { id: string; parentId: string | null; name: CryptoEnvelope; sortOrder?: number },
  nowMs: number,
): Promise<FolderRow> {
  // Idempotent for the same reason a note's create is: the id comes from the client and the upload queue is
  // durable, so a replay must not be answered with a conflict. A move or a rename made after the create
  // arrives as its own update, which is the queued change that carries it.
  const replay = await findFolder(env, userId, input.id);
  if (replay) {
    return replay;
  }

  let depth = 1;
  if (input.parentId !== null) {
    const parent = await findFolder(env, userId, input.parentId);
    if (!parent || parent.deleted_at !== null) {
      throw new ApiError("NOT_FOUND", { diagnostic: "parent folder does not exist" });
    }
    depth = parent.depth + 1;
    if (depth > MAX_FOLDER_DEPTH) {
      throw new ApiError("PRECONDITION_FAILED", {
        diagnostic: `maximum folder depth is ${MAX_FOLDER_DEPTH}`,
      });
    }
  }

  const [iv, ciphertext, cryptoVersion, keyVersion] = await nameColumns(input.name);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO folders
         (id, user_id, parent_id, depth, name_iv, name_ciphertext, crypto_version, key_version, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    ).bind(
      input.id,
      userId,
      input.parentId,
      depth,
      iv,
      ciphertext,
      cryptoVersion,
      keyVersion,
      input.sortOrder ?? 0,
      nowMs,
    ),
    syncChangeStatement(env, {
      userId,
      objectType: "folder",
      objectId: input.id,
      changeType: "create",
      changedAt: nowMs,
    }),
  ]);

  return (await findFolder(env, userId, input.id))!;
}

export async function listFolders(
  env: Env,
  userId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<FolderRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM folders
      WHERE user_id = ?1 AND (?2 = 1 OR deleted_at IS NULL)
      ORDER BY depth ASC, sort_order ASC, created_at ASC`,
  )
    .bind(userId, options.includeDeleted ? 1 : 0)
    .all<FolderRow>();

  return rows.results;
}

/** Ids of every descendant of `rootId`, excluding the root, deepest last. */
export async function descendantIds(env: Env, userId: string, rootId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM folders WHERE id = ?1 AND user_id = ?2
       UNION ALL
       SELECT folders.id FROM folders JOIN subtree ON folders.parent_id = subtree.id
        WHERE folders.user_id = ?2
     )
     SELECT id FROM subtree WHERE id <> ?1`,
  )
    .bind(rootId, userId)
    .all<{ id: string }>();

  return rows.results.map((row) => row.id);
}

/** Height of the tallest branch below `rootId` (0 when it has no children). */
async function subtreeHeight(env: Env, userId: string, rootId: string): Promise<number> {
  const row = await env.DB.prepare(
    `WITH RECURSIVE subtree(id, depth) AS (
       SELECT id, 0 FROM folders WHERE id = ?1 AND user_id = ?2
       UNION ALL
       SELECT folders.id, subtree.depth + 1 FROM folders JOIN subtree ON folders.parent_id = subtree.id
        WHERE folders.user_id = ?2
     )
     SELECT max(depth) AS h FROM subtree`,
  )
    .bind(rootId, userId)
    .first<number>("h");

  return row ?? 0;
}

export async function updateFolder(
  env: Env,
  userId: string,
  id: string,
  input: {
    name?: CryptoEnvelope;
    parentId?: string | null;
    sortOrder?: number;
    baseRevision?: number;
  },
  nowMs: number,
): Promise<FolderRow> {
  const existing = await findFolder(env, userId, id);
  if (!existing || existing.deleted_at !== null) {
    throw new ApiError("NOT_FOUND");
  }

  if (input.baseRevision !== undefined && existing.revision !== input.baseRevision) {
    // §16: a folder move that was based on a revision the server has moved past becomes a conflict. The
    // name envelope stands in for the folder's content, which is what the two sides are compared on.
    await recordConflict(
      env,
      {
        userId,
        objectType: "folder",
        objectId: id,
        baseRevision: input.baseRevision,
        local: input.name ?? {
          crypto_version: existing.crypto_version,
          key_version: existing.key_version,
          alg: "AES-256-GCM",
          iv: existing.name_iv,
          ciphertext: existing.name_ciphertext,
        },
        remote: {
          crypto_version: existing.crypto_version,
          key_version: existing.key_version,
          alg: "AES-256-GCM",
          iv: existing.name_iv,
          ciphertext: existing.name_ciphertext,
        },
        remoteRevision: existing.revision,
      },
      nowMs,
    );
    throw new ApiError("REVISION_CONFLICT", {
      diagnostic: `expected revision ${input.baseRevision}, found ${existing.revision}`,
    });
  }

  const statements = [];

  if (input.parentId !== undefined && input.parentId !== existing.parent_id) {
    // Always assigned by both branches below before it is read.
    let depth: number;
    if (input.parentId === id) {
      throw new ApiError("PRECONDITION_FAILED", { diagnostic: "a folder cannot contain itself" });
    }
    if (input.parentId !== null) {
      const descendants = await descendantIds(env, userId, id);
      if (descendants.includes(input.parentId)) {
        // Moving a folder into its own subtree would detach that subtree from the
        // tree and make the depth calculation meaningless.
        throw new ApiError("PRECONDITION_FAILED", {
          diagnostic: "cannot move a folder into its own subtree",
        });
      }
      const parent = await findFolder(env, userId, input.parentId);
      if (!parent || parent.deleted_at !== null) {
        throw new ApiError("NOT_FOUND", { diagnostic: "target folder does not exist" });
      }
      depth = parent.depth + 1;
    } else {
      depth = 1;
    }

    // The deepest leaf must still fit under the maximum.
    const height = await subtreeHeight(env, userId, id);
    if (depth + height > MAX_FOLDER_DEPTH) {
      throw new ApiError("PRECONDITION_FAILED", {
        diagnostic: `the subtree would exceed the maximum depth of ${MAX_FOLDER_DEPTH}`,
      });
    }

    statements.push(
      env.DB.prepare(
        "UPDATE folders SET parent_id = ?3, depth = ?4, updated_at = ?5 WHERE id = ?1 AND user_id = ?2",
      ).bind(id, userId, input.parentId, depth, nowMs),
    );

    // Every descendant moves by the same delta, so relative depths are preserved.
    const delta = depth - existing.depth;
    if (delta !== 0) {
      const descendants = await descendantIds(env, userId, id);
      for (const descendantId of descendants) {
        statements.push(
          env.DB.prepare(
            "UPDATE folders SET depth = depth + ?2 WHERE id = ?1 AND user_id = ?3",
          ).bind(descendantId, delta, userId),
        );
      }
    }
  }

  if (input.name) {
    const [iv, ciphertext, cryptoVersion, keyVersion] = await nameColumns(input.name);
    statements.push(
      env.DB.prepare(
        `UPDATE folders SET name_iv = ?3, name_ciphertext = ?4, crypto_version = ?5, key_version = ?6, updated_at = ?7
          WHERE id = ?1 AND user_id = ?2`,
      ).bind(id, userId, iv, ciphertext, cryptoVersion, keyVersion, nowMs),
    );
  }

  if (input.sortOrder !== undefined) {
    statements.push(
      env.DB.prepare(
        "UPDATE folders SET sort_order = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2",
      ).bind(id, userId, input.sortOrder, nowMs),
    );
  }

  // One revision per accepted write, whatever it changed: the revision is what the next edit is compared
  // against, so it has to move even for a rename.
  statements.push(
    env.DB.prepare(
      "UPDATE folders SET revision = revision + 1, updated_at = ?3 WHERE id = ?1 AND user_id = ?2",
    ).bind(id, userId, nowMs),
  );

  statements.push(
    syncChangeStatement(env, {
      userId,
      objectType: "folder",
      objectId: id,
      changeType: "update",
      revision: existing.revision + 1,
      changedAt: nowMs,
    }),
  );

  await env.DB.batch(statements);
  return (await findFolder(env, userId, id))!;
}

/**
 * Moves a folder, its descendants **and the notes inside them** to the recycle
 * bin, preserving ids and relationships (§9).
 */
export async function softDeleteFolder(
  env: Env,
  userId: string,
  id: string,
  nowMs: number,
): Promise<{ folders: number; notes: number }> {
  const existing = await findFolder(env, userId, id);
  if (!existing || existing.deleted_at !== null) {
    throw new ApiError("NOT_FOUND");
  }

  const descendants = await descendantIds(env, userId, id);
  const all = [id, ...descendants];
  const placeholders = all.map(() => "?").join(",");

  // Positional placeholders only: mixing `?` with `?N` makes the numbering
  // depend on the order SQLite assigns to the bare ones.
  const notes = await env.DB.prepare(
    `UPDATE notes SET deleted_at = ?, updated_at = ?
      WHERE user_id = ? AND deleted_at IS NULL AND folder_id IN (${placeholders})`,
  )
    .bind(nowMs, nowMs, userId, ...all)
    .run();

  await env.DB.prepare(
    `UPDATE folders SET deleted_at = ?, updated_at = ?
      WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
  )
    .bind(nowMs, nowMs, userId, ...all)
    .run();

  for (const folderId of all) {
    await syncChangeStatement(env, {
      userId,
      objectType: "folder",
      objectId: folderId,
      changeType: "delete",
      changedAt: nowMs,
    }).run();
  }

  return { folders: all.length, notes: notes.meta.changes ?? 0 };
}

/** Restores a folder and everything that was deleted with it. */
export async function restoreFolder(
  env: Env,
  userId: string,
  id: string,
  nowMs: number,
): Promise<{ folders: number; notes: number }> {
  const existing = await findFolder(env, userId, id);
  if (!existing || existing.deleted_at === null) {
    throw new ApiError("NOT_FOUND");
  }

  const descendants = await descendantIds(env, userId, id);
  const all = [id, ...descendants];
  const placeholders = all.map(() => "?").join(",");

  const folders = await env.DB.prepare(
    `UPDATE folders SET deleted_at = NULL, updated_at = ?
      WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`,
  )
    .bind(nowMs, userId, ...all)
    .run();

  const notes = await env.DB.prepare(
    `UPDATE notes SET deleted_at = NULL, updated_at = ?
      WHERE user_id = ? AND deleted_at IS NOT NULL AND folder_id IN (${placeholders})`,
  )
    .bind(nowMs, userId, ...all)
    .run();

  for (const folderId of all) {
    await syncChangeStatement(env, {
      userId,
      objectType: "folder",
      objectId: folderId,
      changeType: "update",
      changedAt: nowMs,
    }).run();
  }

  return { folders: folders.meta.changes ?? 0, notes: notes.meta.changes ?? 0 };
}

/**
 * Permanently deletes a folder subtree.
 *
 * Children are removed before their parents: the self-reference is RESTRICT, so
 * a wrong delete order fails loudly instead of orphaning rows.
 */
export async function purgeFolder(
  env: Env,
  userId: string,
  id: string,
  nowMs: number,
): Promise<{ folders: number; notes: number }> {
  const existing = await findFolder(env, userId, id);
  if (!existing) {
    throw new ApiError("NOT_FOUND");
  }

  const descendants = await descendantIds(env, userId, id);
  const all = [id, ...descendants];

  // Notes first: they reference the folders and are referenced by attachments.
  let notesDeleted = 0;
  for (const folderId of all) {
    const notes = await env.DB.prepare("SELECT id FROM notes WHERE user_id = ?1 AND folder_id = ?2")
      .bind(userId, folderId)
      .all<{ id: string }>();
    for (const note of notes.results) {
      await env.DB.prepare("DELETE FROM note_tags WHERE note_id = ?1").bind(note.id).run();
      const links = await env.DB.prepare(
        "SELECT attachment_id FROM note_attachments WHERE note_id = ?1",
      )
        .bind(note.id)
        .all<{ attachment_id: string }>();
      for (const link of links.results) {
        await env.DB.prepare(
          "UPDATE attachments SET ref_count = ref_count - 1 WHERE id = ?1 AND ref_count > 0",
        )
          .bind(link.attachment_id)
          .run();
      }
      await env.DB.prepare("DELETE FROM note_attachments WHERE note_id = ?1").bind(note.id).run();
      await env.DB.prepare("DELETE FROM notes WHERE id = ?1 AND user_id = ?2")
        .bind(note.id, userId)
        .run();
      notesDeleted += 1;
    }
  }

  // Then the folders, deepest first.
  let foldersDeleted = 0;
  for (const folderId of [...all].reverse()) {
    await env.DB.prepare("DELETE FROM folders WHERE id = ?1 AND user_id = ?2")
      .bind(folderId, userId)
      .run();
    foldersDeleted += 1;
  }

  for (const folderId of all) {
    await syncChangeStatement(env, {
      userId,
      objectType: "folder",
      objectId: folderId,
      changeType: "delete",
      changedAt: nowMs,
    }).run();
  }

  return { folders: foldersDeleted, notes: notesDeleted };
}
