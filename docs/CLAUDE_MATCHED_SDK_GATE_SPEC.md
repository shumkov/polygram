# Matched SDK/CLI acceptance gate amendment

## Current consumer source checkpoint

Released Polygram0.46.0 basef401ba44489925f7861f07b72db51288ebe4968b is now
integrated without conflicts by signed2dcdebe. Consumer0.46.1 preparation aligns
exact registry Orchestra0.12.1 and SDK0.3.322; source/PR/CI/merge is authorized.
No Polygram tag, npm publication, canonical helper or deployment is run by this
worker. Released Codex features/pins and accepted provider gate inputs remain
unchanged. Actual old SDK source was archived before replacing this child's
installed SDK; original matrix receipts retain their point-in-time identities.
The initial failed local full run remains FAIL, with47runner-environment failures
resolved and the sole historical-SDK unit corrected through reviewed RED/GREEN.
Final exact-head full CI remains required before merge. Earlier consumer-hold
statements below are historical; both24hsoaks remain coordinator-owned.


## Orchestra patch release and consumer hold

Coordinator supplied published Orchestra0.12.0 base706dab; owned Claude branch
integrated it without conflicts and prepares0.12.1 through reviewed PR/CI/OIDC
release with artifact readback. No Codex source/pin changes were introduced by
that merge. This consumer child preserves its reviewed generic actual-installed
SDK metadata/shared-resolution assertions independently, with current3/3PASS and
no dependency/version change. Exact consumer SDK0.3.322/Orchestra0.12.1 update
requires the actual published0.12.1 artifact and coordinator-provided released
Polygram0.46.0 base before consumer merge/version/publication. Do not merge or
modify the coordinator parent branch; no deploy or new provider loops. Earlier
Orchestra published-base hold statements below are superseded; accepted gate
6cceb3b23/23 and strict focused INCONCLUSIVE limits remain unchanged.


## Current publication and release ordering

Tracking issue [Polygram #133](https://github.com/shumkov/polygram/issues/133) is
OPEN and its complete body was authoritatively read back. Publication and planned
activation are authorized. Bounded runtime correction is signed Orchestra commit
0664a00dea8b1b4fd1f8c3ff803683171b2c69d8, with the exact accepted runtime source.
Codex owns Orchestra 0.12.0; Claude release version/tag/main integration waits for
its published base and no deployment occurs in this worker. The separate aligned
consumer update must use the actual subsequent Claude Orchestra release plus
SDK 0.3.322, with artifact-backed lock metadata and independent diff review.
Current consumer dependencies remain unchanged rather than installing an invalid
0.11.3/.322 pair. The reviewed pin/consumer design is in the owned Orchestra child,
docs/CLAUDE_2_1_322_PIN_CONSUMER_SPEC.md. The accepted 23/23 matrix does not need
repeating for these documentation/pin metadata changes; prior INCONCLUSIVE
focused traces and failed matrix attempts retain their original verdicts. Both
24-hour soaks remain. Earlier status statements below are historical.


## Coordinator acceptance and retained limits

The coordinator accepts this bounded ownership correction on the completed
23/23 matched matrix, all three distinct UUID-owned user completions observed on
both actual SDK/CLI pairs, observed peer/zero events preserving pending owners,
reviewed retained-shape RED 2 FAIL -> GREEN 2 PASS, the cancellation/drop
regressions, and independent clean code reviews. The former strict focused
oracle required unsupported standalone-report/notification-before-zero behavior
and its overlap holds were denied. Its INCONCLUSIVE verdicts remain unchanged;
those extra assumptions are not a release gate. No new live scheduling fixture,
provider query, or instrumentation loop is required or planned for this correction.
This accepts explicitly limited coverage; downstream delivery and every overlap
schedule remain unproven. Tracking-issue publication remains the explicit pre-pin
prerequisite, and pin/consumer reviews, release/activation authority, staging and
both 24-hour soaks remain. No runtime or package pin changes are made here.

## Final full unit/integration verification

Ran the complete package test command once on the final corrected runtime with
Node 24.4.0: `node --test --test-force-exit --test-concurrency=1 tests/*.test.js`.
All 34 test files completed: 1,579 tests, 1,560 PASS, 0 FAIL, 19 existing contract
capability-N/A skips (17 channels-protocol, 2 Codex-capability), 0 cancelled.
Duration 103.370 seconds, exit 0. Runtime SHA-256 remains
`c6f61a85acd139a0c524a7726dc5eead02be34480305bcd3fbdde32005c72184`.
HOME/CODEX_HOME/TMP/tmux/vendor/versions were private synthetic trees, with an
allowlisted credential-free environment and disabled installer/updater. The suite
uses fake processes/bridges and local fixtures; no paid queries were repeated.
No failures required code changes. This is unit/integration proof, not additional
provider, downstream delivery, persistence, activation or soak proof. Full log,
command, times and per-skip receipts:
`/tmp/orchestra-claude-upgrade-research-3agLJs/compatibility-acceptance-full-suite/`.




Status: coordinator aligned with actual .283/.283 and .322/.322 on one recorded
source commit; design review required before implementation. b796 crossed-pair
FAIL and all exact artifacts remain immutable. No pin/publication/production change.

## Problem and source contracts

The b796 matrix holds SDK .283 constant. Its .322 background task really failed;
filtered later PASS cells cannot turn that run into acceptance. Actual matched
SDK .322/CLI .322 completed the task with correct delivery but the old gate rejected
membership order and exactly-one-result. Official pinned SDK changelog .292 changes
finishing membership to AFTER task_updated/task_notification; .319 adds MCP tasks
to SDK sessions. Results are per turn, and a background completion can create a
synthetic task-notification turn. No production lib/ consumer in either repository
uses task membership ordering. Production result ownership is corrected separately.
Sources: https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.322/CHANGELOG.md
https://code.claude.com/docs/en/agent-sdk/typescript#sdkbackgroundtaskschangedmessage

## Exact runtime selection

Retain the default .283 manifest and existing legacy mode. The separate .322
acceptance manifest gains sdkRuntimes.old/candidate with exact SDK version,
claudeCodeVersion, sdk.mjs SHA256 and package.json SHA256. It removes the ambiguous
single sdkVersion field. Require explicit --old-sdk-root and --candidate-sdk-root
absolute, predownloaded package roots when sdkRuntimes is declared. Reject missing,
wrong-version/hash or nonmatching SDK/CLI pair before any gate child starts.

A small Node preloader (gate-only; Node24.4.0) uses module.registerHooks to redirect
ONLY the bare @anthropic-ai/claude-agent-sdk import/require to the selected sdk.mjs.
It synchronously loads that actual module before gate code and writes a private
exclusive attestation (version, CLI version, entry/package hashes, loaded:true).
The runner passes this through explicit per-child argv/environment, never changes
node_modules or production package pins, never patches SDK code, and compares the
persisted attestation plus source hashes after the child exits. Both ESM and CJS
resolution are tested. Every cell gets the same checked source; only declared
binary/SDK identities differ. Protect SDK-selector env keys from scenario overrides.
Official Node hook docs: https://nodejs.org/api/module.html#moduleregisterhooksoptions .

Alternative: identical copied prefixes with different dependencies (already useful
for supplemental experiments) have stale-source/copy divergence risk. Constant new
SDK would avoid dispatch but change the old baseline; retain as supplemental only.
Do not add a package installation or dependency update to gate execution.

## Exact background policy

Keep all old assertions and all scheduled cells, including the old-only checked
opt-in waiver. Apply new policy ONLY to attested SDK0.3.322/CLI2.1.322 background
mode selected from the checked manifest. Unknown identities fail closed.
Keep the existing proof schema and native proof regeneration from retained raw
bytes. Replace ONLY the old clear-before-notification inequality with the exact
new completed-update < completed-notification < empty-membership < marker order.
All counts, statuses, task/tool correlations, asynchronous placeholder and timing
constraints remain. Foreground still requires one successful non-error result.

Additionally regenerate a task-turn proof directly from the private raw stream:
exactly one matching listed task, started task, completed update and completed
notification share nonempty task_id, tool_use_id where present, run_id and session.
The membership clear and exact once marker remain mandatory. Require EXACTLY TWO
successful non-error top-level results in that same session: initial result after
placeholder and before completed update, with no autonomous origin; final result
after marker, with origin.kind task-notification, producer session-task and runId
matching all task events; final result text must hash to the exact expected marker. Retain both results, do not flatten them. A failed/stopped
task, missing/extra/error result, wrong origin/run/session or duplicate lifecycle
record always fails. SDK .283 foreground/default oracle remains unchanged.

The driver selects policy using actual imported SDK identity and attested CLI;
the runner independently selects it from the immutable manifest and rechecks raw
bytes. A result cannot self-declare a weaker policy. Exact lifecycle comparison
across old/new still checks common semantics and documented version-specific proof.

## Focused attribution observation repair

The completed own-new-a run is INCONCLUSIVE, not accepted: all three normal user
sources completed correctly, but an old copied supplemental prefix still counted
Bash tasks and ended before direct agent reports. Retain it unchanged. The checked
probe must count only direct local_agent/background/depth1 tasks, wait for those
two notifications AND actual report terminal evidence, and keep pending user work
overlapping the reports. Native Bash defaults detach long sleeps unless timeout is
explicit, so the synthetic parent/agent sleep fixture must force timeout60000 and
run_in_background:false through the public PreToolUse updatedInput hook for ONLY
exact sleep20/22/30 commands. The completed own-old-b run is also INCONCLUSIVE: all three normal completions
were correctly attributed, then SDK prioritized those typed turns before draining
any reports, so no report overlapped a pending. Preserve it unchanged. Queue the
second/third normal requests at the first actual top-level autonomous assistant
frame after the first user completes and both direct agents have started;
this puts genuine user work in flight during a real report turn. The completed
own-old-c trace shows peer handback terminal results precede their corresponding
system/task_notification edges; old task-notification result origins have no runId.
Do not assume notification-before-peer-result ordering. Join the peer senderTaskId
to its started task and FINAL completed notification, regardless edge ordering;
queue followups on the real autonomous frame after both starts, then require both
completed notifications in the final proof. Candidate zero-turn correlation still
requires its real runId and both notifications at that witness. Require both
distinct correlated report terminals overall, plus at least one unchanged pending
queue across a correlated report result (candidate additionally a zero-turn one).
Do not demand both reports overlap pending work: the first can finish before the
second produces the trigger. Add a 30s foreground hold to the second normal request. Existing maxTurns12/180s prompt and
15min outer deadlines stay unchanged. Do not waive the required candidate zero-turn
batch witness; old pair requires correct attribution/report delivery but not a
zero-turn event that its SDK does not promise. Never use stale copied gate source;
run the same checked probe via the reviewed per-side resolver. This fixes a concrete
fixture observation defect, not product behavior or a new runtime gate.

## Verification and execution

TDD: retain RED tests using the matched .322 observed ordering/two-turn shape,
then GREEN only under exact attested new policy. Negative tests cover failedtask,
wrong/missing run/session/tool IDs, extra/missing/error results, wrong result
origin, reordered clear/completion/notification, duplicate marker, unknown versions,
source tampering and SDK mismatch. Resolver tests prove both ESM/CJS module identity
without provider access, and show wrong hash/version rejects before script launch.
No tests use real vendor trees or user HOME.

After independent design/code reviews and focused actual-pair ownership proof,
record one signed gate commit containing this amendment and the current dossier;
record exact runtime-source hashes and acceptance manifest SHA before calls. Run
ONE complete unfiltered matrix with a short unique prefix, existing isolated auth,
all fixture deadlines/turn limits unchanged. Do not overwrite prior receipts.
The owned Orchestra correction remains uncommitted for integration; any SDK
consumer package copies used in tests are own disposable/child trees and hashed.
Tracking issue remains draft, pins stay old until repository gates actually pass,
and 24h staging/CLI soaks, separately reviewed consumer update and publication/
activation remain unproven and unauthorized.

## Existing waived-old cell comparison correction

The complete e1870e2 run remains FAIL (14PASS/1BLOCKED/8not-run,15/23 completed).
Its candidate matched background MCP task, exact marker, raw two-turn lifecycle,
imported SDK and actual Orchestra source all PASS. The runner then blocks on
missing old same-scenario evidence even though its existing manifest explicitly
waives that old opt-in regression. This is a runner planning/acceptance mismatch,
not a failed candidate task or a new waiver. Preserve this exact summary and
artifacts; no retroactive acceptance.

Use one small shared decision for cross-version comparison, derived solely from
manifest-generated waivedCells: comparison is required for non-candidate-only
scenarios except when that exact old cell is explicitly listed as waived. Use
it in run construction's pairComparisonRequired, runner comparison scheduling,
and retained acceptance replay. If an old cell is scheduled but missing/failed,
keep BLOCKED; unrelated old waivers and candidate waivers cannot excuse it.
Per-run raw/schema/identity/native version-specific oracle validation remains
mandatory; repetitions and absolute/same-version checks remain. Do not compare a
candidate background task to old production foreground as though the modes were
equivalent, fabricate old results, or require execution of the known waived task.

Alternative rejected: candidateOnly for the scenario (would bypass lifecycle
policy intent) or unconditionally skip all version-specific comparisons (weakens
unaffected cells). Add focused RED tests for the exact current manifest's
candidate delayed run requiring a nonexistent old pair; negative tests preserve
scheduled-old/unrelated-waiver and repeat/absolute comparison requirements.
Implement only the shared comparison decision and its three existing callers;
review code and test retained acceptance behavior. Record a new signed gate
commit and run one new full unfiltered23-cell matrix. The e187 failed run and
b796 failed crossed-pair run stay immutable and cannot be combined into PASS.
