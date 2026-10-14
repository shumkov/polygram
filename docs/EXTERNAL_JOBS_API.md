# External conversation jobs

Protocol version: 1. This is an authenticated local IPC interface for trusted
same-user applications. It uses the public `require('polygram')` client. Route
allowlisting does not isolate clients sharing the bot's IPC credential.

## Configuration

`bots.<bot>.externalJobs` contains `enabled`, optional `maxPending` (default
1000), and `routes`, an object whose keys identify configured destinations.
Each route has `chatId` and optional `threadId`. Forum destinations require an
explicit configured isolated topic. Version 1 dispatch supports Claude CLI only.
Route names and request IDs are nonempty bounded strings; request IDs must be
stable across transport retries. Destinations are frozen at acceptance.

## Operations

All successful responses have the IPC envelope `ok: true`.

- `external_jobs_info` with no payload returns `protocolVersion: 1`, `enabled`
  and `supportedBackends: ["cli"]`.
- `external_job_submit` takes `routeId`, `requestId`, `task` (trusted text) and
  `payload` (untrusted JSON object). Returns `accepted: true`, `duplicate`,
  and `job`.
- `external_job_get` takes `routeId` and `requestId`; returns `job`.
- `external_jobs_status` takes `routeId`; returns `enabled`, `paused`, `pending`
  and `running`. It does not grant permission to resume automation.

`job` includes `routeId`, `requestId`, `state`, `reportState`, `turnId`,
`reportReceipt`, `error`, `inactive` and `paused`. The execution state is one of
`queued`, `running`, `succeeded`, `failed`, `interrupted`, `unknown`.
Report state is `none`, `pending`, `delivered` or `unknown`.
`inactive: true` requires positive runtime evidence that the old turn is no
longer active; missing process state or a timeout is insufficient.

Submission acknowledges committed storage, not agent execution. A repeated
identity with identical canonical content returns the same job. Different
content conflicts even when sanitization would produce identical stored text.
Payload plus task is bounded to 32 KiB. Queue capacity rejects before acceptance.
Completed identities remain retained. Unknown execution is never replayed by
Polygram. Callers query or retry the original identity after a lost reply.

Reports use the destination's Telegram/Channels routing. Ordinary report parts
are sent as plain text to the frozen destination, without chat-root fallback. Ordinary
reports are durably split into parts before sending; only definitively unsent
parts may retry. Sending with a lost receipt becomes `unknown`. Channels
acknowledgement alone does not prove final-report completion.

## Operator controls

`/automation status`, `/automation pause` and `/automation resume` operate in
configured destinations for the configured human operator. A stop also persists
pause before interrupting current work, including while idle. Alias routes share
pause by effective session. Human conversation continues while paused.
No IPC operation resumes automation.

## Compatibility and limitations

Clients negotiate the protocol before submitting. A daemon without version 1
must be reported as incompatible; never fall back to notification-only `send`
and call that a job submission. No exactly-once model side effects or Telegram
delivery is promised. Domain workflows, schedules and outcome verification
belong to the calling application.
