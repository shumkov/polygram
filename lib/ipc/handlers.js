// The op set the IPC server registers.
//
// Assembled here rather than inline at the call site so tests exercise the SAME
// object production serves. A test that builds its own handler map proves the
// transport works and nothing about which ops a running daemon actually answers
// — it would keep passing after an op was dropped.

'use strict';

const { buildBusySnapshot } = require('../queue-utils');

/**
 * @param {object} opts
 * @param {string} opts.botName
 * @param {object} opts.daemonIdentity
 * @param {() => Map<string, number>} opts.getInFlightHandlers — read late, not
 *   captured: the dispatcher's map is assigned during boot and replaced on
 *   reload, so a value bound at wiring time can go stale.
 * @param {(req) => any} opts.handleSendOverIpc
 * @param {(req) => any} opts.requestDeployRestart
 */
function createIpcHandlers({
  botName,
  daemonIdentity,
  getInFlightHandlers,
  handleSendOverIpc,
  requestDeployRestart,
} = {}) {
  return {
    ping: async () => ({ pong: true, bot: botName }),

    identity: async () => ({ bot: botName, ...daemonIdentity }),

    // Deploy pre-flight: what would restarting this daemon interrupt right now?
    // Counts and session keys only — enough to decide, nothing quotable.
    busy: async () => buildBusySnapshot({
      inFlightHandlers: typeof getInFlightHandlers === 'function' ? getInFlightHandlers() : null,
      botName,
    }),

    deploy_restart: (req) => requestDeployRestart(req),

    send: (req) => handleSendOverIpc(req),
  };
}

module.exports = { createIpcHandlers };
