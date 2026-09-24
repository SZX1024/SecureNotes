import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Schema tests for `migrations/0001_init.sql` (requirements §9, §27).
 *
 * They run against the real migration files, applied by
 * `test/apply-migrations.ts`, so the suite fails if the shipped DDL ever drifts
 * from the documented data model. Storage is isolated per test file and every
 * test uses its own ids, so the tests share one database safely.
 *
 * `create*` helpers execute and reject on failure. The few statements that must
 * join a `DB.batch()` transaction are built by the explicit `*Statement`
 * helpers, so no call can silently skip its write.
 */

/** Fixed epoch-millisecond timestamp; the schema never invents its own. */
const T = 1_760_000_000_000;

/** Stand-in envelope values: the server never inspects or decrypts these. */
const IV = "AAAAAAAAAAAAAAAA";
const CT = "Zm9v";

const TABLES = [
  "attachments",
  "audit_logs",
  "folders",
  "note_attachments",
  "note_revisions",
  "note_tags",
  "notes",
  "operation_nonces",
  "rate_limits",
  "recovery_codes",
  "sessions",
  "sync_changes",
  "tags",
  "totp_config",
  "users",
];

function createUser(id: string) {
  return env.DB.prepare(
    `INSERT INTO users (id, username, kdf_salt, wrapped_dek_iv, wrapped_dek_ciphertext, created_at, updated_at)
     VALUES (?1, ?2, 'salt', ?3, ?4, ?5, ?5)`,
  )
    .bind(id, `username-${id}`, IV, CT, T)
    .run();
}

function createFolder(
  id: string,
  userId: string,
  options: { depth?: number; parentId?: string | null } = {},
) {
  return env.DB.prepare(
    `INSERT INTO folders (id, user_id, parent_id, depth, name_iv, name_ciphertext, crypto_version, key_version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7, ?7)`,
  )
    .bind(id, userId, options.parentId ?? null, options.depth ?? 1, IV, CT, T)
    .run();
}

function createNote(id: string, userId: string, folderId: string | null = null, revision = 1) {
  return env.DB.prepare(
    `INSERT INTO notes (id, user_id, folder_id, revision, payload_iv, payload_ciphertext, crypto_version, key_version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7, ?7)`,
  )
    .bind(id, userId, folderId, revision, IV, CT, T)
    .run();
}

function revisionStatement(
  id: string,
  noteId: string,
  revision: number,
  parentId: string | null = null,
) {
  return env.DB.prepare(
    `INSERT INTO note_revisions (id, note_id, revision, parent_revision_id, payload_iv, payload_ciphertext, crypto_version, key_version, save_reason, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, 'manual', ?7)`,
  ).bind(id, noteId, revision, parentId, IV, CT, T);
}

function createRevision(
  id: string,
  noteId: string,
  revision: number,
  parentId: string | null = null,
) {
  return revisionStatement(id, noteId, revision, parentId).run();
}

function createTag(id: string, userId: string) {
  return env.DB.prepare(
    `INSERT INTO tags (id, user_id, name_iv, name_ciphertext, crypto_version, key_version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?5)`,
  )
    .bind(id, userId, IV, CT, T)
    .run();
}

function createAttachment(
  id: string,
  userId: string,
  options: { sizeBytes?: number; contentType?: string; refCount?: number } = {},
) {
  return env.DB.prepare(
    `INSERT INTO attachments (id, user_id, r2_key, name_iv, name_ciphertext, crypto_version, key_version, content_type, size_bytes, ref_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6, ?7, ?8, ?9, ?9)`,
  )
    .bind(
      id,
      userId,
      `attachments/${id}`,
      IV,
      CT,
      options.contentType ?? "image/png",
      options.sizeBytes ?? 1024,
      options.refCount ?? 0,
      T,
    )
    .run();
}

function tagLinkStatement(noteId: string, tagId: string) {
  return env.DB.prepare(
    "INSERT INTO note_tags (note_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
  ).bind(noteId, tagId, T);
}

function addTagLink(noteId: string, tagId: string) {
  return tagLinkStatement(noteId, tagId).run();
}

function attachmentLinkStatement(noteId: string, attachmentId: string) {
  return env.DB.prepare(
    "INSERT INTO note_attachments (note_id, attachment_id, created_at) VALUES (?1, ?2, ?3)",
  ).bind(noteId, attachmentId, T);
}

function addAttachmentLink(noteId: string, attachmentId: string) {
  return attachmentLinkStatement(noteId, attachmentId).run();
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  const value = await env.DB.prepare(sql)
    .bind(...binds)
    .first<number>("c");
  return value ?? 0;
}

describe("schema inventory", () => {
  it("creates every table of the data model (§9)", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'
        ORDER BY name`,
    ).all<{ name: string }>();

    expect(results.map((row) => row.name)).toEqual(TABLES);
  });

  it("records the migration so it is never applied twice", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{
      name: string;
    }>();

    expect(results.map((row) => row.name)).toContain("0001_init.sql");
  });

  it("creates the indexes the sync, cleanup and listing paths rely on", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    ).all<{ name: string }>();
    const indexNames = new Set(results.map((row) => row.name));

    for (const name of [
      "sessions_user_activity_idx",
      "sessions_expires_at_idx",
      "folders_user_parent_idx",
      "notes_user_folder_idx",
      "notes_user_updated_idx",
      "notes_user_deleted_idx",
      "note_revisions_note_created_idx",
      "note_tags_tag_idx",
      "note_attachments_attachment_idx",
      "attachments_cleanup_idx",
      "sync_changes_user_seq_idx",
      "sync_changes_changed_at_idx",
      "audit_logs_created_at_idx",
      "rate_limits_expires_at_idx",
      "recovery_codes_user_idx",
    ]) {
      expect(indexNames, `missing index ${name}`).toContain(name);
    }
  });
});

describe("foreign keys", () => {
  it("rejects a row whose owning account does not exist", async () => {
    await expect(createNote("fk-note", "ghost-user")).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("rejects a folder pointing at a parent that does not exist", async () => {
    await createUser("fk-parent-user");
    await expect(
      createFolder("fk-parent", "fk-parent-user", { parentId: "ghost-folder", depth: 2 }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("removes every owned row when the account is deleted", async () => {
    const user = "cascade-user";
    await createUser(user);
    await createFolder(`${user}-folder`, user);
    await createNote(`${user}-note`, user, `${user}-folder`);
    await createRevision(`${user}-rev`, `${user}-note`, 1);
    await createTag(`${user}-tag`, user);
    await addTagLink(`${user}-note`, `${user}-tag`);
    await createAttachment(`${user}-att`, user);
    await env.DB.prepare(
      `INSERT INTO totp_config (user_id, secret_iv, secret_ciphertext, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    )
      .bind(user, IV, CT, T)
      .run();
    await env.DB.prepare(
      `INSERT INTO sync_changes (user_id, object_type, object_id, change_type, changed_at)
       VALUES (?1, 'note', ?2, 'create', ?3)`,
    )
      .bind(user, `${user}-note`, T)
      .run();

    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(user).run();

    const scoped: Array<[string, string]> = [
      ["folders", "user_id"],
      ["notes", "user_id"],
      ["tags", "user_id"],
      ["attachments", "user_id"],
      ["totp_config", "user_id"],
      ["sync_changes", "user_id"],
      ["note_tags", "note_id"],
    ];
    for (const [table, column] of scoped) {
      const remaining = await countRows(
        `SELECT count(*) AS c FROM ${table} WHERE ${column} LIKE ?1`,
        `${user}%`,
      );
      expect(remaining, `${table} still holds rows for a deleted account`).toBe(0);
    }
    // Revisions are reachable only through their note.
    expect(
      await countRows("SELECT count(*) AS c FROM note_revisions WHERE note_id LIKE ?1", `${user}%`),
    ).toBe(0);
  });

  it("cascades note deletion to revisions and tag links, keeping the tag itself", async () => {
    const user = "note-cascade-user";
    await createUser(user);
    await createNote("note-cascade-note", user);
    await createRevision("note-cascade-rev", "note-cascade-note", 1);
    await createTag("note-cascade-tag", user);
    await addTagLink("note-cascade-note", "note-cascade-tag");

    await env.DB.prepare("DELETE FROM notes WHERE id = ?1").bind("note-cascade-note").run();

    expect(
      await countRows(
        "SELECT count(*) AS c FROM note_revisions WHERE note_id = ?1",
        "note-cascade-note",
      ),
    ).toBe(0);
    expect(
      await countRows(
        "SELECT count(*) AS c FROM note_tags WHERE note_id = ?1",
        "note-cascade-note",
      ),
    ).toBe(0);
    expect(
      await countRows("SELECT count(*) AS c FROM tags WHERE id = ?1", "note-cascade-tag"),
    ).toBe(1);
  });

  it("removes only the relationship when a tag is deleted (§9)", async () => {
    const user = "tag-delete-user";
    await createUser(user);
    await createNote("tag-delete-note", user);
    await createTag("tag-delete-tag", user);
    await addTagLink("tag-delete-note", "tag-delete-tag");

    await env.DB.prepare("DELETE FROM tags WHERE id = ?1").bind("tag-delete-tag").run();

    expect(
      await countRows("SELECT count(*) AS c FROM note_tags WHERE tag_id = ?1", "tag-delete-tag"),
    ).toBe(0);
    expect(
      await countRows("SELECT count(*) AS c FROM notes WHERE id = ?1", "tag-delete-note"),
    ).toBe(1);
  });

  it("refuses to hard-delete a folder that still holds child folders or notes", async () => {
    const user = "restrict-folder-user";
    await createUser(user);
    await createFolder("restrict-parent", user);
    await createNote("restrict-child-note", user, "restrict-parent");

    await expect(
      env.DB.prepare("DELETE FROM folders WHERE id = ?1").bind("restrict-parent").run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    // The same guard applies to a nested folder.
    await createFolder("restrict-child-folder", user, {
      parentId: "restrict-parent",
      depth: 2,
    });
    await expect(
      env.DB.prepare("DELETE FROM folders WHERE id = ?1").bind("restrict-parent").run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("refuses to delete an attachment that is still referenced by a note", async () => {
    const user = "restrict-attachment-user";
    await createUser(user);
    await createNote("restrict-attachment-note", user);
    await createAttachment("restrict-attachment", user);
    await addAttachmentLink("restrict-attachment-note", "restrict-attachment");

    await expect(
      env.DB.prepare("DELETE FROM attachments WHERE id = ?1").bind("restrict-attachment").run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("keeps audit rows for a session id that no longer exists (§5)", async () => {
    // No foreign key here on purpose: the log must outlive the session.
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, category, event_type, session_id, created_at)
       VALUES ('audit-orphan-session', 'session', 'session_revoked', 'long-gone-session', ?1)`,
    )
      .bind(T)
      .run();

    expect(
      await countRows("SELECT count(*) AS c FROM audit_logs WHERE id = ?1", "audit-orphan-session"),
    ).toBe(1);
  });
});

describe("CHECK constraints", () => {
  it("bounds folder depth to the documented maximum of 10 (§9)", async () => {
    const user = "depth-user";
    await createUser(user);

    await expect(createFolder("depth-0", user, { depth: 0 })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(createFolder("depth-11", user, { depth: 11 })).rejects.toThrow(
      /CHECK constraint failed/,
    );

    await createFolder("depth-1", user, { depth: 1 });
    await createFolder("depth-10", user, { depth: 10 });
    expect(await countRows("SELECT count(*) AS c FROM folders WHERE user_id = ?1", user)).toBe(2);
  });

  it("enforces the 20 MB limit and the images-only rule for attachments (§9)", async () => {
    const user = "attachment-limits-user";
    await createUser(user);

    await expect(createAttachment("att-zero", user, { sizeBytes: 0 })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      createAttachment("att-too-big", user, { sizeBytes: 20 * 1024 * 1024 + 1 }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      createAttachment("att-not-image", user, { contentType: "text/plain" }),
    ).rejects.toThrow(/CHECK constraint failed/);

    await createAttachment("att-exact-limit", user, { sizeBytes: 20 * 1024 * 1024 });
    await createAttachment("att-gif", user, { contentType: "image/gif", sizeBytes: 1 });
    expect(await countRows("SELECT count(*) AS c FROM attachments WHERE user_id = ?1", user)).toBe(
      2,
    );
  });

  it("keeps reference counts non-negative and revisions at least 1", async () => {
    const user = "counter-user";
    await createUser(user);

    await expect(createAttachment("att-negative", user, { refCount: -1 })).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(createNote("note-revision-0", user, null, 0)).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("restricts flags and vocabularies to their documented values", async () => {
    const user = "vocabulary-user";
    await createUser(user);
    await createNote("vocabulary-note", user);

    await expect(
      env.DB.prepare("UPDATE notes SET pinned = 2 WHERE id = ?1").bind("vocabulary-note").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO note_revisions (id, note_id, revision, payload_iv, payload_ciphertext, crypto_version, key_version, save_reason, created_at)
         VALUES ('vocabulary-rev', 'vocabulary-note', 1, ?1, ?2, 1, 1, 'whenever', ?3)`,
      )
        .bind(IV, CT, T)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO rate_limits (scope, bucket, window_start, counter, expires_at)
         VALUES ('nonsense', 'bucket', 0, 1, ?1)`,
      )
        .bind(T)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("stores audit detail either encrypted in full or not at all", async () => {
    // Half an envelope would be undecryptable data, so it is rejected outright.
    await expect(
      env.DB.prepare(
        `INSERT INTO audit_logs (id, category, event_type, detail_iv, created_at)
         VALUES ('audit-half-envelope', 'auth', 'login_failure', ?1, ?2)`,
      )
        .bind(IV, T)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    await env.DB.prepare(
      `INSERT INTO audit_logs (id, category, event_type, detail_iv, detail_ciphertext, created_at)
       VALUES ('audit-full-envelope', 'auth', 'login_failure', ?1, ?2, ?3)`,
    )
      .bind(IV, CT, T)
      .run();
    expect(
      await countRows("SELECT count(*) AS c FROM audit_logs WHERE id = ?1", "audit-full-envelope"),
    ).toBe(1);
  });
});

describe("UNIQUE constraints", () => {
  it("keeps usernames, session tokens and recovery codes distinct", async () => {
    await createUser("unique-user");

    await expect(
      env.DB.prepare(
        `INSERT INTO users (id, username, kdf_salt, wrapped_dek_iv, wrapped_dek_ciphertext, created_at, updated_at)
         VALUES ('unique-user-2', 'username-unique-user', 'salt', ?1, ?2, ?3, ?3)`,
      )
        .bind(IV, CT, T)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    const tokenHash = "a".repeat(64);
    const createSession = (id: string, hash: string) =>
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
         VALUES (?1, 'unique-user', ?2, ?3, ?3, ?3)`,
      )
        .bind(id, hash, T)
        .run();

    await createSession("session-1", tokenHash);
    await expect(createSession("session-2", tokenHash)).rejects.toThrow(/UNIQUE constraint failed/);

    const createRecoveryCode = (id: string, hash: string) =>
      env.DB.prepare(
        `INSERT INTO recovery_codes (id, user_id, code_hash, kdf_salt, wrapped_dek_iv, wrapped_dek_ciphertext, crypto_version, key_version, created_at)
         VALUES (?1, 'unique-user', ?2, 'salt', ?3, ?4, 1, 1, ?5)`,
      )
        .bind(id, hash, IV, CT, T)
        .run();

    await createRecoveryCode("code-1", "b".repeat(64));
    await expect(createRecoveryCode("code-2", "b".repeat(64))).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    // The digest length is part of the contract, not just its uniqueness.
    await expect(createRecoveryCode("code-3", "short")).rejects.toThrow(/CHECK constraint failed/);
  });

  it("allows each note revision number once", async () => {
    const user = "revision-unique-user";
    await createUser(user);
    await createNote("revision-unique-note", user);
    await createRevision("revision-unique-1", "revision-unique-note", 1);

    await expect(
      createRevision("revision-unique-1-dup", "revision-unique-note", 1),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("rejects a duplicate tag link and a duplicate rate-limit window", async () => {
    const user = "duplicate-user";
    await createUser(user);
    await createNote("duplicate-note", user);
    await createTag("duplicate-tag", user);
    await addTagLink("duplicate-note", "duplicate-tag");

    await expect(addTagLink("duplicate-note", "duplicate-tag")).rejects.toThrow(
      /UNIQUE constraint failed/,
    );

    const openWindow = () =>
      env.DB.prepare(
        `INSERT INTO rate_limits (scope, bucket, window_start, counter, expires_at)
         VALUES ('ip', '203.0.113.0/24', 1000, 1, ?1)`,
      )
        .bind(T)
        .run();

    await openWindow();
    await expect(openWindow()).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("never reuses a sync cursor (AUTOINCREMENT, §16)", async () => {
    const user = "cursor-user";
    await createUser(user);
    const insertChange = () =>
      env.DB.prepare(
        `INSERT INTO sync_changes (user_id, object_type, object_id, change_type, changed_at)
         VALUES (?1, 'note', 'cursor-object', 'delete', ?2)`,
      )
        .bind(user, T)
        .run();

    await insertChange();
    const first = await env.DB.prepare("SELECT max(seq) AS c FROM sync_changes").first<number>("c");
    await env.DB.prepare("DELETE FROM sync_changes WHERE seq = ?1").bind(first).run();
    await insertChange();

    const last = await env.DB.prepare("SELECT max(seq) AS c FROM sync_changes").first<number>("c");
    // A reused cursor would let a long-offline client silently skip a change.
    expect(last).toBeGreaterThan(first ?? 0);
  });
});

describe("optimistic locking (§27)", () => {
  it("updates only when the base revision still matches", async () => {
    const user = "locking-user";
    await createUser(user);
    await createNote("locking-note", user);

    const update = (baseRevision: number, nextRevision: number) =>
      env.DB.prepare(
        `UPDATE notes SET revision = ?1, payload_ciphertext = ?2, updated_at = ?3
          WHERE id = 'locking-note' AND revision = ?4`,
      )
        .bind(nextRevision, CT, T + nextRevision, baseRevision)
        .run();

    const accepted = await update(1, 2);
    expect(accepted.meta.changes).toBe(1);

    // A client that still believes revision 1 exists must not overwrite revision 2.
    const stale = await update(1, 3);
    expect(stale.meta.changes).toBe(0);

    const current = await env.DB.prepare(
      "SELECT revision AS c FROM notes WHERE id = 'locking-note'",
    ).first<number>("c");
    expect(current).toBe(2);
  });

  it("keeps notes.revision equal to the newest stored revision", async () => {
    const user = "invariant-user";
    await createUser(user);
    await createNote("invariant-note", user, null, 1);
    await createRevision("invariant-rev-1", "invariant-note", 1);

    // The current revision is mirrored into note_revisions, so both writes must
    // happen together; D1 batch() is a single transaction.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE notes SET revision = 2, payload_ciphertext = ?1 WHERE id = 'invariant-note' AND revision = 1",
      ).bind(CT),
      revisionStatement("invariant-rev-2", "invariant-note", 2, "invariant-rev-1"),
    ]);

    const noteRevision = await env.DB.prepare(
      "SELECT revision AS c FROM notes WHERE id = 'invariant-note'",
    ).first<number>("c");
    const newestRevision = await env.DB.prepare(
      "SELECT max(revision) AS c FROM note_revisions WHERE note_id = 'invariant-note'",
    ).first<number>("c");

    expect(noteRevision).toBe(2);
    expect(newestRevision).toBe(2);
  });
});

describe("attachment reference counts (§9)", () => {
  it("equals the number of link rows when links and counts are written together", async () => {
    const user = "refcount-user";
    await createUser(user);
    await createNote("refcount-note-a", user);
    await createNote("refcount-note-b", user);
    await createAttachment("refcount-attachment", user);

    await env.DB.batch([
      attachmentLinkStatement("refcount-note-a", "refcount-attachment"),
      attachmentLinkStatement("refcount-note-b", "refcount-attachment"),
      env.DB.prepare("UPDATE attachments SET ref_count = ref_count + 2 WHERE id = ?1").bind(
        "refcount-attachment",
      ),
    ]);

    const refCount = await env.DB.prepare(
      "SELECT ref_count AS c FROM attachments WHERE id = 'refcount-attachment'",
    ).first<number>("c");
    const links = await countRows(
      "SELECT count(*) AS c FROM note_attachments WHERE attachment_id = ?1",
      "refcount-attachment",
    );

    expect(refCount).toBe(2);
    expect(refCount).toBe(links);
  });
});
