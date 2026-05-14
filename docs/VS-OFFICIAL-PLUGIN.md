# polygram vs `telegram@claude-plugins-official`

A focused head-to-head with the official Anthropic-maintained Claude Code Telegram plugin. The official plugin is the one most users will encounter first; this document is for users deciding whether to upgrade.

For the broader landscape (ClaudeBot, claudegram, OpenClaw legacy, roll-your-own), see [COMPETITORS.md](COMPETITORS.md).

---

## TL;DR

The official plugin is a **chat front-end for ONE Claude Code session**. polygram is **a daemon that hosts MANY long-lived Claude sessions** with persistence, approvals, cron, voice, attachments, and operational tooling.

Use the official plugin if you want a Telegram window onto the Claude Code session you already keep open at your laptop. Use polygram if you want Claude Code to BE your Telegram bot infrastructure.

---

## Side-by-side

### Lifecycle

| | Official plugin | polygram |
|---|-----------------|----------|
| Starts when | You open a Claude Code session and `/plugin enable` | `launchctl` / `systemd` / explicit `polygram --bot <name>` |
| Stops when | Claude Code session closes (`/exit`, terminal closes, machine sleeps) | Daemon exit (uncaught error → launchd respawn) |
| Survives reboot | ❌ Need to re-open Claude Code session | ✅ launchd restarts the daemon |
| Survives `claude` upgrade | ❌ Plugin runs inside the Claude Code session — upgrade ends the session | ✅ Daemon owns its own SDK install via `npm` |
| Cron runs while you sleep | ❌ Bot is dead unless you leave Claude Code open | ✅ Daemon is always-on |

### Sessions

| | Official plugin | polygram |
|---|-----------------|----------|
| Session unit | The Claude Code session you opened | Per Telegram chat (+ optional per-topic) |
| If you have 3 chats hitting the bot | All 3 share one context. Customer chat sees ops chat content. | Each chat has its own session. Customer can't see ops. |
| Forum topics | Same context across topics | Optional `isolateTopics: true` for per-topic sessions |
| Resume after restart | ❌ Session dies with Claude Code | ✅ `claude_session_id` persisted in SQLite, resumed via SDK `Options.resume` |
| Multi-bot | ❌ One session = one bot | ✅ One Node process per bot, N bots = N processes |

### Persistence

| | Official plugin | polygram |
|---|-----------------|----------|
| Transcript | Live session memory only | Per-bot SQLite WAL + FTS5 |
| Survives `/exit` | ❌ Gone | ✅ Persisted |
| Search ("what did Maria send last week") | ❌ Not possible | ✅ `node skills/history/scripts/query.js search "..."` |
| Cron writes to transcript | ❌ N/A | ✅ `tell(bot, 'sendMessage', ...)` over Unix socket |
| Forensic event log | ❌ N/A | ✅ Typed `events` table with `polygram-start`/`shutdown-drain`/`handler-error`/`autosteer`/`reactor-state`/`approval-resolved`/etc. |
| Per-attachment table | ❌ N/A | ✅ `attachments` table with download lifecycle, FTS-able captions/transcriptions |

### Tool execution + approvals

| | Official plugin | polygram |
|---|-----------------|----------|
| Tool runs | With whatever permissions Claude has in this session | With `permissionMode: 'bypassPermissions'` by default OR with `canUseTool` approval flow gating destructive tools |
| `[Approve] / [Deny]` inline buttons | ❌ | ✅ 4-button card (Approve / Deny / Approve always / Deny always) posted to a configured admin chat |
| "Approve always" persists | ❌ | ✅ Stored in `chat_tool_decisions`; future calls of same tool + canonical input short-circuit |
| Out-of-band human-in-the-loop | ❌ | ✅ Operator clicks from a different Telegram chat than the requester |
| Replay protection | ❌ | ✅ Token-protected callbacks; foreign-chat clicks rejected |

### Conversation experience

| | Official plugin | polygram |
|---|-----------------|----------|
| Streaming bubble edits | ✅ basic | ✅ throttled + debounced (default 1 edit/sec, first edit after 30 chars) |
| Status reactions on user msg | ❌ | ✅ 🤔 → 🤓 → 🥱 → 😨 state machine, clears on turn end |
| Mid-turn message merge (autosteer) | ❌ | ✅ User follow-up during in-flight turn injected into running Query via SDK input controller |
| Edit-correction (typo fix mid-turn) | ❌ | ✅ Edit Telegram msg → `[edit] correction: <NEW>` injected into active turn |
| Auto-resume on idle timeout | ❌ | ✅ 300s no-activity → kill wedged Query, fresh `--resume <id>`, continue |
| Inline stickers (`[sticker:happy]`) | ❌ | ✅ Agent's reply emits tags → polygram translates to `sendSticker` |
| Inline reactions (`[react:🔥]`) | ❌ | ✅ Agent's reply emits tags → polygram translates to `setMessageReaction` |
| Natural-language abort (`Stop`, `стоп`, `cancel`) | ❌ | ✅ First-sentence match + slash forms + bilingual ack |
| Reply-to-quote in prompt | ❌ | ✅ Replied-to message text appears in prompt so Claude sees it |
| Multi-photo album coalescing | ❌ | ✅ `media_group_id` siblings merge into one logical turn |

### Voice + media

| | Official plugin | polygram |
|---|-----------------|----------|
| Voice transcription | ❌ | ✅ Whisper API or local `whisper.cpp`, per-bot |
| Per-attachment download lifecycle | ❌ | ✅ `pending` → `downloaded` / `failed` with retry telemetry |
| Failed-download surfaced to Claude | ❌ | ✅ `<attachment-failed reason="..." />` in prompt — user gets a real explanation |
| Content-addressed dedup | ❌ | ✅ Telegram `file_unique_id` — same photo forwarded twice = one file on disk |
| MIME allowlist + extension fallback | ❌ basic | ✅ Archives, markup, images, audio, video, documents; octet-stream / empty falls back to extension |

### Per-chat agents

| | Official plugin | polygram |
|---|-----------------|----------|
| Pinned agent per chat | ❌ — uses your current session's setup | ✅ `agent: 'name'` or `agent: 'plugin:name'` per chat |
| Frontmatter-driven model/effort | ❌ | ✅ Frontmatter `model` / `effort` / `permissionMode` flow through |
| Plugin-qualified agent names | ❌ | ✅ Resolves through `installed_plugins.json`, `~/.claude-plugins-local/`, AND `<cwd>/.claude-plugins-local/` |
| Hot-reload via `/reload` | ❌ | ✅ Kill + respawn Query, session_id preserved |

### Operational tooling

| | Official plugin | polygram |
|---|-----------------|----------|
| Health-check command | ❌ | ✅ `polygram-doctor --bot <name>` runs static + roundtrip checks |
| `/polygram:status` slash command | ❌ | ✅ Running bots, IPC health, recent events |
| `/polygram:logs <bot>` | ❌ | ✅ Tail `~/polygram/logs/<bot>.log` |
| `/polygram:approvals` | ❌ | ✅ Pending + recent approval rows |
| Boot replay for interrupted turns | ❌ | ✅ 3-min window, dedupe against already-sent replies, one-shot guard |
| Crash-resilient `handler_status` state machine | ❌ | ✅ `dispatched` → `replied` / `failed` / `replay-pending` / `replay-attempted` / `aborted` |
| Log rotation | ❌ — relies on Claude Code's logging | ✅ Per-user launchd jobs, daily 03:17/03:23 local, copy-truncate (no SIGHUP) |
| Telemetry queryable from any operator's machine | ❌ | ✅ `scp` + `sqlite3` over SSH; every state change has an event row |

### Slash commands available IN the chat

| | Official plugin | polygram |
|---|-----------------|----------|
| `/model X` | ❌ | ✅ Live-applied via SDK `setModel`, no respawn |
| `/effort X` | ❌ | ✅ Live-applied via SDK `applyFlagSettings({effortLevel})` |
| `/compact [hint]` | ❌ | ✅ Manual SDK compaction, optional preserve hint |
| `/new`, `/reset` | ❌ | ✅ resetSession clears claude_session_id, fresh conversation |
| `/reload` | ❌ | ✅ Close + respawn Query, preserves session_id |
| `/context` | ❌ | ✅ Remaining tokens, percent full |
| `/stop` (graceful) | ❌ — no abort flow | ✅ SDK `interrupt()` + `drainQueue()`, no `💥 crashed` reply |
| `/pair-code`, `/pair`, `/pairings`, `/unpair` | ❌ | ✅ Guest onboarding without polygram restart |

### Multi-bot

| | Official plugin | polygram |
|---|-----------------|----------|
| Run 3 bots | 3 always-on Claude Code terminals, 3 sessions | 3 daemons (`polygram --bot a`, `polygram --bot b`, `polygram --bot c`); per-bot DB; per-bot socket |
| Crash isolation | A bug crashes the WHOLE Claude Code session | A bug in bot A's flow doesn't take down bot B or C |
| Cross-bot ownership | N/A | ✅ chat_id ownership enforced at IPC layer; bot A's cron can't post to bot B's chat |

### Security

| | Official plugin | polygram |
|---|-----------------|----------|
| Chat allowlist | ✅ basic | ✅ closed whitelist; unlisted chats dropped at `bot.on('message')` |
| Prompt-injection hardening | ❌ explicit (relies on Claude's own training) | ✅ user text wrapped in `<untrusted-input>` with xml-escape; attributes use `&quot;` |
| Path-traversal protection on agent names | N/A | ✅ `AGENT_NAME_RE` blocks `..`, slashes, leading dots |
| Env scrub for spawned subprocesses | N/A | ✅ Explicit allowlist (`PATH`, `HOME`, `USER`, `TZ`, …) plus `LC_*` / `NODE_*` / `CLAUDE_*` / `ANTHROPIC_*` prefixes |
| `inline_message_id` IPC bypass blocked | N/A | ✅ rc.2 security fix |
| `callback_query` well-formed gate | N/A | ✅ rc.2 security fix |

### Distribution + plugin integration

| | Official plugin | polygram |
|---|-----------------|----------|
| `npm install -g` | ❌ — installed via `/plugin install` only | ✅ ships as both an npm daemon AND a Claude Code plugin marketplace |
| Bundled skills for Claude | ❌ | ✅ `history` (transcript queries), `polygram-send` (out-of-turn IPC) |
| Marketplace install for plugin features | ✅ from `claude-plugins-official` | ✅ from `https://github.com/shumkov/polygram.git` (single-plugin marketplace) |

---

## When the official plugin is the right choice

You should use the official plugin (and not polygram) if any of these are true:

- You only have **one bot** and don't anticipate adding more.
- You only have **one chat** (a personal DM) and don't run partner chats / ops chats / community chats from the same bot.
- You **already keep a Claude Code session open** at your laptop most of the day and just want a Telegram window onto it.
- You don't need **persistent transcript** beyond what's in the live Claude session.
- You don't run **cron jobs** that need to write into the chat.
- You don't need **inline-keyboard approvals** for destructive tool calls.
- You haven't used OpenClaw before and don't have an OpenClaw mental model to preserve.

In those cases, the official plugin is simpler, supported, and zero-config beyond a token. polygram would be over-kill.

---

## When polygram is the right choice

Pick polygram if any of these are true:

- You run **multiple Telegram bots** (admin bot, partner bots, community bots) from one machine.
- A single bot fans out into **multiple chats** that each need their own session (customer DMs, ops topics, partner groups).
- You want a **persistent transcript** that survives reboot and `claude` upgrades, with **FTS** for "what did Maria send last week" queries.
- You run **cron jobs** that should write into the chat AND show up in the transcript.
- You need an **approval flow** for destructive tool calls (gated `Bash(rm *)`, MCP-driven actions, etc.) with out-of-band operator click in a different chat.
- You're **migrating from OpenClaw** and want to keep the per-chat-session ergonomics.
- You want **operational telemetry** — typed events, queryable forensic log, polygram-doctor for health checks.
- You want **conversation features** the official plugin doesn't have: autosteer, edit-correction, status reactions, voice transcription, album coalescing, inline stickers + reactions, auto-resume on idle.

---

## Switching cost from official plugin → polygram

Smooth, both can co-exist during the transition:

1. **Install polygram** alongside the official plugin (`npm install -g polygram`).
2. **Configure** `~/polygram/config.json` with the bots you want to migrate.
3. **Get a different bot token** from `@BotFather` for polygram (don't share the same token between the two — Telegram returns 409 conflict if both poll). Or migrate fully and revoke the old token after.
4. **Test** in a non-critical chat first.
5. **Migrate cron scripts** to use polygram's IPC (`tell(bot, 'sendMessage', ...)`) so the transcript is unified.

The transcript starts fresh on polygram — there's no migration tool from the official plugin's session memory. Acceptable in practice because the official plugin's "memory" is whatever's in the current session anyway.

---

## Where the official plugin might catch up

For full transparency: Anthropic owns the official plugin and could ship any of polygram's features at any time. Areas that look most likely to land first if Anthropic invests:

- Multi-bot support (the most-requested feature in their issue tracker).
- Per-chat session model.
- Streaming bubble edits with throttle.

Areas where polygram's lead is structural and harder to close:

- The persistent transcript shape (SQLite WAL + FTS5 + `events` table) requires migration tooling once the official plugin commits to it.
- The approval flow (`canUseTool` callback wired into Telegram) requires a security model decision Anthropic hasn't publicly made.
- The cron-IPC / Unix-socket model is opinionated about being self-hosted; the official plugin trends toward zero-config.

If the official plugin grows the features you needed polygram for, switching back is straightforward — the transcript stays in your SQLite file even if the bot stops being polygram. You can always stand the daemon back up later.

---

This file was last updated against polygram 0.9.0-rc.5 (2026-05-08). The official plugin landscape moves fast — if a feature here is wrong, please open an issue.
