-- Folder revisions (§16).
--
-- "Folder movement conflicts enter conflict state." Without a revision there is nothing to compare a
-- move against, which made every folder update last-write-wins — the one thing §16 rules out.
--
-- Existing folders start at revision 1, which is what a folder created before this migration effectively
-- is.
ALTER TABLE folders ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
