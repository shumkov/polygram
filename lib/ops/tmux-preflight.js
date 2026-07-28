// Boot preflight for the tmux backend.
//
// With ORCHESTRA_TMUX_REQUIRE_SERVER=1 the daemon passes tmux `-N` and must
// never create the server itself — that server would be a child of this process,
// so under systemd it lands in this unit's cgroup and a restart reaps every
// Claude session with it. The cost of that guarantee is that an absent or
// unreachable server is unrecoverable here: every tmux-backed turn will fail.
//
// Booting anyway is the worst available outcome. systemd reports the unit
// `active`, the bot answers nothing, and the failure is invisible until someone
// notices the silence. Fail loudly instead, before the DB is opened or any
// Telegram traffic is accepted.
//
// Kept out of the boot sequence so the decision is testable without a daemon.

'use strict';

/**
 * @param {object} opts
 * @param {object} [opts.sweep]  result of sweepTmuxOrphans, when it returned
 * @param {Error}  [opts.error]  the error it threw instead, if it threw
 * @param {boolean} opts.requireExistingServer
 * @returns {{ fatal: boolean, reason?: string }}
 */
function classifyOrphanSweep({ sweep, error, requireExistingServer } = {}) {
  // Free to create the server on demand, so an empty or absent host is normal.
  if (!requireExistingServer) return { fatal: false };

  if (error) {
    return { fatal: true, reason: error.message || String(error) };
  }

  if (!sweep) {
    return { fatal: true, reason: 'orphan sweep returned no result' };
  }

  // Explicitly `false`, not merely falsy. An orchestra predating the strict
  // sweep leaves this undefined, and it cannot tell "no sessions" from "could
  // not ask" — treating that as healthy silently restores the fail-open this
  // check exists to close, which is exactly what a dependency downgrade would
  // do.
  if (sweep.listFailed === false) return { fatal: false };

  if (sweep.listFailed === true) {
    return { fatal: true, reason: sweep.listError || 'tmux server unreachable' };
  }

  return {
    fatal: true,
    reason: 'installed @shumkov/orchestra cannot report tmux reachability '
      + '(no listFailed in the sweep result) — upgrade it, or unset '
      + 'ORCHESTRA_TMUX_REQUIRE_SERVER',
  };
}

module.exports = { classifyOrphanSweep };
