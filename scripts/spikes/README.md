# Spike scripts (Phase 5.5 gates)

These verify behaviours that Phase 0 deferred and that the rc.6-rc.16
sequence introduced. Each is a standalone Node script — they are NOT
run by `npm test` because most need an authenticated Anthropic SDK
session and burn API tokens.

Run individually:

```sh
node scripts/spikes/post-tool-batch.mjs       # G1 — already validated rc.9
node scripts/spikes/tool-less-drain.mjs       # G2 — rc.14 fallback
node scripts/spikes/compact-boundary.mjs      # G3/G4 — auto-compact
node scripts/spikes/auth-expired.mjs          # G5 — auth UX (DESTRUCTIVE: revokes OAuth)
node scripts/spikes/boot-replay.mjs           # G6 — kill mid-turn + restart (DAEMON ONLY)
node scripts/spikes/subagent-task.mjs         # G7 — Task tool subagent + parent_tool_use_id
node scripts/spikes/session-resume.mjs        # G12 — resume after restart
node scripts/spikes/autosteer-tui-real.mjs    # rc.14 gate — real claude TUI autosteer
```

`autosteer-tui-real.mjs` exists alongside the fast scenario suite
in `tests/autosteer-scenarios.test.js`. The fast suite uses a TUI
simulator (deterministic, runs in CI, no token cost). The spike
checks the simulator's FIDELITY against a real claude TUI:
spawns tmux + claude, drives the same dialog patterns, asserts
the polygram-level event chain (`autosteer-resolution`,
`extra-turn-started`/`reply`, no `autosteer-match-miss`). Cost
~$0.10/run. Run before each rc tag that touches autosteer,
tmux-process, or tmux-runner.

Conventions:

- Each script prints **PASS** or **FAIL** at the end and `process.exit`s
  with 0 / 1 accordingly.
- Side-effects (cwds, OAuth token state) are documented in the file
  header.
- Tests that mutate production state (auth-expired, boot-replay) are
  marked DESTRUCTIVE and require explicit confirmation.

Background: see `docs/0.8.0-sdk-migration-plan.md` §7.1 — Phase 5.5
gate sweep.
