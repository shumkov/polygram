-- 0.7.6 (item F): turn_metrics table.
--
-- Stream-json `result` events from `claude -p` carry total_cost_usd and
-- duration_ms (already pulled into pending.resolve()), plus a `usage`
-- block on each `assistant` event with token counts including cache hits.
-- Pre-fix all of this was logged to console only; once a turn was done
-- the cost was unrecoverable for analysis.
--
-- This table persists per-turn metrics keyed by (chat_id, msg_id) so we
-- can answer questions like:
--   - cost / day per bot
--   - cache hit rate per chat
--   - which chats have the longest turns
--   - which models are most expensive overall
--
-- Stored at turn end (in onResult callback). One row per dispatched
-- user-message-to-final-reply cycle, even if the cycle had multiple
-- assistant messages (those are aggregated).
CREATE TABLE IF NOT EXISTS turn_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,                  -- turn end timestamp (ms)
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  msg_id INTEGER NOT NULL,              -- inbound message_id that started turn
  session_id TEXT,                      -- claude session UUID for resume
  bot_name TEXT,                        -- 'shumabit' / 'umi-assistant' / etc
  model TEXT,                           -- chatConfig.model at turn start
  effort TEXT,                          -- chatConfig.effort
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  num_assistant_messages INTEGER,       -- top-level message count (forceNewMessage events)
  num_tool_uses INTEGER,
  result_subtype TEXT,                  -- 'success' / 'error_max_turns' / etc
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_chat_ts ON turn_metrics(chat_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_recent ON turn_metrics(ts DESC);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_session ON turn_metrics(session_id);
