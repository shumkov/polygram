---
description: Explain how to issue a polygram pairing code for a new guest user.
argument-hint: [bot-name]
---

Explain to the operator how to mint a pairing code.

Pairing codes are issued through Telegram itself — the operator DMs the bot
from the admin chat. This is intentional: pairing grants cross-chat trust
and must run as an authenticated user the bot already knows, not as a
claude-code session.

If a bot name was provided, confirm it's one of the configured bots; if
not, list configured bots from `~/polygram/config.json` (read-only) so the
user can pick.

Then tell them to:

1. Open Telegram, go to their admin chat with the bot (the chat whose ID
   matches `config.bot.adminChatId`).

2. Send:
   ```
   /pair-code --ttl 1h --note "Jane — new designer"
   ```
   Optional flags: `--chat <chat_id>` to scope the code to a specific chat,
   `--scope user|chat`, `--ttl 10m|1h|1d`.

3. The bot replies with a code like `K7M2P4VQ`. Share it with the guest
   through a separate channel.

4. Guest DMs the bot (any chat the bot is in):
   ```
   /pair K7M2P4VQ
   ```

5. Revoke later with:
   ```
   /unpair <user_id>
   ```

Admin commands are gated to the admin chat — `/pair-code` run from any
other chat returns "admin-only" regardless of `allowConfigCommands`.

If the user asks you to issue the code for them directly from this Claude
session, politely refuse — explain that pairing is an in-band Telegram
operation and tell them to run it from the bot DM themselves.
