-- 011-pm-backend.sql
--
-- 0.10.0: add pm_backend column to sessions table.
--
-- Lets boot-replay know which backend a session was last running under
-- (sdk | tmux). Phase 1 ships only the SDK backend, so existing rows
-- and new rows all get 'sdk'. Phase 2 starts populating 'tmux' for
-- chats with config.chats[X].pm = 'tmux'.
--
-- Invariant: the running session's backend MUST match what the DB
-- says. If config changes pm: sdk → pm: tmux mid-session, polygram
-- keeps the running session on SDK; only on /new or daemon restart
-- does the new choice take effect.
--
-- See docs/0.10.0-process-manager-abstraction-plan.md §6.5.

ALTER TABLE sessions ADD COLUMN pm_backend TEXT NOT NULL DEFAULT 'sdk';
