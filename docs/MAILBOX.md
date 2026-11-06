# Session mailbox

The mailbox lets one role session ask or tell another role session of the same
bot, and reply to asks it receives. Polygram is only the transport: it stamps
the sender, stores every message, delivers it as a new turn when the target is
idle, enforces limits, and mirrors each message into Telegram. Design:
[`session-mailbox-spec.md`](./session-mailbox-spec.md).

Phase 1 delivers only to Claude CLI sessions of one bot on one host.

## Requirements

- [External jobs](./EXTERNAL_JOBS_API.md) are enabled. Messages travel as
  external jobs, so pause, idle-only admission and job reports apply.
- Each role is an existing session: a non-forum chat, or an isolated topic
  (`isolateTopics: true`) on the CLI backend. Groups that run with
  `isolateTopics: false` don't qualify; give the organization its own forum
  group.
- Each role key is also an `externalJobs.routes` key that points at that
  session. No two roles may share a session.

Boot fails on any configuration error, so a typo can't silently weaken the
rules.

## Configuration

```json
"externalJobs": { "enabled": true, "maxConcurrent": 4, "routes": {
  "orchestrator": { "chatId": "-100…", "threadId": "11" },
  "marketing":    { "chatId": "-100…", "threadId": "12" } } },
"mailbox": {
  "enabled": true,
  "roles": {
    "orchestrator": { "about": "Owns strategy; routes work" },
    "marketing":    { "about": "Campaigns, content, ads" } },
  "allow": { "orchestrator": ["*"], "marketing": ["orchestrator"] },
  "mirror": true,
  "limits": { "maxDepth": 2, "perPairPerHour": 10, "maxBodyBytes": 3500 } }
```

| Key | Meaning |
|---|---|
| `enabled` | Must be `true`. Without a `mailbox` key nothing changes. |
| `roles.<name>` | Role name = route id, `^[a-z][a-z0-9_-]*$`. `about` (≤ 300 characters) is shown to the roles allowed to message it. |
| `allow.<name>` | Roles this role may start an `ask` or `tell` to; `"*"` means every role. A role without an entry can only reply. Replies are never checked against it. |
| `mirror` | Post each message into the target role's topic. Default `true`. |
| `limits.maxDepth` | Longest chain. A human message starts at depth 0, and each new message is one deeper. Default 2. |
| `limits.perPairPerHour` | Asks and tells per (from, to) pair in the last hour. Default 10. |
| `limits.maxBodyBytes` | Body size in UTF-8 bytes, before and after redaction. Default and maximum 3500, so a mirror fits one Telegram message. |

External jobs now run different conversations concurrently, up to
`externalJobs.maxConcurrent` (default 4). Each conversation still runs one job
at a time.

## What agents do

Role sessions get instructions in every prompt: their role, the roles they may
message, and two commands from the `mailbox` skill:

```
POLYGRAM_IPC_DIR="…" node …/skills/mailbox/scripts/msg.js <bot> <token> send  '{"to":"marketing","kind":"ask","body":"…"}'
POLYGRAM_IPC_DIR="…" node …/skills/mailbox/scripts/msg.js <bot> <token> reply '{"id":"m_…","body":"…"}'
```

The command names the daemon's IPC directory itself, because a CLI session
inherits its environment from whoever started the tmux server, which is often
not the daemon; `msg.js` reads the socket and the 0600 secret file there, so the
sessions must run as the daemon's user. The token identifies the session. It lives in memory, so a restart issues new
ones. Both commands return `{id, state}` right away, where `state` is the
message's delivery state: `queued` or `paused` for a new message; a duplicate
reports where its original delivery stands (`running`, `succeeded`, `failed`,
`interrupted` or `unknown`).

The target receives a new turn when it is idle. The trusted header reads
`[Inter-session message] from=role:… to=role:… kind=… id=… isUser=false`,
followed by a statement that the message is not a human instruction or
authorization. The body travels as untrusted input. A reply arrives in the
asker's session as a new turn that quotes the original ask. The target's final
text lands in its own topic through the normal job report.

## Rules

- `ask` and `tell` need the target on the sender's allowlist. No role may
  message itself.
- Exactly one reply per ask, only from the role it was addressed to. An
  identical retried reply returns the stored one. Nothing is forwarded
  automatically.
- Depth: a turn started by a human is depth 0, and a mailbox delivery has its
  message's depth. Any other automation turn (notifications, notices) is at
  `maxDepth`, so it can reply but not start a chain.
- Rate: at most `perPairPerHour` asks and tells per pair.
- The same (from, to, kind, body) within ten minutes returns the existing message
  with `duplicate: true`, unless the sender already had a notice about it; then
  it is a deliberate re-ask and creates a new message.
- Bodies are redacted before they are stored, hashed or mirrored.

## Notices and recovery

When the job delivering an ask settles and the ask still has no reply, the
asker gets one notice from `system:polygram`. The reason is one of: the turn
ended without a reply, delivery failed, the turn was interrupted, or delivery
is uncertain. The ask stays open, and a late reply still arrives. If a reply,
on time or late, has its own delivery fail, get interrupted or become
uncertain, the asker gets one notice about that reply; the ask already has its
one reply, so the asker must ask again.

A mailbox job left `unknown` (for example after a restart mid-turn) is never
replayed. The mailbox runs the same respawn-and-probe recovery that
`notification_reinspect` uses, so the session's queue unblocks. It retries
with backoff from 1 to 30 minutes while the session is paused or busy.

## Human control

- `/automation pause|resume` from the operator in a role's topic pauses or
  resumes delivery into that role. The operator's `/stop` also pauses. A pause
  holds that topic's job reports too.
- `mailbox.enabled: false` (then restart) stops all delivery. Queued mailbox
  jobs are withdrawn unsent as `failed` with error `withdrawn`, and the role's
  other jobs keep flowing.
- Renaming or moving a role requires an empty queue first. Queued jobs keep
  their original destination and are held by the route check if it changes.

## Inspecting

Messages live in `mailbox_messages`; delivery state lives in `external_jobs`
under `request_id = 'mailbox:' || id` (notices: `'mailbox-notice:' || askId`,
or `|| replyId` for a reply that was not delivered).

```sql
SELECT m.id, m.kind, m.from_addr, m.to_addr, m.depth, m.notice_sent, j.state, j.report_state, j.error
FROM mailbox_messages m
LEFT JOIN external_jobs j ON j.route_id = m.route_id AND j.request_id = 'mailbox:' || m.id
ORDER BY m.created_at DESC LIMIT 20;
```

## Not yet hardened

Tokens last until restart, and agents can read the bot's IPC secret, so a
determined agent could submit an external job directly. Mirror rows also enter
topic history without an untrusted tag. These and the wider volume caps are
listed under "Stage 2" in the spec. Run the mailbox only among roles you
already trust with each other's topics.
