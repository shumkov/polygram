---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
status: reviewed
---

# U24 deterministic single-retry amendment

Date: 2026-08-18

**Outcome (2026-08-18):** The amendment was implemented with red-to-green
tests and independently reviewed with no unresolved must-fixes. The corrected
VPS shape gate passed. The one authorized full gate stopped after two natural
retries recovered and two natural retries exhausted on confirmed-cleanup
timeouts. U24 therefore remains blocked; do not rerun the unchanged gate in
hope of a stochastic pass.

## Goal Capsule

Make the fixed Claude CLI/Haiku memory router tolerate one transient or invalid
classification without weakening the privacy boundary or retrying until the
fixture happens to pass.

Done means every eligible routing case gets at most two independent Haiku
attempts, no destination or queue request is projected between attempts, a
recovered second attempt produces one terminal accepted projection, and a
second failure produces one terminal destination-free queue-request projection.
The U24 shape/full gates and durable findings must then be rerun with the exact
pinned subscription runtimes.

## Evidence and problem

- The reviewed U24 harness and local suites pass.
- The VPS full gate produced 109 accepted non-secret cases and one safe
  `ROUTER_MIXED_COVERAGE` failure across 110 real model classifications.
- The failed result selected no destination, but the harness only labelled it
  retryable; it never exercised a retry.
- Re-running the unchanged stochastic gate until it is green is not acceptable
  evidence.

## Chosen contract

Add one orchestration layer around `runRoutingCase`; do not change the prompt,
schema, privacy rules, model, or fixture oracle. The adapter needs one narrow
evidence-preservation change described below; its process, prompt, and routing
behavior remain unchanged.

1. Run the first case normally.
2. Retry immediately and exactly once only when the first result is an
   `operational_error` whose code is in a closed retryable set and any owned
   process has confirmed cleanup.
3. Use a fresh adapter invocation with the identical source fact, model pin,
   schema, environment, and timeout. There is no delay or backoff in this
   bounded gate.
4. Validate observed model identity on every completed adapter response before
   deciding whether output validation may retry. A wrong or ambiguous model is
   terminal.
5. Normalize arbitrary thrown error codes to the closed
   `ROUTER_GATE_FAILURE`; never copy caller-controlled codes into a receipt.
6. Do not project, queue, or publish the first result. Only the terminal result
   leaves the retry wrapper.
7. If attempt two is accepted, return it once with content-free retry evidence.
8. If attempt two is another operational error or a mismatch, return that
   terminal failure. The harness produces one queue-request projection and no
   destination. Never make a third attempt.

### Retry eligibility

The closed retryable set contains adapter/process/output and output-validation
failures that can change on a fresh invocation:

- `ROUTER_TIMEOUT`, `ROUTER_PROCESS_EXIT`, `ROUTER_OUTPUT_TOO_LARGE`, and
  `ROUTER_STDERR_TOO_LARGE`, only when their diagnostics say
  `cleanupConfirmed: true`;
- `ROUTER_OUTPUT_MALFORMED`, `ROUTER_OUTPUT_MISSING`, and
  `ROUTER_OUTPUT_SCHEMA`;
- `ROUTER_PARTS_OVERLAP`, `ROUTER_MIXED_AMBIGUOUS`,
  `ROUTER_MIXED_COVERAGE`, and `ROUTER_MIXED_SENSITIVE_MISSING`.

Do not retry:

- accepted or quarantined results;
- deterministic input rejection such as `ROUTER_INPUT_INVALID` or
  `ROUTER_SECRET_REJECTED`;
- contract/privacy boundary failures: `ROUTER_TOOL_USE`,
  `ROUTER_OUTPUT_SECRET`, `ROUTER_PERSONAL_VETO`,
  `ROUTER_MIXED_WORK_SENSITIVE`, and `ROUTER_MIXED_NOT_EXTRACTIVE`;
- corpus expectation mismatches (the production router has no fixture oracle,
  so retrying them would tune the gate to its answers);
- runtime/authentication preflight failures, route-time
  `ROUTER_AUTH_UNAVAILABLE`, and model-identity failures;
- process-originated failures whose cleanup is absent or unconfirmed.

An unknown operational code becomes terminal `ROUTER_GATE_FAILURE` rather than
silently entering the retry set or being serialized verbatim. Caller
cancellation is not part of this standalone spike API; production cancellation
and durable retry ownership remain U15/U16 work.

## Interface and receipt changes

Add a small exported retry runner beside `runRoutingCase`; keep the single-pass
function available for focused tests and fault injection.

The terminal row may add only content-free fields:

- `attemptCount`: `0`, `1`, or `2` adapter attempts;
- `firstAttempt`, present only after a retry, containing the closed error code,
  the existing safe diagnostics, the privacy-veto boolean, and any observed
  model IDs supplied by that completed envelope.

The retry boolean is derived from `attemptCount === 2`; it is not another
receipt field. Adapter summaries add aggregate recovered/exhausted retry counts,
all-attempt privacy flags, all observed model IDs, and attempts without model
evidence. Per-fixture receipt rows may include the same bounded first-attempt
record. They must never include the fact, model output, stderr, an arbitrary
error code, or a source-derived digest.

`runRoutingEvaluation` uses the retry runner. Fault evaluation uses adapters
that fail both attempts with confirmed cleanup where required and explicitly
calls the retry runner. Its 20 logical fault cases remain 20 outcomes but prove
40 bounded attempts and one final queue-request projection per case.

Required arithmetic:

- `routeCaseCount = accepted + quarantined + operationalErrors + mismatches`;
- `zeroAttemptCaseCount + firstAttemptCaseCount = routeCaseCount`;
- `retriedCaseCount = recoveredRetryCount + exhaustedRetryCount`;
- `adapterAttemptCount = firstAttemptCaseCount + retriedCaseCount =
  sum(attemptCount)`;
- full mode has 130 logical outcomes, 20 pre-model quarantines, 110 first
  adapter attempts, and `110 + retriedCaseCount` total adapter attempts;
- shape mode has 6 logical outcomes, 2 quarantines, 4 first adapter attempts,
  and `4 + retriedCaseCount` total adapter attempts;
- the fault gate has 20 logical outcomes, 20 exhausted retries, 40 adapter
  attempts, and 20 queue-request projections.

Adapter attempts and proved model calls are distinct: a process failure before
an envelope is an adapter attempt without model evidence, not a claimed model
call.

### Implemented evidence-preservation detail

`parseClaudeResult` now reads `modelUsage` before it validates that the envelope
contains routing output; the harness then applies its existing closed model-ID
filter. When an otherwise valid envelope is missing output or reports an API
error, the thrown closed error therefore retains bounded observed-model
evidence. This lets the retry wrapper enforce model identity on every completed
envelope, including a failed first attempt. It does not retain model output,
stderr, or source content and does not alter the Claude invocation.

## Data flow

Prepared synthetic fact -> attempt 1 -> terminal accepted/quarantined/mismatch,
or eligible operational failure -> attempt 2 -> one terminal result -> existing
projection. There is no projection, destination ledger write, or publication
between attempts.

This amendment changes only the U24 spike/gate. Production staging, durable
queue ownership, epochs, idempotency, and publication remain U15/U16 work.

## Failure modes

- Attempt two also fails: STOP the gate; retain one destination-free
  queue-request projection and the two-attempt receipt.
- Attempt two mismatches the fixture: STOP; do not retry the mismatch.
- A secret/input rejection reaches the adapter: test failure; secrets must
  remain pre-model quarantined.
- First-attempt data appears in a destination/projection: test failure.
- Unknown error code is retried: test failure.
- Retry count exceeds two or a retry starts after unconfirmed process cleanup:
  test failure.
- Runtime/auth/model identity changes between attempts: terminal STOP. Every
  completed response, not only the accepted terminal row, participates in the
  exact-model check.
- A recovered first privacy-veto flag disappears from summary evidence: test
  failure. The final gate ORs privacy flags across all attempts.

## Test and verification plan

Proof-first focused tests:

1. A first `ROUTER_MIXED_COVERAGE` result followed by a valid result makes two
   adapter calls, returns one accepted projection, and records recovery.
2. Two eligible failures make exactly two calls, one final queue-request
   projection, zero destinations, and no third call.
3. Accepted, quarantined, input-invalid, unknown-code, tool/secret/privacy
   boundary, auth-unavailable, model-identity, cleanup-unconfirmed, and mismatch
   results do not retry.
4. Each closed retryable code is table-tested, including the confirmed-cleanup
   condition; a code omitted from the set is rejected by the test.
5. Fault evaluation proves 20 logical outcomes, 40 attempts, zero destinations,
   and one queue-request projection per outcome.
6. Receipt tests prove retry metadata is bounded/content-free, an arbitrary
   secret-bearing thrown code is absent, all-attempt model/privacy evidence is
   retained, and summary arithmetic adds up.
7. Existing U24, secret-boundary, and adjacent memory tests stay green under
   the repository Node 24 runtime with zero unreported skips.

Runtime gates after code review:

- rerun VPS shape using the exact pinned Codex/Claude binaries and subscription
  auth, then pin the observed exact Haiku model for full mode;
- rerun full mode once under the two-attempt contract;
- require zero terminal operational errors, mismatches, all-attempt privacy
  flags, model-identity failures, and exhausted non-fault retries, plus 20/20
  bounded fault outcomes;
- accept shape only with zero recovered routing retries and full only with at
  most one recovered non-fault retry, matching the pre-change 109/110 baseline;
  fault injections do not consume this budget. A run with zero natural retries
  may pass because focused/fault tests prove the branch; the live corpus then
  proves clean first-pass behavior;
- record actual first-pass, recovered, exhausted, quarantined, and model-call
  arithmetic in the findings. Do not rerun an unchanged failed build in hope
  that it happens to pass.

The runtime gates produced the following terminal evidence:

- the corrected native-executable shape run passed with 4/4 first-attempt
  model cases, two pre-model quarantines, no natural retry, and 20/20 bounded
  fault outcomes;
- the full run produced 130 logical outcomes: 108 accepted, 20 pre-model
  quarantines, two destination-free terminal operational errors, and zero
  mismatches or privacy flags;
- its 110 first attempts plus four retries equalled 114 adapter attempts;
  two retries recovered and two confirmed-cleanup timeout retries exhausted;
- exact Haiku model identity, projections, arithmetic, and 20/20 fault
  outcomes passed, but the full retry budget did not. U24 remains blocked.

## Alternatives rejected

- Sonnet characterization: higher latency/cost and still needs bounded failure
  handling; keep it as fallback only if Haiku still exhausts the reviewed retry.
- Prompt/schema tuning: risks overfitting one mixed fixture and changes the
  already-reviewed privacy contract.
- Retry only mixed coverage: fixes the observed symptom but leaves equivalent
  transient/schema failures untreated.
- Unbounded retries or retry-until-oracle-match: hides classifier quality,
  increases cost/latency, and can loop.
- Queue-request-only with no immediate retry: safe but leaves avoidable memory
  lag after a roughly one-percent observed operational failure rate.

## Scope and files

Expected files:

- `scripts/spikes/memory-routing-gate/adapters.mjs` for the bounded
  model-evidence preservation described above
- `scripts/spikes/memory-routing-gate/harness.mjs`
- `scripts/spikes/memory-routing-gate/run.mjs` only if receipt aggregation needs
  a direct change
- `tests/scoped-memory-routing-gate.test.js`
- `docs/2026-08-18-001-u24-memory-routing-gate-findings.md` after live evidence
- `docs/plans/2026-07-31-002-feat-shumabit-scoped-memory-plan.md` for the folded
  U24 status/contract after the amendment passes review

No production memory implementation, deployment, service restart, feature-flag
change, prompt tuning, model change, or Telegram action belongs to this unit.

## Definition of Done

- The reviewed single-retry tests are red on the current single-pass harness and
  green after implementation.
- Every logical case makes at most two adapter calls.
- Intermediate failures cannot select destinations or emit queue/publication
  projections.
- The terminal gate/receipt arithmetic is internally consistent and
  content-free.
- Independent correctness, simplicity, failure/operability, and privacy review
  report no unresolved must-fixes.
- The one authorized VPS shape/full rerun passes, or U24 remains explicitly
  blocked with its terminal failure evidence.
