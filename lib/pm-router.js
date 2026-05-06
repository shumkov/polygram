/**
 * ProcessManager router (rc.6+, post-0.9.0 cleanup).
 *
 * 0.9.0 collapsed the dual-pm router. The CLI pm and the env-driven
 * routing layer (POLYGRAM_USE_SDK / POLYGRAM_SDK_CHATS) were deleted
 * once both bots had soaked on SDK pm. The file remains as a thin
 * single-pm wrapper so polygram.js's bootstrap doesn't need to know
 * about pm internals AND so a future alternate pm impl (a
 * pi-agent-core adapter, a synthetic test pm) can slot in cleanly
 * behind the same interface — see lib/pm-interface.js for the
 * canonical contract.
 *
 * Pre-0.9.0 history (kept for the archaeology):
 *
 *   - 0.8.0-rc.6 introduced the router as an env-flag-controlled
 *     A/B between the stream-json CLI pm (lib/process-manager.js)
 *     and the SDK pm (lib/process-manager-sdk.js).
 *   - 0.8.0 final cut from rc.68; both bots on SDK pm by 2026-05-06.
 *   - 0.9.0 deleted lib/process-manager.js, bin/approval-hook.js,
 *     and the dual-pm router state. This file dropped from 196
 *     lines to ~30.
 */

'use strict';

/**
 * Wrap a single pm instance for polygram.js consumption. Currently
 * just returns the pm itself — the indirection is preserved so a
 * future multi-pm version can extend without polygram.js changes.
 *
 * @param {object} opts
 * @param {object} opts.pm  — the SDK pm instance (lib/process-manager-sdk.js)
 * @returns {object}        — pm interface (see lib/pm-interface.js)
 */
function createPmRouter({ pm } = {}) {
  if (!pm) throw new TypeError('pm required');
  return pm;
}

module.exports = { createPmRouter };
