-- Conflicts (§16).
--
-- "Server accepts only when current revision equals base revision. Otherwise it creates a conflict
-- instead of silently overwriting." The three sides are retained so the client can show a
-- Base / Local / Remote diff: base is the revision the client thought it was editing, local is what
-- it sent, remote is what the server holds now.
--
-- The payloads are ciphertext envelopes, exactly like the objects they came from: the worker stores
-- a conflict without being able to read either side of it.
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (object_type IN ('note', 'folder')),
  object_id TEXT NOT NULL,
  -- The revision the client based its edit on. Null when the object it edited is gone.
  base_revision INTEGER,
  local_iv TEXT NOT NULL,
  local_ciphertext TEXT NOT NULL,
  local_crypto_version INTEGER NOT NULL CHECK (local_crypto_version >= 1),
  local_key_version INTEGER NOT NULL CHECK (local_key_version >= 1),
  remote_revision INTEGER NOT NULL,
  remote_iv TEXT NOT NULL,
  remote_ciphertext TEXT NOT NULL,
  remote_crypto_version INTEGER NOT NULL CHECK (remote_crypto_version >= 1),
  remote_key_version INTEGER NOT NULL CHECK (remote_key_version >= 1),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT CHECK (resolution IN ('local', 'remote', 'merged'))
);

-- §16: "Conflicts pause the affected object until resolved", so there can be at most one open
-- conflict per object. Resolved ones are kept, which is why this is a partial index.
CREATE UNIQUE INDEX conflicts_open_object
  ON conflicts (user_id, object_type, object_id)
  WHERE resolved_at IS NULL;

CREATE INDEX conflicts_by_user ON conflicts (user_id, created_at);
