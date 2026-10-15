CREATE TABLE IF NOT EXISTS external_jobs (
  id INTEGER PRIMARY KEY,
  bot_name TEXT NOT NULL,
  route_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  task TEXT NOT NULL,
  payload TEXT NOT NULL,
  target TEXT NOT NULL,
  session_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  report_state TEXT NOT NULL DEFAULT 'none',
  turn_id TEXT,
  report_receipt TEXT,
  error TEXT,
  inactive INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(bot_name, route_id, request_id)
);
CREATE INDEX IF NOT EXISTS external_jobs_queue ON external_jobs(bot_name, state, id);
CREATE INDEX IF NOT EXISTS external_jobs_session ON external_jobs(bot_name, session_key, inactive, state);
CREATE TABLE IF NOT EXISTS external_job_controls (
  bot_name TEXT NOT NULL,
  session_key TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(bot_name, session_key)
);
CREATE TABLE IF NOT EXISTS external_job_report_parts (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES external_jobs(id),
  part_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  receipt TEXT,
  error TEXT,
  retry_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(job_id, part_index)
);
CREATE INDEX IF NOT EXISTS external_job_report_pending ON external_job_report_parts(state, retry_at, job_id);
