/**
 * Dedupe/re-arm gate for AUTH_DISABLED operator notifications
 * (docs/AUTH_DISABLED_HANDLING_SPEC.md).
 *
 * Fires the operator DM once per outage window: the first AUTH_DISABLED
 * occurrence after construction (or after the last successful Claude turn)
 * notifies; every occurrence after that is deduped until a turn succeeds
 * again. `noteSuccess()` must only be called on a genuine Claude-turn
 * success (see polygram.js handleMessage's non-error branch) — calling it
 * on unrelated bot traffic (slash commands, unconfigured chats) would
 * falsely clear an ongoing outage and cause repeat pages.
 *
 * `count`/`lastAt` track every occurrence regardless of dedupe, for the
 * heartbeat counter (lib/ops/heartbeat.js).
 */

'use strict';

function createAuthDisabledGate({ now = Date.now } = {}) {
  let armed = true;
  let count = 0;
  let lastAt = null;

  function noteFailure() {
    count += 1;
    lastAt = now();
    if (!armed) return false;
    armed = false;
    return true;
  }

  function noteSuccess() {
    armed = true;
  }

  function snapshot() {
    return { count, lastAt, armed };
  }

  return { noteFailure, noteSuccess, snapshot };
}

module.exports = { createAuthDisabledGate };
