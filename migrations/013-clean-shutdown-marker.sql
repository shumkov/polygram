-- 0.14: clean-shutdown marker for boot-replay.
--
-- On a DELIBERATE restart polygram skips re-dispatching stale candidates (so it
-- doesn't re-answer messages the user already saw it working on) and posts one
-- visibility notice instead. On a CRASH it recovers everything (unchanged).
--
-- The marker is written in the shutdown handler (same txn as markReplayPending)
-- and read-and-cleared at boot. NULL = no clean shutdown recorded → treat as
-- crash (recover). One row per bot (shares polling_state's PK).
ALTER TABLE polling_state ADD COLUMN clean_shutdown_at INTEGER;
