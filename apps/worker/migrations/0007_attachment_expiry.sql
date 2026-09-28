-- Attachments may expire (§9 as amended).
--
-- A file can be uploaded to be kept for a while rather than forever, which is what makes the application usable as a
-- temporary drop. `expires_at` is null for a permanent attachment, and the sweep that already removes zero-reference
-- objects also removes the ones whose time is up.
--
-- Additive on purpose: an extra nullable column needs no table rebuild, and every existing row keeps its meaning — it
-- is permanent, which is what it was.
--
-- The index is partial because the sweep asks for rows with an expiry, and almost every row will not have one.

ALTER TABLE attachments ADD COLUMN expires_at INTEGER;

CREATE INDEX attachments_expiry_idx ON attachments (expires_at) WHERE expires_at IS NOT NULL;
