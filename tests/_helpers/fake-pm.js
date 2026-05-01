/**
 * In-memory fake ProcessManager for tests that need to verify
 * routing / interaction without spawning a real Query or subprocess.
 *
 * Implements the canonical Pm interface (lib/pm-interface.js).
 * Records every method call into `.calls`. Optional methods are
 * opt-in via the constructor's `opts` object so a single test can
 * assert "method X was forwarded" or "method X was NOT exposed
 * (so the router uses its sentinel)".
 *
 * Usage:
 *
 *   const cli = makeFakePm('cli');
 *   const sdk = makeFakePm('sdk', { steer: true, drainQueue: true });
 *   const router = createPmRouter({ cliPm: cli, sdkPm: sdk, pickPmKindFor });
 *
 *   router.send('chat-1', 'hi');
 *   assert.deepEqual(sdk.calls, [['send', 'chat-1', 'hi', undefined]]);
 *
 * Bigger fakes (entry mocks, queued-pending sims) are out of scope —
 * tests that need them should use the SDK pm's `fake-query.js`
 * harness instead.
 *
 * @typedef {import('../../lib/pm-interface.js').Pm} Pm
 */

'use strict';

/**
 * @param {string} [name]
 * @param {object} [opts]
 *   Toggle each optional method into the returned fake. When false
 *   (default), the method is NOT defined on the returned object —
 *   so `typeof fake.X === 'function'` returns false, matching the
 *   real cli/sdk pms' feature-presence semantics.
 * @param {boolean} [opts.steer]
 * @param {boolean} [opts.setModel]
 * @param {boolean} [opts.applyFlagSettings]
 * @param {boolean} [opts.setPermissionMode]
 * @param {boolean} [opts.requestRespawn]
 * @param {boolean} [opts.drainQueue]
 * @param {boolean} [opts.interrupt]
 * @param {boolean} [opts.resetSession]
 *
 * @returns {Pm & { name: string, calls: Array<Array<any>> }}
 */
function makeFakePm(name = 'fake', opts = {}) {
  const calls = [];
  /** @type {Pm & { name: string, calls: Array<Array<any>> }} */
  const pm = {
    name,
    calls,
    has(key) { calls.push(['has', key]); return true; },
    get(key) { calls.push(['get', key]); return { name, key }; },
    getOrSpawn(key, ctx) { calls.push(['getOrSpawn', key, ctx]); return { name, key }; },
    send(key, prompt, sendOpts) {
      calls.push(['send', key, prompt, sendOpts]);
      return Promise.resolve({ text: name, sessionId: 'fake-sess', cost: 0, duration: 0, error: null, metrics: {} });
    },
    kill(key) { calls.push(['kill', key]); return Promise.resolve(); },
    async killChat(chatId) { calls.push(['killChat', chatId]); },
    async shutdown() { calls.push(['shutdown']); },
  };

  if (opts.steer) {
    pm.steer = (key, ...args) => { calls.push(['steer', key, ...args]); return true; };
  }
  if (opts.injectUserMessage) {
    pm.injectUserMessage = (key, injectOpts) => {
      calls.push(['injectUserMessage', key, injectOpts]);
      return true;
    };
  }
  if (opts.setModel) {
    pm.setModel = async (key, m) => { calls.push(['setModel', key, m]); return true; };
  }
  if (opts.applyFlagSettings) {
    pm.applyFlagSettings = async (key, s) => { calls.push(['applyFlagSettings', key, s]); return true; };
  }
  if (opts.setPermissionMode) {
    pm.setPermissionMode = async (key, mode) => { calls.push(['setPermissionMode', key, mode]); return true; };
  }
  if (opts.requestRespawn) {
    pm.requestRespawn = (key, r) => {
      calls.push(['requestRespawn', key, r]);
      return { killed: true, queued: 0 };
    };
  }
  if (opts.drainQueue) {
    pm.drainQueue = (key, code) => { calls.push(['drainQueue', key, code]); return 3; };
  }
  if (opts.interrupt) {
    pm.interrupt = async (key) => { calls.push(['interrupt', key]); };
  }
  if (opts.resetSession) {
    pm.resetSession = async (key, resetOpts) => {
      calls.push(['resetSession', key, resetOpts]);
      return { closed: true, drainedPendings: 0 };
    };
  }

  return pm;
}

module.exports = { makeFakePm };
