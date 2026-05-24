# Phase 0 spike findings

Captured during the spike run. Updates here feed back into `docs/0.11.0-channels-driver-plan.md`.

## Run metadata

- Date:
- Claude binary: `~/.local/share/claude/versions/2.1.142`
- Node version: (paste from `[bridge] startup` log line)
- Operator:

## Capability declaration

- Did claude accept `experimental.claude/channel`?  __ yes / __ no  →  evidence:
- Did claude accept `experimental.claude/channel/permission`?  __ yes / __ no  →  evidence:
- Any unexpected warnings on startup?

## Notification method names

- Inbound notification method actually used:
  - Expected: `notifications/claude/channel`
  - Actual:
- Permission notification method actually used:
  - Expected: `notifications/claude/channel/permission_request`
  - Actual:
- Permission verdict notification:
  - Expected: `notifications/claude/channel/permission`
  - Actual:

## Tool-call shape

- T1-simple `[bridge] tool_call` log line (paste verbatim):

```
```

- Does claude call `reply` with the exact param shape we declared?
- Did claude wrap the `<channel>` tag the way the docs claim, or differently?

## Permission relay (T2-perm)

- Did `[bridge] permission_request` fire?  __ yes / __ no
- If yes, payload (paste verbatim):

```
```

- If no, what did claude do instead?

## Compaction race (T3-compact)

- Approximate ordering of: T3 push, claude reply to T3, `/compact` trigger, compaction boundary
- Did T3 message reach Claude?
- Did the reply tool call complete normally or was it dropped/duplicated?

## Other observations

- Stderr noise level — manageable or overwhelming?
- Any flag deprecation warnings about `--dangerously-load-development-channels`?
- Any rate-limit / backpressure observations?

## Decisions / plan updates

- [ ] Plan section / line to update:
- [ ] New risk to add to register:
- [ ] Anything that should block Phase 1:
