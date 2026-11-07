-- A system sender's idempotency key and its opaque reference. Messages
-- between role sessions leave both NULL. A key names one message per sender
-- within a bot, so a retried submit finds the message it already created.
ALTER TABLE mailbox_messages ADD COLUMN idem_key TEXT;
ALTER TABLE mailbox_messages ADD COLUMN ref TEXT;
CREATE UNIQUE INDEX mailbox_idem_key ON mailbox_messages(bot_name, from_addr, idem_key) WHERE idem_key IS NOT NULL;
