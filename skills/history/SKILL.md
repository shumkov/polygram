---
name: history
description: Query the polygram transcript database. Use when asked about past chat activity, summaries of topics, who said what, historical references to old messages, or searches across conversation history. Not needed for replies to directly-quoted messages (polygram already embeds them).
---

# Usage

Invoke via: `node skills/history/scripts/query.js <subcmd> [args]`

Subcommands return JSON unless `--format pretty`. All chat IDs and thread IDs are strings.

Bot scope: the skill filters results to the current bot's chat allowlist. Scope is derived from `process.cwd()` — each bot's Claude project dir maps to a chat.cwd in `config.json`. When invoked from an unmapped cwd the skill refuses to run unless `POLYGRAM_ADMIN=1` is set (admin-only override).

DB resolution (post Phase 8): the skill reads the bot's own `<bot>.db` file when scope is known. With `POLYGRAM_ADMIN=1` it opens every `<bot>.db` that exists and unions results (sorted by ts desc, re-capped at `--limit`). If no per-bot DB is found the skill falls back to a legacy `bridge.db` (pre-cutover). Override the resolution with `POLYGRAM_DB=/abs/path.db` for one-off queries against an archived file.

## recent <chat_id> [thread_id]
Last N messages. Default limit 20, hard cap 500.
Flags: `--limit N`, `--since 6h|1d|7d`, `--include-outbound` (default true), `--format pretty`

## around --chat X --msg-id N
Context window around a specific message.
Flags: `--before 5`, `--after 5`, `--format pretty`

## search <term> [chat_id] [thread_id]
FTS5 search on text + user. Operators (AND/OR/*) are treated as literal tokens.
Flags: `--user U` (substring), `--days 30`, `--limit 20`, `--format pretty`

## by-user <user_display_name> [chat_id] [thread_id]
All messages by a user. Substring match on display name.
Flags: `--days 7`, `--limit 50`, `--format pretty`

## msg <msg_id> [chat_id]
Fetch single message. Useful when a reply_to_id surfaces in context.

## stats [chat_id] [thread_id]
Per-user + per-direction counts within the window.
Flags: `--days 7`

# Examples

"Summarize Orders topic today" →
  `node skills/history/scripts/query.js recent -1000000000001 5379 --since 24h --format pretty`

"When did Maria first mention the collaboration?" →
  `node skills/history/scripts/query.js search "collaboration" --chat -1000000000001 --user Maria --format pretty`

"What was said around message 12345?" →
  `node skills/history/scripts/query.js around --chat -1000000000001 --msg-id 12345 --before 10 --after 10 --format pretty`

"Who's been posting the most in UMI Group this week?" →
  `node skills/history/scripts/query.js stats -1000000000001 --days 7`

# Notes

- DB opened read-only — safe to run alongside the live bridge.
- Output capped at 500 rows. Narrow with `--since` or `--days` for wide queries.
- Times in `ts` are ms epoch. `formatPretty` shows local HH:MM.
