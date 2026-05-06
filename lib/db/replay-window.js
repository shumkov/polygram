/**
 * rc.57: pure resolver for the boot-replay window in milliseconds.
 *
 * Lifted out of polygram.js's main() so the derivation rule can be
 * unit-tested without spinning up the daemon.
 *
 * Precedence:
 *   1. config.bot.replayWindowMs — explicit operator override (any
 *      positive integer in ms).
 *   2. Auto-derive from max(maxTurn) × 1.2 across all configured chats
 *      (and defaults.maxTurn). Reasoning: if a chat allows turns up to
 *      maxTurn seconds, an interrupted turn could be that old when
 *      polygram restarts; replay window should outlast it. ×1.2 adds
 *      buffer.
 *   3. If no maxTurn is configured anywhere, return undefined (db.js
 *      uses its 3-min default).
 *
 * Floor at 3 min (legacy default — never tighter than what we shipped
 * before). Cap at 2h (sanity bound — replaying anything older is
 * almost certainly stale work the user already moved on from).
 *
 * Discovery: msg 151 in Shumabit@UMI thread :24 (chat -1003369922517)
 * was sent 2026-05-05 01:55:14, polygram restarted for rc.56 at
 * 02:17 (22 min later). Pre-rc.57 the 3-min default discarded msg 151
 * as too old; the agent's 7-hour Xero-template-build task was
 * abandoned silently. Shumabit@UMI has maxTurn=3600 (60 min); 1.2×
 * = 72 min replay window now keeps long turns alive across deploys.
 */

'use strict';

const FLOOR_MS = 3 * 60 * 1000;        // 3 min
const CAP_MS = 2 * 60 * 60 * 1000;     // 2 h
const BUFFER = 1.2;                    // ×

function resolveReplayWindowMs(config) {
  const explicit = Number(config?.bot?.replayWindowMs);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const chatMaxes = Object.values(config?.chats || {})
    .map((c) => Number(c?.maxTurn) || 0);
  const defaultMax = Number(config?.defaults?.maxTurn) || 0;
  const maxTurnSec = Math.max(0, ...chatMaxes, defaultMax);
  if (maxTurnSec === 0) return undefined;
  const derivedMs = Math.round(maxTurnSec * BUFFER * 1000);
  return Math.max(FLOOR_MS, Math.min(CAP_MS, derivedMs));
}

module.exports = {
  resolveReplayWindowMs,
  FLOOR_MS,
  CAP_MS,
  BUFFER,
};
