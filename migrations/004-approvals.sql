-- Feature 2: inline keyboard approvals for destructive tools.

CREATE TABLE pending_approvals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_name             TEXT NOT NULL,
  turn_id              TEXT,              -- joins back to messages.turn_id (nullable: hook might not know)
  requester_chat_id    TEXT NOT NULL,     -- chat whose Claude is asking
  approver_chat_id     TEXT NOT NULL,     -- chat where the keyboard landed
  approver_msg_id      INTEGER,           -- Telegram msg_id of the keyboard (set after send)
  tool_name            TEXT NOT NULL,     -- "Bash", "mcp__shopify__order_cancel"
  tool_input_json      TEXT NOT NULL,
  tool_input_digest    TEXT NOT NULL,     -- sha256 prefix; dedups repeated hook fires
  callback_token       TEXT NOT NULL,     -- random token in callback_data to defeat replay
  status               TEXT NOT NULL
    CHECK(status IN ('pending','approved','denied','timeout','cancelled'))
    DEFAULT 'pending',
  requested_ts         INTEGER NOT NULL,
  decided_ts           INTEGER,
  decided_by_user_id   INTEGER,
  decided_by_user      TEXT,
  timeout_ts           INTEGER NOT NULL,
  reason               TEXT               -- operator-supplied deny reason (future)
);
CREATE INDEX idx_approvals_pending ON pending_approvals(status, timeout_ts)
  WHERE status = 'pending';
CREATE INDEX idx_approvals_turn    ON pending_approvals(turn_id);
CREATE INDEX idx_approvals_dedup   ON pending_approvals(bot_name, turn_id, tool_input_digest)
  WHERE status = 'pending';
