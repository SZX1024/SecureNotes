-- SecureNotes initial schema (requirements §9 "Data Model").
--
-- Conventions used throughout this file:
--
--   * Ids are TEXT and hold UUIDv7 values (36 chars). UUIDs satisfy the frozen
--     AAD id charset `[A-Za-z0-9_-]{1,64}` in packages/shared/src/crypto/format.ts,
--     so the same id can be bound into a ciphertext's AAD.
--   * Timestamps are INTEGER epoch milliseconds, always supplied by the
--     application. No DEFAULT is used because SQLite's CURRENT_TIMESTAMP is
--     text-typed and would silently mix representations.
--   * Booleans are INTEGER restricted to 0/1 by a CHECK.
--   * Encrypted objects are stored as explicit envelope columns
--     (crypto_version, key_version, iv, ciphertext) rather than a JSON blob so
--     that the frozen envelope shape is enforced by the database. `iv` and
--     `ciphertext` are base64 (standard alphabet, padded); `ciphertext`
--     includes the 16-byte GCM tag. The server can validate shape and version
--     but never decrypts.
--   * SHA-256 verification digests are lowercase hex TEXT (64 chars). The
--     hashed values are high-entropy random secrets, not user-chosen
--     passwords, so no slow KDF is required and no salt is stored alongside.
--   * `STRICT` tables are deliberately not used: the sandbox has no Cloudflare
--     account, so runtime-specific DDL could not be verified against real D1.
--     Portable CHECK constraints cover the same integrity cases.
--   * No triggers: the migration splitter used by the test pool and the
--     wrangler/D1 tooling is statement based, and invariants that span tables
--     are enforced in application transactions and by tests instead.

-- ---------------------------------------------------------------------------
-- Account (§3). Exactly one application account exists; the row is created by
-- first-run initialization. `username` is immutable and is a KDF input, so it
-- is stored byte-exact and is never rewritten.
--
-- The wrapped DEK is NULL until the client finishes key setup. The DEK is
-- generated in the browser — the server never holds it — so enrolment creates
-- the account first and the client uploads the KEK-wrapped DEK afterwards
-- (requirements §6, ADR-002). Any operation that needs data keys must refuse an
-- account whose key material is still missing rather than assume it exists.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Random per-account HKDF salt (base64).
  kdf_salt TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  crypto_version INTEGER NOT NULL DEFAULT 1 CHECK (crypto_version >= 1),
  wrapped_dek_iv TEXT,
  wrapped_dek_ciphertext TEXT,
  -- Progressive login backoff with a cap; never a permanent lockout (§3).
  failed_auth_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_auth_count >= 0),
  auth_backoff_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((wrapped_dek_iv IS NULL) = (wrapped_dek_ciphertext IS NULL))
);

-- ---------------------------------------------------------------------------
-- TOTP configuration (§3). The secret must be re-delivered to the client after
-- authentication to derive the KEK, so it is stored recoverably, encrypted
-- under a Worker-side key — never hashed. That exposure is the accepted risk in
-- requirements §25 and the threat model.
--
-- Deferred to the P3 migration: the pending-rebind columns needed by the
-- resumable/rollbackable TOTP rebind state machine (requirements §3, §6).
-- ---------------------------------------------------------------------------
CREATE TABLE totp_config (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_iv TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  crypto_version INTEGER NOT NULL DEFAULT 1 CHECK (crypto_version >= 1),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  algorithm TEXT NOT NULL DEFAULT 'SHA-1' CHECK (algorithm IN ('SHA-1', 'SHA-256', 'SHA-512')),
  digits INTEGER NOT NULL DEFAULT 6 CHECK (digits IN (6, 8)),
  period_seconds INTEGER NOT NULL DEFAULT 30 CHECK (period_seconds > 0),
  -- Anti-replay (RFC 6238 §5.2): the last accepted time-step. A code from an
  -- already-consumed step is rejected even inside its validity window.
  last_used_step INTEGER,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Recovery codes (§3, §6). Ten single-use codes, each 32 random characters.
-- Only a verification digest and the code's own opaque wrapping of the DEK are
-- stored; a plaintext code never reaches the server, logs or URLs.
-- ---------------------------------------------------------------------------
CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  -- Per-code HKDF salt for the recovery KEK (§6 "Recovery key path"). Generated
  -- by the server at enrolment; it is not secret.
  kdf_salt TEXT NOT NULL,
  -- NULL until the client uploads the recovery wrapping of the DEK (P3), for
  -- the same reason the account's wrapped DEK starts NULL.
  wrapped_dek_iv TEXT,
  wrapped_dek_ciphertext TEXT,
  crypto_version INTEGER CHECK (crypto_version >= 1),
  key_version INTEGER CHECK (key_version >= 1),
  -- NULL until the code is spent. Single use: a spent code is never revived.
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((wrapped_dek_iv IS NULL) = (wrapped_dek_ciphertext IS NULL))
);

CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id, used_at);

-- ---------------------------------------------------------------------------
-- Sessions (§4). The id is a UUIDv7; only SHA-256(token) is stored.
-- Sliding expiration is 40 minutes, remember-device at most 30 days and never
-- bypasses TOTP. The 5-session cap and least-recently-active eviction
-- (ADR-005) are application invariants: they cannot be expressed as a CHECK.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  remember_device INTEGER NOT NULL DEFAULT 0 CHECK (remember_device IN (0, 1)),
  device_name TEXT,
  -- Coarse browser+OS category only; the full User-Agent is never retained (§4).
  client_category TEXT,
  -- Truncated IP (network prefix), never the full address (§4, §5).
  ip_truncated TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX sessions_user_activity_idx ON sessions (user_id, revoked_at, last_seen_at);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Folders (§9). Names are encrypted; the parent relationship is not, because
-- requirements §24 permits the server to see structural relationships.
-- `depth` is 1-based and CHECKed so the documented maximum depth of 10 is
-- enforced by the database rather than only by application code.
--
-- Deleting a folder is a soft delete that preserves ids and subtree
-- relationships, so the self-reference and the notes reference use RESTRICT:
-- a hard DELETE that would silently drop a subtree fails instead, and the
-- purge path must remove children explicitly in dependency order.
-- ---------------------------------------------------------------------------
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  depth INTEGER NOT NULL CHECK (depth >= 1 AND depth <= 10),
  name_iv TEXT NOT NULL,
  name_ciphertext TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  -- Manual drag order; the application maintains gaps between values.
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX folders_user_parent_idx ON folders (user_id, parent_id);
CREATE INDEX folders_user_deleted_idx ON folders (user_id, deleted_at);
CREATE INDEX folders_deleted_at_idx ON folders (deleted_at);

-- ---------------------------------------------------------------------------
-- Tags (§9). Flat, encrypted names. Deleting a tag removes relationships only,
-- so a tag row is hard-deleted and the note_tags rows cascade. Favourites are
-- expressed as a reusable tag, not as a separate table.
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_iv TEXT NOT NULL,
  name_ciphertext TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX tags_user_idx ON tags (user_id);

-- ---------------------------------------------------------------------------
-- Notes (§9). The folder relationship, revision, timestamps and deletion state
-- are visible to the server; the title lives inside the encrypted Markdown
-- payload, so no plaintext title column exists by design.
--
-- `revision` is the optimistic lock: updates must use
--   UPDATE notes SET ... WHERE id = ? AND revision = ?
-- and treat "0 rows affected" as a conflict (requirements §27). The primary
-- key already makes that a single-row lookup, so no extra index is added.
--
-- note_revisions additionally stores a row for the *current* revision (§9
-- "Keep current revision plus at most 10 historical versions"); this payload is
-- duplicated here for fast reads and the two must be written in one
-- transaction. The invariant is asserted by the schema tests.
-- ---------------------------------------------------------------------------
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL means "root / unfiled"; see docs/schema.md for the interpretation of
  -- requirements §10 "a note has exactly one folder".
  folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  payload_iv TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX notes_user_folder_idx ON notes (user_id, folder_id);
CREATE INDEX notes_user_updated_idx ON notes (user_id, updated_at);
CREATE INDEX notes_user_deleted_idx ON notes (user_id, deleted_at);
CREATE INDEX notes_deleted_at_idx ON notes (deleted_at);

-- ---------------------------------------------------------------------------
-- Note <-> tag join (§9). Tags are many-to-many; the limit of 10 tags per note
-- is an application invariant and is covered by the schema tests. Deleting a
-- tag removes relationships only, hence the cascade on tag_id.
-- ---------------------------------------------------------------------------
CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX note_tags_tag_idx ON note_tags (tag_id);

-- ---------------------------------------------------------------------------
-- Revision history (§9, §18). At most 10 historical versions plus the current
-- one are retained; pruning the oldest is permanent. `parent_revision_id` uses
-- ON DELETE SET NULL so that pruning a parent cannot be blocked by its
-- children, while still preserving the chain for the revisions that remain.
-- ---------------------------------------------------------------------------
CREATE TABLE note_revisions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  parent_revision_id TEXT REFERENCES note_revisions(id) ON DELETE SET NULL,
  payload_iv TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  save_reason TEXT NOT NULL CHECK (save_reason IN ('initial', 'interval', 'manual', 'restore', 'import')),
  created_at INTEGER NOT NULL,
  -- Monotonic numbering per note and idempotent replay of the same revision.
  UNIQUE (note_id, revision)
);

CREATE INDEX note_revisions_note_created_idx ON note_revisions (note_id, created_at);

-- ---------------------------------------------------------------------------
-- Attachments (§9). Only images, at most 20 MB, stored in R2 under a random
-- key; the original filename is encrypted. Sizes and the image/* content type
-- are server-visible structural metadata (§24).
--
-- `ref_count` is maintained transactionally alongside note_attachments. The
-- two foreign keys in note_attachments use RESTRICT so an attachment or note
-- cannot be deleted without the application explicitly removing its links and
-- adjusting the count; a test asserts ref_count always equals the number of
-- link rows. When the count reaches zero the R2 object is deleted
-- asynchronously (deletion_enqueued_at), never inline.
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  name_iv TEXT NOT NULL,
  name_ciphertext TEXT NOT NULL,
  crypto_version INTEGER NOT NULL CHECK (crypto_version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  content_type TEXT NOT NULL CHECK (content_type LIKE 'image/%'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  ref_count INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  deletion_enqueued_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX attachments_user_idx ON attachments (user_id);
CREATE INDEX attachments_cleanup_idx ON attachments (ref_count, deletion_enqueued_at);

-- ---------------------------------------------------------------------------
-- Note <-> attachment join (§9). One image may be referenced by many notes.
-- ---------------------------------------------------------------------------
CREATE TABLE note_attachments (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, attachment_id)
);

CREATE INDEX note_attachments_attachment_idx ON note_attachments (attachment_id);

-- ---------------------------------------------------------------------------
-- Incremental sync feed and tombstones (§16). `seq` is the server-provided
-- cursor: clients ask for rows with seq greater than the cursor they hold.
-- AUTOINCREMENT guarantees a value is never reused, so a cursor can never
-- silently skip a change. Deletions are rows with change_type = 'delete'
-- (tombstones) and are retained for 30 days like every other change.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (
    object_type IN ('note', 'note_revision', 'folder', 'tag', 'note_tag_link', 'attachment', 'note_attachment')
  ),
  object_id TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update', 'delete')),
  -- Revision produced by the change, when the object is revisioned.
  revision INTEGER,
  changed_at INTEGER NOT NULL
);

CREATE INDEX sync_changes_user_seq_idx ON sync_changes (user_id, seq);
CREATE INDEX sync_changes_changed_at_idx ON sync_changes (changed_at);

-- ---------------------------------------------------------------------------
-- Security audit log (§5). Retention is exactly 30 days and enforced by the
-- hourly cron sweep; users cannot clear it. Note plaintext, titles, TOTP
-- secrets, recovery codes and keys must never be written here.
--
-- `category` uses a closed vocabulary because it is stable and useful for
-- filtering; `event_type` is intentionally free text so that new event names do
-- not require a migration. Sensitive per-event detail goes into the encrypted
-- envelope, which must be either wholly present or wholly absent.
-- `session_id` deliberately has no foreign key: the log entry must survive the
-- session it describes.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('auth', 'session', 'key', 'data', 'account')),
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure')),
  session_id TEXT,
  ip_truncated TEXT,
  client_category TEXT,
  detail_iv TEXT,
  detail_ciphertext TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((detail_iv IS NULL) = (detail_ciphertext IS NULL))
);

CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at);
CREATE INDEX audit_logs_user_created_idx ON audit_logs (user_id, created_at);
CREATE INDEX audit_logs_category_created_idx ON audit_logs (category, created_at);

-- ---------------------------------------------------------------------------
-- Rate limiting (§3): by IP, by account and globally per endpoint. Fixed
-- windows keyed by (scope, bucket, window_start); the bucket is a truncated IP,
-- a user id or an endpoint label. Expired rows are swept by the cron job.
-- Per-account exponential backoff state lives on `users`.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'account', 'endpoint', 'global')),
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket, window_start)
);

CREATE INDEX rate_limits_expires_at_idx ON rate_limits (expires_at);
