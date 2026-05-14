# polygram — competitor landscape

Where polygram fits in the Telegram-bot-on-top-of-Claude-Code space. Honest comparisons; the best tool depends on what you're trying to do.

---

## TL;DR — pick by use case

| Use case | Best fit |
|----------|----------|
| Single chat, single user, just want to talk to Claude from your phone | `telegram@claude-plugins-official` |
| One bot, one community, single shared session | `claudegram` |
| Many bots, isolated git worktrees, you live in worktrees | `ClaudeBot` |
| Many bots × many chats, each chat its own session, transcript persists, cron writes to it, ops at OpenClaw scale | **polygram** |
| You're migrating from OpenClaw and don't want to relearn the model | **polygram** |

Detailed breakdown below.

---

## The four projects

| Project | Status | Multi-bot | Session unit | Persistence | Active dev (early 2026) |
|---------|--------|-----------|--------------|-------------|-------------------------|
| `telegram@claude-plugins-official` ([Anthropic](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)) | Official, in `claude-plugins-official` org | ❌ one per Claude Code session | One session per Claude Code session | Session memory only (dies with `/exit`) | Yes |
| `ClaudeBot` ([Jeffrey0117](https://github.com/Jeffrey0117/ClaudeBot)) | Community, MIT | ✅ via git worktrees (one per bot) | Worktree path | `.sessions.json` file | Sporadic |
| `claudegram` ([NachoSEO](https://github.com/NachoSEO/claudegram)) | Community, MIT | ❌ one per install | Chat (+ optional forum topic) | JSON files | Sporadic |
| **polygram** ([shumkov](https://github.com/shumkov/polygram)) | Community, MIT, used in production by author | ✅ one Node process per bot | Chat (+ optional forum topic) | SQLite WAL + FTS5 | Active |

---

## `telegram@claude-plugins-official` — the official plugin

The Anthropic-maintained Telegram plugin shipped via `claude-plugins-official`. It's the official "Claude Code in Telegram" experience.

**Strengths**
- Official, supported, easy install (`/plugin install telegram@claude-plugins-official`).
- Tight integration with the Claude Code CLI lifecycle.
- Zero config beyond the bot token + chat allowlist.
- Authoritative reference for what an "official" Telegram bot looks like.

**Limitations vs polygram**
- **One session, full stop.** All Telegram chats hitting the bot share the same Claude Code session. A customer-support chat and an ops chat see each other's context.
- **Dies with `/exit`.** The bot lives inside an open Claude Code session. Close the session, the bot dies. No way to run it as a daemon for cron-driven workflows.
- **No per-chat persistence.** No transcript DB. Memory is whatever Claude has in context for THIS session, gone on `/exit`.
- **No multi-bot.** One `claude` instance hosts one bot. Running 3 bots = 3 always-on Claude Code terminals.
- **No approval flow.** Tool calls run with whatever permissions Claude has; no out-of-band human-in-the-loop confirmation.
- **No autosteer / edit-correction / status reactions / streaming bubble edits.** The plugin is designed as a chat front-end, not a full-fledged conversational system.

**Migrate to polygram if** you have multiple bots, need transcripts to survive restarts, want approvals on destructive tool calls, or used OpenClaw and miss the per-chat session ergonomics.

**Stay on the official plugin if** you have one bot, one chat, mostly sit at your laptop with Claude Code running anyway, and just want a Telegram window onto the same session.

For the head-to-head, see [VS-OFFICIAL-PLUGIN.md](VS-OFFICIAL-PLUGIN.md).

---

## `ClaudeBot` (Jeffrey0117)

Community project. Telegram → multiple Claude Code instances, one per git worktree.

**Strengths**
- Multi-bot via git worktrees — clean isolation between codebases.
- Lightweight, easy to reason about.
- Worktree-per-bot makes "agent A works on repo X, agent B on repo Y" feel native.

**Limitations vs polygram**
- **Session unit is the worktree, not the chat.** All chats hitting bot A share ONE session. A customer chat and an ops chat in the same worktree share memory.
- **`.sessions.json` for persistence.** No SQL, no FTS, no `events` table. Forensic queries ("what did partner Maria send last Tuesday") are not first-class.
- **No transcript writes from cron.** Cron scripts that send to Telegram bypass the bot, so the JSON record is incomplete.
- **No approval flow, no IPC, no doctor command.**
- **No autosteer / edit-correction / status reactions.**

**Choose ClaudeBot if** you live in git worktrees, run a small number of bots tied to specific repos, and don't have cross-chat ops needs. The worktree-per-bot pattern is genuinely good for code-focused workflows.

**Choose polygram if** you have many chats inside one bot (groups, partner DMs, ops topics) that each need their own session, or you need the SQLite + FTS + cron-IPC plumbing.

---

## `claudegram` (NachoSEO)

Community project. Closer to polygram in spirit — chat (and optional forum topic) is the session unit.

**Strengths**
- Right session model: chat (+ topic) gets its own context. Mirrors what OpenClaw users expect.
- Simple JSON-file persistence, easy to inspect by hand.
- Works for one bot.

**Limitations vs polygram**
- **One bot per install.** N bots = N copies of the infra (separate node processes, separate config trees, separate JSON files). Doesn't scale to "I run a customer-facing bot AND an internal ops bot AND a partner bot."
- **JSON file persistence.** No FTS, no concurrent reader-without-blocking-writer (WAL), no migrations. Crash mid-write = corruption risk; reader during write = inconsistency risk.
- **No write-before-send atomicity.** A crash mid-`sendMessage` can leave the file showing "sent" with no actual Telegram delivery (or vice versa).
- **No cron IPC, no approval flow, no doctor command.**

**Choose claudegram if** you run exactly one bot, want minimal infra, and are happy with JSON files for persistence.

**Choose polygram if** you anticipate running more than one bot, need durable persistence under load, or want the operational toolkit (doctor, IPC, FTS, telemetry).

---

## OpenClaw (legacy)

Worth mentioning because polygram exists specifically because OpenClaw users lost their Claude integration.

**Status**: OpenClaw no longer supports Claude. The project still runs on other models. Per-chat sessions, persistent memory, cron writes to transcript — the original shape this project preserves.

**Why this matters for polygram**: every architectural choice in polygram is calibrated against "would an OpenClaw migrator find this familiar?" — the answer is "yes" for chat-as-session-unit, persistent transcripts, cron writing through the same pipeline, and admin/partner bot separation.

**Choose OpenClaw if** you're happy on a non-Claude model and want to stay there.

**Choose polygram if** you specifically want Claude Code while keeping OpenClaw's ergonomics. That's the entire premise.

---

## "Just write your own with grammy + claude CLI"

Tempting. Plenty of writeups exist. Reasonable for a tiny single-purpose script.

**What you'll re-implement** if your needs grow past "talk to my bot from my phone":

1. Per-chat Claude session resume (`--resume <id>`)
2. LRU eviction so you don't keep N idle Claude processes warm forever
3. Write-before-send atomicity (so a crash doesn't lose a half-sent message)
4. Boot replay for in-flight turns (the user IS still waiting — silently dropping is a bug)
5. Inline-keyboard approvals with token-protected callbacks
6. Voice transcription pipeline (Whisper API or local)
7. Multi-photo album coalescing (Telegram delivers each photo separately)
8. Prompt-injection hardening (`<untrusted-input>` + xml escape)
9. Streaming bubble edits with throttle + debounce (so users see progress, but Telegram doesn't 429 you)
10. Status reactions state machine (🤔 → 🤓 → 🥱 → 😨, cleared on turn end)
11. Autosteer (mid-turn message merge into in-flight turn)
12. Edit-correction injection (typo fixes mid-turn)
13. Auto-resume on idle timeout (wedged tool calls)
14. SDK lifecycle callbacks (compact-boundary, onAssistantMessageStart, parent_tool_use_id filter)
15. Cross-bot ownership check + IPC method allowlist (so cron bot A can't post to bot B's chat)
16. SQLite + WAL + FTS5 for transcript queryability
17. polygram-doctor health checks
18. Crash-resilient handler lifecycle with `handler_status` state machine

Every one of those is a meaningful incident waiting to happen. polygram has all 18, exercised by 1605 unit tests, with the regressions visible in the `events` table.

**Roll your own if** you want a learning project or have very specific needs nothing else covers.

**Choose polygram if** you'd rather skip rebuilding 1.5 years of incident-driven hardening from scratch.

---

## Where polygram is NOT the right choice

Honest non-fits.

- **You need horizontal scale-out** (bot A in Bangkok, bot B on AWS). Polygram is one machine, shared filesystem. Swap SQLite for a networked DB and the architecture survives, but that's not on the roadmap.
- **You want a non-Claude model.** Polygram is Claude Code only. No abstraction over other AIs.
- **You need Linux systemd units out of the box.** macOS LaunchAgent plists ship; systemd units are easy to adapt but not bundled.
- **You want a hosted SaaS.** Polygram is self-hosted, runs on your machine.

---

## Stability + maturity

Rough scoring. "✅" = production-ready in author's experience, "△" = exists but rough edges, "—" = not applicable.

| Property | official | ClaudeBot | claudegram | polygram |
|----------|---------:|----------:|-----------:|---------:|
| First-class crash recovery (boot replay) | — | △ | — | ✅ |
| Per-chat session model | — | — | ✅ | ✅ |
| Multi-bot | — | ✅ | — | ✅ |
| Approval flow (canUseTool) | — | — | — | ✅ |
| Voice transcription | — | — | — | ✅ |
| Album coalescing | — | — | — | ✅ |
| Streaming bubble edits | △ | △ | — | ✅ |
| Status reactions | — | — | — | ✅ |
| Autosteer (mid-turn merge) | — | — | — | ✅ |
| Edit-correction (typo fix mid-turn) | — | — | — | ✅ |
| FTS over transcript | — | — | — | ✅ |
| Cron / external IPC | — | — | — | ✅ |
| Health-check command | — | — | — | ✅ |
| Test suite (count) | — | — | — | 1605 |

---

## When this comparison is wrong

Project comparisons rot. If `ClaudeBot` ships a worktree-aware approval flow tomorrow, this table is outdated. If `claudegram` adds SQLite, the persistence column changes. If the official plugin grows multi-bot support, polygram's main edge narrows.

This file was last updated against polygram 0.9.0-rc.5 (2026-05-08). PRs welcome to keep the competitor columns honest.
