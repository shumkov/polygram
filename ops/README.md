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

## Cron → polygram (IPC, not direct DB write)

Cron jobs that want to post to Telegram must address a specific bot:

```js
const { tell } = require('polygram/lib/ipc-client');

await tell('admin-bot', 'sendMessage', {
  chat_id: '111111111',
  text: 'Billing synced.',
}, { source: 'cron:billing-sync' });
```

The daemon stores sockets and secrets in `<data-dir>/.ipc`, an
owner-only `0700` directory. External callers must either run with the same
working directory as the daemon or set `POLYGRAM_IPC_DIR` to that exact
canonical absolute directory. Temporary paths and unsafe aliases are rejected;
there is no `/tmp` fallback. If the data-directory path is too long for a
portable Unix socket, set `POLYGRAM_IPC_DIR` to a shorter owner-only path.

Deployment automation can query the aggregate in-flight handler count without
printing session identifiers or the socket path:

```sh
POLYGRAM_IPC_DIR=/absolute/data-dir/.ipc polygram-ipc admin-bot busy
# {"bot":"admin-bot","in_flight":0}
```

This is an advisory quiet-window check. The daemon's shutdown admission,
delivery, and handler-settlement barriers remain the correctness boundary.
Invoking `polygram-ipc admin-bot` without a subcommand retains the existing
path-and-ping health output.

Allowed methods: `sendMessage`, `sendPhoto`, `sendDocument`, `sendSticker`,
`sendChatAction`, `editMessageText`, `setMessageReaction`. Other methods
are rejected server-side.

If the target bot is down, `tell()` throws. Intentional — cron failures
should surface, not silently log to a DB the bot isn't watching.

## Native Codex beta diagnostics

Codex is an opt-in native beta supported on Darwin arm64 and Linux x64.
Before selecting `pm: "codex"`, configure:

- `codex.binary` as the canonical immutable executable for the pinned
  target-specific version and checksum;
- `codex.home` as a dedicated, persistent, non-temporary `CODEX_HOME` with
  mode `0700`;
- owner-only `config.toml` and `auth.json` files with mode `0600`; and
- the owned `polygram-session` profile with approval policy `never`, command
  network disabled, and model web search disabled.

List every other daemon credential or control tree in
`codex.daemonSecretRoots`, including the interactive `~/.codex` tree when it
exists; the dedicated deployment home is separate and must not be reused.

On Linux, `POLYGRAM_CODEX_TMPDIR` is mandatory. Set it to a canonical,
service-owned directory with mode `0700`; do not use `/tmp`, a symlink, or a
shared writable parent. A systemd unit can provision it without a reboot:

```ini
[Service]
RuntimeDirectory=polygram-codex
RuntimeDirectoryMode=0700
Environment=POLYGRAM_CODEX_TMPDIR=/run/polygram-codex
```

Polygram passes this selector only to the Codex app-server child as `TMPDIR`.
The exact generated `config.toml` includes the selected directory, or a
normalized parent that covers it, as a `deny` root. Claude SDK and CLI child
environments retain their existing `TMPDIR` and do not receive the selector.

Existing generated `config.toml` files from before the Codex temp-root policy
will fail with `CODEX_OWNED_CONFIG_DRIFT`. This is deliberate: Polygram never
migrates or overwrites an owned config automatically. With the daemon stopped:

1. Choose an owner-only backup directory outside `CODEX_HOME` that is already
   listed in `codex.daemonSecretRoots`.
2. Back up by moving the old file there, preserving it for inspection:

   ```bash
   codex_config=/path/to/codex-home/config.toml
   codex_backup_dir=/path/to/denied-daemon-secret-root/codex-config-backups
   install -d -m 0700 "$codex_backup_dir"
   mv "$codex_config" "$codex_backup_dir/config.toml.before-tmpdir-deny"
   ```

3. Start Polygram again so it provisions the new exact owner-only
   `config.toml`, then rerun doctor and retain the backup until the deployment
   is verified.

Do not edit the generated file in place or copy the old file back. This clean
configuration migration and normal Linux canary setup require no reboot.

Run the existing doctor against the intended config and database:

```bash
node scripts/doctor.js --bot my-bot --config /path/to/config.json --db /path/to/my-bot.db
```

The Codex checks are local and content-free. They verify the binary pin,
dedicated home, installed protocol schema, owned profile, protected IPC runtime
directory, selected app-server temp directory (`codex-tmpdir`), stable host and
kernel boot-session identity, and the daemon-wide lease. `codex-tmpdir`
requires a canonical owner-only mode-`0700` directory that does not overlap
runtime state or a configured workspace and is covered by the owned profile's
deny roots. The checks do not print
paths, credential contents, raw host/boot identities, generation IDs, prompts,
command output, or raw failure text. They do not start app-server or perform
authenticated model discovery. `codex-model-catalog` therefore remains a
warning until the normal pinned startup preflight proves the selected profile,
model, and effort are available.

Lease results have daemon scope:

- `clear` means this daemon has no live or quarantined native Codex owner.
- `active` means one chat owns the daemon-wide Codex generation; a second
  Codex chat must be rejected without spawning or changing its session.
- `quarantined` is a hard failure. Do not delete the database, force-release
  the lease, reset the chat, switch runtimes to evade it, or retry ambiguous
  input automatically. Input reconciliation does not release containment.
  The same validated host must reboot before native Codex can be released.

This lease does not fence Claude, another Polygram daemon, or an
uninstrumented host process.

Detached and background development servers are unsupported in the native
Codex beta on both supported targets. Healthy stop proves the exact Codex turn
settled, tracked-terminal cleanup was accepted, and a fresh registry page was
empty; it does not prove arbitrary descendants died. After transport or
app-server hard loss, such a process may survive until the required host
reboot.
