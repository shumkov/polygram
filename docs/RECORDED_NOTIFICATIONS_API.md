# Recorded external notifications

This opt-in interface is local source code only. It does not activate collection,
change production notification ownership, or authorize repairs. It requires the
existing enabled Claude CLI external-job route and an isolated configured topic.

## Configuration

Set the active bot's `notifications.enabled=true`. `sources` maps a stable source
ID to an existing `externalJobs` route ID. `eligible` defaults to true; configure
coverage/controller notices false so they cannot wake themselves. Unknown sources,
caller-selected destinations and execution settings are rejected. Ordinary IPC
`send` keeps its existing behavior.

`consumers` configures one consumer per effective conversation. Give each an
explicit generation, routeId and baseline (the recorded-notification row sequence,
not a Telegram ID). Baseline 0 includes all accepted rows in a fresh notification
ledger; it does not import old messages or jobs. Session recreation preserves the
cursor. A changed destination requires a new generation and an explicit baseline.
Aliases share the external-job conversation lock and durable pause.

See `config.example.json` for disabled examples. Typical source IDs are host name,
`<host>-coverage`, `<host>-cargo-sweep` and `<host>-orphan-sweep`. Add only sources
whose ownership and migration are accounted for.

## Authenticated IPC

Use the public `polygram` package's `call`, `readSecret`, `socketPathFor` helpers.
All operations use the existing per-bot authenticated Unix socket.

| Operation | Request | Result |
| --- | --- | --- |
| `notify` | `{sourceId,eventId,text,data}` | `{accepted,duplicate,notification}` |
| `notification_get` | `{sourceId,eventId}` | `{notification}` |
| `notification_status` | `{scope}` | `{consumers}` |
| `notification_wake` | `{scope,key,dueAt,context,notificationIds}` | `{key,revision,dueAt}` |

Text is at most 4096 UTF-8 bytes. Canonical serialized text plus data is at most
8192 bytes; data must be a JSON object. Identity is bot + sourceId + eventId.
Exact retries return the same recorded identity. Changed content conflicts, even
when the route changes. Recognized secrets are redacted before persistence/send.

`notify` commits the notification, actual-source outbound transcript row and
eligibility in one transaction before its ACK. Telegram sends happen afterward.
Storage refusal sends nothing. Acceptance is not proof that Ivan saw the message,
the agent processed it, a report arrived, or a health condition recovered.

Delivery states are pending, sending, delivered, failed (definitely unsent) and
unknown. Unknown delivery is never retried. A successful receipt must identify
the real Telegram message, exact chat and topic; no General-topic fallback.
`notification_get` and history expose delivery and associated execution/report
state independently. Startup turns interrupted sending into unknown. Definitely
unsent delivery retries reuse the same transcript row after 60 seconds.

## Conversation processing and checks

The monitor settles input for 5 seconds, then freezes an ordered batch of at most
20 notifications and 16 KiB of notification text, bounded by the external-job
serialized-envelope limit. It includes bounded exact-topic history. It persists
the request before submission and reuses that identity after a lost ACK/restart.
One batch is active per consumer. Telegram delivery and processing run independently.
An unchanged poll makes no model call. Own replies/status messages are ineligible.

Only successful agent execution advances the consumer cursor. Unknown, failed and
interrupted execution retains its input and reason. Unknown is never replayed.
Successful execution advances even when report delivery is unknown; that report
state remains in the existing external-job ledger and notification history link.
Pre-acceptance submission failures retry up to five times, 60 seconds apart, then
remain visibly held. Once the external-job ledger accepts the request, existing
admission deferrals (busy session, recovery, authentication or spawn) retain the
same queued identity and use the existing 60-second polling without another LLM
execution. This change adds no exhaustion policy to that existing queue. Existing
recovery, pause and definitely-unsent report retry rules remain authoritative. `/automation status` includes unread, active processing,
last execution/report and due-check counts. Human stop durably pauses automation.

Every human turn, including a resumed or paused session, receives bounded unread
source context. A reply to a processed notification also receives that exact
notification's source, receipt and associated processing state. Older rows remain
available through the history skill and stable notification references.

The daemon includes an own-conversation notification tool command in current
human/automatic turns. Its opaque scope cannot choose a different destination and
expires at daemon restart; use the current turn's command. `status` is read-only.
`schedule` requires a stable key, future dueAt in epoch milliseconds, bounded
context and at most 20 same-conversation notification IDs. At most 10 active keys
are allowed. `cancel` sets dueAt null. Persisted schedules survive restart/pause.
Every replace/cancel increments a revision; an older batch consumes only the
revision it froze. Overdue checks coalesce with unread input, without replaying
missed ticks. The usual unresolved recheck is 30 minutes or later. A successful
persisted response is required before telling Ivan that a check is scheduled.

## Cutover and remaining acceptance

No old incident DB, job, producer spool or unknown report is imported, changed or
replayed by this migration. Before activation, inventory outstanding/running old
jobs and producer envelopes; stop future old submissions and explicitly drain or
hold accepted work. Preserve old state and config/binaries. Write a versioned
cutover record with baseline, source IDs, held envelope/job identities and rollback.

Establish history/retention behavior and notification recipient policy on each
host before selecting the adapter as its one notification owner. Disable only the
old Telegram route after that host passes; keep Netdata health and history intact.
A blocked host retains its current owner. Rollback stops the new route first.

Still required live: one authorized same-topic notification/reply canary, resumed
and paused visibility, autonomous timed execution/restart, finite-retention/cap
behavior, and notification-owner cutover. Offline tests do not prove these gates.

## Explicit inspection after unknown execution

A privileged local caller can request one fresh diagnostic inspection of a held
batch through authenticated IPC operation `notification_reinspect`:

```json
{"consumerId":"admin","generation":"recorded-v1","requestId":"notifications:<held-uuid>","recoveryRequestId":"inspection:<new-uuid>","acknowledgeUnknown":true}
```

This mutation requires deliberate operator authorization. The IPC boundary is the
existing same-user secret/socket boundary; it does not distinguish the operator
from agent processes running as that user. It is absent from the agent-facing
notification helper. It is never invoked by status reads, startup, or a timer.

The exact current generation and held request must match an original `unknown`
execution. Polygram first recovers the session without sending a task and proves
it idle under its admission lock. Inconclusive evidence leaves the batch held.
It then freezes a separate inspection input and identity in the existing batch.
The original job, outcome, input, report and frozen batch fields remain intact;
only its inactivity marker can change after positive runtime evidence.

The fresh task receives the original notifications/checks, the unknown receipt,
and a bounded current history snapshot. It asks for current evidence and warns
against replaying actions or reports. These are task instructions, not technical
read-only restrictions: a new execution can still duplicate effects. It grants
no additional repair authority.

Repeating the same request returns the same inspection identity even while it is
running or after completion. A competing identity conflicts. Normal dispatch
independently rechecks destination, pause and process readiness. Only successful
inspection advances the original batch bound and original wake revisions; later
notifications remain unread. An unknown or failed inspection stays held and
cannot create a second inspection chain. Original report parts are not replayed
by this mutation. Status includes the original batch state and nested `recovery`
receipt; successful processing history points to the new successful job.
