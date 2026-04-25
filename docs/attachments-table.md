# Attachments table — design (target: 0.6.0)

## Why

Today every attachment a Telegram message carries is squashed into a single
`messages.attachments_json` blob. That mostly works (single insert with the
message keeps things atomic), but it's a write-once dead-end:

- No way to query "all PDFs Maria sent in the last week" without grepping
  blobs across rows.
- No place to record per-attachment lifecycle: pending → downloaded → failed.
- Voice transcription has to re-marshal the whole array to update one item.
- Local download path isn't persisted — we re-derive it from `msg_id` +
  `file_unique_id` every turn (cheap, but means we can't tell which files
  on disk are still referenced when sweeping `inbox/`).
- Boot replay reads `attachments_json` to reconstruct what to re-fetch, but
  has no signal "this attachment failed last time, don't bother".

A proper table fixes all of that and unlocks future features (per-type
analytics, search, smarter cleanup, attachment-level retention policies).

## Schema (migration 007)

```sql
CREATE TABLE attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL,           -- FK to messages.id
  chat_id         TEXT    NOT NULL,           -- denormalized for chat-scoped queries
  msg_id          INTEGER NOT NULL,           -- Telegram msg_id (denormalized)
  thread_id       TEXT,                       -- forum topic, if any
  bot_name        TEXT    NOT NULL,           -- which bot received it
  file_id         TEXT    NOT NULL,           -- Telegram per-bot id (changes per bot)
  file_unique_id  TEXT,                       -- Telegram global stable id
  kind            TEXT    NOT NULL,           -- document|photo|voice|audio|video
  name            TEXT,                       -- original or synthesized filename
  mime_type       TEXT,
  size_bytes      INTEGER,                    -- as reported by Telegram (may differ from on-disk)
  local_path      TEXT,                       -- NULL until downloaded
  download_status TEXT    NOT NULL,           -- pending|downloaded|failed
  download_error  TEXT,                       -- short message if failed
  transcription   TEXT,                       -- voice/audio transcript text (NULL otherwise)
  ts              INTEGER NOT NULL,           -- copied from message ts (chat-scoped queries)
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX idx_attachments_chat_ts   ON attachments(chat_id, ts);
CREATE INDEX idx_attachments_kind_ts   ON attachments(kind, ts);
CREATE INDEX idx_attachments_status    ON attachments(download_status)
  WHERE download_status != 'downloaded';
CREATE INDEX idx_attachments_message   ON attachments(message_id);
CREATE INDEX idx_attachments_unique_id ON attachments(file_unique_id)
  WHERE file_unique_id IS NOT NULL;
```

The narrow indexes on `download_status` (only failed/pending) and
`file_unique_id` (only non-null) keep the index small while still
supporting the only queries that need them: "find work to retry" and
"dedupe by Telegram's stable id".

## Backfill

Migration 007 also walks every existing row where
`messages.attachments_json IS NOT NULL`, parses, inserts one
`attachments` row per item with `download_status='downloaded'` (we know
historical rows were processed; reconstructing failure state isn't useful
for old data). If JSON parse fails, the row is skipped and a
`migration-007-skip` event is logged with the row id.

Then drops `messages.attachments_json` — single source of truth, no
read-back-compat needed once the migration commits.

## API additions to lib/db.js

| Method | Purpose |
|---|---|
| `insertAttachment(row)` | Called by `recordInbound` per file; status starts as `pending` |
| `markAttachmentDownloaded(id, {local_path, size_bytes})` | After successful fetch |
| `markAttachmentFailed(id, error)` | After fetch fails — sets status + error |
| `setAttachmentTranscription(id, text)` | Replaces the JSON-rewrite hack in voice path |
| `getAttachmentsByMessage(message_id)` | Replaces `JSON.parse(attachments_json)` everywhere |
| `searchAttachments({chat_id?, kind?, since?, until?, status?})` | New ops query |
| `listFailedAttachments({since})` | Dashboards / debugging |

All synchronous (better-sqlite3), all wrapped in `dbWrite` from polygram.js.

## Code touches

### `polygram.js`

- `recordInbound`: same single transaction now also inserts attachment rows
  (`pending` status). Use `db.transaction(...)` so message + attachments
  commit together.
- `downloadAttachments`: takes the array of pending row objects, loops them,
  on success calls `markAttachmentDownloaded` with the local path; on failure
  calls `markAttachmentFailed`. Returns the same shape callers consume today
  so call sites barely change.
- `transcribeVoiceAttachments`: calls `setAttachmentTranscription` per row
  instead of rewriting the JSON blob.
- Boot replay reconstructs `_mergedAttachments` from
  `getAttachmentsByMessage(row.id)` so the existing `extractAttachments`
  shortcut still works.

### `lib/prompt.js`

- `buildAttachmentTags` now branches on `download_status`. `downloaded` →
  `<attachment ...>`. `failed` → `<attachment-failed reason="..." />` so
  Claude can naturally tell the user "I couldn't see your photo." This
  is the same surfacing fix as #3 above; the table just makes it cleaner.

### FTS

`messages.text` keeps the voice transcript copy for now — chat-search
parity ("find Maria saying X") is more valuable than FTS purity. The
attachments table holds the canonical transcript. We could later add
`attachments_fts` on `transcription` if we want kind-scoped search.

## Migration risk

- The backfill runs once at boot when SCHEMA_VERSION moves 6→7. It's
  read-only against the source rows (just reads + inserts). If it fails
  mid-flight the migration rolls back via `BEGIN IMMEDIATE` (already used
  by the migration runner).
- Dropping `messages.attachments_json` is irreversible — keep the
  migration in two phases if we want a safety window:
    - **007a**: create table, backfill
    - **007b**: drop column (next release after we're confident)

## Test plan

`tests/db.test.js` already has fixtures for messages. New cases:

- `insertAttachment + markAttachmentDownloaded` round-trip
- `markAttachmentFailed` sets status + error, leaves `local_path` NULL
- `getAttachmentsByMessage` ordering (insertion order)
- `searchAttachments` filters by kind, status, time window
- Foreign-key cascade: deleting a message deletes its attachments
- Migration 007 backfill: insert pre-migration messages with
  `attachments_json`, run migration, assert attachments table has the
  same items.

## Rollout

- Bump 0.5.x → 0.6.0 (minor — schema change, public-API addition).
- Migration runs automatically on next boot (existing migration runner
  handles it).
- Existing inboxes / `attachments_json` data is preserved via backfill.
- The on-disk `inbox/<chat_id>/...` filename convention is unchanged
  (deterministic from `msg_id` + `file_unique_id`), so no file moves.

## Out of scope (notes for future)

- **Content hashing**: Telegram doesn't give us a SHA, so we can't verify
  CDN integrity. Adding our own (sha256 on download) costs CPU; defer
  unless we have a corruption case to chase.
- **Attachment retention policy** beyond `sweepInbox`: e.g. "drop voice
  files older than 30d but keep documents forever." With the table we
  could add a `retention_class` column and a sweeper that respects it.
- **Per-attachment row** opens the door to a Telegram bot-side `/files`
  command ("show me everything Maria sent this week") — useful but
  not in this slice.
