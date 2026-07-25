---
name: completion-sentinel
description: Claude Code-only compatibility fixture for bounded autonomous Workflow completion.
---

Use the native `Workflow` tool exactly once. This fixture is only for the
polygram compatibility gate; do not substitute Agent, Bash backgrounding, a
skill-only answer, or an inline simulation.

The invocation argument is a short opaque sentinel available as `$ARGUMENTS`.

Build and launch a background Workflow with at most three agents:

1. One agent first runs `sleep 8`, then verifies that `2 + 2 = 4`.
2. One agent verifies that the sentinel was preserved byte-for-byte.
3. An optional final agent checks both findings.

The Workflow's terminal result must contain exactly:

`WF-COMPLETE:$ARGUMENTS`

After the Workflow tool returns its background-launch receipt, immediately call
the channel `reply` tool with exactly:

`WF-LAUNCHED:$ARGUMENTS`

Then end the launch turn. Do not poll, wait, or send another user message.

When the native task notification later arrives, call the channel `reply` tool
once with exactly `WF-COMPLETE:$ARGUMENTS`. If that completion reply returns an
error, do not retry it: leave exactly `WF-COMPLETE:$ARGUMENTS` as the terminal
assistant text so polygram's released transcript fallback can rescue it.
