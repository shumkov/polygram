-- Telegram Bridge v2 — initial schema
-- Run once. Subsequent schema changes use additional migration files.

CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  claude_session_id TEXT NOT NULL,
  agent TEXT,
  cwd TEXT,
  model TEXT,
  effort TEXT,
  created_ts INTEGER NOT NULL,
  last_active_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_migrations (
  old_chat_id TEXT PRIMARY KEY,
  new_chat_id TEXT NOT NULL,
  migrated_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  msg_id INTEGER NOT NULL,
  user TEXT,
  user_id INTEGER,
  text TEXT,
  reply_to_id INTEGER,
  direction TEXT CHECK(direction IN ('in','out','system')),
  source TEXT,
  bot_name TEXT,
  attachments_json TEXT,
  session_id TEXT,
  model TEXT,
  effort TEXT,
  turn_id TEXT,
  status TEXT CHECK(status IN ('pending','sent','failed','received')) DEFAULT 'received',
  error TEXT,
  cost_usd REAL,
  ts INTEGER NOT NULL,
  edited_ts INTEGER,
  UNIQUE(chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_recent ON messages(chat_id, thread_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reply ON messages(chat_id, reply_to_id);
CREATE INDEX IF NOT EXISTS idx_turn ON messages(turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pending ON messages(status, ts) WHERE status = 'pending';

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, user,
  content=messages, content_rowid=id,
  tokenize='unicode61 remove_diacritics 2'
);

-- External-content FTS5: use 'delete' command so the old tokens are purged.
-- Plain DELETE/UPDATE on messages_fts leaves orphans.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, user) VALUES (new.id, new.text, new.user);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, user) VALUES ('delete', old.id, old.text, old.user);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, user) VALUES ('delete', old.id, old.text, old.user);
  INSERT INTO messages_fts(rowid, text, user) VALUES (new.id, new.text, new.user);
END;

CREATE TABLE IF NOT EXISTS config_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  field TEXT NOT NULL CHECK(field IN ('model','effort','agent')),
  old_value TEXT,
  new_value TEXT NOT NULL,
  user_id INTEGER,
  user TEXT,
  source TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_config_recent ON config_changes(chat_id, ts DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  chat_id TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_recent ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, ts DESC);
