# General topic routes and identify depth (0.43.0)

## Problem

1. The external-jobs route resolver refuses every forum chat unless the route
   names an explicit configured topic. A forum's General topic has no
   `message_thread_id`, so it can never be named. Polygram already runs
   General as its own session, keyed by the bare chat id (`threadId` null),
   and replies there without `message_thread_id`. The agent organization
   wants a role whose topic is General.
2. `mailbox_identify {token}` returns only `{role}`. The agent-org layer also
   needs to know whether a human asked in the current turn, which is the
   session depth the daemon already tracks.

## Approach

### Route shape `{ chatId, general: true }`

`createExternalJobTargetResolver` gains one explicit opt-in:

- `general === true`, no `threadId`, forum or isolated chat (the resolver's
  existing `forum` test) → `{ chatId, threadId: null, sessionKey:
  getSessionKey(chatId, null, chat) }`, which is the bare chat id.
- `general === true` with a `threadId` → refused. The route would be
  ambiguous.
- `general` missing or anything other than `true` → today's rules.
- `general: true` on a non-forum chat resolves as today: that chat has one
  conversation, and today's resolver already accepts the same route.
- The CLI-backend check is unchanged.

Everything downstream already treats a null `threadId` as General, so no
other code changes:

| Path | Behavior with `threadId: null` |
|---|---|
| `routeMatches` (runtime), `matches` (service) | compare `null` to the frozen `null`. |
| `findAutomationDestination` | a General message has no `message_thread_id`, so it compares `null` to `null`; `/automation` and the operator's `/stop` in General act on that route. |
| dispatch | `sendToProcess(chatId, …, { threadId: null })`, the General session. |
| job report, mailbox mirror, notification post | `message_thread_id` is omitted, so the post lands in General; `strictDestination` only matters when a thread id is set. |
| mailbox | a role is a route; General's session key differs from every topic's (`chatId:threadId`), so the "no shared session" rule still holds. |

In a forum without `isolateTopics`, the General session is the whole chat's
shared session. That is allowed, as for a plain chat, but `/automation` only
matches when sent from General.

### `mailbox_identify` returns `{ role, depth }`

`depth` is what `send` would use as the caller's current depth:

- 0 after a human prompt or a system-sender tell;
- the message's depth after a mailbox delivery;
- `maxDepth` after any other automation turn, or before the session's first
  prompt since boot.

## Alternatives rejected

- **A sentinel thread id such as `"1"` or `"general"`.** It would leak into
  `message_thread_id` and every `threadId` comparison. A separate boolean
  keeps `threadId` null, which is what polygram already uses for General.
- **Accepting a bare `{ chatId }` for forums.** That is an implicit opt-in:
  a route that forgot its topic would silently land in General.
- **Returning `maxDepth` too.** The caller only needs to know whether depth
  is 0.

## Failure modes

- A route typo (for example `"general": "true"`) is refused, as today. A
  mailbox role fails boot, as any other route error does.
- If a route changes from General to a topic, queued jobs keep their frozen
  General target. They are held by the route check, as for any route change.

## Verification

- Unit tests, written to fail first:
  - the resolver: accepted and refused shapes;
  - the runtime: dispatch to the General session, and route-change hold;
  - the service: report matching for a General job;
  - report delivery without `message_thread_id`;
  - `/automation` in General, and not from a sibling topic;
  - the mailbox with a General role, using the real resolver: delivery
    target, mirror without a thread, distinct tokens, reply back to a topic;
  - `identify` depth after a human prompt, a mailbox delivery, a notice, a
    system tell, and no prompt.
- Full `npm test`.
- Deploy: all hosts on 0.43.0 and booted, and one shumabit turn answered.
  The activation config itself belongs to Ivan.
