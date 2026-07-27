-- Durable Codex generation, request-delivery, effect, and recovery ledger.
-- Payload-bearing command/tool data is intentionally absent.

CREATE TABLE codex_runtime_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  stable_host_id TEXT NOT NULL,
  last_boot_session_id TEXT NOT NULL,
  established_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);

CREATE TABLE codex_reboot_releases (
  stable_host_id TEXT NOT NULL,
  incident_boot_session_id TEXT NOT NULL,
  released_boot_session_id TEXT NOT NULL,
  released_ts INTEGER NOT NULL,
  PRIMARY KEY(stable_host_id, incident_boot_session_id)
);

CREATE TABLE codex_generations (
  generation_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  thread_id TEXT,
  app_server_session_id TEXT,
  stable_host_id TEXT NOT NULL,
  boot_session_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK(state IN (
      'created', 'active', 'healthy-stopped', 'containment-failed',
      'durability-blocked', 'retired'
    )),
  containment_reason TEXT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  settled_ts INTEGER
);

CREATE INDEX idx_codex_generations_state
  ON codex_generations(state, updated_ts);
CREATE INDEX idx_codex_generations_session
  ON codex_generations(session_key, created_ts DESC);

CREATE TABLE codex_daemon_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation_id TEXT REFERENCES codex_generations(generation_id)
    ON DELETE SET NULL,
  stable_host_id TEXT NOT NULL,
  boot_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('clear', 'active', 'quarantined')),
  quarantine_reason TEXT,
  acquired_ts INTEGER,
  updated_ts INTEGER NOT NULL,
  released_ts INTEGER
);

CREATE TABLE codex_turn_attempts (
  attempt_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL
    REFERENCES codex_generations(generation_id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  method TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  telegram_source_message_id TEXT,
  client_user_message_id TEXT,
  request_id TEXT,
  delivery_state TEXT NOT NULL
    CHECK(delivery_state IN (
      'prepared', 'write-attempted', 'response-observed'
    )),
  response_outcome TEXT CHECK(response_outcome IN ('result', 'error')),
  recovery_state TEXT NOT NULL
    CHECK(recovery_state IN (
      'prepared', 'ambiguous', 'active', 'terminal-pending',
      'clean-pending', 'empty-registry-pending', 'settled', 'cancelled'
    )),
  terminal_status TEXT
    CHECK(terminal_status IN ('completed', 'interrupted', 'failed')),
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  settled_ts INTEGER,
  ambiguous_ts INTEGER
);

CREATE INDEX idx_codex_attempts_recovery
  ON codex_turn_attempts(recovery_state, updated_ts);
CREATE INDEX idx_codex_attempts_generation
  ON codex_turn_attempts(generation_id, created_ts);

CREATE TABLE codex_attempt_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id TEXT NOT NULL
    REFERENCES codex_generations(generation_id) ON DELETE CASCADE,
  attempt_id TEXT
    REFERENCES codex_turn_attempts(attempt_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  request_id TEXT,
  item_id TEXT,
  detail_json TEXT,
  ts INTEGER NOT NULL
);

CREATE INDEX idx_codex_checkpoints_attempt
  ON codex_attempt_checkpoints(attempt_id, id);
CREATE INDEX idx_codex_checkpoints_generation
  ON codex_attempt_checkpoints(generation_id, id);

-- Provider choice is recorded before provider dispatch so replay never infers
-- a backend from mutable current configuration. Historical rows without a
-- selection remain unknown.
CREATE TABLE inbound_runtime_selections (
  bot_name TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
  selected_ts INTEGER NOT NULL,
  PRIMARY KEY(bot_name, telegram_chat_id, telegram_message_id)
);

CREATE INDEX idx_inbound_runtime_session
  ON inbound_runtime_selections(session_key, provider, selected_ts);

CREATE TABLE codex_linked_inputs (
  linked_input_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL
    REFERENCES codex_generations(generation_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL
    REFERENCES codex_turn_attempts(attempt_id) ON DELETE CASCADE,
  target_attempt_id TEXT NOT NULL
    REFERENCES codex_turn_attempts(attempt_id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK(state IN ('linked', 'settled', 'failed', 'ambiguous', 'interrupted')),
  created_ts INTEGER NOT NULL,
  settled_ts INTEGER
);

CREATE INDEX idx_codex_linked_inputs_target
  ON codex_linked_inputs(target_attempt_id, state);
CREATE INDEX idx_codex_linked_inputs_attempt
  ON codex_linked_inputs(attempt_id, state);

-- One durable claim per Telegram input before either steering or queueing.
-- Payload text is deliberately absent; callers retain it only in memory.
CREATE TABLE codex_dispatch_reservations (
  reservation_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL
    REFERENCES codex_generations(generation_id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK(state IN (
      'reserved', 'steer-accepted', 'queue-authorized', 'ambiguous',
      'cancelled', 'settled', 'failed', 'interrupted'
    )),
  steer_attempt_id TEXT
    REFERENCES codex_turn_attempts(attempt_id) ON DELETE CASCADE,
  target_attempt_id TEXT
    REFERENCES codex_turn_attempts(attempt_id) ON DELETE CASCADE,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  settled_ts INTEGER,
  UNIQUE(bot_name, telegram_chat_id, telegram_message_id)
);

CREATE INDEX idx_codex_dispatch_generation
  ON codex_dispatch_reservations(generation_id, state, created_ts);

CREATE TABLE codex_item_effects (
  generation_id TEXT NOT NULL
    REFERENCES codex_generations(generation_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL
    REFERENCES codex_turn_attempts(attempt_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started', 'completed', 'failed')),
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY(attempt_id, item_id)
);

CREATE INDEX idx_codex_item_effects_generation
  ON codex_item_effects(generation_id, updated_ts);

CREATE TABLE codex_attempt_reconciliations (
  attempt_id TEXT PRIMARY KEY
    REFERENCES codex_turn_attempts(attempt_id) ON DELETE CASCADE,
  disposition TEXT NOT NULL
    CHECK(disposition IN ('incorporated', 'retry-authorized', 'dismissed')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_ts INTEGER NOT NULL
);

CREATE TABLE codex_retry_reservations (
  original_attempt_id TEXT PRIMARY KEY
    REFERENCES codex_turn_attempts(attempt_id) ON DELETE CASCADE,
  retry_attempt_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL
    CHECK(state IN ('reserved', 'claimed', 'dispatched', 'retired')),
  reserved_ts INTEGER NOT NULL,
  claimed_ts INTEGER,
  dispatched_ts INTEGER,
  retired_ts INTEGER
);
