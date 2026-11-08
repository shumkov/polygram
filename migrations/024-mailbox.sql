-- Messages between role sessions. Delivery state lives in external_jobs,
-- keyed by (route_id, 'mailbox:' || id); this table holds only what the
-- daemon decided and stamped at send time.
CREATE TABLE mailbox_messages (
  id          TEXT PRIMARY KEY,
  bot_name    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('ask','tell','reply')),
  from_addr   TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  route_id    TEXT NOT NULL,
  body        TEXT NOT NULL,
  in_reply_to TEXT REFERENCES mailbox_messages(id),
  depth       INTEGER NOT NULL,
  body_hash   TEXT NOT NULL,
  notice_sent INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX mailbox_one_reply ON mailbox_messages(in_reply_to) WHERE kind = 'reply';
CREATE INDEX mailbox_by_pair ON mailbox_messages(bot_name, from_addr, to_addr, created_at);
