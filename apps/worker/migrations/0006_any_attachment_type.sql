-- Attachments become arbitrary files, up to 60 MB (§9, §12 — amended by the decision recorded in docs/decisions.md).
--
-- Two constraints in `0001_init.sql` assumed images: `content_type` had to match `image/%`, and `size_bytes` could not
-- exceed 20 MB. Both are widened here: any file type, at most 60 MB. The uploaded bytes were never type-dependent —
-- they are already ciphertext written to R2 as `application/octet-stream` — so this is the whole of the storage change.
--
-- SQLite cannot drop a CHECK constraint, so the table is rebuilt. The order matters: `note_attachments.attachment_id`
-- references `attachments(id)` with ON DELETE RESTRICT, and with foreign keys enforced a DROP of the parent performs an
-- implicit delete that RESTRICT turns into an error. Dropping the child first removes the reference, so the parent can be
-- replaced, and both are restored from transient copies. The whole migration runs in one transaction, so a failure
-- leaves nothing behind. `content_type` stays in plaintext: it is structural metadata the server is allowed to see
-- (§286), and the original filename remains encrypted.

CREATE TABLE note_attachments_backup AS SELECT * FROM note_attachments;
DROP TABLE note_attachments;

CREATE TABLE attachments_backup AS SELECT * FROM attachments;
DROP TABLE attachments;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  name_iv TEXT NOT NULL,
  name_ciphertext TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  -- A media type, whatever it is. The shape is still checked so a row cannot record something that is not one.
  content_type TEXT NOT NULL CHECK (content_type LIKE '%/%'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 62914560),
  content_iv TEXT,
  plaintext_size_bytes INTEGER,
  ref_count INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  deletion_enqueued_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO attachments (
  id, user_id, r2_key, name_iv, name_ciphertext, crypto_version, key_version,
  content_type, size_bytes, content_iv, plaintext_size_bytes, ref_count, deletion_enqueued_at,
  created_at, updated_at
)
SELECT
  id, user_id, r2_key, name_iv, name_ciphertext, crypto_version, key_version,
  content_type, size_bytes, content_iv, plaintext_size_bytes, ref_count, deletion_enqueued_at,
  created_at, updated_at
FROM attachments_backup;

DROP TABLE attachments_backup;

CREATE TABLE note_attachments (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, attachment_id)
);

INSERT INTO note_attachments (note_id, attachment_id, created_at)
SELECT note_id, attachment_id, created_at FROM note_attachments_backup;

DROP TABLE note_attachments_backup;

CREATE INDEX attachments_user_idx ON attachments (user_id);
CREATE INDEX attachments_cleanup_idx ON attachments (ref_count, deletion_enqueued_at);
CREATE INDEX note_attachments_attachment_idx ON note_attachments (attachment_id);
