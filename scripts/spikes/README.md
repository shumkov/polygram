# Real-Claude compatibility gates

These scripts exercise the installed Claude executable and are not run
by `npm test`: they require authenticated Claude access, tmux for CLI
scenarios, and API tokens.

## Pinned-version matrix

`claude-2.1.283-matrix.json` is the auditable old/new contract. It
keeps the adapter comparison on `claude-sonnet-4-6` at medium effort,
runs every `2.1.220` comparator before `2.1.283`, and finishes with two
candidate-only cells: a projection proving that `opus` resolves to
`claude-opus-5-5`, and the system-prompt snapshot contract.

Behaviour that legitimately differs between CLI releases is declared per
attested CLI version under `expectations` (wrapper provenance, delayed-MCP
modes with and without the auto-background opt-in, subagent `task_updated` count, CLI-contract `task_reminder` count,
the `opus` resolution, and the Workflow size default with the byte anchors
that prove it in that exact binary). Every cell is judged by the entry for
the version its executable attested, never by whether it sits on the old or
candidate side. A version without an entry blocks the matrix before any
run starts. Moving the pin means adding the new version's entry and
dropping the one that is no longer compared.

The Agent SDK is held constant across both sides: every SDK cell runs the
installed `@anthropic-ai/claude-agent-sdk` (`sdkVersion` in the manifest,
checked against the installed package by `npm test`) and varies only
`pathToClaudeCodeExecutable`. The matrix therefore compares CLI versions,
not SDK versions.

Preserve and attest the old executable outside both mutable binary
trees before running the candidate. Then run:

```sh
node scripts/spikes/run-claude-gate-matrix.mjs \
  --old-bin /absolute/path/to/claude-2.1.220 \
  --candidate-bin /absolute/path/to/claude-2.1.283 \
  --artifact-base /absolute/private/artifact-directory
```

The runner stops on the first `FAIL` or `BLOCKED` cell. A driver that
proves its own precondition absent exits 3 with a `NOT-APPLICABLE`
sanitized result; that cell is reported separately (`notApplicableCount`),
does not stop the run, and is accepted only for the snapshot cell. Use
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
  --old-bin /absolute/path/to/claude-2.1.220 \
  --candidate-bin /absolute/path/to/claude-2.1.283 \
  --artifact-base /absolute/private/artifact-directory \
  --accept-run <run-prefix>
```

The matrix covers:

- current Orchestra `CliProcess` readiness, reply, fold/queue,
  multiline input, interruption, warm continuation, and file reply;
- native Workflow direct delivery and forced direct-failure fallback
  after launch-turn closure, with foreign-topic checks;
- delayed MCP twice per version: without `CLAUDE_AUTO_BACKGROUND_TASKS`, the
  path production runs (declared foreground on both `2.1.220` and `2.1.283`),
  and with the opt-in (declared native background). The runner clears any
  inherited value, applies only the manifest's opt-in (which must be common
  to both sides), derives each driver's `--expected-mode` from the attested
  version's expectations, and correlates the task/tool-use lifecycle;
- SDK PostToolBatch, subagent attribution, resume, compaction, and
  tool-less completion;
- worker-wrapper provenance on both sides and the separate Opus 5.5
  production-default projection. The public SDK does not emit the Workflow
  size default, so that projection binds the declared value to the
  version's semantic anchors in the exact SHA-attested candidate
  executable. From `2.1.283` the default is plan-dependent (`medium`, or
  `small` on Pro plans); the anchors cover both the documented text and the
  Pro branch. The expected `medium` assumes the gate account is not on a Pro
  plan; a run from a Pro account would need `small` declared instead;
- the system-prompt snapshot contract through Orchestra's `CliProcess`.
  Each leg spawns with display hint A, answers one turn, strictly resumes
  the same session with display hint B, and reports which hint the prompt
  carries. `system-prompt-snapshot-launcher.mjs` rewrites Orchestra's
  `--system-prompt-snapshot off` to `on` before exec-ing the provenance
  wrapper. The control leg records and resumes with the snapshot on. The
  test leg records with it on, then resumes through the normal launch
  (snapshot off), as a restarted production chat does, and must see B. The
  cell passes when the control still sees A; when the control also sees B,
  recording is not active for the account and the cell is `NOT-APPLICABLE`
  instead of `PASS`. Both transcripts and the leg markers stay private, and
  the matrix re-derives both observed hints from them on validation and
  acceptance.

For every old/new cell, the runner also compares privacy-safe normalized
lifecycle evidence. Cells use strict shape equality by default. The CLI
contract runs twice per version and compares its same-version results before
all four old/new pairings. Each run must first match the manifest's exact
35-row session-pivotal and 21-row transport-hook baselines. The
session-pivotal projection leaves out `total_tokens_reminder` attachments:
the service injects these context-usage reminders a varying number of times
even on an unchanged binary, and nothing downstream reads them. Every other
attachment stays pivotal.
Rows a version adds at fixed places in a baseline are declared under that
version's `projectedInsertions`, keyed by the policy's `baselineId`, as exact
index and record pairs. Identical rows elsewhere (every turn has a
`UserPromptSubmit`) make count-based removal ambiguous, so each declared row
must sit at exactly its index before it is removed; a missing, moved, renamed,
duplicated, or undeclared row fails. `2.1.283` declares its five session-start
attachments, `environment` and `model` after the first prompt,
`deferred_tools_record` after the first turn's context attachments, and the
`UserPromptSubmit` it now fires for the prompt folded into the third CLI turn.
`2.1.220` declares none. The CLI rows were observed in an authoritative run;
the Workflow rows are inferred from them (with `deferred_tools_record` after
`command_permissions`) and fail closed until a run confirms them. Each run may then
remove exactly the number of reviewed `task_reminder` rows its version declares
(one on both `2.1.220` and `2.1.283`); either version may also remove at most
one interrupt-correlated `hook_cancelled`. One source-bound composite proof must
show that every removed row's parser push is empty, every retained input line
emits the same event batch, and final flush is unchanged. The runner
independently checks the private transcript hash. Unknown or malformed
normalized rows, missing/false/stale proof evidence, and any other projected
difference fail the gate.

Every run requires `CLAUDE_GATE_BIN` and
`CLAUDE_GATE_EXPECTED_VERSION`; the matrix runner supplies those plus
unique run ids and both CLI/SDK selectors. Versions that declare
`wrapperRequired` also use `CLAUDE_CODE_PROCESS_WRAPPER` to attest Claude
self-spawns.

## Other operational spikes

These remain standalone and are not part of the pinned-version
compatibility matrix:

```sh
CLAUDE_GATE_BIN=/absolute/path/to/the/pinned/claude \
CLAUDE_GATE_EXPECTED_VERSION=x.y.z \
CLAUDE_GATE_ARTIFACT_BASE=/absolute/private/artifact-directory \
node scripts/spikes/clean-restart-resume.mjs
node scripts/spikes/auth-expired.mjs  # DESTRUCTIVE: revokes OAuth
node scripts/spikes/boot-replay.mjs   # DAEMON ONLY: kill mid-turn + restart
```

`clean-restart-resume.mjs` is the opt-in, authenticated gate for the
clean-restart resume-plus-`continue` rollout. It verifies the exact installed
Orchestra contract, retires a live eight-step CLI turn after step five, strictly
resumes the same Claude session, and checks that only steps six through eight
run. It also rejects reply-bearing output, pending/ambiguous delivery, and a
missing JSONL. Config drift is deterministic Polygram policy covered by the
clean-resume coordinator and source-wiring tests. The gate consumes model usage
and leaves private evidence beneath the supplied mode-0700 artifact directory.

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
