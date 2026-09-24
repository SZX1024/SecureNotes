-- Content envelope for attachments (§7, §12).
--
-- The name was already stored as an envelope (iv + ciphertext + versions). The bytes
-- in R2 were not: nothing recorded the IV used to encrypt them, so a client could not
-- decrypt an attachment it had uploaded. These columns carry what decryption needs.
--
-- Both are nullable because SQLite cannot add a NOT NULL column without a default, and
-- inventing an IV for existing rows would produce data that looks decryptable and is
-- not. The API requires both for every new upload; rows predating this migration exist
-- only in development databases and are documented as undecryptable.

ALTER TABLE attachments ADD COLUMN content_iv TEXT;
ALTER TABLE attachments ADD COLUMN plaintext_size_bytes INTEGER;
