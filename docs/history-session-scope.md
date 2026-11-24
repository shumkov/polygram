# History skill: reads bound to the calling session

## Problem

The history skill derived its scope from `process.cwd()`: every chat whose
configured `cwd` matched became readable. A bot that runs many chats from one
directory therefore gave every session read access to every chat of the bot.
In the UMI bot all eleven chats share one cwd, so a team member's DM session
could read the operator's DM, or any other member's DM, with
`query.js recent <chat_id>`. The fresh-session preload even advertised that
invocation with a `<chat_id>` argument.

## Approach

The scope comes from a token the daemon mints per session, the same pattern
the notifications skill uses for its own-conversation tool.

- `lib/history-scope.js` keeps `token → sessionKey` in daemon memory. Every
  prompt (human messages through `formatPrompt`, external jobs through the
  dispatch wrapper) appends one line with the session's command and a freshly
  minted token; the session's four previous tokens keep working, older ones
  are refused, so a command copied into a shared file (the chats of one cwd
  share auto-memory and CLAUDE.md) or handed to another session expires:
  `POLYGRAM_IPC_DIR=… node …/query.js <bot> <token> <subcmd> [args]`.
- `query.js` is a thin IPC client. It never opens a database; it sends the
  parsed request to the `history_query` IPC op with the token.
- The daemon maps the token to the session key and derives the scope from
  the live config on every call: the session's own chat; for an isolated
  topic, only that thread; for the General topic of an isolated chat, only
  rows without a thread; for a chat-wide session, every thread of its chat.
- A chat or thread the agent names is compared against that scope and the
  read is refused on mismatch. It never widens the scope. Unknown fields and
  subcommands are refused.
- `lib/history.js` gains a `threadScope` option so the thread restriction is
  applied in SQL (not by filtering after `LIMIT`), for `around`, `search`,
  `by-user`, `msg` and `stats`; `recent` already had `scopeThread`.

### No cross-chat read for the operator's chat

The operator's DM session gets the same own-chat scope. A session's context
can carry foreign content (forwarded messages, web pages, mailbox asks), so a
cross-chat grant would make any prompt-injected operator session a way to
read every DM of the bot. The operator can read the DB on the host directly
when needed; there is no agent path for it.

## Alternatives rejected

- **A per-chat environment variable.** An agent's Bash sets any environment
  on a subprocess; the old `POLYGRAM_ADMIN` / `CLAUDE_CHANNEL_BOT` overrides
  were removed for that reason.
- **The mailbox token.** It is minted only for sessions that may start
  mailbox messages (roles, or receivable CLI sessions) and only when the
  mailbox is enabled, so many sessions would have no history at all. It also
  carries send authority, which history reads do not need.
- **A per-chat cwd.** A deployment change outside polygram; isolated topics
  of one chat would still share a cwd.
- **An HMAC token derived from a key file.** Survives restarts, but the key
  file is readable by the same OS user, so an agent could mint any session's
  token.

## Failure modes

- Daemon restart: tokens are in memory, so old commands fail with "History
  scope is not valid"; the next prompt carries a new command.
- Stale command: a token more than four prompts old gets the same refusal.
- IPC server failed to start: the command fails to connect; nothing is read.
- Chat removed from the config: its token is refused at once.
- No database: no command is injected.

## Residual exposure (not addressed here)

The same OS user runs the daemon and every agent session. A determined agent
can still read the bot's SQLite file directly, and every session's Claude
JSONL transcript lives in the shared project directory of the shared cwd.
This change closes the sanctioned skill path; the OS-level boundary remains
the open item from `docs/0.13-history-read-permission-spec.md`.

## Verification

`tests/history-skill-scope.test.js` builds the shared-cwd layout (two DMs
and a forum with isolated topics) on a real DB, starts the real IPC server
with the real service, and runs the script as the injected command does:

- the old shared-cwd invocation exits with a usage error and prints no rows
  (red before the change: it returned the operator's DM rows);
- a member session reads only its DM, and is refused for the operator's chat
  through positional, `--chat`, `search`, `msg` (message ids repeat across
  chats) and `around`;
- the operator's session cannot read the member's DM;
- an isolated topic cannot reach a sibling topic or the General topic, and
  the General topic reads only threadless rows;
- forged tokens, a chat id passed as the token, environment overrides and
  the shared cwd do not change the scope.
