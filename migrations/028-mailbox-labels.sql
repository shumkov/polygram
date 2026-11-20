-- Display labels for session addresses. A session that is not a configured
-- role is stored as session:<sessionKey>; the label (its alias when the message
-- was sent) is what trusted headers and mirror cards show instead.
ALTER TABLE mailbox_messages ADD COLUMN from_label TEXT;
ALTER TABLE mailbox_messages ADD COLUMN to_label TEXT;
