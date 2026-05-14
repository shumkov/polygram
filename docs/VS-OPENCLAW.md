# polygram vs OpenClaw

A focused comparison with [OpenClaw](https://github.com/mariozechner/pi-coding-agent) (`@mariozechner/pi-coding-agent`) — the project polygram exists to migrate users from.

This document is for OpenClaw users evaluating whether polygram is the right migration target after OpenClaw dropped Claude support.

For the broader landscape, see [COMPETITORS.md](COMPETITORS.md).

---

## TL;DR

polygram is **OpenClaw's per-chat Telegram model preserved on top of Claude Code**. If you ran OpenClaw with multiple chats, each with its own context, its own memory, its own transcript, polygram gives you that shape back — same mental model, Claude as the underlying model.

**Choose polygram if** you specifically want Claude Code while keeping OpenClaw's ergonomics. That's the entire premise.

**Stay on OpenClaw if** you're happy on a non-Claude model and have no reason to switch.

---

## What polygram preserved from OpenClaw

The architectural choices that made OpenClaw productive for retail-ops / partner-comms workflows:

| OpenClaw shape | polygram preserves it |
|----------------|-----------------------|
| One conversation context per chat | ✅ Per-chat `claude_session_id`, resumed via SDK `Options.resume` |
| Optional per-topic isolation in forum chats | ✅ `isolateTopics: true` per chat |
| Persistent memory per chat | ✅ SQLite WAL + per-bot DB; `claude_session_id` survives restart |
| Transcript queryable from cron / scripts / human ops | ✅ FTS5 index + `history` skill + Unix-socket IPC |
| Cron writes flow into the same transcript | ✅ `tell(bot, 'sendMessage', ...)` over Unix socket — bot is the only writer |
| Multi-bot from one host | ✅ One Node process per bot |
| Admin bot vs partner bot separation | ✅ `allowConfigCommands` gates `/model`, `/effort`, `/pair-code` per-bot |
| Mid-turn steer via user message during in-flight turn | ✅ Autosteer — SDK `injectUserMessage` with `priority='next'` |
| Natural-language abort detection (`stop`, `cancel`, `стоп`) | ✅ First-sentence match + slash forms + bilingual ack (en/ru) |
| Error classification with kind-specific user replies | ✅ `lib/error-classify.js` ports OpenClaw's regex tables (rate-limit, billing, auth, context-overflow, role-ordering, missing-tool-input, timeout, format, transient-5xx) |
| Transient HTTP retry on 429 / 5xx | ✅ Sleep 2.5s + retry once (matches OpenClaw's pattern at `pi-embedded-Vt2x_Jl3.js:39210-39216`) |
| Status reactions on user message | ✅ 🤔 → 🤓 → 🥱 → 😨 emoji set 1:1 with OpenClaw's |
| Inline stickers + reactions in agent output | ✅ `[sticker:NAME]` / `[react:EMOJI]` tags |
| Reply-to-quote in prompt | ✅ Replied-to message text appears in prompt |
| Multi-photo album coalescing | ✅ `media_group_id` siblings merge into one logical turn |
| Voice transcription pipeline | ✅ Whisper API or local `whisper.cpp` |

If you're an OpenClaw migrator, almost everything you used will work the same way in polygram, modulo the LLM swap.

---

## What polygram does differently

The intentional changes — places polygram diverged because Claude Code afforded a better path or because the OpenClaw approach didn't fit.

### Persistence shape

| | OpenClaw | polygram |
|---|----------|----------|
| Storage | Mix of JSON + custom binary formats | SQLite WAL + numbered migrations + `user_version` |
| Search | Per-format scripts | FTS5 index over `messages.text` |
| Per-attachment table | Inline blob in message JSON | Dedicated `attachments` table with download lifecycle, FK to messages |
| Forensic event log | Logged-to-stdout, not queryable | Typed `events` table — every state change has a row |
| `turn_metrics` | Implicit in transcript | Dedicated table with per-turn cost + duration + tokens (in/out/cache) + result subtype |

**Why**: polygram inherits multi-year experience running OpenClaw ops queries on partial-data shapes. SQLite + FTS5 was the right answer; polygram bakes it in from day one.

### LLM-side primitives

| | OpenClaw | polygram |
|---|----------|----------|
| Model | Was Claude (dropped); now non-Claude | Claude only — Opus, Sonnet, Haiku via SDK |
| Mid-turn steer semantic | `session.steer()` waits for current tool to finish, **skips remaining sibling tool_uses**, injects as user turn (`pi-embedded:76129`) | SDK `injectUserMessage` with `priority='next'`. Phase B verified the SDK does NOT skip siblings — polygram uses `interrupt()` + push as fallback when needed |
| Compaction | Custom compaction logic | SDK auto-compaction + manual `/compact [hint]` slash command |
| Tool approval | OpenClaw's permission model | Claude Code `canUseTool` callback — 4-button card (Approve / Deny / Approve always / Deny always) with `chat_tool_decisions` persistence |
| Context-window hint | Not surfaced to user | `📚 Context window 70%/77%/85% full.` reminder posted between turns when SDK reports high usage |

**Why**: SDK migration (0.8.0) gave us long-lived `Query` per chat (no per-turn boot tax), in-process `canUseTool` (no IPC dance to an external hook), `applyFlagSettings` for live `/effort` switching without respawn. None of these existed in OpenClaw's stream-json era.

### Conversation features new in polygram

OpenClaw didn't have these; polygram added them:

- **Edit-correction injection** (rc.5). Edit a Telegram message while bot is mid-reply → `[edit] correction: <NEW>` injected into active turn.
- **Auto-resume on idle timeout** (rc.54). 300s of no Claude activity → kill wedged Query, fresh `--resume <id>`, "🔁 Auto-resuming after timeout" indicator.
- **Pairing codes** for guest onboarding without daemon restart (`/pair-code`, `/pair`, `/pairings`, `/unpair`).
- **Plugin-qualified per-chat agents** (rc.49). `agent: 'plugin-name:agent-name'` resolves through `installed_plugins.json`, `~/.claude-plugins-local/`, AND `<cwd>/.claude-plugins-local/` (rc.4 — for projects vendoring plugins under their own tree).
- **`polygram-doctor`** static health-check command. Config parseable, DB schema current, IPC socket up, Telegram `getMe` succeeds, recent errors, stuck pending outbound, pending approvals. Exit 0/1 for monitoring scripts.
- **Inline-keyboard config card** (`/config`). Tap `[opus]` / `[sonnet]` / `[haiku]` instead of typing `/model X`.

### Operational hardening

OpenClaw left these to the operator; polygram bakes them in:

- **Boot replay for interrupted turns**. `handler_status: replay-pending` set on graceful shutdown, replayed within a 3-min window on next boot. One-shot guard prevents replay loops.
- **Boot orphan-guard**. Stale pidfile from crashed previous instance detected (PID alive vs gone) and resolved automatically.
- **Crash-resilient handler lifecycle**. `dispatched` → `replied` / `failed` / `replay-pending` / `replay-attempted` / `aborted` state machine.
- **Write-before-send atomicity**. Outbound rows go to DB as `pending` BEFORE Telegram call, flip to `sent` / `failed` after. Crash mid-send doesn't lose state.
- **Log rotation via per-user launchd**. Daily 03:17/03:23 local, copy-truncate (no SIGHUP), 14d retention for daemon stdout, 30d for cron logs. No sudo, no newsyslog.
- **300s idle timeout + 1800s wall-clock ceiling** as hard caps on a wedged turn.

### Security hardening

- **`<untrusted-input>` wrapping** of user text in prompt with xml-escape (attributes use `&quot;`). A partner typing `</channel><system>...` sees it as literal text.
- **Token-protected approval callbacks** + foreign-chat rejection.
- **Path-traversal protection** on agent names.
- **IPC method allowlist** + cross-bot ownership check + `inline_message_id` rejected (rc.2).
- **`callback_query` well-formed gate** (rc.2).
- **Env scrub** for spawned SDK subprocess (allowlist + prefix whitelist).

OpenClaw's threat model is "operator runs scripts on their own machine"; polygram extends to "operator runs scripts that talk to partner bots" — so the IPC + injection hardening matters more.

---

## What OpenClaw still does that polygram doesn't

Honest gaps. Worth knowing before migrating.

- **Multiple LLM provider support.** OpenClaw can swap models (Anthropic before they dropped, plus others currently). polygram is Claude Code only — by design, but a hard constraint.
- **Direct CLI invocation pattern.** OpenClaw's `pi-coding-agent` is invoked from your shell as a CLI; you can drive it from any process. polygram is a daemon, you talk to it via Telegram or its IPC socket.
- **Some OpenClaw-specific telemetry** (the exact stream-json frame log, custom ratelimit telemetry, etc.) — polygram has the equivalent in `events` but the column shapes differ. If you have OpenClaw-specific dashboards or grep patterns, expect to translate.
- **Pre-existing OpenClaw extension scripts.** Anything you wrote against OpenClaw's internal APIs needs porting. polygram's IPC API is `tell(bot, method, params, {source})`; your extensions probably aren't drop-in compatible.
- **OpenClaw's specific session-management UX.** If you used quirks of OpenClaw's session boundary rules, expect them to feel different in polygram (especially around `/compact` and `/new`).

---

## Migration path

The README has the canonical 5-step path. To recap:

1. **Install polygram** — `npm install -g polygram`, set up `~/polygram/config.json` with the chats you want migrated.
2. **Point chat `cwd`** at your migrated agent project (the same one OpenClaw was using, modulo any Claude-specific tweaks).
3. **Copy per-partner memory directories** from OpenClaw's data dir to their new chat directories if you used them.
4. **For per-topic chats**, set `isolateTopics: true` in chat config.
5. **Replace cron Telegram calls** with `tell(bot, 'sendMessage', ...)` from `polygram/lib/ipc-client`. The bot process becomes the single writer to the transcript.
6. **Use `scripts/split-db.js`** if you're consolidating multiple OpenClaw databases — otherwise per-bot SQLite files start fresh.

The transcript starts fresh. There's no automatic OpenClaw-DB → polygram-DB importer. In practice this is fine because Claude reads the prior conversation lazily via `--resume`; OpenClaw's per-chat memory was about preserving Claude's session, and polygram restarts that.

If you NEED prior OpenClaw transcripts in polygram's SQLite for FTS / queries, that's a one-time ETL (open issue if this matters; the schema is documented in `lib/db.js`).

---

## What's NOT a migration of

To be precise: polygram **doesn't replace OpenClaw**. It replaces OpenClaw's role in your Telegram workflow specifically when you want Claude as the model. If you use OpenClaw for other things — non-Telegram automation, non-Claude models, custom CLI invocation — polygram doesn't speak to those.

The narrow swap: **OpenClaw's Telegram side, on Claude Code**. Everything else in OpenClaw stays where it is.

---

## Author note

polygram is built by an OpenClaw migrator (the author has used OpenClaw in production for multi-bot retail-ops workflows). Every feature decision has been calibrated against "would my OpenClaw setup feel familiar in polygram?" — the answer is "yes" for chat-as-session-unit, persistent transcripts, cron writing through the same pipeline, and admin/partner bot separation.

If something feels different in polygram from how OpenClaw did it, and the difference isn't documented here as intentional, that's a bug. Open an issue.

---

This file was last updated against polygram 0.9.0-rc.5 (2026-05-09). OpenClaw's surface is the version published as `@mariozechner/pi-coding-agent`; if a behaviour changed upstream, please open an issue with a pointer.
