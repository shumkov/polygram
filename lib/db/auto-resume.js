/**
 * rc.54: auto-resume on 300s no-activity timeout.
 *
 * Background — the rc.54 incident pattern:
 *   When polygram's per-turn watchdog fires "Timeout: 300s idle with
 *   no Claude activity", the running SDK Query is torn down and the
 *   user gets the friendly "⏳ I went quiet too long without finishing.
 *   Try resending or simplifying." message. The session_id is preserved,
 *   so the *next* user message resumes context — but the work the user
 *   was waiting for is dropped on the floor.
 *
 *   Most timeouts are wedged tool calls (long Bash, hanging MCP, stuck
 *   subagent). The wedged subprocess is dead by the time the watchdog
 *   fires; a fresh resume of the same session_id will spawn a clean
 *   Query and Claude has full prior context to continue.
 *
 * What this module provides: a per-session cooldown tracker so we
 * don't auto-resume in a tight loop when the wedge is permanent.
 *
 *   - markAttempt(sessionKey) — record we just tried an auto-resume
 *   - isInCooldown(sessionKey) — true if we attempted within the
 *     cooldown window (default 10 min). Caller skips auto-resume and
 *     falls back to the existing user-facing timeout reply.
 *   - clear(sessionKey) — drop the timestamp (e.g. a successful turn
 *     completed since the auto-resume — we're back to healthy).
 */

'use strict';

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

function createAutoResumeTracker({ cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now } = {}) {
  const lastAttemptAt = new Map();

  return {
    /**
     * Returns true if the most recent attempt for this sessionKey was
     * within `cooldownMs` ago. Use to gate further auto-resume
     * attempts when a wedge keeps recurring.
     */
    isInCooldown(sessionKey) {
      const ts = lastAttemptAt.get(sessionKey);
      if (ts == null) return false;
      return now() - ts < cooldownMs;
    },

    /**
     * Record an auto-resume attempt. Call BEFORE dispatching the
     * resumed turn so a fast follow-up timeout can still see this
     * session is in cooldown.
     */
    markAttempt(sessionKey) {
      lastAttemptAt.set(sessionKey, now());
    },

    /**
     * Clear the cooldown for a session — called when a normal turn
     * succeeds, signalling the session is healthy again. Without
     * this, a session that auto-resumed once would be locked out of
     * future auto-resumes for the full 10 min even after recovery.
     */
    clear(sessionKey) {
      lastAttemptAt.delete(sessionKey);
    },

    /**
     * Reset all tracked sessions. Called by daemon reload, tests.
     */
    reset() {
      lastAttemptAt.clear();
    },

    // Test hooks
    _size() { return lastAttemptAt.size; },
    _get(sessionKey) { return lastAttemptAt.get(sessionKey); },
  };
}

/**
 * Classify the durable provider ledger for one Codex Telegram input.
 *
 * A request is safe to submit automatically only when the ledger proves that
 * no provider write occurred. Explicit cancellation is also definitely
 * not-sent, but remains cancelled rather than becoming new work. Every other
 * state fails closed because re-submission could duplicate text or tool
 * effects.
 *
 * Linked steering inputs are never independent work. Their state follows the
 * target turn, which is returned only for diagnostics and reconciliation.
 */
function classifyCodexRecoveryEvidence(evidence = {}) {
  const deliveryState = evidence?.delivery_state ?? evidence?.deliveryState;
  const recoveryState = evidence?.recovery_state ?? evidence?.recoveryState;
  const linkedState = (
    evidence?.linked_input_state
    ?? evidence?.linkedInputState
  );

  if (linkedState != null) {
    const target = classifyCodexRecoveryEvidence({
      delivery_state: (
        evidence?.target_delivery_state
        ?? evidence?.targetDeliveryState
      ),
      recovery_state: (
        evidence?.target_recovery_state
        ?? evidence?.targetRecoveryState
      ),
    });
    return {
      action: 'defer',
      reason: 'linked-input',
      target,
    };
  }

  if (deliveryState === 'prepared' && recoveryState === 'prepared') {
    return {
      action: 'recover',
      reason: 'request-proven-not-accepted',
    };
  }
  if (deliveryState === 'prepared' && recoveryState === 'cancelled') {
    return {
      action: 'skip',
      reason: 'request-cancelled-before-acceptance',
    };
  }
  return {
    action: 'defer',
    reason: 'provider-acceptance-not-disproven',
  };
}

/**
 * Decide whether an error is a candidate for auto-resume.
 *
 * Claude keeps its established timeout and bridge-disconnect behavior. Codex
 * additionally requires a typed definitely-not-sent error and matching durable
 * evidence that no provider write occurred.
 *
 * All providers reject user-aborted, boot-replay, and shutdown work.
 */
function isAutoResumable({
  error,
  aborted,
  replay,
  shuttingDown,
  provider,
  providerRecovery,
}) {
  if (aborted || replay || shuttingDown) return false;
  if (provider === 'codex') {
    const disposition = classifyCodexRecoveryEvidence(providerRecovery);
    return (
      disposition.action === 'recover'
      && error?.code === 'CODEX_RPC_NOT_SENT'
    );
  }
  // Delivery may have happened before the contained process tree disappeared.
  // Automatic continuation could duplicate work; a user resend starts fresh.
  if (error?.code === 'SESSION_PROCESS_LOST') return false;
  // Review F#6: channels analog of the tmux 'idle with no Claude activity'
  // pattern. The bridge socket dropped mid-turn (claude crashed, bridge
  // process died) — that's a wedge, not a runaway. Same intent as the
  // regex match below, just expressed via err.code because channels throws
  // a different message string. TURN_TIMEOUT stays NON-resumable (it's
  // the channels analog of the wall-clock ceiling — likely a runaway).
  if (error?.code === 'BRIDGE_DISCONNECTED') return true;
  const msg = String(error?.message || error || '');
  return /idle with no Claude activity/i.test(msg);
}

module.exports = {
  createAutoResumeTracker,
  classifyCodexRecoveryEvidence,
  isAutoResumable,
  DEFAULT_COOLDOWN_MS,
};
