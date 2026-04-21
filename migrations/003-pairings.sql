-- Feature 1: pairing codes for live onboarding without bridge restarts.

-- Pairing codes (single-use, short-lived).
CREATE TABLE pair_codes (
  code              TEXT PRIMARY KEY,
  bot_name          TEXT NOT NULL,
  chat_id           TEXT,                  -- NULL = valid in any of the bot's chats
  scope             TEXT NOT NULL CHECK(scope IN ('user','chat')),
  issued_by_user_id INTEGER NOT NULL,
  issued_ts         INTEGER NOT NULL,
  expires_ts        INTEGER NOT NULL,
  used_by_user_id   INTEGER,
  used_ts           INTEGER,
  note              TEXT
);
CREATE INDEX idx_pair_codes_expiry ON pair_codes(expires_ts) WHERE used_ts IS NULL;
CREATE INDEX idx_pair_codes_bot    ON pair_codes(bot_name, issued_ts);

-- Active pairings: the result of a successful /pair <CODE>.
-- Soft-deleted via revoked_ts for audit trail.
CREATE TABLE pairings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_name            TEXT NOT NULL,
  user_id             INTEGER NOT NULL,
  chat_id             TEXT,                -- NULL = valid in any of the bot's chats
  granted_ts          INTEGER NOT NULL,
  granted_by_user_id  INTEGER NOT NULL,
  revoked_ts          INTEGER,
  note                TEXT,
  UNIQUE(bot_name, user_id, chat_id)
);
CREATE INDEX idx_pairings_lookup ON pairings(bot_name, user_id)
  WHERE revoked_ts IS NULL;
