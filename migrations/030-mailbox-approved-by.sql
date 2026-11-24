-- The person whose go sent a role's tell to the assistant of someone outside
-- the role's Telegram group (the assistant's key, such as "ivan"). Null for
-- every other message.
ALTER TABLE mailbox_messages ADD COLUMN approved_by TEXT;
