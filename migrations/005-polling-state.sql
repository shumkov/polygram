-- Persist grammy's update offset so a polygram restart doesn't re-process
-- the entire getUpdates backlog from the last 24h. Grammy's in-memory
-- offset resets to 0 on boot; Telegram replies with every unconfirmed
-- update. For a bot that went down overnight with active chats, that can
-- mean re-running dozens of turns on stale messages.
--
-- One row per bot. Row is upserted on every successful getUpdates batch
-- that returned at least one update.

CREATE TABLE IF NOT EXISTS polling_state (
  bot_name       TEXT PRIMARY KEY,
  last_update_id INTEGER NOT NULL,
  ts             INTEGER NOT NULL
);
