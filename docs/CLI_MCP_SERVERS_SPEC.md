# Per-chat and per-topic MCP servers for the CLI backend

Status: draft for review. The mechanism lives in Orchestra; its spec is
`@shumkov/orchestra` `docs/CLI_MCP_SERVERS_SPEC.md` (problem, validation, logging,
failure modes, tests). This document covers polygram's side: the config key, how a change
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

- A topic value replaces the chat value as a whole (same as every other topic key, and
  the same as the SDK backend, where `composeSdkOptions` already copies
  `chatConfig.mcpServers` / `topicConfig.mcpServers` into SDK options).
- The bridge name is reserved; invalid entries are skipped with a warning and the
  session still starts (Orchestra spec).
- An HTTP server with OAuth reuses the CLI's stored token when the server name and URL
  match the `claude mcp` registration. Verified on the VPS: name `canva`, same URL, no new
  credential entry, no login.
- `/config` does not expose this key; only an operator editing `config.json` sets it.

polygram itself needs no code change for the CLI path: `buildSpawnContext` already passes
the whole `chatConfig` to the backend, and Orchestra resolves topic over chat there.
polygram's changes are:

1. Bump `@shumkov/orchestra` to the release that ships the feature.
2. Document `mcpServers` in `README.md` and `config.example.json`.
3. A test in polygram that a chat's `mcpServers` reaches the CLI backend's spawn options
   unchanged (guards the hand-off if `buildSpawnContext` is ever narrowed to a field
   list).

## When a change takes effect

- polygram reads `config.json` at boot only. An edit takes effect after a daemon restart.
- Boot sweeps orphaned tmux sessions, so after a restart every CLI session respawns on
  its next message (with `--resume`) and loads the new servers. `/new` (fresh
  conversation) or `/reload` (same conversation) also respawn with the current config.
- A warm process keeps the servers it started with until it respawns.
- `mcpServers` is not a spawn-identity field, so a change does not drop the stored
  session; `--resume` continues the conversation with the new tool set.

### Operator caveat: in-memory config overwrites disk edits

`saveConfig` writes this bot's chats from memory over the file. If anyone runs a
config-changing command (`/model`, `/effort`, pairing) between an on-disk edit and the
restart, the edit is lost. So the rollout edits `config.json` immediately before the
restart and reads it back after.

## Release and rollout

1. Orchestra: implement with TDD, PR, release (minor: new config surface).
2. polygram: bump the pin, docs, the hand-off test, PR, release.
3. Pre-release contained checks on the VPS (Orchestra spec, Verification): the TUI with
   canva connects; with an unreachable server it still reaches its prompt.
4. Deploy with the `polygram-deploy` skill to local `shumorobot` and the VPS, in a quiet
   Bangkok night window. The VPS step does the daemon-owned IPC restart of
   `polygram-shumabit` and `polygram-umi-assistant`; in-flight turns in their topics are
   interrupted. No other service restarts.
5. Just before the Shumabit restart: back up `~/polygram/config.json`, add the topic 1306
   `mcpServers` entry, validate JSON. After the restart, read the file back.
6. Ivan sends `/new` in topic 1306. Check: the session's MCP list includes `canva`, the
   `mcp__canva__*` tools are present, a read-only `search-designs` returns designs, and
   another Shumabit topic (and UMI Assistant) has no canva tools.

Rollback: remove the key and restart, or roll polygram back with the deploy helper; the
feature is inert without the key.

## Out of scope

- Agent-level MCP servers for the CLI backend.
- Changing the SDK backend's existing behaviour.
- Exposing `mcpServers` through `/config`.
