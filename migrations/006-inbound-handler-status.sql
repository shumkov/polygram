-- Track the lifecycle state of inbound message processing so a polygram
-- restart (SIGTERM, crash) can replay any turns that were in progress.
--
-- The existing `status` column on messages already tracks OUTBOUND state
-- ('pending' / 'sent' / 'failed'). Rather than overload it with inbound
-- semantics, add a dedicated column.
--
-- States for inbound:
--   received  — row inserted by recordInbound, nothing else has happened
--   dispatched — handleMessage started (attachment download, voice, format)
--   processing — pm.send has written the prompt to claude's stdin
--   replied    — outbound reply was sent successfully
--   replay-pending — marked by graceful shutdown to be replayed on next boot
--
-- NULL is valid (for historical rows inserted before this migration).
--
-- The boot replay loop scans for rows where:
--   direction = 'in'
--   AND handler_status IN ('dispatched', 'processing', 'replay-pending')
--   AND ts > now() - REPLAY_WINDOW_MS  (default 30 min — anything older is stale)
-- and re-dispatches them.

ALTER TABLE messages ADD COLUMN handler_status TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_handler_status
  ON messages(handler_status, ts)
  WHERE handler_status IS NOT NULL;
