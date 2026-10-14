CREATE TABLE infra_incidents (
  id TEXT PRIMARY KEY,
  bot_name TEXT NOT NULL,
  source TEXT NOT NULL,
  host TEXT NOT NULL,
  resource TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'open',
  latest_state TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  summary TEXT,
  verification TEXT,
  next_check_at INTEGER,
  retry_at INTEGER NOT NULL DEFAULT 0,
  active_claim TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX infra_incidents_due ON infra_incidents(bot_name, next_check_at);
CREATE TABLE external_events (
  id INTEGER PRIMARY KEY,
  bot_name TEXT NOT NULL,
  source TEXT NOT NULL,
  host TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  incident_id TEXT NOT NULL REFERENCES infra_incidents(id),
  payload TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'pending',
  claim TEXT,
  received_at INTEGER NOT NULL,
  delivered_at INTEGER,
  report_receipt TEXT,
  UNIQUE(bot_name, source, host, source_event_id)
);
CREATE INDEX external_events_pending ON external_events(bot_name, delivery, incident_id);
CREATE TABLE infra_controls (
  bot_name TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  last_tick_at INTEGER,
  updated_at INTEGER NOT NULL
);
