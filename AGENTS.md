# AGENTS.md — context for agents working on polygram

Project: polygram — Telegram daemon for Claude Code that preserves
the OpenClaw per-chat session model. Targets two backends:

- **SDK backend** — Orchestra's `SdkProcess`, configured through
  `lib/sdk/build-options.js`, uses the Anthropic Agent SDK runtime.
- **CLI backend** — Orchestra's `CliProcess` hosts the real `claude`
  CLI in tmux and connects it to Telegram through the Channels MCP
  bridge and hook NDJSON. It also observes the per-session JSONL log.
  This remains brittle because those CLI surfaces are not public
  compatibility contracts.

## Pinned claude CLI version

> **The CLI backend is tightly coupled to ONE specific
> `claude` CLI version. Polygram's CI / spikes / production
> hosts MUST run that exact version.**

The CLI backend reads internal claude artefacts:
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

The version polygram has been validated against is owned by Orchestra.
Search the exact installed dependency for
`CLAUDE_CLI_PINNED_VERSION` in
`node_modules/@shumkov/orchestra/lib/claude-bin.js`.

### How the pin is enforced (hard pin, since 0.10.0-rc.19)

Polygram does **not** spawn the bare `claude` on `$PATH`. Orchestra's
`ensureVendoredClaudeBin()` resolves the exact pin, copies it from
`~/.local/share/claude/versions/<version>` into Polygram's
`~/.local/share/polygram/claude-bin/<version>` vendor directory, and
returns that absolute path to `CliProcess`. The separate vendor copy is
required because Claude's updater both moves the active symlink and
prunes older versioned binaries.

Override CLI selection with `ORCHESTRA_CLAUDE_BIN`. Polygram also uses
`POLYGRAM_CLAUDE_BIN` as the SDK query's
`pathToClaudeCodeExecutable`. Compatibility gates set both selectors
to the same attested path. Daemon boot logs the exact vendored binary
used by CLI-backed chats; SDK-backed chats remain available if CLI
preflight fails.

### Upgrade procedure (separate, deliberate process)

Upgrading the pinned claude CLI version is **NOT a routine task** and
**MUST NOT happen incidentally** as part of unrelated work. It is its
own change with its own validation gate:

1. **Open a tracking issue.** Title: `bump claude CLI vX.Y.Z → vX.Y.Z+1`.
2. **Read the CLI release notes** for the candidate version. Look for
   any change in: hooks, settings.json schema, JSONL event format,
   queue semantics, `--agent` flag behaviour, banner/READY strings,
   permission-mode UI, paste handling.
3. **Preserve the current binary offline.** Copy the host-specific
   current pin outside both Claude's versions tree and Polygram's
   garbage-collected vendor tree; verify `--version` and SHA-256.
4. **Run the checked old/new matrix on one gate commit before editing
   the pin:**
   ```sh
   node scripts/spikes/run-claude-gate-matrix.mjs \
     --old-bin /absolute/path/to/old \
     --candidate-bin /absolute/path/to/candidate \
     --artifact-base /private/mode-0700/directory
   ```
   Every applicable cell must pass. Normalize and compare the captured
   session, hook, queue, task-notification, Stop, reply, and worker
   evidence. An unexplained lifecycle change blocks the bump.
5. **Update `CLAUDE_CLI_PINNED_VERSION`** in Orchestra's
   `lib/claude-bin.js`, then release and consume the new exact Orchestra
   version through separately reviewable PRs.
6. **Test in staging** for at least 24h on shumorobot before
   shumabit / umi-assistant. Watch the events DB for
   `autosteer-match-miss`, `autonomous-wakeup-message`, and
   `tool-only-completion` events — these are the leading
   indicators of TUI-format drift.
7. **Document the bump** in the release commit message. Include: old
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
- `scripts/spikes/*.mjs` — real-Claude / real-SDK gates. NOT in CI.
  Run the version-controlled matrix before bumping the CLI pin; see
  `scripts/spikes/README.md`.

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
