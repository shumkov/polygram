-- Replace the messages.attachments_json blob with a real table so we can
-- query, search, and track lifecycle per attachment. Design doc:
-- docs/attachments-table.md.
--
-- This migration creates the table + indexes and backfills from existing
-- attachments_json. The column itself is NOT dropped here — kept as a
-- safety net for one minor release. A follow-up migration drops it once
-- we're confident reads/writes have fully moved over.
--
-- For backfilled rows we set download_status='downloaded' (we know they
-- went through to disk historically; recreating failure state isn't
-- useful for old data). Local path is left NULL — the deterministic
-- on-disk location can be re-derived from msg_id + file_unique_id at
-- read time if a caller needs it; the existing inbox/<chat_id>/...
-- filename convention is unchanged.

CREATE TABLE IF NOT EXISTS attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL,
  chat_id         TEXT    NOT NULL,
  msg_id          INTEGER NOT NULL,
  thread_id       TEXT,
  bot_name        TEXT,
  file_id         TEXT    NOT NULL,
  file_unique_id  TEXT,
  kind            TEXT    NOT NULL,
  name            TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  local_path      TEXT,
  download_status TEXT    NOT NULL CHECK(download_status IN ('pending','downloaded','failed')),
  download_error  TEXT,
  transcription   TEXT,
  ts              INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_chat_ts
  ON attachments(chat_id, ts);

CREATE INDEX IF NOT EXISTS idx_attachments_kind_ts
  ON attachments(kind, ts);

-- Narrow index: only the small set we actually want to query for retries
-- and dashboards. Skips the bulk 'downloaded' rows.
CREATE INDEX IF NOT EXISTS idx_attachments_status
  ON attachments(download_status, ts)
  WHERE download_status != 'downloaded';

CREATE INDEX IF NOT EXISTS idx_attachments_message
  ON attachments(message_id);

-- Narrow: file_unique_id is NULL for some historical rows (Telegram doesn't
-- always populate it for old messages); only index the populated ones.
CREATE INDEX IF NOT EXISTS idx_attachments_unique_id
  ON attachments(file_unique_id)
  WHERE file_unique_id IS NOT NULL;

-- Backfill from messages.attachments_json. Only rows that aren't already
-- represented (idempotent — re-running this migration on a partially-
-- migrated DB doesn't double-insert).
--
-- attachments_json shape: array of objects, each with kind, name,
-- mime_type, size, file_id, file_unique_id, and optionally transcription.
-- Pre-0.5.x rows may not have file_unique_id. We pull what's there and
-- leave the rest NULL.
--
-- Robustness: json_each() raises on malformed JSON or on a non-array
-- root, which would roll back the entire migration transaction (one bad
-- row blocks the upgrade). The `json_valid(...) AND json_type(...) =
-- 'array'` guards skip those rows so the rest still backfill. Rows
-- without a `file_id` are also skipped — the schema declares file_id
-- NOT NULL and we'd rather drop a corrupt entry than materialise a
-- permanently un-redownloadable row with file_id=''.
-- Pre-filter messages in a subquery so json_each() only runs on valid
-- JSON arrays. SQLite's json_each raises on malformed JSON or on a
-- non-array root, and that error rolls back the whole migration. The
-- subquery materialises only rows that pass json_valid + json_type
-- before the join expands them.
INSERT INTO attachments (
  message_id, chat_id, msg_id, thread_id, bot_name,
  file_id, file_unique_id, kind, name, mime_type, size_bytes,
  local_path, download_status, transcription, ts
)
SELECT
  m.id, m.chat_id, m.msg_id, m.thread_id, m.bot_name,
  json_extract(att.value, '$.file_id'),
  json_extract(att.value, '$.file_unique_id'),
  COALESCE(json_extract(att.value, '$.kind'), 'document'),
  json_extract(att.value, '$.name'),
  json_extract(att.value, '$.mime_type'),
  json_extract(att.value, '$.size'),
  json_extract(att.value, '$.path'),
  'downloaded',
  json_extract(att.value, '$.transcription.text'),
  m.ts
FROM (
  SELECT id, chat_id, msg_id, thread_id, bot_name, attachments_json, ts
    FROM messages
   WHERE direction = 'in'
     AND attachments_json IS NOT NULL
     AND json_valid(attachments_json) = 1
     AND json_type(attachments_json) = 'array'
     AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = id)
) m, json_each(m.attachments_json) att
WHERE json_extract(att.value, '$.file_id') IS NOT NULL
  AND json_extract(att.value, '$.file_id') != '';
