---
name: completion-sentinel
description: Claude Code-only compatibility fixture for bounded autonomous Workflow completion.
---

Use the native `Workflow` tool exactly once. This fixture is only for the
polygram compatibility gate; do not substitute Agent, Bash backgrounding, a
skill-only answer, or an inline simulation.

The invocation argument is a short opaque sentinel available as `$ARGUMENTS`.

Build and launch a background Workflow with at most three agents:

1. One agent waits for the marker file to appear by checking
   `.workflow-completion-marker` once per second for at most two minutes. It
   then runs `sleep 20`, reads the marker, and verifies that `2 + 2 = 4`. The
   marker file already contains the complete `WF-COMPLETE:[a-f0-9]{32}` line.
   Output that line byte-for-byte, excluding only its one trailing LF line
   terminator. Do not hash, digest, checksum, encode, prefix, suffix, or
   otherwise transform it. In particular, never use `md5`, `md5sum`, `shasum`,
   or `sha256sum`. This delay keeps completion beyond the launch turn's
   stop-grace window.
2. One agent verifies that the sentinel was preserved byte-for-byte.
3. Do not ask another agent to restate or reformat the marker. After both agents
   finish, use ordinary JavaScript in the Workflow script to extract every line
   matching `^WF-COMPLETE:[a-f0-9]{32}$` with multiline matching from the first
   agent's result. Require exactly one match. The Workflow script must end with
   exactly `return matches[0]`. Do not use `replace`, `slice`, or `substring`;
   return that match directly without removing or changing the prefix.

The Workflow's terminal result must equal exactly the marker read from
`.workflow-completion-marker`. Do not read that file in the launch turn; only a
Workflow agent may read it after the delay.

After the Workflow tool returns its background-launch receipt, immediately call
the channel `reply` tool exactly once, with no attached files and with text
exactly:

`WF-LAUNCHED:$ARGUMENTS`

After that reply returns, make no further channel call: do not send a progress/status
reply, edit a message, ask a question, or attach a file. End the launch turn
immediately. Never call any `WF-COMPLETE` text in the launch turn, even though the
background-launch receipt contains a task identifier. Do not poll, wait, or send
another user message.

Only when the current user event contains `<task-notification>` may you call the
channel `reply` tool once with exactly the Workflow's terminal result from that
event. Send the raw marker without quotes, backticks, labels, or commentary. If
that completion reply returns an error, do not retry it: leave exactly the raw
marker as the terminal assistant text so polygram's released transcript fallback
can rescue it.
