-- 0.8.0 Phase 1 step 1: SDK migration prep.
--
-- Two changes (atomic in one migration to keep schema-version
-- bookkeeping clean):
--
-- (1) Add `tool_use_id` column to pending_approvals — under SDK,
--     canUseTool's `opts.toolUseID` is a stable per-call identifier
--     that the SDK guarantees across retries of the same tool call
--     within a turn. It's the better dedup key than the current
--     (bot_name, turn_id, tool_input_digest) tuple — avoids the
--     digest collision risk if Claude reorders JSON keys between
--     retries.
--
--     Existing rows get NULL. Boot-time sweep marks legacy 'pending'
--     rows as 'expired' so the new dedup query (matching on
--     non-NULL tool_use_id) doesn't accidentally match them. See
--     v4 plan §6.5.4 + seam G.
--
-- (2) Add chat_tool_decisions table — cross-turn "always allow /
--     always deny" persistence for the new 4-button approval UI
--     (Allow / Deny / Always allow / Always deny). canUseTool
--     consults this table FIRST (step 3 of §4.2) before posting a
--     card; "always" buttons write here. Per-bot scoping prevents
--     cross-bot leakage (ship-breaker H7 mitigation).
--
--     match_type semantics (v4 plan §6.5.4):
--       'exact'  — full canonical-JSON-stringify of `input` matches
--                  input_pattern exactly. Default for "always allow
--                  this exact command".
--       'prefix' — canonical-JSON `input` starts with input_pattern.
--                  Default for "always allow this command name with
--                  any args".
--       'regex'  — full match against canonical input. Power user
--                  only; not exposed in 0.8.0 UI.
--
--     Canonical JSON: keys sorted alphabetically, no whitespace.
--     Prevents Claude reordering keys from breaking dedup
--     (ship-breaker M8 mitigation).

ALTER TABLE pending_approvals ADD COLUMN tool_use_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_approvals_tool_use_id
  ON pending_approvals(bot_name, tool_use_id)
  WHERE tool_use_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_tool_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_name TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  match_type TEXT NOT NULL
    CHECK (match_type IN ('exact', 'prefix', 'regex')),
  input_pattern TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('allow', 'deny')),
  issued_ts INTEGER NOT NULL,
  issued_by_user_id TEXT,
  expires_ts INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chat_tool_decisions_lookup
  ON chat_tool_decisions(bot_name, chat_id, tool_name);
