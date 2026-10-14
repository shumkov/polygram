# External jobs separation validation

## Scope and ownership

The approved extraction is implemented in Polygram branch `admin` and the
separate local repository `~/Projects/shumkov/infra-agent`, branch
`separate-infra-agent`. The destination was approved before implementation.
No remote repository was created for the new application. Its reviewed fixes
are committed as `6213c91`.

Polygram retains the generic job ledger, public IPC operations, CLI session
admission, operator pause and report delivery. The separate application owns
Netdata, maintenance spool, incident schema, diagnosis policy and follow-ups.
The old integrated design and validation files are historical evidence only.

Migration 022 was unpublished: the latest published release inspected was
0.39.1. Its replacement creates generic tables. Opening the superseded
development incident schema fails explicitly before the version early return;
no old data is dropped or reset. Exporting such a development DB is a separate
manual operation, not an automatic migration into the new application.

## Offline verification checkpoint

Runtime: Node 24.4.0. Orchestra, Agent SDK and Claude pins are unchanged.

- Polygram full suite: 4490 tests, 4474 passed, 16 skipped, zero failed.
  Skips are opt-in real-Claude scenarios; no real-Claude qualification is claimed.
  Log: `/tmp/polygram-separation-canonical-full.log`.
- infra-agent full suite: 158 passed, zero failed/skipped.
  Log: `/tmp/infra-agent-separation-canonical-full.log`.
- Two-process acceptance uses an actual authenticated Unix socket, Polygram's
  public package entry point, the production handler map and generic service,
  the standalone controller/store, and synthetic agent/delivery adapters.
  A deliberately lost acceptance response is recovered with the exact same
  envelope after closing and reopening the incident database: one accepted
  request, one agent turn, one report delivery. Turn/delivery counts are read
  from the synthetic server process, not inferred from the job receipt.
  Run `node scripts/verify-polygram-boundary.js /absolute/polygram/checkout`
  from infra-agent. No real Telegram sends occur.
- `npm pack --dry-run --json` confirms no embedded infrastructure executable,
  collector or domain module in the Polygram distribution.
- Both repositories pass `git diff --check`. Neither package defines lint or
  typecheck scripts.

## Observed regression checks

Tests were run failing before each correction, then passing afterward:

- report retry during persistent pause;
- report preparation failure erasing known execution outcome;
- deleted topic redirecting a report to the chat root;
- uncertain connection reset causing a hidden second send;
- old development schema bypassing migration checks;
- automation command reaching question capture;
- unsupported runtime fabricating inactivity proof;
- route removal during process creation;
- incident DB failure losing an already accepted producer event;
- asynchronous controller tick accessing a prematurely closed database.

The extracted domain tests preserve missing-alarm/coverage UNKNOWN behavior,
bounded cursor progression and spool draining, explicit maintenance CLEAR,
recovery-report obligations and metadata-update retry preservation.

## Separation review and follow-up

Review run `20261015-035525-9ba35211` covered Polygram `87cbd3a` and the
standalone application `e115002`. Its original verdict was **Not ready**.
Independent validation confirmed six findings; the fixes below resolve that
snapshot verdict without treating the original review as approval of later code.

| Finding | Disposition |
| --- | --- |
| 1: successful but ambiguous reports were invisible to fallback | Unknown reports count as blocked; CLI fallback is tested with a later CRITICAL transition and no second diagnosis. |
| 2: old jobs starved new incidents | Separate bounded existing/fresh phases; held reports cannot consume fresh slots. |
| 3: remote disabled silently held alerts | Explicit availability error reaches the bounded operator fallback. |
| 4: pause write failure prevented human stop | Attempt interruption, hold automatic admission/report retries in memory, and warn that storage must be repaired before restart. |
| 6: missing durable restart evidence | Actual child-process death at acceptance/execution/send boundaries, file reopen for pause/partial reports, and incident DB reopen after lost acknowledgement. |
| 7: removed route blocked historical lookup | Gate fresh admission independently; reconcile frozen accepted and lost-ACK identities through get. |

The soft dispatcher coverage finding (5) is also covered: recovery waits,
tracked tasks, shutdown settlement, rejection cleanup and absence of manufactured
Telegram replay targets. Actual socket response-loss coverage supplements the
cross-repository harness. A separate process tests controller ownership and
reclaim after its owner dies.

A targeted independent review confirmed the fixes and caught one additional
`maxPerTick: 1` starvation case. Its regression failed before the final bounded
per-request budget correction, then passed. That adjustment received follow-up
review with no blocker. Controller/stop regressions were observed RED then GREEN.

Artifacts are under
`/tmp/compound-engineering-502/ce-code-review/20261015-035525-9ba35211`.
Additional regression logs: `/tmp/infra-controller-review-red.log`,
`/tmp/infra-controller-review-red2.log`, `/tmp/infra-one-slot-red.log`,
`/tmp/polygram-pause-review-red.log` and corresponding green logs.

The requested Claude cross-model review could not start: npm could not resolve
`acpx@0.19.5`, before source egress. A local independent adversarial review
completed instead. No cross-model corroboration is claimed.

A full suite attempted from the isolated `/tmp` worktree failed 14 existing IPC
path tests because production deliberately rejects temporary runtime paths.
The final full-suite receipt above is from the canonical checkout.

## Requirements recheck after fixes

R1-R4 retain the generic/domain boundary, existing conversation lifecycle and
stable request contract. R5-R8 now include the restart, pause-failure, visibility,
fairness and frozen-route proofs described above. R9 remains diagnosis-only with
original notifications preserved. U1-U4 are implemented; live acceptance is a
separate deployment step, not part of this offline completion receipt.

## Operational boundaries

This is source and synthetic integration validation. No production config,
service, notification producer, installed skill or monitoring source was changed.
No daemon was restarted, real agent turn launched or infrastructure repaired.

Activation requires compatible Polygram and infra-agent artifacts, a configured
isolated CLI destination, the standalone private data/config directories and an
explicit deployment instruction. Older daemons fail protocol negotiation.
Channels send acknowledgement alone is insufficient to prove final reporting;
a succeeded diagnosis with an unknown report remains held for operator review.
Read-only policy is an agent instruction, not an operating-system sandbox.
