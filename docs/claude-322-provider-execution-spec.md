# Authorized Claude provider compatibility execution

Start from Polygram eea29d3 and Orchestra 19fb8fc. Ivan has explicitly authorized
all paid calls necessary for this upgrade, including discovery, full old/new
comparison and actual-new-SDK/focused compatibility runs. Do not ask again for
each planned batch. Publication, push, issue creation, release and production
activation remain unauthorized. Runtime pins stay unchanged until mandatory
issue and accepted-matrix requirements are met.

## Authentication and isolation

Use existing supported access. Prefer a currently valid full-profile OAuth
access token from an existing account (native/Orca-managed or proxy OAuth store), read through its existing native
credential store once and passed via supported CLAUDE_CODE_OAUTH_TOKEN. Never
copy a refresh token, invoke login/logout/refresh, alter the real credential
store, or print credentials/identity. Existing setup-token files are the
alternative; the primary setup token's profile read returned definite 403,
so full profile/Channels availability is unproven there. Default native file
and keychain contain no Anthropic access token. Managed Orca locations also
had no native token; an existing proxy OAuth access token returned HTTP 200
from the official profile endpoint, without refresh or credential mutation. Inspect only sanitized
metadata and official profile/feature responses. A real account's own returned
metadata may initialize its isolated context; never invent account/feature
cache success or bypass enrollment.

The existing access token passed the official profile read and the real SDK
PostToolBatch cell with candidate CLI. If environment-token mode cannot expose
Channels, test the native credential-file fallback in the isolated HOME using
that same access token, genuine expiry/plan/rate-limit metadata, and only the
profile/inference scopes demonstrated by those successful calls. Omit refresh
material entirely. This changes credential presentation, not token permissions
or feature enrollment; keep Keychain denied and report actual feature outcome.

Keep fresh private HOME/CODEX_HOME/TMPDIR and private short TMUX_TMPDIR, test
vendor/install paths, updater disabled and real user config/Keychain denied to
test children. The parent coordinator process may read the selected authorized
credential, but children receive only that access token through the supported
environment mode or an exclusive private credential file in their synthetic
HOME. Credential-file execution uses try/finally cleanup even on setup/spawn
failure; no refresh material is copied.
Do not persist it in command logs, argv, source or result JSON. Permit HTTPS
for the official client's provider/control calls and DNS in a dedicated test
sandbox while retaining real-config/Keychain denial; no new proxy/metering
service. Do not import user hooks, MCP servers, projects, sessions or settings.

Official authentication docs support existing OAuth tokens for automation;
Channels docs require Anthropic auth and feature access. Current docs are not
proof of behavior in old .283; exact binaries and observed results decide.
Sources: https://code.claude.com/docs/en/authentication.md and
https://code.claude.com/docs/en/channels.md .

## Minimal harness correction before discovery

The three matrix CLI drivers also isolate settings to project,local, but unlike
the previously corrected API-error/mailbox drivers do not create included
consent. Call the already reviewed exclusive consent helper in their fresh
workspaces before launch: cli-contract-matrix, workflow-autonomous-completion,
and each fresh system-prompt-snapshot leg before its first launch (not resume).
Canonicalize their cwd as needed. Workflow fixture
policy/hash and all behavioral oracles stay unchanged. Add regression coverage
that each prepared matrix project has the included file before CLI launch;
observe red before the correction, green afterward. Do not waive startup,
Channels, Workflow, provider-task or snapshot failures.

## Execution and evidence

Startup inspection exposed a second fixture prerequisite: the harness's
synthetic DISABLE_TELEMETRY setting disables upstream feature-flag evaluation,
so both binaries reported Channels unavailable even with genuine account auth.
Candidate bytes explicitly describe that condition. Remove the synthetic
telemetry/error overrides and permit the official client's normal feature
evaluation; do not inject or import cached flags. Recheck startup without any
turn sender before rerunning the blocked CLI cell. This is a verified local
cause, not evidence that existing account access itself is insufficient.

The first discovery launch stopped before the turn sender because setuid
`/bin/ps` cannot execute under macOS sandbox-exec, even with allow-default.
Retain this failed startup evidence. Use a private copy of the same system
tool with setuid cleared and ad-hoc re-signing (the unmodified platform-signed
copy is killed after relocation); change no system file or gate oracle.
Preflight full process listing and own-pid lsof under the unchanged sandbox,
record tool provenance/hash, then prepend only its private directory to PATH.
This fixes an observed fixture prerequisite without weakening credential or
network isolation. No test prompt/model result occurred in the failed cell.

First attest both preserved binaries and the exact SDK/package/source hashes.
Run candidate-filtered discovery with the checked provisional manifest. It
has 13 invocations and a 15-minute child timeout, preserving existing turn
limits. Stop at a definite failure, inspect private source evidence and fix
its confirmed cause before another affected invocation. An ambiguous paid
result requires coordinator clarification before retry; definite schema or
oracle failures with retained terminal evidence are not ambiguous inference.
Do not re-run known blocked prerequisites without new evidence/context.

Review observations independently against every dossier hypothesis. Evidence-
supported per-version changes require regression tests and independent code
review. Prepare a distinct acceptance manifest only when observations justify
it, record one signed gate commit (authorized by this task), and run all
required old/new cells on that commit before pins. Discovery summaries remain
non-authoritative. Preserve all private artifacts; no acceptance cleanup.

Actual-new-SDK checks run in a separate temporary dependency prefix/workspace,
without mutating parent or installed consumer packages. Exercise the five
SDK scenarios and the specific queued-subagent pending attribution risk; keep
their purpose distinct from the constant-SDK CLI matrix. Independent final
code/evidence review precedes reporting. Both 24h soaks and publication gates
remain outstanding; neither paid tests nor unit counts replace them.

## Focused queued-subagent attribution probe

Use the real unchanged SdkProcess from the copied Orchestra source, actual
SDK .322 and exact candidate CLI in the temporary prefix. A real streaming
query and makeInputController are supplied through the existing spawnFn
interface. Explicitly select permissionMode:auto, since the upstream batching
change is specific to auto mode, and attest the actual system/init permission
mode. Genuine account/capability availability is required; an unavailable or
fallback mode makes this risk probe INCONCLUSIVE. Do not force feature flags
or replace auto policy with a blanket allow callback. An instance-only observer delegates every unmodified _handleEvent
to the original method while recording the raw synthetic SDK stream privately
and the pending sourceMsgId before/after each result. It must not synthesize
events, skip empty results, or change routing to make an oracle pass.

The first synthetic prompt launches two background subagents, each restricted
to one bounded Bash sleep (20/22 seconds) and one unique marker, while the
parent holds a Bash sleep for 30 seconds so reports can queue. After observing
both task starts, enqueue two genuine follow-up prompts with distinct markers
and distinct sourceMsgIds. Record every completion's marker identity and the
result num_turns/subtype/text-presence without printing response content.
Keep maxTurns 12, per-prompt idle/max deadlines 150/180 seconds, and the
existing 15-minute outer invocation deadline; no automatic paid retries.

Success requires all three user completions attributed to their own markers,
both task notifications, and observed queued empty result(s) with num_turns:0.
If the provider does not exercise that shape, report INCONCLUSIVE rather
than declaring the .321 risk cleared. A wrong pending completion is concrete
failure: preserve the trace, reproduce it with a deterministic red test before
any adapter fix, then independently review the smallest correction. A normal
SDK subagent PASS alone does not cover this case. Compare to the old SDK/CLI
pair if necessary to separate a new regression from an existing assumption.

## Observed session diagnostic record schemas

Candidate discovery-c completed the CLI behavior assertions, then the evidence
writer rejected five new normalized session record types: session-owner,
tools-used, api-request-shape, api-request-blob, api-request. Raw private source
is retained with its hash; no accepted result exists for that invocation.
Repository callers use hooks for runtime lifecycle; SessionEventAggregator
finalizes on every non-assistant record, including these, so they must remain
in raw replay and may not be silently removed as inert metadata. The existing
session-pivotal projection excludes them by design, but this is not proof that
they can be deleted. Official release notes do not document their JSONL schema.

Add only these five explicit type-only normalized schemas, matching the existing
cost-state/atis-latch treatment. Normalization already retains their type and
excludes raw identity/request fields. Keep all source rows, ordering, hashes,
rawRecordCount, removal-proof eligibility and lifecycle projection unchanged.
Unknown types and additional normalized fields remain rejected. Do not create
a generic metadata wildcard or permit copying raw API request content into
review artifacts. Validate by synthetic regression fixtures based on observed
key shapes, with canary identity/request values that never reach normalized
output; observe failing schema validation before the change, passing after.
Also show that these records remain in collected evidence and raw source counts,
unknown names still fail, and no removal proof is created. Replay retained real
source offline; the successful offline schema check is recovery of writer
validation, not a completed matrix cell. Independent code review precedes the
next affected provider invocation. Alternative: keep candidate blocked on
undocumented diagnostics; rejected because explicit fail-closed recognition
retains evidence and changes no behavioral oracle. Do not update runtime parsers.

## Workflow receipt diagnostic snapshots

The first quota-available Workflow direct attempt reached its completion reply,
then receipt validation failed because api-request-blob rows repeat message
blocks. The receipt reader currently traverses message.content on every row.
Constrain live tool_use counting to assistant records and tool_result counting
to user records, matching the existing snapshot reader and typed session parser.
Do not deduplicate IDs across genuine live records: repeated assistant/user
receipts must still fail ambiguous identity. Add a synthetic exact-shape test
that fails before this two-condition correction and passes afterward, including
a genuine duplicate control. Retain all raw diagnostic rows and every receipt
marker/payload/order/timing check. This is a small gate-reader correction, not
proof that the Workflow behavior or pin is compatible.

## Preserve local-stub evidence

Run the checked API-error fail/401/flaky and mailbox stub modes on both binaries
using the same isolated native access-only account context for genuine Channels
feature evaluation; all model messages target loopback and Telegram is recorded
by the fixture stub. Validate the private launcher's mode arguments before any
credential read: reject real mailbox mode, unknown options, duplicates and
conflicting mode selectors. Preserve existing fixture limits and updater/vendor
isolation. No test may enable real Telegram transport or real model inference.

The checked stubs currently remove their own work, IPC and synthetic external
project JSONL trees in cleanup. Add an explicit --keep-artifacts boolean to
both drivers that bypasses only deletion of gate-owned files, including early
binary-preflight failure, while still stopping jobs, closing DB/IPC/HTTP,
killing fixture processes and private tmux. Default cleanup stays identical.
CliProcess.kill also removes hook files, so before teardown snapshot only each
owned hook NDJSON into its fixture work tree with mode 0600 and record a capture
cutoff timestamp; this is evidence through that cutoff, not kill-time events.
A requested snapshot failure must fail the fixture while still cleaning up
resources. An absent pre-launch hook file is recorded as absent. Do not copy
any other HOME/config files or native credential files.
Print the private retained paths (no credentials) for authoritative readback;
retain mode-0700 trees and existing mode-0600 files in their synthetic HOME/TMP.
Never retain/copy the temporary native credential file: the parent launcher's
existing finally cleanup still removes it. This opt-in supports the task's
required evidence retention without a new archive service or cleanup waiver.
Verify syntax/default path guard and read retained fixture state after runs;
independent final review precedes execution. Do not claim logs preserve raw
artifacts when the opt-in is absent.

## Reviewed acceptance manifest proposal after discovery

Candidate discovery exercised all 13 planned invocations across retained batches.
All five constant-SDK scenarios, snapshot and foreground MCP pass. CLI contract
(two runs), direct/fallback Workflow and nested Opus behavior pass but provisional
lifecycle baselines fail. The opt-in delayed MCP has a concrete failed-task/no-
marker result; it remains required background behavior, with no .322 waiver.
SDK auto-mode concurrency also fails on both old/new pairs; it stays a separate
compatibility blocker. An acceptance manifest can describe the reviewed desired
contract without claiming it passes, and its full run may legitimately fail.

The observed lifecycle delta is narrow: .322 has zero instructions attachments
(old expectation remains one), and first channel-user hasParent is true rather
than false. Retained raw source links that first channel message to an unparented
isMeta user reminder containing only tools-used-before-summary for the fixture's
channel tool. Both CLI repeats and the Workflow runs show this. Anonymous meta
users already remain in raw normalized evidence but outside pivotal projection;
no new removal or projection rule is needed or proposed.

Use existing exact positional-row declarations to factor the first channel row
at index 2 into BOTH version contracts on NEW baseline IDs ending -283-322-v1.
For .283 the exact row must remain hasParent:false; for .322 it must be true.
Then the common baseline omits that one row, while each version's declaration
requires it at exactly that position with every other field exact. Copy the
existing CLI hooks insertion index9 unchanged. This is algebraically equivalent
to the old first-row baseline assertion, not a wildcard or dropped assertion.
All old existing expectation values and default accepted manifest stay intact;
new baseline declarations are additive only in the separate .283/.322 manifest.
The four listing/delta attachments remain in the common baseline, not reclassified
as passive. Only .322 instructions count changes to the observed zero.

Write a separate claude-2.1.322-matrix.json with validationStage:acceptance only
after independent spec review. Preserve discovery history and mark its remaining
hypotheses as superseded by observation; keep .322 opt-in behavior required and
failing until the upstream issue is resolved. Synthetic tests must show old
baseline equivalence, candidate accepted parent shape, and rejection of wrong
parent, missing/extra/moved first channel row, wrong fields and later lifecycle
mutation. Replay all retained CLI/Workflow evidence offline, including nested
Opus, without promoting those filtered runs to authoritative matrix results.
Then independent code/manifest review and a signed recorded gate commit precede
one full old/new attempt. Keep pins unchanged even if this matrix passes: the
unpublished tracking issue, actual-pair attribution blocker and mandatory soaks
remain unresolved. Do not change runtime queue semantics in this gate commit.

## Neutral owned instructions input after failed full attempt

The unfiltered full attempt gate-b10cdb3-full-a on signed b10cdb3 stopped after
two old CLI behavior PASS results. Absolute comparison fails only because old
.283 instructions attachment count is0, while its preserved expectation is1.
Old root channel parent isfalse and remaining pivotal rows match. Candidate's
previously observed count0 therefore does not establish version-specific removal:
both clean profiles lack the attachment observed in the historical baseline.
A missing instruction-file input is a testable fixture hypothesis; the original
historical instruction source is not established. Do not silently lower the checked old count or import real instructions.

Official memory docs specify project CLAUDE.md as an included instruction source.
Add a separate writeFixtureInstructions helper in cli-fixture-prerequisites.mjs,
using the same canonical cwd/strict fixture-root containment as consent, exclusive
creation and0600mode. Its entire fixed neutral text is:
`This is a synthetic compatibility fixture.\n`.
No behavior policy, secrets, user instructions or account data enter the file.
Call it explicitly alongside consent before the first launch in CLI contract,
Workflow direct/fallback and each fresh snapshot leg, never during snapshot
resume. Keep the Workflow skill/hash and policy untouched. The helper must fail
if CLAUDE.md already exists or is a symlink; never replace existing instructions.

Preserve old count1. Restore candidate provisional instructions count1 until the
owned input is observed under both binaries; the earlier zero observation is
clearly attributed to clean fixture context and retained as history. All other
reviewed exact root-parent, listing, hook, task and model expectations stay intact.
No relaxation of MCP or attribution blockers. Unit coverage must show the missing
helper/input red before correction, then green for neutral exact bytes, private
mode, containment, refusal to overwrite and CLI driver prelaunch wiring. Run one
focused old/new CLI observation on the prepared fixtures, review actual counts
and replay, then new signed gate commit and full unfiltered attempt on that one
commit. Prior b10cdb3 failed evidence remains immutable. Do not edit pins.

## Native-auth presentation for existing local stubs

Two no-turn startup probes now changed only ANTHROPIC_BASE_URL to an unused
loopback port, retaining the genuine isolated native credential file and no
dummy ANTHROPIC_AUTH_TOKEN. Both start successfully; old shows the Channels
experimental notice and candidate has no known rejection. toolCalls0 and no
turn sender are recorded. This supports testing a changed auth presentation,
not a claim of enrollment/delivery or API-error gate success. Prior blocked
stub attempts remain immutable; the exact old rejection branch is unrecorded.

Add explicit --native-auth to the two checked local stubs. In this mode the
launcher unsets ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, preserves supported
native OAuth presentation, and keeps the exact loopback ANTHROPIC_BASE_URL.
Default dummy-token behavior stays unchanged. Require a dedicated isolated HOME
marker supplied by the private wrapper, equal to canonical HOME, private mode
0700, a non-symlink .claude parent directory, and an existing regular
non-symlink0600 native credential file whose canonical path equals its expected
path inside that HOME, before starting. This mode is permitted only for mailbox --model stub, never real.
No refresh material is provided; 401 effects stay inside synthetic HOME. The
parent finally still removes only its owned credential file. The native token
may reach the trusted loopback fixture HTTP handler; source inspection verifies
handlers do not log/persist authorization headers or proxy requests. Retain
private evidence without credentials, and whole-output redaction remains active.

Use small pure launcher-policy helper functions to keep shell construction and
native-auth preconditions testable without credentials/providers. Cover default
dummy mode, native mode with no literal credentials, refusal for real mailbox,
wrong HOME marker, broad modes, absent/symlink/nonprivate credential file. Model
traffic is intended to remain local; confirm actual local request counts from
the fixture. No new proxy/service, enrollment override, feature cache or model
endpoint fallback is introduced. Review the actual diff before the first local
model turn. Run fail/401/flaky and mailbox stub old/new only after the changed
presentation demonstrates the prerequisite; stop and classify definite errors
without blindly retrying unchanged failures. Preserve hooks/work/session evidence.


Neutral instruction observations completed 2026-11-12: instructions-old-cli-a
and instructions-candidate-cli-a each PASS 2/2, with all four exact instruction
attachment counts equal1 and neutral private file bytes verified. Both remain
filtered supplemental observations, independently reviewed by compatibility,
isolation and scope reviewers; no full matrix success is inferred. Native-auth
spec and code likewise received three independent CLEAN receipts after adding
the parent-directory symlink guard; its two new regressions failed before code,
then all106 focused tests passed with zero skips. The refreshed existing dash
context was re-read after prior observations completed: profile403, then one
supported environment-token actual-SDK smoke returned a definite weekly limit
isApiErrorMessage/rate_limit, not an unknown provider outcome or compatibility
finding. No repeat of that context is justified without changed quota evidence.
The earlier eligible native context is re-read at invocation, profile200; usage
readback429 is inconclusive about quota. No real credentials are refreshed.
