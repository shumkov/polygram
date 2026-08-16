# Foreground canary retry-gate fix

Status: implemented, pending live canary validation (2026-08-16)

## Problem

The local foreground deploy canary stores content-free attempt journals. A new
attempt is allowed only after earlier matching attempts are terminal and the
daemon is idle.

The verifier currently qualifies a historical attempt by reusing
`observeTurn()`. That operation correctly requires exactly one post-baseline
message for an active canary, but it is wrong for retry history. Once two
ordinary messages exist after an old journal's baseline, the old journal
becomes `conflict` forever even when both turns completed safely.

This happened during the 0.38.2 Codex foreground canary. The older rejected
journal had two later replied Codex rows; the newer rejected journal had one.
No restart occurred and the daemon was idle, but `--new-attempt` could not
create another journal.

## Chosen approach

Use one frozen current message baseline `F` and require all relevant historical
rows through that point to be durably terminal:

1. Statically validate every journal, phase, and matching receipt/staged-node
   precondition exactly as today.
2. Capture `F = MAX(messages.id)` once.
3. For every matching prior journal with lower cursor `L`, inspect all scoped
   inbound rows where `messages.id > L AND messages.id <= F` in one read
   transaction.
4. An empty result is `absent`. Otherwise every row must have exactly one
   durable runtime selection with the journaled provider and resolved session
   key.
5. Use closed handler-state sets:
   - nonterminal: `received`, `dispatched`, `processing`, `replay-pending`,
     `resume-attempted`, `codex-ambiguous`;
   - terminal: `replied`, `failed`, `aborted`, `replay-attempted`,
     `replay-skipped`;
   - unknown or null state, or missing/duplicate/mismatched selection:
     `conflict`.
   Every row must be terminal for the prior journal to qualify.
6. A `proof-failed` attempt must additionally pass its existing exact
   `authorized-turn-state` check. The historical row scan supplements rather
   than replaces its request-bound proof.
7. After all historical checks, require authenticated daemon busy count zero.
8. Create the new journal immediately with the same frozen baseline `F`. Never
   recapture the baseline after the busy sample.

The active canary's `observeTurn()` behavior does not change. A new attempt
still requires exactly one new live scoped message, authenticated daemon busy
count one, an exact request-bound target token, and synchronous daemon
revalidation before restart.

## Why this is safe

- Every incomplete, dispatch-uncertain, or proof-pending journal still blocks a
  new attempt.
- A `precondition-rejected` attempt either stopped before becoming
  dispatch-capable or received the sole safe post-send result: an exact
  authenticated `accepted:false` response proving shutdown did not begin.
- Every historical scoped row through `F` must be durably terminal and routed
  to the expected provider/session. Active, replay-pending, Codex-ambiguous,
  malformed, or mismatched evidence blocks retry.
- `proof-failed` attempts retain their exact authorization, daemon identity,
  request, provider/session, and evidence checks.
- Capturing `F` before the final busy sample prevents a racing message from
  being hidden below the new journal's cursor. A row arriving after `F` remains
  visible to the active canary.
- Busy zero is an advisory scheduling witness, not the admission fence. The
  correctness boundary remains the active observer plus daemon-owned exact
  target authorization and restart revalidation.
- Existing journals remain immutable. The fix never deletes, moves, rewrites,
  or manually waives them.

The flow becomes:

`--new-attempt` -> static journal validation -> freeze baseline `F` -> verify
all prior rows through `F` -> run exact proof checks where required -> require
busy zero -> create one new journal with baseline `F`.

## Trade-off

Historical scans overlap: an older journal may recheck rows also checked for a
newer journal. That is intentional simplicity. Canary attempts are rare,
matching is already limited by version, integrity, provider, and scope, and
terminal rows do not block retry. A durable unresolved or malformed row keeps
blocking until repaired, which is the correct fail-closed behavior.

This design does not add speculative journal chronology or database-lineage
machinery. It detects a current baseline below a prior lower cursor and fails
closed, but absolute detection of a restored database epoch would require a
separate database-generation or predecessor identity. That is outside this
incident.

## Alternatives rejected

### Select only the earliest post-baseline row

Timeout, cancellation, and multi-row conflict paths may never have selected a
unique row. Earliest-only can also ignore a later durable nonterminal row that
busy count does not own.

### Partition history into per-journal intervals

Intervals reduce overlapping reads but require journal ordering, boundary
rules, and chronology/rollback policy. That machinery is unnecessary for a
small number of one-shot canary attempts.

### Delete, move, or waive rejected journals

This bypasses the audit and crash-recovery contract and is operationally
destructive.

## Failure modes

- No scoped row in `(L, F]`: `absent`; other gates still apply.
- Every scoped row terminal with exact routing evidence: `terminal`.
- Any known unresolved row: `nonterminal`; retry is refused.
- Any unknown state or missing/duplicate/mismatched routing evidence:
  `conflict`; retry is refused.
- `F < L`: invalid historical range; retry fails closed.
- A row arrives after `F`: it belongs to the new active attempt and remains
  visible because the new journal stores `F` unchanged.
- Generic ambiguity after `dispatch-possible`: existing reconciliation rules
  apply; this verifier cannot authorize another send.

## Test and verification plan

Follow red-to-green TDD in the shared `polygram-deploy` skill:

1. Reproduce production: one prior baseline with two later terminal Codex rows
   must return `terminal`; confirm the old code returns `conflict`.
2. Test empty history and inclusive upper-bound behavior.
3. Table-test every closed terminal/nonterminal state, unknown, and null.
4. Test missing, duplicate, wrong-provider, and wrong-session selection
   evidence as `conflict`.
5. Prove a durable nonterminal row blocks even when mocked busy count is zero.
6. Prove `proof-failed` requires both the all-row historical check and its exact
   authorization check.
7. Prove runner ordering: static validation -> frozen `F` -> historical/exact
   checks -> final busy sample -> journal creation using the same `F`.
8. Insert a row after frozen `F` before journal creation; prove the journal
   retains `F` and the active observer sees the row.
9. Retain authenticated-negative retryability and prove malformed/transport
   `dispatch-possible` attempts still block.
10. Run the focused regression, full foreground-canary suite, and shell syntax
    checks.
11. Independently review the implementation for fail-closed behavior.
12. Re-run `--new-attempt` against the immutable production journals, then
    complete the real Codex restart/continuation canary without the restart
    notice.

This changes only the canary verifier/runner helpers and their tests. It does
not change Polygram message routing, deploy IPC, continuation authorization,
or daemon runtime behavior.
