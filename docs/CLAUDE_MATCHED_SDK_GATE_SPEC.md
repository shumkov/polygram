# Matched SDK/CLI acceptance gate amendment

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
