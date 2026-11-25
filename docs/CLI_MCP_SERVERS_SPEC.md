# Per-chat and per-topic MCP servers for the CLI backend

Status: reviewed (two spec reviewers, 25 Nov 2026), review fixes folded in. The mechanism
lives in Orchestra; its spec is `@shumkov/orchestra` `docs/CLI_MCP_SERVERS_SPEC.md`
(validation, OAuth reuse rule, OAuth-tool denial, logging, failure modes measured on the
pinned CLI, tests). This document covers polygram's side: the config key, how a change
reaches a session, the release and the rollout.

## Problem

Claude scopes on the CLI backend cannot use any MCP server except polygram's bridge:
Orchestra starts `claude` with `--strict-mcp-config` and an mcp-config holding only the
bridge. UMI's instagram role (Shumabit bot, chat `-1004462674958`, topic 1306, agent
`shumabit-builder`) needs Canva, which the CLI has registered at local scope with OAuth,
but the session never sees it.

## Config

A new key, `mcpServers`, at chat or topic level, in Claude's own `mcpServers` shape:

```json
"chats": {
  "-1004462674958": {
    "topics": {
      "1306": {
        "mcpServers": {
          "canva": { "type": "http", "url": "https://mcp.canva.com/mcp" }
        }
      }
    }
  }
}
```

- **OAuth reuse is exact.** The CLI keys a stored login by
  `name|sha256({type,url,headers})[0:16]`. To reuse a `claude mcp add` login, the entry
  must have the same name, type, exact URL (no trailing slash change) and headers.
  Verified on the VPS for `canva`.
- A topic value (non-null) replaces the chat value as a whole; a topic without the key,
  with `null`, or in the legacy string form inherits the chat's; `{}` drops it.
- A topic-level key only matters when the chat has `isolateTopics: true` (otherwise all
  topics share one session). The marketing forum has it.
- Invalid entries are skipped with a names-only event and warning; the session still
  starts. For each configured server, its `authenticate` / `complete_authentication`
  tools are denied, so a bot session can never start an OAuth flow. A re-login is done by
  an operator (Ivan) running `claude` → `/mcp` as the bot user in the directory where
  the server is registered (`/home/shumabit/shumabit-claude` for Canva).
- `/config` does not expose this key; only an operator editing `config.json` sets it.

### Backends

- **CLI:** chat and topic level, as above.
- **SDK: different, documented, not changed here.** `lib/sdk/build-options.js` passes
  `composeSdkOptions` a narrowed chat object (`model`, `effort`, `cwd`, `thinking`), so a
  chat-level `mcpServers` never reaches the SDK backend. A topic-level `mcpServers` is
  copied over the agent bundle's `settings.json` servers as a whole value. Chat-level
  `mcpServers` is therefore CLI-only.
- **Codex and tmux:** the key does nothing. A Codex topic silently has no Canva.

polygram needs no code change for the CLI path: `buildSpawnContext` passes the whole
`chatConfig` to the backend, and Orchestra resolves topic over chat there. polygram's
changes:

1. Bump `@shumkov/orchestra` to the release that ships the feature.
2. Call Orchestra's `sweepStaleMcpConfigs({ sessionPrefix: 'polygram' })` at boot, next to
   the tmux orphan sweep (leftover mcp-config files hold bridge secrets and, now, server
   headers).
3. Document `mcpServers` in `README.md` and `config.example.json` (with the OAuth reuse
   rule).
4. A hand-off test through the public spawn path: a chat-level and a topic-level
   `mcpServers` reach the CLI backend's spawn options unchanged (guards the hand-off if
   the spawn context is ever narrowed to a field list).

## When a change takes effect

- polygram reads `config.json` at boot only. An edit takes effect after a daemon restart.
- Boot sweeps orphaned tmux sessions, so after a restart every CLI session respawns on its
  next message (with `--resume`, same conversation) and loads the new servers. `/reload`
  does the same on demand; `/new` also works but starts a fresh conversation.
- A warm process keeps the servers it started with until it respawns.
- `mcpServers` is not a spawn-identity field, so a change does not drop the stored
  session.

### Operator caveat: in-memory config overwrites disk edits

`saveConfig` writes this bot's chats from memory over the file. If anyone runs a
config-changing command (`/model`, `/effort`, pairing) between an on-disk edit and the
restart, the edit is lost. So the rollout edits `config.json` immediately before the
restart and reads it back after.

## Isolation

Config-only. UMI Assistant runs as the same Linux user and shares the CLI's stored
credentials, so the boundary is that none of its chats names a server. Checked
25 Nov 2026: `~/polygram/config.json` contains no `canva` at all yet; the rollout checks
again that only topic 1306 does.

## Release and rollout

1. Orchestra: TDD, PR, release (minor: new config surface).
2. polygram: pin bump, boot sweep, docs, hand-off test, PR, release.
3. Deploy with the `polygram-deploy` skill to local `shumorobot` and the VPS, in a quiet
   Bangkok night window, avoiding the Black Friday publish slots. The release requires
   the daemon-owned IPC restart of both VPS daemons (`deploy.sh --vps-only` installs and
   restarts without a pause); the key is not in config yet, so the feature is inert.
4. Then, still in the window: `cp -p ~/polygram/config.json
   ~/polygram/config.json.bak-<UTC>-pre-canva-mcp`, add the topic 1306 `mcpServers.canva`
   entry, validate the JSON and read it back.
5. Restart **polygram-shumabit only**, through the `shumabit-control` skill, when its busy
   count is 0, without `--emergency-restart-busy`. **Never restart UMI Assistant for
   this**: it does not resume interrupted turns. Read `config.json` back after the restart.
6. Verify without losing the role's context: a `/reload` (or a normal message) in topic
   1306. Check the session lists `canva` and `mcp__canva__*`, a read-only
   `search-designs` returns designs, and the `cli-mcp-servers` events show canva for topic
   1306 only (none for `cmo`, chat-level General, or other topics).
7. Update `~/INFRASTRUCTURE.md` and the `polygram-deploy` skill's runtime configuration
   section with the new key and where it is set.

Rollback: remove the key (`cp -p` first), restart polygram-shumabit only as in step 5; if
the release itself misbehaves, roll back with the deploy helper to polygram 0.52.1 and
Orchestra 0.12.6.

## Out of scope

- Agent-level MCP servers for the CLI backend.
- Changing the SDK backend's existing behaviour.
- Exposing `mcpServers` through `/config`.
