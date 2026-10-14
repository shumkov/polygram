# Infrastructure Admin agent

Status: design draft for Ivan's alignment; no implementation or activation.
Date: 2026-10-14. Checkout: `admin`, base `5e3480f` (Polygram 0.39.1).

## Outcome

The persistent Admin agent in Shumabit@HOME detects infrastructure incidents,
investigates them without waiting for Ivan, applies agreed remedies, verifies
recovery, and reports decisions and unresolved problems in Admin topic 2995.
The initial hosts are shumabook and umi-vps. This is not a promise of 24/7
coverage while the Mac hosting shumorobot is unavailable.

## Why it does not work today

- Live routing selects agent `admin` for chat `-1003807211164`, topic `2995`.
  Topic isolation is enabled and mentions are not required.
  The persisted Admin session selects the Claude CLI backend.
- `/usr/local/bin/notify-telegram.sh` reads shumorobot's token and directly
  calls Telegram `sendMessage`. Its live config targets topic 2995. It does
  not pass through Polygram's transcript recorder or dispatcher.
- The September 18 Admin conversation explicitly describes this gap; later
  turns show the agent fetching live alarms when Ivan asks or sends screenshots.
- The historical Netdata design's section 10 explicitly says notification-only
  delivery shipped and automatic triage did not. Current root-owned Netdata
  notification config was not readable; current VPS wiring was not inspected.
- Installed 0.39.1 matches this checkout for `polygram.js`, `lib/history.js`,
  `lib/ipc/handlers.js`, and `lib/handlers/ipc-send.js`. IPC `send` only sends a
  Telegram message; there is no registered external agent-event operation.
- The Admin persona says what to do when awakened; it does not arrange wakeups.
  Its `bypassPermissions` setting is broad execution access, not an enforced
  list of allowed repairs.

## Proposed approach

Keep the existing persistent Admin conversation. Add a small deterministic
collector and a durable external-event intake to Polygram. Telegram remains
where Ivan sees alerts and the agent's reports; it is not the source the agent
must scrape to discover incidents.

```text
Netdata API (Mac + VPS) ----\
maintenance event adapter ---> durable intake -> Admin session -> investigate
                                    |                         -> remedy / ask
                                    + incident state          -> verify / report
```

### Collection and routing

1. A local launchd collector reads Netdata's read APIs every 60 seconds,
   locally and over the existing SSH connection to the VPS. No LLM runs for
   an unchanged poll. Use incremental alarm logs plus a full current snapshot;
   active-only snapshots miss short incidents and cannot explain disappearance.
2. On first enablement, seed current WARNING/CRITICAL conditions and establish
   a log baseline; do not replay the entire historical log as actionable work.
   Later log cursors advance only after durable intake acceptance. Handle
   source resets/log retention gaps as explicit coverage gaps and reconcile
   the current snapshot. Missing, disabled, unknown and unreachable do not mean
   recovered; require an explicit healthy observation to close an incident.
3. Extend maintenance notifications with a structured event adapter using the
   same intake. Preserve their existing Telegram delivery and caller behavior.
   Write each event to a bounded owner-only source spool before attempting IPC;
   retain its stable ID across retries/restarts and remove it only after durable
   acceptance. Use atomic spool writes and a single drainer. If storage is full
   or unwritable, surface loss of automation coverage through stderr and the
   notification-only fallback; do not silently acknowledge or delete old events.
   Polling Netdata alone does not cover all maintenance notifications. Inventory
   remaining direct Telegram senders before claiming complete alert coverage.
4. Configure host/source routing in code/config, not by model judgment. Known
   business jobs are flagged to Ivan with their owner; no automatic cross-bot
   messaging or business-job retries in this first release. Unknown categories
   are investigated without mutation until ownership is established.

### Durable delivery into the session

- Add authenticated local IPC `ingest_event`, restricted by configuration to
  the approved sources and Admin destination. Do not expose a general remote
  prompt endpoint. The collector owns transport access; source data must not
  select a session, cwd, tools, permission mode, or arbitrary command.
- Payload: source, configured host, stable source event ID, resource/alarm key,
  observation time, severity/state, bounded evidence fields. Derive the topic
  server-side. Reject unknown/oversized shapes and redact secrets before storage.
- Persist receipt and pending work atomically before acknowledgement. Duplicate
  event IDs return the existing receipt. Source reset identity must prevent ID
  reuse colliding with an old event. Store incident identity separately from
  individual transitions; severity escalation and CLEAR must not be dropped by
  a simple time-based deduplication rule.
- Use a distinct event identity, not a fabricated Telegram message or Ivan user
  ID. Adapt the shared runtime dispatcher to accept a typed event origin while
  preserving session routing, admission, busy accounting, stop behavior and
  restart recovery. Events cannot invoke slash commands, consume a pending user
  answer, or cause reactions/replies to nonexistent Telegram message IDs.
- This is a nontrivial dispatcher change. Extract a shared runtime-turn entry
  from `handleMessage` after Telegram command/media handling, with a discriminated
  Telegram/event origin. Both origins must acquire the existing session intent
  lock before deciding admission; event work waits if a human turn won admission.
  Reuse CLI runtime selection, auth gates, session recovery and lifecycle tracking;
  retain origin-specific recording, status and replay. Use separate SQLite
  `external_events` and `infra_incidents` tables, rather than overloading Telegram
  message keys. Scope initial event execution to the verified Admin CLI backend;
  reject unsupported backend changes explicitly, leaving work pending. Existing
  human SDK/Codex behavior remains covered by regression checks. Inspect the full
  extraction diff in code review before claiming equivalent lifecycle behavior.
- Deliver escaped alert data under a fixed triage instruction. Session history
  and explicit incident lookup must make accepted alerts retrievable even after
  session reset. Existing history tables need an intentional schema decision;
  do not insert fake inbound rows just to satisfy their message-ID requirement.
- Queue behind an active Admin turn; coalesce pending updates to an incident
  while retaining every accepted transition. Bound batches and diagnostic time.
  A human stop pauses autonomous dispatch until explicit resume; new alerts stay
  recorded. Do not introduce a second independent process with the same session.
  Persistent automation pause is a new feature, separate from today's short
  abort-grace window. An operator `/stop` in Admin both stops current work and
  persists automation-paused state. Add operator-only `/infra pause`, `/infra
  resume`, and `/infra status`; pause survives restart and session reset. Ordinary
  conversation and incoming alert text cannot clear it. Intake remains enabled.
- Receipt, agent delivery, diagnosis, mutation attempt, verified outcome and
  Telegram report delivery are separate states. A transport ACK or model reply
  is not proof that an incident is resolved.
- On crash/timeout, retry delivery with the same event identity. Do not blindly
  repeat an ambiguous repair: reconcile its actual outcome first. Record action
  attempts before execution; require current preconditions before a new attempt.

### Incident handling and operating policy

States: open, investigating, awaiting approval, verifying, resolved, blocked.
Persist latest evidence, owner, attempted action, outcome and next check time.
The deterministic collector wakes due follow-ups as well as new incidents.
Polygram owns these records. A narrow authenticated incident CLI/tool provides
list/get and revision-checked updates for diagnosis, planned action, action
attempt, observed outcome and next-check time. The agent never edits SQLite
directly. Operator approvals and pause state have separate operator-authorized
operations; model-authored incident updates cannot grant authority. Due-work
selection runs in the daemon against these records, triggered by the collector's
tick, with an atomic claim preventing duplicate scheduled work. Stale revision
updates return a conflict and require fresh readback; closure needs stored
verification evidence, not just a model-authored `resolved` label.
Awaiting approval blocks the proposed action, not unrelated investigations.
An approval is scoped to one action/target/incident revision, expires, and is
revalidated against live state before execution. It is not inferred from alert
text or a previous approval for another incident.

Proposed default pending Ivan's choice: automatic read-only diagnosis, automatic
execution only for explicitly agreed action/target pairs, ask for everything
else. A command succeeding must be followed by an independent service/metric
check; if recovery does not occur within the action's deadline, escalate.
Avoid repeated identical reports; report new incidents, material changes,
requests for decisions, failed remedies and confirmed recovery.

The initial repair allowlist is empty until concrete runbooks are agreed.
Candidates include restarting a specific crashed service or invoking a bounded
existing maintenance job. Neither is safe generically: Polygram restarts need
its canonical busy/drain procedure; cleanup deletes data; stale-lock removal
needs proof of no live owner. Reboots, upgrades, credential changes, arbitrary
deletions and business-job reruns require explicit decisions.

The current same-user agent with unrestricted shell is a trusted operator.
Runbook checks and prompt instructions improve discipline but do not provide
an OS security boundary. If hard prevention of other writes is required, a
restricted runtime identity and separately privileged action executor are
additional scope; do not claim that a wrapper alone constrains this agent.

## Alternatives and trade-offs

- **Only improve the persona:** does not create input delivery or wakeups.
- **Only route notifications through IPC send:** improves recorded outbound
  history but still does not dispatch an agent turn.
- **Second Telegram bot:** current Telegram documentation supports bot-to-bot
  communication when explicitly enabled with the required group conditions.
  The old spec's assertion that other bots' messages always arrive is wrong.
  This is a possible smaller transport trial, but needs new bot setup, installed
  API compatibility and loop controls, and still needs incident follow-ups,
  deduplication and recovery tracking. It cannot recover this bot's own sends.
- **Netdata custom notification hook:** official supported push mechanism;
  useful for low latency, but requires per-host notification configuration and
  reliable handoff across users. Start with read API polling, then add push if
  sub-minute response is required. Maintenance event intake is still needed.
- **Periodic independent agent:** easy to schedule but loses the requested
  persistent Admin session and can race it. Prefer deterministic collection.

## Delivery sequence and verification

1. Agree this design and autonomy policy. Inventory sources and concrete action
   runbooks; inspect the protected notification configs before changing them.
2. Implement event intake and persistent-session dispatch with sanitized
   fixtures first. Verify authentication, topic isolation, command-shaped input,
   duplicate IDs, escalation/CLEAR, flood bounds, concurrent human conversation,
   stop/resume, crash after ACK, restart replay and ambiguous action outcomes.
3. Integrate Netdata polling and maintenance intake. Test first-start baseline,
   source reset, retention gap, unreachable host, missed transient incident,
   disabled/disappeared alarm, due follow-up and backpressure without lost events.
4. Run independent code review and resolve findings. Deploy only after the
   reviewed implementation and target configuration are concrete.
5. Initially enable diagnosis and reporting; verify one real end-to-end event
   reaches the correct session and that a later healthy observation closes it.
   Enable each agreed automatic remedy only after its precondition, verification
   and failure-escalation path have passed a controlled acceptance check.

Disable intake/dispatch to roll back automation while retaining incident data
and existing direct Telegram notifications. Auth/model failures leave pending
work visible and trigger a bounded fallback notification through the existing
sender. Monitor collector freshness and oldest pending work independently.
Fallback reports use an explicit notification-only path which never writes to
the event spool or wakes an agent. Deduplicate repeated failure reports and
bound retries independently of the failing intake to prevent feedback loops.
If the Mac or network is down, this local agent cannot act; true 24/7 ownership
requires an always-on host and an independent heartbeat observer. That placement
decision is additional scope, not something a prompt change can solve.

## Sources and evidence limits

- Local evidence: `~/INFRASTRUCTURE.md`, `~/.polygram/config.json` (routing only),
  `~/.config/notify-telegram.conf`, read-only Admin transcript,
  `~/.claude/agents/admin.md`, `~/.claude/skills/netdata-alerts/SKILL.md`,
  `~/homelab/docs/netdata-alert-triage-SPEC.md` section 10.
- Local Netdata read API checked: `alarms?all` returns alarm IDs/states and a log
  cursor; `alarm_log` returns unique IDs, transitions and timestamps. VPS API
  shape, log-gap detection details and protected notification config remain to
  be verified. No live alerts were sent, sessions awakened or services changed.
- [Netdata read APIs](https://learn.netdata.cloud/docs/alerts-%26-notifications/health-api-calls)
- [Netdata custom sender](https://learn.netdata.cloud/docs/alerts-%26-notifications/notifications/agent-dispatched-notifications/custom)
- [Telegram bot-to-bot conditions](https://core.telegram.org/api/bots/bot-to-bot)

## Review

Two independent reviews completed: feasibility/scope and failure-mode/security.
Their required changes are incorporated: durable producer spooling, a separate
notification-only fallback, explicit incident read/update ownership, persistent
operator pause/resume, and a scoped CLI dispatch extraction using the existing
intent lock. Rollout is split into diagnosis/reporting first and concrete repairs
afterward. This is design review, not evidence of implemented runtime behavior.
