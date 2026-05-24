/**
 * TurnPhase — unified per-turn liveness state.
 *
 * Companion to `docs/0.10.0-tmux-patience-model-solution.md`. This
 * module exports the enum and the active/inactive partition only.
 * Phase computation lives on TmuxProcess so it can reach turn state
 * (`outstandingTools`, `outstandingSubagents`, `submitConfirmed`,
 * `parked`) without leaking those internals here.
 *
 * Commit 1 (predicate as observer):
 *   - Every signal that reaches `_handleSessionEvent` / the capture
 *     poll / the debug-log poll feeds the predicate.
 *   - The predicate transitions per-turn state and emits a
 *     `phase-change` event.
 *   - **NO existing control flow consumes `turn.phase` yet** — the
 *     5-way `Promise.race` in `_runTurn`, the §6 fail-loud branch,
 *     B10's outstanding-Agent check, `_sweepStaleTurns`, and the
 *     reactor remain untouched. This commit is purely additive.
 *
 * Subsequent commits replace those consumers one at a time
 * (Commit 2: `_confirmSubmitViaJsonl`; Commit 3: `_runTurn`'s race).
 *
 * @see docs/0.10.0-tmux-patience-model-solution.md
 */

'use strict';

/**
 * The 13-state phase enum.
 *
 *  queued              in pendingQueue, not yet pasted
 *  pasted-unconfirmed  _pasteAndEnter returned; no JSONL signal yet
 *  paste-parked        queue-operation enqueue carrying our corr-id seen,
 *                      or capture-pane fallback ("Press up to edit
 *                      queued messages")
 *  submitted           JSONL user-message reproducing our corr-id seen
 *  streaming           assistant text/thinking arriving
 *  tool-running        ≥1 outstanding non-Agent tool_use
 *  subagent-running    ≥1 outstanding `Agent` tool_use (existing B10)
 *  bg-shell-running    session-level (no in-flight turn); TUI shows
 *                      `N shell` — not per-turn but included for
 *                      catalogue completeness
 *  approval-pending    approval prompt detected; awaiting respondToApproval
 *  quiet               no active phase + no heartbeat for quietToleranceMs
 *  wedged              `quiet` held for quietToWedgedMs with empty
 *                      outstanding sets AND submitConfirmed
 *  done                terminal JSONL `result` flushed
 *  failed              explicit failure (TMUX_SUBMIT_FAILED, kill, drain)
 */
const TurnPhase = Object.freeze({
  QUEUED:             'queued',
  PASTED_UNCONFIRMED: 'pasted-unconfirmed',
  PASTE_PARKED:       'paste-parked',
  SUBMITTED:          'submitted',
  STREAMING:          'streaming',
  TOOL_RUNNING:       'tool-running',
  SUBAGENT_RUNNING:   'subagent-running',
  BG_SHELL_RUNNING:   'bg-shell-running',
  APPROVAL_PENDING:   'approval-pending',
  QUIET:              'quiet',
  WEDGED:             'wedged',
  DONE:               'done',
  FAILED:             'failed',
});

/**
 * Active phases — the predicate's "turn is making progress" set.
 *
 * Any phase here means we have *positive evidence* the turn is alive:
 * either we just acted on it (paste/park/submit), or a signal
 * arrived (streaming/tool/subagent/approval), or it's holding the
 * session (bg-shell).
 *
 * Inactive: queued (not started), quiet (silence — demoted), wedged
 * (silence past the wedged threshold), done/failed (terminal).
 */
const ACTIVE_PHASES = Object.freeze(new Set([
  TurnPhase.PASTED_UNCONFIRMED,
  TurnPhase.PASTE_PARKED,
  TurnPhase.SUBMITTED,
  TurnPhase.STREAMING,
  TurnPhase.TOOL_RUNNING,
  TurnPhase.SUBAGENT_RUNNING,
  TurnPhase.BG_SHELL_RUNNING,
  TurnPhase.APPROVAL_PENDING,
]));

const TERMINAL_PHASES = Object.freeze(new Set([
  TurnPhase.DONE,
  TurnPhase.FAILED,
]));

/** True when phase is one of the "turn making progress" states. */
function isActive(phase) {
  return ACTIVE_PHASES.has(phase);
}

/** True when phase is terminal — `done` or `failed`. */
function isTerminal(phase) {
  return TERMINAL_PHASES.has(phase);
}

/**
 * The set of phases that are reachable FROM a given phase. Used by
 * tests to assert no illegal jumps; also documents the state machine
 * shape in code. Terminal phases have no successors.
 *
 * The graph is intentionally permissive — observer-only Commit 1
 * doesn't gate any transitions; future commits MAY tighten this.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  // PASTE_PARKED is reachable directly from QUEUED on cold-start +
  // stacked-message flows: claude TUI emits `queue-operation:enqueue`
  // before the corresponding `user-message` when it is still
  // cold-starting or finishing a prior turn. The predicate sees the
  // enqueue first and sets PASTE_PARKED without ever observing the
  // PASTED_UNCONFIRMED intermediate. rc.35 production caught this as
  // log noise once Commit 3 (`_awaitSettle`) started consuming
  // predicate fields more strictly.
  // rc.49 (shumorobot HOME 2026-05-24): SUBMITTED is reachable
  // directly from QUEUED when the TUI's `jsonl:user-message` event
  // races ahead of the `paste:returned` event-loop callback that
  // normally lands first and advances QUEUED → PASTED_UNCONFIRMED.
  // Symmetric to the rc.35→rc.36 PASTE_PARKED edge; same fix shape.
  [TurnPhase.QUEUED]:             new Set([TurnPhase.PASTED_UNCONFIRMED, TurnPhase.PASTE_PARKED, TurnPhase.SUBMITTED, TurnPhase.FAILED]),
  [TurnPhase.PASTED_UNCONFIRMED]: new Set([TurnPhase.PASTE_PARKED, TurnPhase.SUBMITTED, TurnPhase.STREAMING, TurnPhase.TOOL_RUNNING, TurnPhase.SUBAGENT_RUNNING, TurnPhase.APPROVAL_PENDING, TurnPhase.QUIET, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.PASTE_PARKED]:       new Set([TurnPhase.SUBMITTED, TurnPhase.STREAMING, TurnPhase.TOOL_RUNNING, TurnPhase.SUBAGENT_RUNNING, TurnPhase.APPROVAL_PENDING, TurnPhase.QUIET, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.SUBMITTED]:          new Set([TurnPhase.STREAMING, TurnPhase.TOOL_RUNNING, TurnPhase.SUBAGENT_RUNNING, TurnPhase.APPROVAL_PENDING, TurnPhase.QUIET, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.STREAMING]:          new Set([TurnPhase.STREAMING, TurnPhase.TOOL_RUNNING, TurnPhase.SUBAGENT_RUNNING, TurnPhase.APPROVAL_PENDING, TurnPhase.QUIET, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.TOOL_RUNNING]:       new Set([TurnPhase.TOOL_RUNNING, TurnPhase.STREAMING, TurnPhase.SUBAGENT_RUNNING, TurnPhase.APPROVAL_PENDING, TurnPhase.QUIET, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.SUBAGENT_RUNNING]:   new Set([TurnPhase.SUBAGENT_RUNNING, TurnPhase.STREAMING, TurnPhase.TOOL_RUNNING, TurnPhase.APPROVAL_PENDING, TurnPhase.QUIET, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.BG_SHELL_RUNNING]:   new Set([TurnPhase.STREAMING, TurnPhase.QUIET, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.APPROVAL_PENDING]:   new Set([TurnPhase.STREAMING, TurnPhase.TOOL_RUNNING, TurnPhase.SUBAGENT_RUNNING, TurnPhase.QUIET, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.QUIET]:              new Set([TurnPhase.STREAMING, TurnPhase.TOOL_RUNNING, TurnPhase.SUBAGENT_RUNNING, TurnPhase.APPROVAL_PENDING, TurnPhase.WEDGED, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.WEDGED]:             new Set([TurnPhase.STREAMING, TurnPhase.DONE, TurnPhase.FAILED]),
  [TurnPhase.DONE]:               new Set(),
  [TurnPhase.FAILED]:             new Set(),
});

/** True iff `next` is a legal successor of `prev`. */
function isLegalTransition(prev, next) {
  if (prev === next) return true;
  const successors = ALLOWED_TRANSITIONS[prev];
  return Boolean(successors && successors.has(next));
}

module.exports = {
  TurnPhase,
  ACTIVE_PHASES,
  TERMINAL_PHASES,
  ALLOWED_TRANSITIONS,
  isActive,
  isTerminal,
  isLegalTransition,
};
