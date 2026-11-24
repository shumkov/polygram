---
name: history
description: Query this conversation's own polygram transcript. Use when asked about past activity in this chat, summaries of it, who said what here, references to older messages, or searches through this chat's history. Not needed for replies to directly-quoted messages (polygram already embeds them).
---

# Usage

Use the exact own-chat history command Polygram supplied in the current turn:

    <command from this turn> <subcmd> [args]

The command carries this session's scope token. The daemon maps the token to
the session and reads only that session's own chat: its DM, its group, or, for
a chat with isolated topics, its own topic (the General topic reads only
messages outside any topic). The token, never an argument, the working
directory or an environment variable, decides the scope, so no other chat is
reachable through this skill, the operator's chat included. Tokens expire when
the daemon restarts; the next prompt brings a new command.

A chat or thread named with `--chat` / `--thread` (or the old positional
chat and thread arguments) is only checked against the session's scope: the
read is refused when it names another chat or topic. A chat-wide session may
use `--thread` to narrow to one topic of its own chat.

Subcommands return JSON unless `--format pretty`.

## recent
Last N messages. Default limit 20, hard cap 500.
Flags: `--limit N`, `--since 6h|1d|7d`, `--include-outbound false`, `--thread T`, `--format pretty`

## around --msg-id N
Context window around a message of this chat.
Flags: `--before 5`, `--after 5`, `--format pretty`

## search <term>
FTS5 search on text + user. Operators (AND/OR/*) are treated as literal tokens.
Flags: `--user U` (substring), `--days 30`, `--limit 20`, `--thread T`, `--format pretty`

## by-user <user_display_name>
Messages by a user in this chat. Substring match on display name.
Flags: `--days 7`, `--limit 50`, `--thread T`, `--format pretty`

## msg <msg_id>
Fetch a single message of this chat. Useful when a reply_to_id surfaces in context.

## stats
Per-user + per-direction counts within the window (JSON only).
Flags: `--days 7`, `--thread T`

# Examples

"Summarize what was said here today" →
  `<command> recent --since 24h --format pretty`

"When did Maria first mention the collaboration?" →
  `<command> search "collaboration" --user Maria --format pretty`

"What was said around message 12345?" →
  `<command> around --msg-id 12345 --before 10 --after 10 --format pretty`

# Notes

- The script never opens a database; the daemon runs the read-only query.
- Output capped at 500 rows. Narrow with `--since` or `--days` for wide queries.
- Times in `ts` are ms epoch. `--format pretty` shows local HH:MM.
- Operators who need another chat's history read the bot's DB on the host
  directly; there is no agent path for it.
