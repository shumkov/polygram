-- Presses on buttons whose callback_data starts with "ext:", which belong
-- to an external IPC sender (agent-org is "ext:ao:..."). polygram records
-- each press as a fact; the owner reads this table and decides what it
-- means. See docs/EXT_BUTTONS_SPEC.md.
--
-- thread_id is the message's message_thread_id, user_id the presser's
-- Telegram id, data the full callback_data (untrusted: a client can send
-- data no button carries), ts the receipt time in ms. A redelivered update
-- carries the same callback_query_id and inserts nothing. AUTOINCREMENT so
-- a row id is never reissued in the live file, even after deletes. A
-- reader's once-only claim should still key on callback_query_id, which
-- also survives a restore from backup.
CREATE TABLE button_presses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  msg_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL,
  callback_query_id TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_button_presses_chat_ts ON button_presses(chat_id, ts);
