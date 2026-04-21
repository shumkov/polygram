-- Fix FTS5 triggers for external-content tables.
-- The v1 triggers used plain UPDATE/DELETE on messages_fts which doesn't purge
-- old tokens from the index. Switch to the documented 'delete' command form
-- and rebuild the FTS index so any orphan tokens from pre-fix writes are gone.

DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_au;
DROP TRIGGER IF EXISTS messages_ad;

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, user) VALUES (new.id, new.text, new.user);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, user) VALUES ('delete', old.id, old.text, old.user);
END;

CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, user) VALUES ('delete', old.id, old.text, old.user);
  INSERT INTO messages_fts(rowid, text, user) VALUES (new.id, new.text, new.user);
END;

-- Rebuild index from scratch to discard any stale tokens.
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
