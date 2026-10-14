# Admin infrastructure automation

This release implements automatic diagnosis and reporting for the existing
Admin Claude CLI session. No automatic repair action is enabled. The agent
may propose a repair; the operator must explicitly direct it in conversation.
The agent still has its configured shell permissions: this is operating policy,
not an OS sandbox or a privileged action executor.

## Configure and activate

Use the canonical `polygram-deploy` procedure for the reviewed release. Keep the
Orchestra/Claude pins unchanged. Configure `bots.shumorobot.infraAdmin` using
`config.example.json`, with chat `-1003807211164` and topic `2995` for this host.
The chat must belong to this bot, isolate topics, and include that topic. Set
`operatorUserId` (or the existing positive `adminChatId`) to the operator's user
ID. The actual selected process must be Claude CLI; SDK fallback leaves work
queued with a visible failure notification.

Enable only after checking the host inventory, SSH read access and source names.
`sources` is the event-source/host allowlist. `hosts` is the collector's configured
Netdata read targets; these names must agree with `sources.netdata.hosts`.
Local reads use loopback port 19999; remote reads use BatchMode SSH and loopback
on that host. No Netdata notification configuration change is required.

Install a rendered copy of `ops/infra-collector.plist.example` as a user
LaunchAgent. Replace every placeholder with absolute paths; use the same Node
major as the installed release's native SQLite dependency and its stable runtime
path. The collector runs every minute and writes no prompts for unchanged
healthy observations. Keep its log in the existing rotation policy.

First activation seeds current raised alarms and records a history baseline.
It does not act on every historical Telegram alert. Keep the existing Netdata
Telegram notifications as the independent human-visible feed.

## Maintenance producers

`notify` both retains an event for the agent and invokes the configured original
Telegram notifier. Copy/preserve that original notifier outside any wrapper
path, and set `notificationCommand` to its absolute path. It must never call
`polygram-infra` or emit intake events; otherwise failure reports can loop.

At each selected producer, replace only its Admin-topic notification call with:

```sh
printf '%s' "$message" | /absolute/path/to/polygram-infra \
  --bot shumorobot --data-dir /Users/ivanshumkov/.polygram \
  --host shumabook --resource orphan-sweep --state WARNING notify
```

Use the actual producer identity (`cargo-sweep`, `orphan-sweep`, etc.) as resource.
Pass state explicitly from the producer's decision: `WARNING`, `CRITICAL`,
`CLEAR`, or `UNKNOWN`. For cargo-sweep, its low-space branch passes `WARNING`
and both existing recovered-space branches pass `CLEAR`. Do not replace its
shared notify function with a wrapper that assigns the same state to every call.
State is never inferred from notification wording. A producer `CLEAR` represents
its fresh successful health check and uses the same host/resource as the alert.
Do not use one generic resource for unrelated jobs. Preserve the producer's
existing handling of notification errors; a nonzero result means the agent
handoff or notification needs attention. Telegram delivery is attempted even
when the event spool cannot be opened. When automation is disabled, `notify`
still uses the configured original notifier without creating an event.
Input is drained with bounded memory, retaining the original notifier's first
3900 Unicode characters. Incident evidence keeps a marked, bounded excerpt.

The local inventory found `cargo-sweep-cleanup.sh` and `orphan-sweep.sh` calling
`/usr/local/bin/notify-telegram.sh`. These are the initial maintenance adapters.
Do not redirect notifications for other topics (for example budget notices).
Other direct Telegram senders and VPS maintenance producers need an explicit
inventory before claiming complete maintenance coverage.

## Controls and inspection

In the Admin topic, the operator can use `/infra status`, `/infra pause`, and
`/infra resume`. An operator stop also persists a pause even when no turn is
running. Pause survives daemon restart and session reset; incoming alerts remain
recorded. Resume is an explicit Telegram operator action, unavailable over IPC.

```sh
polygram-infra --bot shumorobot status
polygram-infra --bot shumorobot list
polygram-infra --bot shumorobot get INCIDENT_ID
polygram-infra --bot shumorobot verify INCIDENT_ID
printf '%s' '{"incidentId":"ID","revision":1,"summary":"Investigating","nextCheckAt":1792000000000}' |
  polygram-infra --bot shumorobot update
```

`nextCheckAt` is an epoch-millisecond future time. Updates require the latest
revision; after a conflict read the incident again. `list` and `get` return up to
100 records and `nextBefore`; repeat with `--before CURSOR` until it is null.
Lists use stable creation order so updating an incident does not move it between
pages. Resolution requires a CLEAR snapshot no older than five minutes plus
explicit verification. `verify` reads the configured Netdata host directly and
returns the current incident revision. Unchanged health refreshes evidence
without a new autonomous turn; changed health enters durable event intake.
Disappearance, disabled checks and loss of
contact are UNKNOWN, never recovery. Only new events, due follow-ups and bounded
delivery retries wake the agent. Unresolved incidents get a default follow-up
after 30 minutes if the agent did not schedule one.

For maintenance without a new producer notification, the agent can perform an
independent read-only check using that producer's documented health criterion.
It then passes JSON to `polygram-infra --bot shumorobot observe`: `source`, `host`,
`resource`, `state`, `observedAt`, and `evidence` with `kind: "snapshot"` and a
`summary` recording the actual check and result. An event ID is generated by the
CLI. Read the incident again before updating its workflow state. This interface
records a trusted operator/agent observation; it does not execute or attest the
diagnostic command. Missing evidence means blocked/unresolved, never invented
recovery. It cannot approve a repair or resume automation.

When alarm history is unavailable but a current Netdata snapshot is valid,
current resource states remain usable. A separate collector incident reports
`log-unavailable`, and the history cursor is retained for later recovery. The
initial VPS check found exactly this condition (Netdata v2.10.3, HTTP 200 with an
empty `alarm_log` body). Short transitions during this gap cannot be guaranteed
until the source's history endpoint works; source-daemon repair is separate work.

Events live in the bot's SQLite DB, separately from Telegram message IDs.
Producer state lives under `<data-dir>/infra/<bot>/`: `collector.sqlite` holds
accepted cursors and frozen pending cycles; `spool/spool.sqlite` retains unsent
events. These files and directories are owner-only. Do not delete or reset them
to retry an outage; lost cursors can replay old identities or skip coverage.
Dead collector/drainer owners recover automatically. A still-live or reused PID
is conservatively treated as owning the run; inspect it before intervention.

## Acceptance and rollback

Local automated coverage uses temporary databases, synthetic alarms, local IPC
and injected runtime/transport boundaries. It does not prove a real Claude turn
or Telegram delivery. After the reviewed release is installed, confirm:

1. A controlled accepted event appears once in incident lookup and reaches only
   Admin. The existing session is reused, and IPC busy includes the diagnosis.
2. A fresh healthy source observation and verification close the incident;
   command success or message delivery alone cannot close it.
3. Pause prevents a new autonomous turn, including after restart, while intake
   continues. Resume starts pending work.
4. A temporary intake outage leaves source events pending, then retries with
   the same identities; a notification failure never generates another event.

Disable the collector LaunchAgent and pause automation to stop new work. Keep
the original Telegram notifier and durable event files. Disable `infraAdmin`
in configuration on a normal controlled restart for a complete rollback.

The Mac owns the agent and collector. If it is offline, it cannot respond to an
incident or announce its own absence. Always-on hosting and independent freshness
monitoring are separate deployment work; no 24/7 availability is claimed here.
