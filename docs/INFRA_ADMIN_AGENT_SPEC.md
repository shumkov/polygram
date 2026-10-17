---
title: Admin assistant with shared history and Netdata alerts
type: refactor
date: 2026-10-17
supersedes: EXTERNAL_JOBS_SEPARATION_SPEC.md
---

# Admin assistant with shared history and Netdata alerts

This is the current proposed design. It replaces the incident-controller design
in `docs/EXTERNAL_JOBS_SEPARATION_SPEC.md`. Implementation and production migration
require review and alignment with Ivan under `AGENTS.md`.

## Outcome and scope

The persistent Home Admin session sees the same infrastructure notifications as
Ivan, processes new notifications without a human prompt, and performs scheduled
checks. When Ivan asks “Что это?” about a notification, the assistant can retrieve
that exact message, its source and the associated investigation from topic history.
Netdata owns alarm state and transition history. Polygram owns conversation history
and session execution. No second database owns a duplicate incident lifecycle.

The initial hosts remain shumabook and umi-vps, destination Home topic 2995.
Automatic work is diagnosis and reporting. Repair authority still requires agreed
runbooks or a human instruction. A sleeping/offline Mac cannot provide continuous
monitoring; this design does not add an always-on host or remote service.

## Current behavior and the correction

Polygram 0.40.0 and the separate infra-agent were activated on October 15.
Direct Netdata and maintenance Telegram sends bypass Polygram's transcript.
The external jobs do enter Admin, but the separate controller holds claims until
report delivery is final. The observed jobs completed with report state `unknown`;
the controller then generated the same fallback warning every five minutes,
also outside history. This is an operational failure, not successful follow-up.

IPC `send` already calls Polygram's normal `tg()` transport, which records pending
outbound rows and Telegram results. It does not wake a session, give callers a
stable notification identity, or make recording failure fatal. History preload
runs when a session starts; an existing session does not automatically receive
new outbound rows. Reusing `send` alone therefore does not close the requirement.

The correction is a small generic recorded-notification intake and a conversation
consumer. A thin Netdata adapter supplies input; it does not manage incidents.

## Ownership and data flow

```text
Netdata APIs ── thin source adapter ──┐
maintenance notification producers ─┴─> Polygram recorded notification
                                      ├─> Telegram, through existing transport
                                      └─> topic history + unread batch
                                              ↓
                                      existing Admin session
                                              ├─> ordinary recorded reply
                                              └─> scheduled follow-up wake
```

| Owner | Durable state |
| --- | --- |
| Netdata | Alarm configuration, current state, retained transitions |
| Source adapter | Host identity/epoch, source cursor, compact snapshot fingerprint, pending transport envelope, coverage change marker |
| Polygram | Notification identity, transcript row and send outcome; per-conversation consumer cursor and active batch; due follow-up and external-job reference |
| Admin session | Diagnosis and decisions recorded in conversation; reads fresh Netdata state when checking recovery |

These are transport and work checkpoints, not incident records. Remove the new
path's need for incident IDs, revisions, claims, reconciliation attempts and
separate `investigating`/`resolved` states. Preserve old databases as historical
artifacts. Source fingerprints only suppress unchanged observations or establish
a current snapshot after a gap; they never establish that an incident is resolved.

## Recorded notification contract

Extend the authenticated local IPC surface with a small opt-in notification
operation alongside ordinary `send`. Use configured routes and source identifiers;
callers cannot select arbitrary session settings, cwd, permissions or execution
instructions. The original `send` behavior remains compatible.

A request carries a stable source event ID, source identity, bounded text and
bounded data. Identity is bot + configured source + event ID. Exact retries return
the same receipt; conflicting content is rejected. Commit the notification,
associated pending outbound transcript row and eligibility before acknowledging.
The row is outbound with its actual source, never a fabricated human message.
Bind a successful send to Telegram's actual message ID, chat and topic. Keep
pending/failed/unknown delivery visible and queryable in history. Recording failure
rejects intake before network send; storage failure must not silently produce an
unrecorded message. Secrets are redacted and source data is untrusted context.

Use the existing Telegram send/recording path, extending its durable behavior only
as needed to bind the notification to one row. Require the exact configured topic;
never fall back to General. Retry only definitely unsent deliveries. A crash or
lost response after sending leaves `unknown`, not permission to send again.
Notification acceptance, Telegram receipt, agent processing and health recovery
are independent facts. Telegram failure does not hide the accepted input from the
agent or prevent diagnosis. Its status must say it may not be visible to Ivan.

Persisted eligibility is explicit and restricted to configured external sources.
Agent replies, delivery-status updates, typing indicators and controller notices
are not eligible. Ordinary human messages retain their current dispatch path.

## Reading and processing

A deterministic monitor checks eligible rows for each configured destination
consumer. Its cursor is a Polygram row sequence scoped to bot + effective isolated
conversation + consumer generation, not a Telegram message ID, timestamp or Claude
session ID. Session recreation preserves progress. Route retargeting requires an
explicit new baseline; alias routes share admission and pause for the conversation.

Coalesce eligible rows into one bounded batch, initially at most 20 notifications
and 16 KiB of text, after a short 5-second settling interval. Persist the exact
batch range and stable external-job request ID before submission. One active batch
per consumer. Rows arriving during a turn remain for the next batch. Do not call an
LLM on unchanged polls. Preserve order and do not discard escalation or CLEAR
when batching; related alarms are investigated together where practical.

Reuse the existing external-job ledger, configured destination resolver, admission
lock, recovery barrier and `/automation` controls. The batch task includes exact
notification rows, delivery status and a bounded window of same-topic conversation,
including recent user questions and agent answers. History queries can retrieve
older rows by reference. A human question also receives pending external context
before its turn, so asking about a newly sent alert works while automation is busy
or paused. Context is untrusted data, not authorization. Never inject another topic.

Advance the processed cursor only after the batch's agent execution succeeds.
Acceptance, submission or a Telegram send is not processing. Check execution state
on restart using the frozen request ID. Known pre-dispatch failures retain the
batch for a bounded retry. An unknown execution is held visibly for reconciliation;
never replay it because a timeout elapsed. Failed/interrupted executions retain
input and their reason; human stop durably pauses further automatic turns.

A succeeded execution advances processing even when its report receipt is pending
or unknown. Keep the actual report outcome separately visible; do not mark it
`delivered` or block every future check to manufacture final-report evidence.
Report-only retries use existing definitely-unsent rules, without another LLM turn.
No universal exactly-once execution or Telegram delivery is promised.

## Timed checks and noise

Add a minimal durable scheduled wake for the same consumer: stable key, due time,
bounded context and references to relevant notifications. No incident lifecycle.
The Admin tool can create, replace or cancel that key in its own destination.
Each replacement increments a durable revision. Freeze the due revision in the
accepted batch and consume only that revision on success; a later replacement or
cancellation cannot be erased or resurrected by an older in-flight check.
Store it before telling Ivan that a check is scheduled. At due time, coalesce it
with unread input and submit through the same admission path, even if there are
no new notifications. Preserve it across restart and pause; after resume perform
one overdue check, not one for every missed tick. Unknown executions are held under
the same rule as batches. A fresh source read determines recovery; disappearance,
disabled checks or an unavailable source cannot be described as healthy.

Automation reports meaningful findings, changed conditions, decisions or requests
for help. An unchanged healthy poll produces neither a turn nor a message. An
unchanged unresolved condition can cause a due verification, but not an automatic
repeat of the same report. An ongoing alarm does not schedule endless immediate
checks: default recheck interval is 30 minutes and the agent can choose a later time.

Replace periodic generic fallback warnings with persisted coverage/status changes:
one notice when a failure begins, one when it changes materially or recovers.
Identical failures remain in logs and `/automation status`, without a five-minute
Telegram reminder. These notices use recorded delivery and cannot wake themselves.
If Polygram is down, retain the notice in the adapter outbox and log locally;
there is no direct Telegram bypass that recreates invisible conversation context.

## Netdata adapter and non-Netdata producers

Poll every 60 seconds using the existing local loopback and BatchMode SSH access.
Read `/api/v1/alarms?all` for current evidence and incremental `/api/v1/alarm_log`
for transitions. Netdata retains a finite log, not an unlimited journal. Sort by
source unique ID, deduplicate with host identity/epoch, and advance the source
cursor only after notifications are durably accepted by Polygram. Agent completion
and Telegram receipt do not gate source ingestion. Retain unsent envelopes until
acceptance; a lost IPC reply resubmits the same identity. Bound queue size and fail
visibly without dropping oldest evidence when full.

First enablement first reads and durably records a trustworthy source log
high-water fence, then takes the current snapshot and reads transitions above the
fence with an overlapping boundary. Emit current WARNING / CRITICAL conditions
once, retain every later transition, and deduplicate overlapping snapshot/log
observations. Never advance the fence merely to a later snapshot's high-water ID.
The same ordering applies at cutover or gap rebaseline, so a transition between
reads cannot disappear. Do not replay history at or below the initial fence.
Include a cursor-boundary check when catching up; unique IDs need not be numerically contiguous. A reset,
missing cursor boundary, incomplete result, empty log behind an advanced snapshot
cursor, invalid JSON or unreachable source means coverage is incomplete. Preserve
the gap, reconcile the full current snapshot and label any snapshot-derived input.
Do not claim all brief transitions were recovered or treat missing history as CLEAR.
One coverage notice per change avoids a new flood from the coverage monitor itself.

Earlier VPS collection could not use `alarm_log`; the current exact endpoint,
response and version must be established before cutover. Verify this read path and
retention on each host. If a supported history API is required, document and use
its actual paging/boundary semantics. Until transition coverage is demonstrated,
keep that host's existing notification path and mark the integration incomplete;
do not silently replace it with snapshots or claim full host acceptance.

After a host's acceptance gate, choose the adapter as its one Telegram notification
owner and disable only the previous Telegram notification route for those alarms.
Do not disable health evaluation or Netdata's event history. Do not run native
Telegram sends and adapter sends together. Inventory the actual recipient/role
routing first. The adapter applies a deterministic destination/severity policy
from that inventory: only configured WARNING/CRITICAL transitions and an applicable
CLEAR for an alarm previously raised through this route become notifications.
Administrative, disabled, unselected and non-notifying changes update source
checkpoints without Telegram output or an agent wake. Source history remains
available for diagnosis. Document any deliberate difference from native Netdata
notification delay/repeat policy before changing the host's notification owner;
do not accidentally implement Netdata's whole notification engine in the adapter.
Business alarms retain deterministic ownership labels in the input.
No automatic cross-bot messages or business-job retries are added.

`cargo-sweep` and `orphan-sweep` produce notifications outside Netdata. Route those
existing producer messages through the same recorded intake with stable spool IDs,
leaving their cleanup behavior intact. Keep them as explicitly sourced maintenance
messages; do not invent persistent alarm state from a one-time notification.
Converting their durable conditions into custom Netdata checks is a separate,
optional monitoring change, not a prerequisite for shared history. Inventory other
direct senders before claiming all chat alerts are covered.

## Alternatives considered

- Keep the deployed incident controller and fix report ACKs: still duplicates
  Netdata state and leaves direct notification/history divergence. Replace it.
- Only store notifications through IPC `send`: closes ordinary history recording,
  but resumed sessions still need unread context, batching and timed checks.
- Drive everything from current active snapshots: misses short warning/clear cycles
  and can misdescribe disappearance. Use history plus explicit gap reconciliation.
- Netdata notification hook alone: can preserve notification policy, but requires
  durable host-side retries and does not provide catch-up/current-state evidence.
  Prefer the existing polling access; revisit only if installed API evidence forces it.
- External incident SaaS or a broker: no demonstrated need; adds another authority,
  deployment and failure boundary.

## Migration and implementation units

U1. Add recorded-notification intake and scoped history references using the existing
IPC and Telegram recorder (`lib/handlers/ipc-send.js`, `lib/telegram/api.js`,
`lib/db.js`, additive migration). Pin the bypass and storage-failure regressions first.

U2. Add generic conversation consumption and minimal due wakes beside
`lib/external-jobs/`, reusing its existing admission/pause machinery. Integrate
bounded context into resumed human turns and add read-only consumer status plus
own-destination scheduling access. Do not introduce infrastructure fields in Polygram.

U3. Reduce the separate adapter to source reads, source checkpoints/outbox and
notification formatting. Replace incident CLI instructions with Netdata reads,
history access and scheduling instructions. Change maintenance notification calls
without changing maintenance actions. Stop producing periodic fallback warnings.

U4. Review the actual diff independently, then migrate one host/source at a time
under a separately stated activation step. Before stopping the old collector,
check outstanding/running jobs and preserve all old state, source spools and report
outcomes. Stop its future submissions; drain or explicitly hold accepted work.
Never rewrite old `unknown` reports to delivered or replay historical jobs.

Use a versioned cutover record and new consumer baseline. Account for every old
pending producer envelope before switching; transfer its source identity or retain
it explicitly as historical/held, never blindly re-emit it. Start with one current
snapshot and one explanatory migration summary. Historical database import is not
required for diagnosis; make old records available for deliberate read-only lookup.
Keep previous configs/binaries and checkpoints for rollback. Rollback stops the new
consumer/producer route before restoring one old notification owner; never run two.
Update `INFRASTRUCTURE.md` only when the actual deployed wiring changes.

## Acceptance and review gates

Bug fixes require concrete failing-then-passing regression evidence under `AGENTS.md`.
Use Node 24.4.0 for native SQLite; do not change Orchestra/Claude pins. Tests are
chosen for the affected contracts, followed by one authorized real canary; pure
unit success is not proof of the business outcome.

- The exact notification text/source/topic exists in history before its wake;
  Telegram success binds the real message ID. Storage failure sends nothing.
- Ivan asks “Что это?” replying to that notification in a resumed session; the
  assistant identifies it and explains its actual source and investigation status.
  A fresh session and paused automation retain the same history visibility.
- A burst becomes one bounded turn; own replies and status notices cause none.
  New rows during execution remain pending, restart loses none, and two workers
  cannot process the same batch concurrently.
- A succeeded job with `report_state=unknown` preserves that fact and still permits
  later input and due checks. An unknown execution is not silently retried.
- A check scheduled a few minutes ahead actually runs without new alerts, including
  restart and pause/resume cases. Verify its persisted schedule and execution,
  not merely the assistant's promise that it scheduled something. Replace or cancel
  a key during its running check; completion consumes only the frozen revision
  and leaves the newer replacement/cancellation intact.
- A prolonged identical failure produces one recorded notice, not recurring spam;
  recovery produces one restoration notice. No unrecorded direct fallback is used.
- Both hosts demonstrate transition reads, snapshot reconciliation, reset/gap
  detection and finite-retention behavior. WARNING followed by CLEAR between polls
  is represented. A transition between fence and snapshot reads survives initial
  baseline, cutover and gap recovery; an excluded transition produces neither
  Telegram output nor a turn. Missing/disabled/unreachable is never reported as recovery.
- Lost IPC ACK and ambiguous Telegram send do not duplicate source work or LLM
  execution. Source ingestion, processing and reporting have separate readback.
- Maintenance notifications appear with their own source and do not change cleanup
  behavior. Cutover preserves old databases/spools and starts no historical replay.

Independent review should focus on simplicity/ownership, resumed-session context,
and crash/gap/cutover semantics. The unresolved production gate is the installed
VPS history API behavior; it is not permission to add another incident database.
No runtime or production change is part of this spec update.

## Evidence and sources

- `lib/handlers/ipc-send.js`, `lib/telegram/api.js`: existing recorded IPC send;
  recording failures currently log and continue, requiring the durable opt-in path.
- `lib/history.js`, `lib/history-preload.js`, `lib/prompt.js`: scoped history and
  session-start preload; resumed context requires explicit handling.
- `lib/external-jobs/{runtime,service,store,delivery}.js`: configured destination,
  execution ledger, admission/pause and independent report outcomes to reuse.
- Separate adapter at `infra-agent/lib/{netdata,collector,controller}.js` and
  `infra-agent/scripts/infra.js`: extraction source and five-minute fallback.
- Host deployment evidence: `INFRASTRUCTURE.md`, section “Home Admin infrastructure
  caretaker — 2026-10-15”; production assertions must be refreshed before migration.
- [Netdata Health API](https://learn.netdata.cloud/docs/alerts-%26-notifications/health-api-calls):
  enabled/raised alerts, incremental log reads and configurable retention. This
  shapes the source cursor and gap contract; snapshot polling alone is insufficient.
