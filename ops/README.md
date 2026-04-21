# ops/ — launchd plists for per-bot process isolation

Each bot runs in its own Node process. `--bot <name>` is required on every
invocation — polygram refuses to boot without it. These user-scope
LaunchAgents supervise them individually so a crash in one bot never takes
down another.

## Install

```bash
mkdir -p /Users/$USER/polygram/logs
# For each bot, render the template to LaunchAgents with the bot's name
# and your username substituted in:
cp ops/polygram.plist.example ~/Library/LaunchAgents/com.polygram.my-bot.plist
sed -i '' "s/BOTNAME/my-bot/g; s|YOURNAME|$USER|g" \
  ~/Library/LaunchAgents/com.polygram.my-bot.plist
launchctl load ~/Library/LaunchAgents/com.polygram.my-bot.plist
```

Repeat for each bot.

## Manage

```bash
# Status of all
launchctl list | grep polygram

# Restart one
launchctl kickstart -k gui/$(id -u)/com.polygram.my-bot

# Stop / start
launchctl unload ~/Library/LaunchAgents/com.polygram.my-bot.plist
launchctl load   ~/Library/LaunchAgents/com.polygram.my-bot.plist

# Tail logs
tail -f /Users/$USER/polygram/logs/my-bot.log
```

## Adding a new bot

1. Render a new plist from `polygram.plist.example` (see Install).
2. Add `bots.<new>` and any `chats` entries in `config.json`.
3. `launchctl load ~/Library/LaunchAgents/com.polygram.<new>.plist`.

Existing bots keep running — no shared process, no restart.

## Design choice: user-level LaunchAgents, not LaunchDaemons

- LaunchAgents live in `~/Library/LaunchAgents/`, run as the logged-in user,
  no sudo required.
- LaunchDaemons (`/Library/LaunchDaemons/`) would run as root at boot — nice
  for headless servers, overkill for a per-user Mac install. LaunchAgents
  fire at login and stay running.

## Local development

For running outside launchd:

```bash
cd /Users/$USER/polygram
node polygram.js --bot admin-bot     # in one tmux window
node polygram.js --bot partner-bot   # in another
```

Each is independent. Kill one, the other keeps serving. There is no
"run all bots in one process" mode — `--bot` is required.

`--db <path>` overrides the default DB location (`<repo>/<bot>.db`).
Useful for dry-running new bots against a throwaway DB without touching
production files.

## One-time: split shared bridge.db into per-bot DBs

If you migrated from an earlier build that used a single shared `bridge.db`:

```bash
cd /Users/$USER/polygram

# Dry run first
node scripts/split-db.js --config config.json --dry-run

# For real (archives bridge.db to bridge.db.archived-<stamp>)
launchctl unload ~/Library/LaunchAgents/com.polygram.*.plist
node scripts/split-db.js --config config.json
launchctl load   ~/Library/LaunchAgents/com.polygram.my-bot.plist
# ... repeat load for each bot
```

The script is idempotent; safe to re-run. It refuses to proceed if a WAL
file on the source DB indicates a live writer.

## Cron → bridge (IPC, not direct DB write)

Cron jobs that want to post to Telegram must address a specific bot:

```js
const { tell } = require('polygram/lib/ipc-client');

await tell('admin-bot', 'sendMessage', {
  chat_id: '111111111',
  text: 'Billing synced.',
}, { source: 'cron:billing-sync' });
```

Allowed methods: `sendMessage`, `sendPhoto`, `sendDocument`, `sendSticker`,
`sendChatAction`, `editMessageText`, `setMessageReaction`. Other methods
are rejected server-side.

If the target bot is down, `tell()` throws. Intentional — cron failures
should surface, not silently log to a DB the bot isn't watching.
