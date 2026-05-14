# polygram — TODO / follow-ups

Tracking known-but-deferred work. Anything that surfaced during a release but didn't block shipping. Not a roadmap for new features — see milestones / the design docs for that.

---

## Bug class follow-ups (candidates for 0.9.1)

### `proc.stdin` EIO storm on kickstart (regression from rc.38 fix)

**Symptom**: every `launchctl kickstart -k` against shumabit emits ~100 `uncaught-exception: write EIO` events, then `panic-exit` fires (rate-limited bailout). launchd respawns via `Crashed=true`, so the daemon recovers — but the kickstart is noisy.

**History**: rc.38 added `proc.stdin.on('error')` to suppress these. Confirmed working in 0.8.0. Something in the 0.9.0-cleanup refactor (commit 19 extracting `lib/sdk/callbacks.js`, or one of the pm-sdk extractions) lost the handler.

**Repro**: `launchctl kickstart -k gui/503/com.shumabit.claude-sessions` while shumabit has an in-flight turn with an active SDK subprocess. Check shumabit events table for `uncaught-exception` events emitted in the second around the kickstart.

**Fix direction**: grep for `proc.stdin` / `stdinHandler` in `lib/sdk/process-manager.js` and adjacent. Confirm the error handler is still installed on every spawned subprocess. May need a test that simulates SIGTERM mid-stdin-write.

**Severity**: cosmetic (KeepAlive recovers), but every deploy generates ~100 monitor alerts. Worth fixing for cleanliness.

---

### Format-aware chunker (true fix for HTML inflation)

**Current state**: rc.6 reduced `TG_CHUNK_BUDGET = 3500` (from 4096) to leave HTML headroom for `toTelegramHtml` inflation. Approximation — works for ~99% of natural-language inputs but pathological code-heavy text can still inflate past 4096 even when raw is 3500.

**Real fix**: chunker should accept a `formatter` callback and measure POST-format size when deciding break points. Currently it measures raw markdown length only.

**Anti-regression test**: `tests/telegram-chunk.test.js` has a test pinning the bug class at limit=4096. If a future format-aware chunker passes that test, `TG_CHUNK_BUDGET` can be raised back to 4096.

**Severity**: low — the budget approximation handles real production traffic. Worth doing for correctness + to remove the magic-number 3500.

---

### `assembleHandlers()` refactor (eliminate deferred-wire placeholders)

**Current state**: polygram.js has ~17 `let X = null` placeholders for handler factories that get wired late in main() (after `bot = createBot(...)` and `pm = new ProcessManagerSdk(...)` are alive). v4 architecture review flagged this as a code smell — the placeholders are a future-bug magnet (cf. rc.3 boot blocker, rc.7 wedged-session — both wire-order class).

**Real fix**: extract an `assembleHandlers({db, bot, pm, ...})` function that constructs all handlers in one go and returns them, eliminating the `let` placeholders. Boot wire-order becomes structurally enforced.

**Severity**: low — boot-smoke test guards against the regressions this would prevent. Cosmetic cleanup.

---

## Feature follow-ups

### Hot-reload agent files without `/reload`

**Current**: editing `~/.claude/agents/<name>.md` requires `/reload` in chat (or cold spawn) to pick up changes.

**Real fix**: file-watcher on agent dirs (chokidar), invalidate agent-loader cache on change.

**Severity**: minor UX win; current `/reload` is fine.

---

### Operator approval-fire-and-forget rejection

When approval card is posted to admin chat and admin doesn't respond, the 5-min sweeper kicks in. But the REQUESTER chat sees nothing in the meantime — the SDK is just paused. A "🕐 waiting on approval from operator" stub in the requester chat would be nice.

**Severity**: minor UX.

---

## Doc / promote follow-ups

### README polish

The README is 424 lines and pre-dates the 0.9.0 cleanup. Needs:
- Test count: 643 → 1618
- Relation-to-existing-projects table modernized
- SDK migration mention (0.8.0)
- Autosteer / edit-correction / wedged-session / status-reactions mentions
- Pointers to the four new docs (`docs/FEATURES.md`, `docs/COMPETITORS.md`, `docs/VS-OPENCLAW.md`, `docs/VS-OFFICIAL-PLUGIN.md`)
- Trimmed: the long sections on config / cron / approvals should move to dedicated `docs/CONFIGURATION.md` etc.

### Promote 0.9.0

After the README is polished. Author plans to promote — exact channels TBD.

---

## Next milestone

### 0.10.0 — process manager abstraction + tmux backend

See [docs/0.10.0-process-manager-abstraction-plan.md](docs/0.10.0-process-manager-abstraction-plan.md) for the comprehensive spec.

Summary: extract `ProcessManager` interface, keep SDK as default implementation, add `ProcessManagerTmux` that runs Claude Code CLI under tmux sessions. Per-chat / per-topic selection via config.
