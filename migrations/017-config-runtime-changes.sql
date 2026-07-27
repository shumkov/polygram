-- Extend config_changes without changing its columns, so older Polygram
-- binaries can continue reading the table and writing legacy field values.
-- runMigrations() wraps every migration in BEGIN IMMEDIATE / COMMIT.

CREATE TABLE config_changes_v17 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  field TEXT NOT NULL CHECK(field IN ('model','effort','agent','runtime','pm')),
  old_value TEXT,
  new_value TEXT NOT NULL,
  user_id INTEGER,
  user TEXT,
  source TEXT,
  ts INTEGER NOT NULL
);

INSERT INTO config_changes_v17 (
  id,
  chat_id,
  thread_id,
  field,
  old_value,
  new_value,
  user_id,
  user,
  source,
  ts
)
SELECT
  id,
  chat_id,
  thread_id,
  field,
  old_value,
  new_value,
  user_id,
  user,
  source,
  ts
FROM config_changes;

DROP TABLE config_changes;
ALTER TABLE config_changes_v17 RENAME TO config_changes;

CREATE INDEX idx_config_recent ON config_changes(chat_id, ts DESC);
