# External conversation jobs

Protocol version: 1. This is an authenticated local IPC interface for trusted
same-user applications. It uses the public `require('polygram')` client. Route
allowlisting does not isolate clients sharing the bot's IPC credential.

## Configuration

`bots.<bot>.externalJobs` contains `enabled`, optional `maxPending` (default
1000), optional `maxConcurrent` (default 4), and `routes`, an object whose keys
identify configured destinations. Jobs for different conversations run
concurrently, up to `maxConcurrent` dispatched turns at once; each
conversation still runs one job at a time, in submission order. A busy
conversation keeps its job queued until the next scheduling pass (a submit, a
resume, a finished turn or the 60-second timer).
Each route has `chatId` and optional `threadId`. Forum destinations require an
explicit configured isolated topic, or `"general": true` with no `threadId` for
the forum's General topic. General is the session polygram keys by the bare
chat id, and its reports post without `message_thread_id`. The flag must be
exactly `true`, and a route may not combine it with a `threadId`. In a forum
without `isolateTopics`, every topic shares that session, but `/automation`
only works when sent in General. Version 1 dispatch supports the Claude CLI and
Codex backends; a Codex destination is admitted only while its process is idle
(or proven idle with no process), and its final text is the report. Mailbox
deliveries are the tested Codex use; a notification consumer on a Codex
route fails at boot.
Every job's task gets one more paragraph at dispatch, after the stored task:
the final text is posted to the people in the chat, so the turn writes one only
when a person there needs to know something (a result, a problem found, a
decision they must make), to them and in their current language, and otherwise
ends with no text. While the turn runs the chat shows typing; a mailbox job's
card also gets the status reactions a human message gets, ending 👍. See
[`JOB_TURN_VOICE_SPEC.md`](./JOB_TURN_VOICE_SPEC.md).
Route names and request IDs are nonempty bounded strings; request IDs must be
stable across transport retries. The `mailbox:` and `mailbox-notice:` request
ID prefixes are reserved for the [session mailbox](./MAILBOX.md); jobs using
them are withdrawn unsent while the mailbox is off. Destinations are frozen at
acceptance.

## Operations

All successful responses have the IPC envelope `ok: true`.

- `external_jobs_info` with no payload returns `protocolVersion: 1`, `enabled`
  and `supportedBackends: ["cli", "codex"]`.
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
render like a non-streamed final reply: rich in a rich-enabled chat, otherwise
Telegram HTML, with one plain-text retry when Telegram refuses the HTML. They
go to the frozen destination without chat-root fallback; a rich send into a
deleted topic lands in General and its receipt records that. A rich attempt
whose outcome is unknown is never followed by another send. Unlike a rich
reply, which is one message, a long report is split into parts of up to 3500
characters first, and each part renders as its own message. Ordinary
reports are durably split into parts before sending; only definitively unsent
parts may retry. Sending with a lost receipt becomes `unknown`. Channels
acknowledgement alone does not prove final-report completion.

## Operator controls

`/automation status`, `/automation pause` and `/automation resume` operate in
configured destinations for the configured human operator. A stop also persists
pause before interrupting current work, including while idle. Alias routes share
pause by effective session. If pause persistence fails, the daemon keeps an
in-memory hold, still attempts interruption and warns the operator. Repair
storage before restarting: that emergency hold cannot survive process exit.
Human conversation continues while paused.
No IPC operation resumes automation.

## Compatibility and limitations

Clients negotiate the protocol before submitting. A daemon without version 1
must be reported as incompatible; never fall back to notification-only `send`
and call that a job submission. No exactly-once model side effects or Telegram
delivery is promised. Domain workflows, schedules and outcome verification
belong to the calling application.
