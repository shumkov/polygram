---
name: notifications
description: Inspect this conversation's unread external notifications and persist, replace or cancel a timed follow-up check.
---

Use the own-conversation command and scope supplied by Polygram in the current turn.
The daemon chooses the destination; the tool cannot target another topic. Its scope
expires when the daemon restarts, so use the current turn's command.

`status` returns the processing cursor, unread count, active job execution/report
states, pause state and schedules. `schedule` accepts one JSON argument with key,
future dueAt (epoch milliseconds), context and notificationIds. A stable key replaces
an older schedule with a new revision. `cancel` accepts a key and durably cancels it.
Only a successful persisted result proves a check was scheduled. Paused automation
retains overdue work and performs one check after resume. Unknown execution is held
for human reconciliation; it is never permission to repeat the turn.

Read fresh source evidence to establish recovery. Missing history, an unavailable
host or disabled check cannot establish health. Default unresolved recheck interval
is 30 minutes; choose a later time when appropriate. Report meaningful changes or
questions, without repeating an unchanged report. Notifications and scheduled checks
do not authorize repairs.
