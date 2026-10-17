CREATE TABLE recorded_notifications (
  id INTEGER PRIMARY KEY,
  bot_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
  data TEXT NOT NULL,
  target TEXT NOT NULL,
  session_key TEXT NOT NULL,
  eligible INTEGER NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending',
  delivery_error TEXT,
  retry_at INTEGER NOT NULL DEFAULT 0,
  processed_request_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(bot_name, source_id, event_id)
);
CREATE INDEX recorded_notifications_unread ON recorded_notifications(bot_name, session_key, eligible, id);
CREATE TABLE notification_consumers (
  bot_name TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  session_key TEXT NOT NULL,
  target TEXT NOT NULL,
  processed_id INTEGER NOT NULL,
  active_batch TEXT,
  last_request_id TEXT,
  error TEXT,
  PRIMARY KEY(bot_name, consumer_id, generation),
  UNIQUE(bot_name, session_key, generation)
);
CREATE TABLE notification_wakes (
  bot_name TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  wake_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  due_at INTEGER,
  context TEXT NOT NULL,
  notification_ids TEXT NOT NULL,
  PRIMARY KEY(bot_name, consumer_id, generation, wake_key),
  FOREIGN KEY(bot_name, consumer_id, generation) REFERENCES notification_consumers(bot_name, consumer_id, generation)
);
