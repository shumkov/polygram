# polygram — Features

Comprehensive feature inventory across 0.4 → 0.9.0. Grouped by user-facing experience first, then operations and architecture. Every entry below is shipped, in production, and exercised by the test suite (1605 tests at last count).

---

## 1. Per-chat conversation model

The OpenClaw-shape preserved on top of Claude Code.

- **One Claude session per chat.** Each Telegram chat has its own `claude_session_id`, resumed via the SDK `Options.resume`. Cold spawn for a new chat, warm afterwards (LRU-bounded — default cap 5 simultaneously warm).
- **Per-topic isolation — opt-in.** `isolateTopics: true` in chat config gives each forum topic its own session. Default is shared context across topics, since topics are usually organisational.
- **Multi-bot.** N Telegram bots = N Node processes. No "one process hosts many bots" mode. Crash isolation is the point: a bug in one bot's flow can't take down a sibling bot.
- **Pinned per-chat agent.** `agent: 'name'` or `agent: 'plugin:name'` in chat config. polygram reads the agent file and injects its body as `systemPrompt`, frontmatter `model` / `effort` / `permissionMode` flow through.
- **Per-topic config overrides** (rc.48). A specific topic can override the chat's `agent`, `model`, `effort`, `cwd`, `permissionMode`. Common use: keep the chat in `bypassPermissions` mode but force `default` (with approvals firing) on a sensitive topic.

---

## 2. Conversation flow

Behaviours that make polygram feel native to Telegram, not a wrapped CLI.

- **Status reactions.** As the bot processes a turn, polygram applies emoji reactions to the user's message: 🤔 (thinking) → 🤓 (deep) at 12s → 🤓 (deepest) at 30s. 🥱 (stalled) at 30s of no progress. 😨 (frozen) at 180s. ✍ (autosteered). Reactions clear on turn end. Visible state without bubble pollution.
- **Step-level streaming replies.** Telegram message edits on each assistant step as Claude works through tool calls. Throttled (default 1 edit/sec) and debounced (default first edit after 30 chars).
- **Autosteer.** Send a follow-up while the bot is mid-reply: polygram absorbs it into the current turn instead of queueing a separate response. Saves a turn, saves tokens, feels conversational. Per-chat opt-out via `autosteer: false`. Mode `'merge'` (default, priority='next') or `'queue'` (priority='later').
- **Edit-correction injection** (rc.5). Edit a Telegram message while the SDK is still processing it: polygram injects `[edit] I corrected my previous message — it now reads: <NEW>` into the active turn via the same channel autosteer uses. Lets users fix typos mid-turn without `/stop` + resend. Per-chat opt-out via `editCorrection: false`.
- **Auto-resume on idle timeout** (rc.54). When Claude goes 300s with no activity (typically a wedged tool call — long Bash, hanging MCP, stuck subagent), polygram tears down the wedged Query, spawns a fresh one with `--resume <id>` to preserve the session, and asks Claude to continue. Cooldown prevents runaway loops.
- **Inline stickers + reactions** (rc.61, rc.63, rc.67). Agent's reply can contain `[sticker:NAME]` (translated to `sendSticker` with the configured stickers map) or `[react:EMOJI]` (translated to `setMessageReaction` on the user's last message). Tags are stripped from the bubble before stream-time.
- **Natural-language abort.** `stop`, `cancel`, `wait`, `стоп`, `отмена`, `хватит`, plus the slash forms `/stop`, `/abort`, `/cancel`. First-sentence match catches "Stop. I'll ask in another session." too. Scoped to the user's own session — abort in one topic never disturbs sibling topics under `isolateTopics`. Bilingual ack (en/ru).
- **Album coalescing.** Multi-photo Telegram albums (each photo arrives as a separate message sharing `media_group_id`) coalesce into one logical turn so Claude sees the whole album, not just the first photo.
- **Reply-to-quote.** When a user replies to a prior message, the prior message's text appears in the prompt so Claude sees what was being replied to.
- **Context-window hint.** `📚 Context window 70%/77%/85% full.` reminder posted between turns when the SDK reports high context use. User can `/new`, `/compact [hint]`, or keep chatting (auto-compaction will fire).

---

## 3. Slash commands

All gated on `config.bot.allowConfigCommands` (default off — partner bots ignore commands, only operator bots allow them) except `/pair` which is its own auth flow.

- `/context` — on-demand context-usage report (remaining tokens, percent full).
- `/compact [hint]` — manual SDK compaction with optional preserve hint.
- `/reload` — close + respawn Query while preserving session_id (fresh skills/agents, same conversation).
- `/new`, `/reset` — fresh session (resetSession clears session_id).
- `/model opus|sonnet|haiku` — switch model. Live-applied via SDK `setModel`, no respawn needed.
- `/effort low|medium|high|xhigh|max` — switch effort. Live-applied via SDK `applyFlagSettings({effortLevel})`.
- `/config` — show current model/effort + inline keyboard to switch.
- `/pair-code [--scope user|chat] [--ttl 10m] [--note "..."]` — admin: issue a pairing code.
- `/pairings` — admin: list active pairings.
- `/unpair <user_id>` — admin: revoke pairings for a user.
- `/pair <CODE>` — open: claim a pairing code (the code is the auth).

---

## 4. Per-chat agents

- **Single-file Claude Code agents** (`~/.claude/agents/<name>.md`) — frontmatter (model/effort/permissionMode) + body (systemPrompt). The Claude-Code-standard layout.
- **Directory agents** (`~/.claude/agents/<name>/CLAUDE.md` + optional `skills/`, `settings.json`). Polygram reads CLAUDE.md / AGENTS.md / system-prompt.txt. Directory layout supports per-agent skills + MCP servers from settings.json.
- **Plugin-qualified names** (rc.49). `agent: 'plugin:agent-name'` resolves through:
  1. `~/.claude/plugins/installed_plugins.json` registry → installPath/agents/
  2. `~/.claude-plugins-local/<plugin>/agents/`
  3. `<cwd>/.claude-plugins-local/<plugin>/agents/` (rc.4 — for projects vendoring plugins under their own tree via `extraKnownMarketplaces.<m>.source.path`)
- **Path-traversal protection.** Agent name regex blocks `..`, slashes, leading dots — operator typos can't read arbitrary file paths.
- **Hot-reload via `/reload`.** Edit an agent file → `/reload` in the chat → next message picks up the new prompt without daemon restart.

---

## 5. Voice + media

- **Whisper transcription.** OpenAI Whisper API or local `whisper.cpp`, selectable per bot. Transcriptions land in `messages.text` so FTS finds them.
- **Per-attachment table** (since 0.6.0). `attachments` table with download lifecycle (`pending` → `downloaded` | `failed`), per-attachment transcription, and `chat_id` / `kind` / `status` indexes. Replaces the older `attachments_json` blob. Query "all PDFs Maria sent last week" without scanning every message.
- **Content-addressed storage** via Telegram's `file_unique_id`. Same photo forwarded twice = one file on disk.
- **Failed downloads surface to Claude** as `<attachment-failed reason="..." />` so the user gets a real explanation instead of silence.
- **MIME allowlist with extension fallback** (rc.68). Archives (zip/rar/7z), markup (md/csv/yaml/etc), images, audio, video, documents. `application/octet-stream` or empty MIME falls back to extension-based detection.
- **Per-file caps** (default 10 MB) with operator-readable rejection text in the prompt.

---

## 6. Approvals (canUseTool)

- **Inline-keyboard 4-button card** posted to a configured admin chat. `[Approve]` / `[Deny]` / `[Approve always]` / `[Deny always]`.
- **Always-* persists** to `chat_tool_decisions` table. Future calls of the same tool with the same canonical input short-circuit without posting a card.
- **Token-protected callbacks.** Each card embeds a random token in `callback_data`; clicks with bad tokens are rejected and logged.
- **Foreign-chat rejection.** Only the configured `adminChatId` can resolve approvals. A leaked card forwarded to another chat does nothing.
- **Double-click race-safe.** Atomic SQL `UPDATE ... WHERE status='pending'` — only one writer wins, the other sees changes=0 and gets "Already approved/denied".
- **5-minute auto-deny** by sweeper. Card edits to `⏰ Timed out`.
- **In-process** since 0.8.0 — the deleted `bin/approval-hook.js` IPC dance is gone. SDK `canUseTool` callback wires directly into the same approval flow.
- **`updatedPermissions`** — when you tap "Approve always", the SDK Query receives an addRules update so Claude doesn't re-prompt for the rest of the turn.
- **Pattern-based gating.** `gatedTools: ['Bash(rm *)', 'mcp__*__invoice_create']` — first-arg glob for Bash, URL match for WebFetch, JSON-stringified input match otherwise.

---

## 7. Pairing

- **Pairing codes** for guest onboarding without polygram restart. `/pair-code` from admin chat issues a short code; `/pair <CODE>` from any chat claims it. Default TTL 10m. Scope: `user` (any chat) or `chat` (specific chat only).
- **Rate-limited claims** (3 attempts per 15min per user). Exposes only `invalid or expired` to defeat enumeration.
- **`/pairings`** lists active grants; **`/unpair <user_id>`** revokes.
- **Audit trail.** Every claim attempt logs to `events` with reason — operator can see who tried what, when.

---

## 8. Cron + IPC

- **Unix-socket IPC per bot.** `<data-dir>/.ipc/polygram-<bot>.sock`, inside a canonical owner-only `0700` runtime directory. Cron jobs and external scripts call the bot to send messages, so the transcript is unified and the bot is the only writer to its own DB.
- **`tell(bot, method, params, {source})`** — the public API.
- **Method allowlist.** Only non-destructive methods: `sendMessage`, `sendPhoto`, `sendDocument`, `sendSticker`, `sendChatAction`, `editMessageText`, `setMessageReaction`. Cron has no business calling `deleteMessage` or `banChatMember`.
- **Cross-bot send rejection.** `chat_id` must belong to this bot (via `config.chats[chatId]`). A cron in bot A can't accidentally post to bot B's chat.
- **`inline_message_id` blocked** (rc.2 security fix). Prevents a cron caller from bypassing the chat ownership check via inline-mode addressing.
- **File param validation.** `localhost` URLs, `http://` URLs, bare filesystem paths — all rejected with a clear error before Telegram returns the cryptic `Wrong port number specified` or similar. Wrap local files in `{ source: '/abs/path' }`.

---

## 9. Persistent state (SQLite)

- **Per-bot DB.** `~/polygram/<bot>.db`. Bot is the only writer to its own file.
- **WAL mode** for concurrent readers (history skill, polygram-doctor) without blocking the writer.
- **FTS5 index** on `messages.text` — full-text search via `node skills/history/scripts/query.js search "invoice"`.
- **Numbered migrations** (`migrations/NNN-*.sql`), guarded by `user_version`. 10 migrations applied at boot.
- **Tables**:
  - `messages` — every inbound + outbound + IPC-posted message, with `direction`, `status` (pending/sent/failed for outbound), `handler_status` for inbound lifecycle.
  - `attachments` — per-attachment row with download lifecycle and FK to messages.
  - `sessions` — `chat_id` → `claude_session_id` mapping.
  - `events` — typed lifecycle events. Forensic-grade, queryable. Critical kinds: `polygram-start`/`polygram-stop`/`shutdown-drain`/`handler-error`/`auth-expired`/`compact-boundary`/`autosteer`/`reactor-state`/`approval-resolved`/`pair-claim-attempt`/`transient-retry`/...
  - `pending_approvals` — canUseTool requests with status (pending → approved/denied/timeout/cancelled).
  - `chat_tool_decisions` — persisted "always allow / always deny" rules.
  - `pairings` — active grants.
  - `polling_state` — per-bot last-seen update_id (resume polling on restart).
  - `config_changes` — model/effort/agent change audit log.
  - `turn_metrics` — per-turn cost + duration + tokens (in/out/cache) + result subtype.

---

## 10. Reliability

- **Write-before-send atomicity.** Outbound messages hit the DB as `pending` before the Telegram call, flip to `sent` or `failed` after. Boot sweep resolves stale `pending` rows from the last crash.
- **Crash-resilient handler lifecycle.** Inbound rows track `handler_status` (`dispatched` → `replied` | `failed` | `replay-pending` | `replay-attempted` | `aborted`). On graceful shutdown, in-flight turns mark `replay-pending`. On next boot, daemon re-dispatches anything within a 3-minute window (configurable). One-shot guard prevents replay loops. Dedupes against already-sent outbound replies.
- **Boot orphan-guard.** Stale pidfile from a crashed previous instance is detected (PID alive vs gone) and resolved automatically.
- **300s idle timeout + 1800s wall-clock ceiling.** Hard caps on a wedged turn so a hanging Bash or stuck MCP doesn't park forever.
- **Transient HTTP retry** (0.7.7+). 429 / 503 / 521 / 522 / 524 / 529 / iterator throws — sleep 2.5s and retry once. Telemetry: `transient-retry` event.
- **Auto-resume tracker** with per-session cooldown — prevents permanently-wedged tools from looping forever.
- **/stop is graceful.** SDK `interrupt()` + `drainQueue()` rejects pending Promises with `INTERRUPTED`, polygram suppresses the user-facing apology, sends "Stopped." in the user's language. No `💥 crashed` reply within 15s of `/stop`.

---

## 11. Security

- **Chat allowlist** is the primary auth boundary. Unlisted chats are dropped at `bot.on('message')`.
- **Prompt-injection hardening.** User text wrapped in `<untrusted-input>` with xml-escape; attributes use `&quot;`. A partner typing `</channel><system>...` sees it as literal text in the prompt.
- **Token-protected approval callbacks** (see §6).
- **Path-traversal protection** on agent names (`AGENT_NAME_RE`). `../etc/passwd` doesn't resolve.
- **Per-chat ownership check** on IPC `editMessageText` (rc.2) — `inline_message_id` rejected outright since polygram doesn't emit inline-mode keyboards.
- **`callback_query` well-formed gate** (rc.2). Malformed payloads (missing `from`, missing `message`, inline-mode) are skipped early.
- **Env scrub.** Spawned SDK subprocess sees only an explicit allowlist (`PATH`, `HOME`, `USER`, `TZ`, …) plus `LC_*` / `NODE_*` / `CLAUDE_*` / `ANTHROPIC_*` prefixes. No accidental leaking of operator-shell secrets.
- **IPC secret opt-in** (0.9.0). Pre-cleanup, `POLYGRAM_IPC_SECRET` was unconditionally exported to the spawned child for the (now-deleted) `bin/approval-hook.js`. Now gated behind `config.bot.exposeIpcSecretToChildren`.
- **IPC runtime isolation.** Socket and secret paths are rejected when they are temporary, aliased, not owned by the daemon user, or not protected by a `0700` directory. Native Codex profiles explicitly deny that directory.
- **Codex app-server (native macOS beta).** Optional ChatGPT-backed Codex sessions use the pinned app-server directly, with mid-turn steering and durable stop/recovery fences. Linux and Windows are rejected in this milestone. Command network and model-native web search are disabled, product MCP tools and interactive approvals are unavailable, and long-running commands must remain in the foreground. Detached/background servers are unsupported and may survive hard runtime loss.

---

## 12. Operations

- **`polygram-doctor --bot <name>`** — runs static checks: config parseable, DB schema current, IPC socket up, Telegram `getMe` succeeds, recent errors from last 24h, stuck pending outbound, pending approvals. Exit 0 = pass, 1 = any failure (`--strict` to fail on warnings too). `--json` for machine-readable. `--roundtrip --to <chat_id>` for full outbound verification.
- **LaunchAgent plists** in `ops/` for macOS auto-start.
- **Log rotation** via per-user launchd jobs. Copy-truncate (preserves daemon's open fd, no SIGHUP / restart). Daily 03:17 / 03:23 local. 14d retention for daemon stdout, 30d for cron logs.
- **Telemetry queryable from any operator's machine** via `scp` + `sqlite3` over SSH. The `events` and `messages` tables are forensic-grade; every state change has a row.
- **Telegram empty-response fallback.** On `getUpdates` returning 0 updates for too long, polygram logs `poll-stalled` so external monitoring sees the silence.
- **Polling watchdog.** If the poll loop hasn't ticked in 120s, log + event. Recovery is logged when ticks resume.

---

## 13. Distribution

- **`npm install -g polygram`** for the daemon. Single binary, all migrations bundled.
- **Claude Code plugin marketplace.** The repo doubles as a single-plugin marketplace.
  - `/plugin marketplace add https://github.com/shumkov/polygram.git`
  - `/plugin install polygram@shumkov`
  - Adds slash commands at `/`: `/polygram:status`, `/polygram:logs <bot>`, `/polygram:pair-code`, `/polygram:approvals [bot]`.
- **Bundled `history` skill** lets Claude query the transcript directly when asked about chat activity. Scope by `process.cwd()` — refuses unmapped directories unless `POLYGRAM_ADMIN=1`.
- **Bundled `polygram-send` skill** for out-of-turn IPC sends with file-upload validation.

---

## 14. Architecture (for those evaluating)

- **Long-lived SDK Query per chat.** No per-turn spawn — same `claude-agent-sdk` `Query` instance kept warm via the LRU. Faster than CLI mode (no boot tax), supports mid-turn `interrupt()` and `applyFlagSettings()`.
- **In-process `canUseTool` callback.** No external IPC for approvals.
- **DI factory pattern.** Every handler is a `createX({deps}) → fn|object` factory. Closure-by-value at call time means main()'s wiring order matters — covered by a [boot-smoke test](../tests/boot-smoke.test.js) that catches wire-order bugs in CI before they reach prod.
- **Modular layout** (post-0.9.0 cleanup):
  - `lib/sdk/` — SDK process manager, options builder, lifecycle callbacks
  - `lib/handlers/` — per-handler factories (autosteer, abort, approvals, slash-commands, dispatcher, poll, voice, …)
  - `lib/db.js` + `lib/db/auto-resume.js` — storage layer
  - `lib/telegram/` — chunk, deliver, format, display-hint
  - `lib/agents/loader.js` — per-chat agent + plugin resolution
  - `lib/approvals/` — store + UI builders
  - `lib/ipc/` — server, client, file-validator
  - `lib/error-classify.js` — kind-based error → user message mapping
- **Test coverage**: 1605 unit tests, 25 test files, native `node:test` runner. No external services in test runs.

---

## Versioning + provenance

- 0.4.0 — first public release (single-bot)
- 0.5.x — multi-bot, per-chat sessions, per-bot DB
- 0.6.0 — attachments table (replaces JSON blob)
- 0.7.x — error classifier, transient retry, FTS, status reactions
- 0.8.0 — Claude Agent SDK migration (long-lived Query, in-process canUseTool, mid-turn steer)
- 0.9.0 — cleanup branch (extract 13+ handler factories from polygram.js, +763 unit tests, security hardening)

The `0.9.0-cleanup` branch is what's documented above. See `docs/0.9.0-cleanup-plan.md` for the cleanup history; the head of the branch is what ships under `next` on npm.
