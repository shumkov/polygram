# polygram

A Telegram daemon and Claude Code plugin that preserves the per-chat
session model from **OpenClaw**. Intended primarily as a **migration
path** for users moving their Telegram-based ops from OpenClaw to Claude
Code, after OpenClaw dropped Claude support.

> If you ran OpenClaw with multiple Telegram chats — each with its own
> context, its own memory, its own transcript — polygram gives you that
> shape back on top of `claude` CLI. Install as a daemon, a Claude plugin,
> or both.

## Background

OpenClaw ran a Telegram agent with one conversation context per chat.
Each chat had its own persistent memory; topics in a forum chat could
optionally carry their own sub-context. The agent, cron scripts, and
human operators all wrote into a shared transcript.

OpenClaw no longer supports Claude. Migrating to Claude Code loses that
model unless it's rebuilt. The official `telegram@claude-plugins-official`
plugin is single-session — one Claude Code process, one bot, one shared
context across all chats. Third-party Claude Code Telegram bots usually
share one session across all users of a given bot instance.

`polygram` is the shape that keeps OpenClaw's per-chat-session
ergonomics while running on top of `claude` CLI.

## What it is

- **One Node process per bot.** Required `--bot <name>` flag. N bots = N
  processes. No "one process hosts many bots" mode — crash isolation is
  the point.
- **Per-chat Claude sessions.** Each chat has its own `claude_session_id`,
  resumed via `claude --resume`.
- **Per-topic sessions — opt-in** (`isolateTopics: true` in chat config).
  Default is shared context across topics, since topics are usually
  organisational. OpenClaw migrators who used per-topic separation can
  keep it with one flag.
- **SQLite transcripts** (WAL, FTS5, numbered migrations, `user_version`).
- **Write-before-send atomicity.** Outbound messages hit the DB as
  `pending` before the Telegram call, flip to `sent` or `failed` after.
  Boot sweep resolves stale `pending` rows from the last crash.
- **Unix-socket IPC per bot.** Cron jobs and Claude Code approval hooks
  talk to the bot process over `/tmp/polygram-<bot>.sock`. The bot
  is the only writer to its own DB.
- **Inline-keyboard approvals.** Destructive tool calls gate on operator
  click via Claude Code's `PreToolUse` hook; 5-minute auto-deny.
- **Voice transcription.** OpenAI Whisper API or local `whisper.cpp`,
  selectable per bot. Transcriptions land in `messages.text` so FTS
  finds them.
- **Content-addressed attachment storage** via Telegram's `file_unique_id`.
  Same photo forwarded twice = one file on disk.
- **Prompt-injection hardening.** User text wrapped in `<untrusted-input>`
  with xml-escape; attributes use `&quot;`. A partner typing
  `</channel><system>...` sees it as literal text in the prompt.
- **Pairing codes** for guest onboarding without polygram restart
  (`/pair-code`, `/pair <CODE>`, `/pairings`, `/unpair`).
- **Step-level streaming replies** (optional per bot). Telegram message
  edits on each assistant step as Claude works through tool calls and
  reasoning.

## Relation to existing projects

| | Session unit | Bots per install | Persistence |
|---|---|---|---|
| [`telegram@claude-plugins-official`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) | one (bound to an open Claude Code session) | one | session memory only |
| [`ClaudeBot`](https://github.com/Jeffrey0117/ClaudeBot) | worktree path (≈ one per bot) | many (git worktrees) | `.sessions.json` |
| [`claudegram`](https://github.com/NachoSEO/claudegram) | chat (+ forum topic) | one | JSON files |
| **polygram** | chat (+ optional forum topic) | many (per-process) | SQLite WAL + FTS5 |

Practical differences that matter for migration:

- The official plugin dies with `/exit`, so it can't carry scheduled jobs
  or replace a long-running ops bot.
- `ClaudeBot` puts many chats on one session per bot. For OpenClaw users
  this feels wrong — a customer group and an ops group would share
  memory unless each goes in its own worktree.
- `claudegram` gets the session model right but serves one bot per
  install. Running five bots means five copies of the infra.
- `polygram` lands on the combination: multi-bot (one process per
  bot) and per-chat/per-topic sessions. Scaling from one bot to many
  doesn't change the mental model inherited from OpenClaw.

## Install

Requires Node 20+.

```bash
# Global binary:
npm install -g polygram

# Data directory (config + per-bot DBs + inbox live here):
mkdir ~/polygram && cd ~/polygram
cp $(npm root -g)/polygram/config.example.json config.json
# edit config.json: bot tokens from @BotFather, chat IDs, cwds
```

## Run

```bash
cd ~/polygram
polygram --bot admin-bot          # one bot, one process
polygram --bot partner-bot        # another bot, another process
```

`--bot` is required. Paths resolve from your current working directory:

- `config.json` → `$PWD/config.json` (override with `--config` or `POLYGRAM_CONFIG`)
- `<bot>.db` → `$PWD/<bot>.db` (override with `--db` or `POLYGRAM_DB`)
- `inbox/` → `$PWD/inbox/` (override with `POLYGRAM_INBOX`)

Migrations are bundled in the package and apply automatically. The daemon
opens a Unix socket at `/tmp/polygram-<bot>.sock`.

For production, LaunchAgent plists are in `ops/`. See `ops/README.md`.

## Health check

Every install includes a round-trip smoke test:

```bash
polygram-smoke --bot my-bot --to <admin-chat-id>
```

Exits 0 on success, 1 on any step failure. It verifies:

1. **IPC ping** — the per-bot unix socket is up
2. **Outbound round-trip** — IPC `send` op → Telegram API → returns a `msg_id`
3. **DB read-back** — that `msg_id` is in the `messages` table with
   `direction='out'`, `status='sent'`, matching text

A sample passing run:

```
✅ ipc-ping — bot=my-bot
✅ outbound-send — msg_id=12345
✅ db-readback — sent row confirmed (source=polygram-smoke)

polygram-smoke: PASS  my-bot  2026-04-22T15:30:00.000Z
```

Flags: `--db <path>` or `POLYGRAM_DB` for non-default DB location;
`--timeout-ms <ms>` (default 8000).

The test sends a tagged message (`polygram-smoke:<timestamp>`) silently
to the target chat. Use your own DM as `--to` so the marker arrives
somewhere you control.

## Install as a Claude Code plugin

polygram also ships as a Claude Code plugin — adds admin slash commands
and bundles the transcript-query skill for use inside your Claude sessions.

The repo doubles as a single-plugin marketplace. Two commands at your
Claude Code `/` prompt:

```
/plugin marketplace add https://github.com/shumkov/polygram.git
/plugin install polygram@shumkov
```

The first registers the marketplace (`shumkov`). The second installs the
`polygram` plugin from it.

To enable in a specific Claude project, add to `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "polygram@shumkov": true
  }
}
```

Once enabled:

- `/polygram:status` — running bots, IPC health, recent events
- `/polygram:logs <bot>` — tail `~/polygram/logs/<bot>.log`
- `/polygram:pair-code` — walks you through issuing a pairing code (in-band via Telegram)
- `/polygram:approvals [bot]` — pending and recent tool-approval rows

The bundled **`history` skill** lets Claude query the transcript directly
when you ask about past chat activity:

```
"Summarise the Orders topic today" →
  Claude invokes the history skill → runs `recent <chat> --since 24h`
```

Scope is derived from `process.cwd()`: the skill refuses to run from an
unmapped directory unless `POLYGRAM_ADMIN=1` is set.

## Configuration

Minimal:

```json
{
  "bots": {
    "my-bot": { "token": "..." }
  },
  "chats": {
    "123456789": {
      "name": "My DM",
      "bot": "my-bot",
      "agent": "my-agent",
      "model": "sonnet",
      "effort": "low",
      "cwd": "/Users/me/my-agent"
    }
  }
}
```

Per-chat flags:

- `isolateTopics: true` — each forum topic gets its own Claude session.
  Default is shared.
- `requireMention: true` — group chats only respond to `@botname` or
  replies to bot messages. Paired users bypass this.
- `topics: { "<thread_id>": "<name>" }` — human-readable topic labels
  included in the prompt.

Per-bot flags:

- `allowConfigCommands: true` — enables `/model`, `/effort`, `/pair-code`,
  `/pairings`, `/unpair`.
- `streamReplies: true` — live-edit the Telegram message as Claude works.
- `voice: { enabled, provider: "openai"|"local", ... }` — Whisper
  transcription settings.
- `approvals: { adminChatId, timeoutMs, gatedTools, ... }` — which tool
  calls require an inline-keyboard approval and where to post the card.

See `config.example.json` for the full schema.

## Migrating from OpenClaw

See the design doc (`docs/polygram-design.md`) for the full trust model
and architectural choices. In practice:

1. Install `polygram`, point chat `cwd` at your migrated agent
   project.
2. Copy OpenClaw's per-partner memory directories to their new chat
   directories if you used them.
3. For chats where each OpenClaw topic had its own context, set
   `isolateTopics: true` in chat config.
4. For cron/scheduled scripts, replace direct Telegram API calls with
   `tell(bot, method, params, {source})` from `lib/ipc-client`. The
   bot process writes to the transcript; the script just asks it to send.
5. Use `scripts/split-db.js` if you're consolidating multiple OpenClaw
   databases — otherwise per-bot SQLite files start fresh.

## Cron → bot (IPC)

```js
const { tell } = require('polygram/lib/ipc-client');

await tell('admin-bot', 'sendMessage', {
  chat_id: '123456789',
  text: 'Daily inventory report ready.',
}, { source: 'cron:inventory-report' });
```

Allowed methods: `sendMessage`, `sendPhoto`, `sendDocument`, `sendSticker`,
`sendChatAction`, `editMessageText`, `setMessageReaction`. The socket
server rejects others. Cross-bot sends are rejected (chat must belong
to the bot on the other end of the socket).

If the bot process is down, the call throws. This is intentional — cron
failures should surface.

## The `telegram-history` skill

A Claude skill that queries the transcript:

```bash
node skills/history/scripts/query.js recent -1000000000001 --since 24h
node skills/history/scripts/query.js search "invoice" --user Maria
node skills/history/scripts/query.js around --chat -100... --msg-id 12345 --before 10
```

Bot scope is derived from `process.cwd()` — the skill refuses to run if
the cwd doesn't match a chat in config, unless `POLYGRAM_ADMIN=1` is set.
With per-bot DBs the skill opens only the current bot's file; in admin
mode it unions across all `<bot>.db` files.

## Approvals

Config:

```json
"approvals": {
  "adminChatId": "123456789",
  "timeoutMs": 300000,
  "gatedTools": ["Bash(rm *)", "mcp__*__invoice_create"]
}
```

Install the hook at the agent level (`settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|mcp__*",
      "hooks": [{
        "type": "command",
        "command": "/abs/path/to/polygram/bin/approval-hook.js"
      }]
    }]
  }
}
```

When Claude attempts a matched tool, the hook blocks, the daemon posts
`[Approve]/[Deny]` buttons to `adminChatId`, and the tool runs (or is
denied) after the click. Tokens in `callback_data` defeat replay;
foreign-chat clicks are rejected. Default-deny on IPC error.

## Development

```bash
npm test        # 336 tests, 72 suites, node:test, no external services
npm start -- --bot my-bot
npm run split-db -- --config config.json --dry-run
npm run ipc-smoke -- my-bot
```

Layout:

```
polygram.js                         main daemon
bin/approval-hook.js       PreToolUse hook
lib/                              core modules (db, prompt, telegram,
                                   process-manager, sessions, history,
                                   attachments, inbox, voice, approvals,
                                   pairings, ipc-{server,client},
                                   session-key, stream-reply, ...)
migrations/NNN-*.sql              applied at boot, guarded by user_version
skills/history/          Claude skill
ops/                              LaunchAgent plists
scripts/split-db.js               one-time shared-DB → per-bot migration
tests/*.test.js                   node:test
```

## Status and non-goals

- Used in production by the author for a retail ops workflow.
- No horizontal scale-out. One machine, shared filesystem. If you need
  bot A in Bangkok and bot B on AWS, swap SQLite for something networked;
  that's not on the roadmap.
- Claude Code only. No abstraction over other AIs.
- macOS LaunchAgent plists included; Linux systemd units are not (easy
  to adapt).
- No marketplace plugin wrapper yet. See roadmap.

## Roadmap

- Pairings phase 2: auto-create DM chat entries for paired users in
  unknown chats.
- Approvals phase 2: deny-with-reason, per-user quotas.
- Voice phase 2: `/replay-voice` to re-transcribe with a language hint.
- `/replay-pending` admin command for crashed-mid-send rows.
- Marketplace plugin wrapper with slash commands for admin.

## Licence

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

- [grammy](https://grammy.dev) for the Telegram client.
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for the
  storage layer.
- OpenClaw for the per-chat session ergonomics this project aims to
  preserve.
