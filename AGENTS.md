# AGENTS.md — context for agents working on polygram

Project: polygram — Telegram daemon for Claude Code that preserves
the OpenClaw per-chat session model. Targets two backends:

- **SDK ProcessManager** (`lib/process/sdk-process.js`) — first-class
  Anthropic SDK runtime. Stable contract.
- **tmux backend** (`lib/process/tmux-process.js` + `lib/tmux/`) —
  hosts the real `claude` CLI inside a tmux session and observes
  behaviour via capture-pane + the per-session JSONL log. Brittle
  by nature: depends on undocumented internals of the CLI's JSONL
  format, queue mechanics, and TUI banner shape.

## Pinned claude CLI version

> **The tmux backend is tightly coupled to ONE specific
> `claude` CLI version. Polygram's CI / spikes / production
> hosts MUST run that exact version.**

The tmux backend reads internal claude artefacts:
- Per-session JSONL events under `~/.claude/projects/<encoded-cwd>/`
- Queue-operation enqueue / dequeue / remove events
- `attachment.type='queued_command'` for fold detection
- TUI banner ASCII art (`▐▛███▜▌` / `▝▜█████▛▘`) used to gate
  startup readiness
- READY hint strings (`? for shortcuts`, `accept edits on`,
  `bypass permissions on`)
- The `MULTILINE_SEPARATOR = ' / '` paste convention
- `stop_reason` values in assistant messages

Any of these CAN change in a new claude CLI release. The rc.7→rc.15
saga (May 2026) is direct evidence: every rc shipped fixes that were
needed because the TUI's behaviour, not polygram's logic, drifted.

### Current pinned version

The version polygram has been validated against is recorded in the
TmuxProcess source — search for `CLAUDE_CLI_PINNED_VERSION` in
`lib/process/tmux-process.js`.

### How the pin is enforced (hard pin, since 0.10.0-rc.19)

Polygram does **not** spawn the bare `claude` on `$PATH`. The claude
CLI installs each version as a standalone binary at
`~/.local/share/claude/versions/<version>` and points
`~/.local/bin/claude` (a symlink) at the active one — the CLI's
auto-updater re-points that symlink whenever a new version lands.
A `$PATH` spawn therefore silently drifts (shumorobot 2026-05-16:
the CLI auto-updated 2.1.142 → 2.1.143 between deploys).

`TmuxProcess.start()` resolves the **absolute versioned path** via
`lib/claude-bin.js` (`resolvePinnedClaudeBin`) and spawns that. The
versioned binary is immutable — the updater only adds new files, it
never overwrites an existing one — so the pin holds across CLI
auto-updates. If the pinned binary is missing, `start()` throws
`CLAUDE_BIN_MISSING` with an actionable message (run
`claude install <version>`); SDK-backed chats are unaffected.

Override the resolved path with `POLYGRAM_CLAUDE_BIN` (non-standard
installs, CI, tests). Daemon boot logs the absolute binary the tmux
backend will use.

### Upgrade procedure (separate, deliberate process)

Upgrading the pinned claude CLI version is **NOT a routine task** and
**MUST NOT happen incidentally** as part of unrelated work. It is its
own change with its own validation gate:

1. **Open a tracking issue.** Title: `bump claude CLI vX.Y.Z → vX.Y.Z+1`.
2. **Read the CLI release notes** for the candidate version. Look for
   any change in: hooks, settings.json schema, JSONL event format,
   queue semantics, `--agent` flag behaviour, banner/READY strings,
   permission-mode UI, paste handling.
3. **Update `CLAUDE_CLI_PINNED_VERSION`** in `lib/process/tmux-process.js`
   to the new value (string compare).
4. **Run the full real-claude spike suite** against the new CLI:
   ```sh
   node scripts/spikes/autosteer-tui-real.mjs        # autosteer / multi-msg
   node scripts/spikes/post-tool-batch.mjs            # SDK PostToolBatch
   node scripts/spikes/subagent-task.mjs              # subagent
   node scripts/spikes/session-resume.mjs             # resume
   node scripts/spikes/compact-boundary.mjs           # auto-compact
   node scripts/spikes/tool-less-drain.mjs            # tool-only turns
   ```
   ALL must PASS. Any new failure = a regression introduced by the
   CLI version change. File it as a polygram bug to fix in the
   bump PR.
5. **Diff the JSONL format.** Run `subagent-task.mjs` and
   `post-tool-batch.mjs`, capture the JSONL files for both old and
   new CLI versions, diff. New event types, renamed fields, removed
   fields = behaviour change that the parser
   (`lib/tmux/session-log-parser.js`) may need to handle.
6. **Test in staging** for at least 24h on shumorobot before
   shumabit / umi-assistant. Watch the events DB for
   `autosteer-match-miss`, `autonomous-wakeup-message`, and
   `tool-only-completion` events — these are the leading
   indicators of TUI-format drift.
7. **Document the bump** in the rc commit message. Include: old
   version → new version, summary of CLI release notes that
   could affect us, any code adjustments made.

### Why this discipline

The CLI is upstream code we don't control. The TUI's internals are
not a contract — they can change between versions without notice.
Polygram's tmux backend works by reading those internals; therefore
every CLI version is a potential breaking change.

The discipline above turns "the CLI just updated and prod broke"
(reactive, painful) into "we bumped the pin after running 50
scenarios; here's the release-note diff" (proactive, auditable).

### Hard binary pin — DONE (0.10.0-rc.19)

Polygram spawns the absolute versioned binary (see "How the pin is
enforced" above). A system-wide `claude update` no longer affects
the running daemon — the updater adds a new `versions/<v>` file but
polygram keeps spawning the pinned path.

Background + the options considered:
[`docs/0.10.0-claude-binary-pinning.md`](./docs/0.10.0-claude-binary-pinning.md).

## Test layers

- `npm test` — fast unit + integration tests, no CLI needed, no
  network. CI runs this.
- `scripts/spikes/*.mjs` — real-claude / real-SDK gates. NOT in CI.
  Run before tagging RCs and before bumping the CLI pin.
  - `autosteer-tui-real.mjs` — 50 scenarios for the tmux backend's
    autosteer + multi-msg + paste / queue / fold-vs-new-turn
    behaviour. Authoritative. See
    `docs/0.10.0-spike-leftovers.md` for the rc.15 baseline.

## Deploy

Two production targets — see the `polygram-deploy` skill (in
`~/.claude/skills/polygram-deploy/`) for the canonical procedure.

## See also

- `docs/0.10.0-process-manager-abstraction-plan.md` — the
  SDK ↔ tmux abstraction.
- `docs/0.10.0-spike-leftovers.md` — known leftover bugs after the
  rc.15 release.
- `docs/0.10.0-phase2.6-tier2-findings.md` — early tmux-backend
  findings.
