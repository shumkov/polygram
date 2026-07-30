-- One-shot ownership for a CLI turn interrupted by a deliberate restart.
--
-- generation_id is a non-identity reference token. It lets a restart intent
-- prove that the authoritative provider-session row was not replaced between
-- shutdown and boot without copying provider session identity into the intent.

ALTER TABLE agent_runtime_sessions ADD COLUMN generation_id TEXT;

UPDATE agent_runtime_sessions
   SET generation_id = lower(hex(randomblob(16)))
 WHERE generation_id IS NULL;

CREATE UNIQUE INDEX idx_agent_runtime_sessions_generation_id
  ON agent_runtime_sessions(generation_id);

CREATE TABLE clean_restart_resume_intents (
  bot_name TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_generation_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  shutdown_at INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  PRIMARY KEY(bot_name, session_key)
);
