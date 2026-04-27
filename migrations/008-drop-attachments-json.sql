-- Drop the legacy messages.attachments_json column. 0.6.0's migration 007
-- created the per-attachment table and backfilled from this column; the
-- column was kept for one minor as a safety net. polygram 0.6.1 reads
-- exclusively from the attachments table now, so the column is dead code
-- on the schema side and can go.
--
-- SQLite supports ALTER TABLE DROP COLUMN since 3.35 (well below
-- better-sqlite3's bundled SQLite). The op rewrites the table in place,
-- which is fine — `messages` is small enough that a one-time rewrite at
-- migration time is cheaper than carrying the column around forever.

ALTER TABLE messages DROP COLUMN attachments_json;
