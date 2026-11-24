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

### The operator's chat reads every chat (admin tier)

The operator's own private chat with the bot, the bot's `adminChatId`, may
read any chat of the bot: `--chat <chat_id>` (all topics; `--thread`
narrows) or `--chat all` for `search`, `by-user` and `stats` (`recent`,
`around` and `msg` need one chat). Admin is decided from the session the
token was minted for, re-read from the live config on every call, so
removing `adminChatId` revokes it at once. Only a private chat (a positive
id) qualifies: a group set as `adminChatId` would hand the grant to every
member of the group, so it grants nothing.

A turn started by an external job or a mailbox message is not the operator
asking (any same-user process can submit one), so it reads only its own
chat: its job token has no admin reach, and once its prompt is sent the
session's earlier commands lose admin reach too. The next human prompt
brings a fresh admin command.

Trade-off: the operator's session takes in foreign content (forwarded
messages, web pages, mailbox replies), so a prompt-injected operator session
can read any chat through this path. Ivan chose that reach for his own chat;
every other session keeps the own-chat scope. Reading the topics of a role's
group for its members is left to the membership table of the personal
assistants work.

The operator's chat in the UMI bot runs on Codex. Codex prompts come from the
same `formatPrompt`, so the command reaches its turns. Codex runs commands
with a bare environment (`HOME`, `TMPDIR`, `PATH` only), which the command
does not depend on: it carries `POLYGRAM_IPC_DIR`, and the script reads the
socket secret from that directory. The Codex profile grants the service
user's filesystem rights with network enabled, so the socket is reachable.

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
  through positional, `--chat`, `--chat all`, `search`, `msg` (message ids
  repeat across chats) and `around`;
- the operator's DM reads the member's DM, a forum topic and `--chat all`
  (red before the admin tier, green after), but a group set as `adminChatId`
  grants nothing and removing `adminChatId` revokes the tier at once;
- the injected command runs through `/bin/sh` with a Codex-style bare
  environment;
- an isolated topic cannot reach a sibling topic or the General topic, and
  the General topic reads only threadless rows;
- forged tokens, a chat id passed as the token, environment overrides and
  the shared cwd do not change the scope.
