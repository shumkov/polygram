-- Boot replay only needs to distinguish zero, one, or conflicting evidence
-- for a Telegram input. These indexes keep those bounded probes independent
-- of the accumulated Codex attempt and linked-input history.
CREATE INDEX idx_codex_attempts_replay_source
  ON codex_turn_attempts(
    session_key,
    telegram_source_message_id,
    created_ts,
    attempt_id
  );

CREATE INDEX idx_codex_linked_inputs_replay_source
  ON codex_linked_inputs(
    telegram_chat_id,
    telegram_message_id,
    generation_id,
    created_ts,
    linked_input_id
  );
