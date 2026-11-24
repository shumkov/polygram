-- Where the mirror card in the target's topic landed, as a message link, kept
-- only when Telegram's receipt proves the chat and topic. Later cards (the
-- sender's copy, the answer, a delivery notice) link to it.
ALTER TABLE mailbox_messages ADD COLUMN target_card TEXT;
-- A system sender's jump link, kept only when it names a message this bot
-- sent for that sender; shown on the mirror card, never to the receiving role.
ALTER TABLE mailbox_messages ADD COLUMN link TEXT;
