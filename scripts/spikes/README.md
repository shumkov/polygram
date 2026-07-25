# Real-Claude compatibility gates

These scripts exercise the installed Claude executable and are not run
by `npm test`: they require authenticated Claude access, tmux for CLI
scenarios, and API tokens.

## Pinned-version matrix

`claude-2.1.220-matrix.json` is the auditable old/new contract. It
keeps the adapter comparison on `claude-sonnet-4-6` at medium effort,
runs every `2.1.173` comparator before `2.1.220`, and finishes with a
candidate-only projection proving that `opus` resolves to
`claude-opus-5`.

Preserve and attest the old executable outside both mutable binary
trees before running the candidate. Then run:

```sh
node scripts/spikes/run-claude-gate-matrix.mjs \
  --old-bin /absolute/path/to/claude-2.1.173 \
  --candidate-bin /absolute/path/to/claude-2.1.220 \
  --artifact-base /absolute/private/artifact-directory
```

The runner stops on the first `FAIL` or `BLOCKED` cell. Use
`--version old|candidate` and `--scenario <id>` only for diagnosis or
an explicit rerun; a filtered summary is marked non-authoritative.
The artifact base must be a dedicated absolute directory with mode 0700;
the runner never changes permissions on an existing directory.

After reviewing and accepting a complete authoritative `PASS`, delete
the private evidence while retaining each `sanitized-result.json` and
the matrix summary. The acceptance pass also removes the isolated gate
sessions from Claude's external `~/.claude/projects/` store; their exact
gate-owned cwds are recorded privately and preflighted before deletion:

```sh
node scripts/spikes/run-claude-gate-matrix.mjs \
  --artifact-base /absolute/private/artifact-directory \
  --accept-run <run-prefix>
```

The matrix covers:

- current Orchestra `CliProcess` readiness, reply, fold/queue,
  multiline input, interruption, warm continuation, and file reply;
- native Workflow direct delivery and forced direct-failure fallback
  after launch-turn closure, with foreign-topic checks;
- delayed MCP foreground behavior on `2.1.173` and native
  auto-background completion on `2.1.220`;
- SDK PostToolBatch, subagent attribution, resume, compaction, and
  tool-less completion;
- candidate worker-wrapper provenance and the separate Opus 5
  production-default projection. The public SDK does not emit the Workflow
  size default, so that projection binds the documented value to semantic
  anchors in the exact SHA-attested candidate executable.

For every old/new cell, the runner also compares privacy-safe normalized
lifecycle shapes. Hook fields, queue operations, task-notification
provenance, ancestry shapes, and pivotal event ordering must match; any
unreviewed lifecycle difference fails the pair.

Every run requires `CLAUDE_GATE_BIN` and
`CLAUDE_GATE_EXPECTED_VERSION`; the matrix runner supplies those plus
unique run ids and both CLI/SDK selectors. Candidate runs also use
`CLAUDE_CODE_PROCESS_WRAPPER` to attest Claude self-spawns.

## Other operational spikes

These remain standalone and are not part of the pinned-version
compatibility matrix:

```sh
node scripts/spikes/auth-expired.mjs  # DESTRUCTIVE: revokes OAuth
node scripts/spikes/boot-replay.mjs   # DAEMON ONLY: kill mid-turn + restart
```

Conventions:

- Each script prints **PASS** or **FAIL** at the end and `process.exit`s
  with 0 / 1 accordingly.
- Reviewable results contain event shapes, counts, hashes, versions,
  and checksums only. Raw streams and session files stay mode 0600
  beneath mode-0700 run directories.
- Side-effects (cwds, OAuth token state) are documented in the file
  header.
- Tests that mutate production state (auth-expired, boot-replay) are
  marked DESTRUCTIVE and require explicit confirmation.
