-- The name of the human whose words a system sender relayed, such as the
-- author of a Notion comment. NULL for every other message. A message with a
-- name counts as that human asking, so it is stored at depth 0.
ALTER TABLE mailbox_messages ADD COLUMN origin_name TEXT;
