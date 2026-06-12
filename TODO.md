# polygram — TODO / follow-ups

Known-but-deferred work that didn't block shipping. Not a roadmap — see the
design docs and `docs/0.12.0-stable-release-plan.md` for the current release.

> Refreshed 2026-06-12 at 0.12.0-rc.41. The pre-0.10 entries (EIO storm — now
> fixed, the "0.10.0 next milestone" — shipped five milestones ago, the
> 643→1618 test count) were stale and have been removed/reconciled. Suite is
> now **2510 tests**.

---

## Pre-stable (tracked in the release plan)

See `docs/0.12.0-stable-release-plan.md`. Open items there:
- **Health-monitor tuning** (Phase 1b, host-side `shumabit health` job) — stop
  paging on auto-recovered transients; alert only on un-recovered / repeated /
  terminal kinds. The user-facing error copy is already humanized (rc.41).
- **File the upstream resume-race report** (Phase 2a) — see the OPEN entry in
  `docs/0.12.0-known-issues.md` (MCP connect-timeout tears down an
  already-connected transport during `--resume`; 5 samples, root-caused).
- **Branch/worktree consolidation** (Phase 5) — collapse 6 worktrees back to
  `/polygram` on `main`; one fast-forward merge of `0.12.0-cli-driver` lands
  0.11 + 0.12 + 0.13.

## Known upstream (contained, not polygram bugs)

- **Dev-channels resume/MCP-timeout race** — the ~30s startup death; contained
  by auto-retry + delivery watchdog. `docs/0.12.0-known-issues.md` OPEN #1.
- **Verbatim re-delivery** — claude occasionally re-emits a prior reply tool
  call; every polygram-side fix rejected as worse than the symptom.
  `docs/0.12.0-known-issues.md` OPEN #3.

## Post-stable polish (low severity)

- **Format-aware chunker** — `TG_CHUNK_BUDGET=3500` is an approximation for
  HTML inflation; a formatter-aware chunker measuring post-format size would
  let the budget return to 4096. Anti-regression test already in
  `tests/telegram-chunk.test.js`.
- **`assembleHandlers()` refactor** — polygram.js has ~17 `let X = null`
  deferred-wire placeholders (a wire-order-bug magnet — cf. the rc.34 boot
  crash and the 2026-06-12 config-scope bug). Extract a single
  `assembleHandlers({db, bot, pm, …})`. Boot-smoke test guards the regressions
  meanwhile.

## Post-stable features (designs filed, need operator decisions)

- **SessionStart cwd auto-pairing** — `/use <cwd>` to pair without editing
  config.json. `docs/0.12.0-session-start-pair-spec.md` (open questions need a
  decision). ~4h.
- **Context/token observability** — `/context`, `/tail`, 85% proactive push.
  `docs/0.12.0-context-observability-spec.md`. Depends on the pairing infra. ~3h.
- **Hot-reload agent files** — chokidar watch on agent dirs, invalidate the
  loader cache (vs the current `/reload`). Minor.
- **Approval-waiting stub** — a "🕐 waiting on operator approval" line in the
  requester chat while the approval card is pending. Minor UX.

## Doc debt (post-stable)

- **README rewrite** — 424 lines, pre-0.9.0; needs the channels/cli-backend
  story, current test count, and the split into `docs/CONFIGURATION.md` etc.
