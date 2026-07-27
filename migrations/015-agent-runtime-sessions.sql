-- Provider/session compatibility namespaces.
--
-- The legacy sessions table remains unchanged for rollback. New binaries
-- dual-write Claude rows during the rollback window. Codex never writes the
-- legacy claude_session_id column.

CREATE TABLE agent_runtime_sessions (
  session_key TEXT NOT NULL,
  namespace TEXT NOT NULL
    CHECK(namespace IN ('claude:inline', 'claude:channels', 'codex:app-server')),
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  provider_session_id TEXT NOT NULL,
  app_server_session_id TEXT,
  agent TEXT,
  cwd TEXT,
  model TEXT,
  effort TEXT,
  pm_backend TEXT,
  created_ts INTEGER NOT NULL,
  last_active_ts INTEGER NOT NULL,
  PRIMARY KEY(session_key, namespace)
);

CREATE INDEX idx_agent_runtime_sessions_provider
  ON agent_runtime_sessions(provider, namespace, last_active_ts DESC);

-- Stored tmux rows are the historical inline backend. Only cli/channels rows
-- carry the Channels reply-tool compatibility contract.
INSERT INTO agent_runtime_sessions (
  session_key, namespace, provider, provider_session_id,
  app_server_session_id, agent, cwd, model, effort, pm_backend,
  created_ts, last_active_ts
)
SELECT
  session_key,
  CASE
    WHEN pm_backend IN ('cli', 'channels') THEN 'claude:channels'
    ELSE 'claude:inline'
  END,
  'claude',
  claude_session_id,
  NULL,
  agent,
  cwd,
  model,
  effort,
  pm_backend,
  created_ts,
  last_active_ts
FROM sessions;
