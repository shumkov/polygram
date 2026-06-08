-- 0.12 interactive questions: AskUserQuestion → Telegram inline keyboards.
-- Mirrors pending_approvals (per-row 128-bit callback token, status lifecycle,
-- audit-kept rows). One OPEN question per session at a time (idx_pq_open).
-- The answer routes back to claude on tool_call_id via a question_answer message.

CREATE TABLE pending_questions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_name          TEXT NOT NULL,
  session_key       TEXT NOT NULL,     -- chat:thread that asked (claude session)
  chat_id           TEXT NOT NULL,
  thread_id         TEXT,
  turn_id           TEXT,              -- echoed for routing
  tool_call_id      TEXT NOT NULL,     -- the question_answer routes back on this
  from_id           INTEGER,           -- Telegram user_id allowed to answer; claimed on first tap
  callback_token    TEXT NOT NULL,     -- 128-bit; defeats forged/guessed callback_data
  questions_json    TEXT NOT NULL,     -- the ask call's questions array
  state_json        TEXT NOT NULL,     -- the question-state machine state
  message_ids_json  TEXT,              -- Telegram msg_id(s) of the keyboard message to edit/strip
  awaiting_other    INTEGER NOT NULL DEFAULT 0,  -- 1 while capturing a free-text "Other"
  status            TEXT NOT NULL
    CHECK(status IN ('pending','answered','cancelled','timeout','expired'))
    DEFAULT 'pending',
  created_ts        INTEGER NOT NULL,
  timeout_ts        INTEGER NOT NULL,
  answered_ts       INTEGER
);

CREATE INDEX idx_pq_open      ON pending_questions(session_key, status) WHERE status = 'pending';
CREATE INDEX idx_pq_timeout   ON pending_questions(status, timeout_ts)  WHERE status = 'pending';
CREATE INDEX idx_pq_tool_call ON pending_questions(tool_call_id);
