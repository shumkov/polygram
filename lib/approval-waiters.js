/**
 * Parked-Promise Map for canUseTool's async user-approval flow.
 *
 * Per v4 plan §6.5.3 / Phase 1 step 8.
 *
 * Background: under SDK migration, canUseTool is an in-process
 * callback (replaces today's `bin/approval-hook.js` IPC). When a
 * gated tool fires, polygram posts a Telegram inline-keyboard card
 * to the admin chat and PARKS a Promise that resolves on user click.
 * The SDK awaits that Promise — so the in-flight tool sleeps until
 * the user decides.
 *
 * This module owns the waiter Map. Five cleanup paths are wired:
 *   1. resolveByClick(toolUseId, decision) — user pressed a button
 *   2. signal abort — SDK called Query.interrupt() / Query.close();
 *      AbortSignal fires → Promise rejects with code:'ABORTED'
 *   3. timeout — periodic sweeper rejects waiters parked > timeoutMs
 *   4. rejectAllForSession(sessionKey) — pm.resetSession or kill
 *   5. shutdown — daemon SIGTERM; reject all
 *
 * Memory bound: MAX_WAITERS (200). Park beyond cap throws a typed
 * error so the caller can return `{behavior:'deny'}` to the SDK
 * instead of accumulating garbage.
 */

'use strict';

const DEFAULT_MAX_WAITERS = 200;
const DEFAULT_TIMEOUT_MS = 60_000;             // 60s; matches OpenClaw cancel window
const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

function createApprovalWaiters({
  logger = console,
  maxWaiters = DEFAULT_MAX_WAITERS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
} = {}) {
  // toolUseId → entry { resolve, reject, signal, sigCleanup,
  //                     parkedAt, sessionKey }
  const waiters = new Map();
  let sweepTimer = null;

  /**
   * Park the canUseTool Promise; return a Promise that resolves on
   * user click / rejects on signal-abort / timeout / shutdown.
   *
   * @param {object} args
   * @param {string} args.toolUseId — SDK opts.toolUseID. Required.
   * @param {string} args.sessionKey — for rejectAllForSession routing.
   * @param {AbortSignal} [args.signal] — opts.signal from canUseTool.
   *
   * @returns {Promise<PermissionResult>}
   * @throws {Error{code:'WAITER_CAP'}} if cap exceeded.
   */
  function park({ toolUseId, sessionKey, signal }) {
    if (!toolUseId) {
      throw Object.assign(new Error('toolUseId required'),
                          { code: 'NO_TOOL_USE_ID' });
    }
    if (waiters.size >= maxWaiters) {
      logger.error?.(`[approval-waiters] cap reached (${maxWaiters}); rejecting`);
      throw Object.assign(
        new Error(`approval waiter cap exceeded (${maxWaiters})`),
        { code: 'WAITER_CAP' },
      );
    }
    if (waiters.has(toolUseId)) {
      // Concurrent canUseTool with same toolUseID — SDK doesn't
      // typically retry the same call, but handle defensively by
      // resolving the old one with a deny first.
      logger.error?.(`[approval-waiters] duplicate toolUseId ${toolUseId}; abandoning prior waiter`);
      const prior = waiters.get(toolUseId);
      prior.reject(Object.assign(new Error('superseded'), { code: 'SUPERSEDED' }));
    }

    return new Promise((resolve, reject) => {
      // signal-abort cleanup wired here so signal-fires always
      // unparks the waiter, even if user click never arrives.
      const sigCleanup = signal
        ? () => {
            const e = waiters.get(toolUseId);
            if (e) {
              waiters.delete(toolUseId);
              e.reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
            }
          }
        : null;
      if (signal && sigCleanup) {
        signal.addEventListener('abort', sigCleanup, { once: true });
      }

      waiters.set(toolUseId, {
        resolve: (decision) => {
          if (signal && sigCleanup) {
            try { signal.removeEventListener('abort', sigCleanup); }
            catch { /* swallow */ }
          }
          waiters.delete(toolUseId);
          resolve(decision);
        },
        reject: (err) => {
          if (signal && sigCleanup) {
            try { signal.removeEventListener('abort', sigCleanup); }
            catch { /* swallow */ }
          }
          waiters.delete(toolUseId);
          reject(err);
        },
        signal,
        parkedAt: Date.now(),
        sessionKey,
      });
    });
  }

  /**
   * Path 1: user clicked a button. `decision` is the
   * SDK-shape PermissionResult.
   */
  function resolveByClick(toolUseId, decision) {
    const e = waiters.get(toolUseId);
    if (!e) return false;
    e.resolve(decision);
    return true;
  }

  /**
   * Path 4: pm.resetSession or kill. Reject every waiter whose
   * sessionKey matches.
   */
  function rejectAllForSession(sessionKey, code = 'RESET_SESSION') {
    let count = 0;
    for (const [id, e] of [...waiters.entries()]) {
      if (e.sessionKey === sessionKey) {
        e.reject(Object.assign(new Error('session reset'), { code }));
        count++;
      }
    }
    return count;
  }

  /**
   * Path 5: daemon shutdown. Reject every waiter.
   */
  function rejectAll(code = 'DAEMON_SHUTDOWN') {
    let count = 0;
    for (const [id, e] of [...waiters.entries()]) {
      e.reject(Object.assign(new Error('daemon shutdown'), { code }));
      count++;
    }
    return count;
  }

  /**
   * Path 3: timeout sweeper. Periodically reject waiters parked
   * longer than timeoutMs.
   */
  function startTimeoutSweeper() {
    if (sweepTimer) return;
    const sweep = () => {
      const cutoff = Date.now() - timeoutMs;
      for (const [id, e] of [...waiters.entries()]) {
        if (e.parkedAt < cutoff) {
          e.reject(Object.assign(new Error('approval timeout'),
                                  { code: 'TIMEOUT' }));
        }
      }
    };
    sweepTimer = setInterval(sweep, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  function stopTimeoutSweeper() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  return {
    park,
    resolveByClick,
    rejectAllForSession,
    rejectAll,
    startTimeoutSweeper,
    stopTimeoutSweeper,
    get size() { return waiters.size; },
    // Test introspection only:
    _waiters: waiters,
  };
}

module.exports = {
  createApprovalWaiters,
  DEFAULT_MAX_WAITERS,
  DEFAULT_TIMEOUT_MS,
};
