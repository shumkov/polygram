# Spec — Session / artifact garbage collection (#12)

Status: **DRAFT — quantified, not yet implemented.** Task #12 stays in TODO.
Origin: "#12 cleanup accumulated tmux + Claude sessions (fleet)." Investigation (2026-06-17, against the shumabit VPS — the clean bot-only instance) reframed the problem: **tmux is not the leak; disk artifacts are.**

## 1. Quantified findings (shumabit VPS, bot-only user — clean measurement)

| Source | Volume | Rate | Owner | Severity |
|---|---|---|---|---|
| **Claude JSONL transcripts** (`~/.claude/projects/*/*.jsonl` + nested `subagents/agent-*.jsonl`) | **654 files / 610 MB**, only **20** referenced by live `sessions` rows → **~97% orphaned** | ~11.5 MB/day; oldest 53d (2026-04-25) | polygram-adjacent (Claude's files) | 🔴 biggest byte leak |
| **WhatsApp Baileys auth** (`~/.whatsapp-channel/.baileys_auth`) | **887 files** (3.7 MB) — **811 `pre-key-*.json`** in ~9 days (~90/day) | unbounded file count → slow Baileys boot (re-reads dir) | **shumabit-claude repo** (not polygram) | 🟠 file-count leak, delicate (auth state) |
| **tmux sessions** (`polygram-<bot>-*`) | **0 live orphans**; 6 cli + 11 sdk in table | bounded by LRU (`maxWarmProcesses:30`) + boot-sweep | polygram | 🟢 not leaking |

shumorobot (Mac) was checked but is a poor measurement: too low-traffic (3 sessions, 0 evictions/24h) to leak tmux, and its JSONLs spawn into cwds (`~`, `~/Music/curator`) **shared with the user's own interactive Claude Code sessions** — so a dir-based GC there would delete the user's work. Mac GC must be session-id-targeted, never dir-based.

## 2. Why Claude's built-in cleanup isn't saving us
Claude Code has `cleanupPeriodDays` (default 30d) that deletes transcripts **at `claude` startup** by mtime. It's not firing here because polygram's warm SDK processes **stay alive for days and *resume*** rather than restart — the startup cleanup almost never runs. It's also not configured anywhere (`~/.claude/settings.json` has no key). So the retention exists but the trigger doesn't fit a long-lived daemon. → polygram (or a cron) must drive the sweep on a timer.

## 3. Design (polygram-owned, ships fleet-wide)

### 3.1 Claude JSONL sweep (the high-value win)
A background sweep (boot + interval, mirrors `lib/db/secret-sweep.js` + `lib/db/events-retention.js`):
- **Live-set:** union of `claude_session_id` across all bot DBs' `sessions` tables (the only ids polygram ever `--resume`s).
- **Delete criterion:** a transcript (top-level `<id>.jsonl` or `<id>/` subagent dir) is removed iff `mtime > retentionDays` **AND** `id ∉ live-set`. Grace (recency) covers in-flight sessions not yet upserted and any actively-resumed chain (resume touches the chain's mtime).
- **Safety invariants:**
  1. Never delete a transcript whose id is a live `claude_session_id` (would break `--resume`).
  2. Never delete by directory on a host where the bot shares a cwd with a human user (Mac) — only by id-match.
  3. Default DISABLED + dryRun-on (like secret-sweep); log `scanned / would-delete / bytes`.
- **Config:** `defaults.session_gc = { enabled, dryRun, retentionDays (default 30, matching Claude's own), intervalMs (6h) }`.
- **Open question:** ancestor-chain safety — if a live session resumed from an older id whose JSONL is now >retentionDays and not in the table, does deleting it truncate resume history? Claude's own 30d default implies ≥30d is safe; below 30d, parse parent lineage or keep ≥30d only. Resolve before enabling <30d.

### 3.2 tmux untracked-reaper (cheap defense-in-depth)
Interval sweep that kills `polygram-<bot>-*` tmux sessions **not present in the live `procs` map** (an evicted-but-not-killed leftover). Narrow, can't touch a live chat. Low priority — steady-state shows 0 orphans; this only guards long-uptime daemons against a `killSession`-failure edge.

### 3.3 Out of scope: Baileys
Lives in the **shumabit-claude repo's WhatsApp channel code**, not polygram, and is the most delicate (deleting an unconsumed `pre-key-*` or a live `session-*` breaks E2E / forces re-link; `creds.json` is sacred). Correct fix is at the Baileys integration layer (prune consumed pre-keys via Baileys' own key-store API), filed as separate shumabit-claude work — **not** a blind file sweep.

## 4. Test plan
- live-set built from multiple bot DBs; a transcript whose id is live is NEVER selected (even if old).
- mtime > retention AND not-live → selected; mtime < retention → kept; live + old → kept.
- subagent dir handling (delete `<id>/` only when parent id not live + old).
- dryRun deletes nothing, reports accurate count + bytes.
- idempotent re-run; tolerates missing dir / unreadable file.
- (tmux) untracked session reaped; a session in `procs` is never reaped.

## 5. Rollout
1. Implement sweep (pure path-selection module + thin polygram wiring) + tests + review (data-safety lens — this DELETES files).
2. Ship disabled + dryRun; review the dry-run "would-delete" log against prod.
3. Enable enforcement; confirm reclaim + that live sessions still `--resume`.

## 6. Interim action taken
A **one-time manual cleanup** of orphaned Claude JSONLs was run on the shumabit VPS on 2026-06-17 (archive-then-delete, criterion: not-in-live-set AND mtime > 14d) to reclaim the standing 610 MB while this spec awaits implementation. See the session log / backups dir for the archive. The recurring sweep (§3.1) is still needed so it doesn't re-accumulate.
