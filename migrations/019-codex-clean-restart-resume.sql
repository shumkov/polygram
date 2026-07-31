ALTER TABLE agent_runtime_sessions ADD COLUMN spawn_profile_id TEXT;

ALTER TABLE clean_restart_resume_intents
  ADD COLUMN interrupted_provider_turn_id TEXT;

ALTER TABLE clean_restart_resume_intents
  ADD COLUMN interrupted_spawn_profile_id TEXT;

-- Rows written by a pre-v19 daemon during the one-time upgrade restart use
-- the default and therefore cannot authorize provider continuation.
ALTER TABLE clean_restart_resume_intents
  ADD COLUMN continuation_authorized INTEGER NOT NULL DEFAULT 0
    CHECK (continuation_authorized IN (0, 1));
