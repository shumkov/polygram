/**
 * Per-chat ProcessManager router (rc.6+).
 *
 * Daemon hosts up to TWO pm instances simultaneously — the
 * stream-json-CLI ProcessManager and the @anthropic-ai/claude-agent-sdk
 * ProcessManagerSdk. Each chat is assigned to one of them based on
 * env config:
 *
 *   POLYGRAM_USE_SDK=1                 → all chats SDK pm
 *   POLYGRAM_SDK_CHATS=id1,id2,...     → those chats SDK; others CLI
 *   neither set                        → all chats CLI
 *
 * The router exposes the same surface a single pm did, plus two
 * introspection methods:
 *
 *   pm.pickFor(sessionKey)   → underlying pm instance (for feature
 *                              detection at call sites)
 *   pm.isSdkFor(sessionKey)  → boolean shortcut
 *
 * Lifecycle methods (`killChat`, `shutdown`) broadcast to BOTH pms
 * when both are alive — a chat could have a session on either side
 * (e.g. mid-config-change), so we don't risk leaking one.
 *
 * Optional methods (steer / setModel / applyFlagSettings /
 * requestRespawn / drainQueue / interrupt / resetSession) forward
 * when the routed pm has the method and return a sentinel otherwise.
 * Sites that need to feature-detect should `pm.pickFor(sessionKey)`
 * and check `typeof X === 'function'` directly.
 *
 * Used by `polygram.js` main() — Phase 5 + rc.6.
 */

'use strict';

/**
 * Parse the SDK-chats env config into a router policy.
 *
 * @param {object} opts
 * @param {boolean} opts.useSdkAll  — POLYGRAM_USE_SDK=1
 * @param {Iterable<string>} [opts.sdkChats]  — POLYGRAM_SDK_CHATS list
 * @param {(sessionKey: string) => string|null} opts.getChatIdFromKey
 *
 * @returns {object} { sdkAllChats, sdkSomeChats, sdkActive,
 *                     sdkChatIdSet, pickPmKindFor }
 */
function makeRouterPolicy({ useSdkAll = false, sdkChats = [], getChatIdFromKey } = {}) {
  if (typeof getChatIdFromKey !== 'function') {
    throw new TypeError('getChatIdFromKey function required');
  }
  const sdkChatIdSet = new Set(
    [...sdkChats].map((s) => String(s).trim()).filter(Boolean),
  );
  const sdkAllChats = !!useSdkAll && sdkChatIdSet.size === 0;
  const sdkSomeChats = sdkChatIdSet.size > 0;
  const sdkActive = sdkAllChats || sdkSomeChats;

  function pickPmKindFor(sessionKey) {
    if (sdkAllChats) return 'sdk';
    if (!sdkSomeChats) return 'cli';
    const chatId = String(getChatIdFromKey(sessionKey) ?? '');
    return sdkChatIdSet.has(chatId) ? 'sdk' : 'cli';
  }

  return { sdkAllChats, sdkSomeChats, sdkActive, sdkChatIdSet, pickPmKindFor };
}

/**
 * Build a routing pm proxy. cliPm is required; sdkPm is optional
 * (null when SDK isn't enabled for any chat).
 *
 * @param {object} opts
 * @param {object} opts.cliPm
 * @param {object|null} opts.sdkPm
 * @param {(sessionKey: string) => 'sdk'|'cli'} opts.pickPmKindFor
 */
/**
 * Broadcast helper for killChat / shutdown. Awaits every task to
 * settlement (success OR rejection), then throws an aggregate error
 * if any task rejected. Single rejections re-throw the original
 * error untouched (no AggregateError noise); multiple rejections
 * surface as `AggregateError` with all causes preserved.
 *
 * Each task entry is `[label, () => Promise]`; the label appears in
 * AggregateError messages so a debugger can tell which pm failed.
 */
async function broadcastSettle(method, tasks) {
  const results = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const tag = tasks[i][0];
      const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      err.pmTag = tag;
      errors.push(err);
    }
  });
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${method} failed in ${errors.length} pms`);
  }
}

function createPmRouter({ cliPm, sdkPm = null, pickPmKindFor } = {}) {
  if (!cliPm) throw new TypeError('cliPm required');
  if (typeof pickPmKindFor !== 'function') {
    throw new TypeError('pickPmKindFor function required');
  }

  function routedPm(sessionKey) {
    return pickPmKindFor(sessionKey) === 'sdk' && sdkPm ? sdkPm : cliPm;
  }

  return {
    pickFor: routedPm,
    isSdkFor(sessionKey) {
      return pickPmKindFor(sessionKey) === 'sdk' && !!sdkPm;
    },

    // Methods that exist on every pm instance — direct routing.
    has(sessionKey) { return routedPm(sessionKey).has(sessionKey); },
    get(sessionKey) { return routedPm(sessionKey).get(sessionKey); },
    getOrSpawn(sessionKey, ctx) { return routedPm(sessionKey).getOrSpawn(sessionKey, ctx); },
    send(sessionKey, prompt, opts) { return routedPm(sessionKey).send(sessionKey, prompt, opts); },
    kill(sessionKey) { return routedPm(sessionKey).kill(sessionKey); },

    // Lifecycle methods broadcast to both pms because a chat may
    // have spawned sessions on either side at different times.
    // Promise.allSettled (NOT Promise.all) so a rejection from one
    // pm doesn't abandon the other mid-tear-down. Both must always
    // complete; we then surface aggregated errors. Pre-fix, a cliPm
    // rejection let sdkPm's Query.close() get GC'd with handles
    // still open.
    killChat(chatId) {
      const tasks = [['cli', () => cliPm.killChat(chatId)]];
      if (sdkPm) tasks.push(['sdk', () => sdkPm.killChat(chatId)]);
      return broadcastSettle('killChat', tasks);
    },
    shutdown() {
      const tasks = [['cli', () => cliPm.shutdown()]];
      if (sdkPm) tasks.push(['sdk', () => sdkPm.shutdown()]);
      return broadcastSettle('shutdown', tasks);
    },

    // Optional methods — forward when the routed pm implements
    // them, return a documented sentinel otherwise. Use
    // `pm.pickFor(sessionKey)` for proper feature detection at
    // call sites that need to branch on capability.
    steer(sessionKey, ...args) {
      const target = routedPm(sessionKey);
      return typeof target.steer === 'function' ? target.steer(sessionKey, ...args) : false;
    },
    // rc.42: native autosteer / queue. CLI pm doesn't have an
    // input-controller push primitive (the binary's stream-json
    // input is one-shot per pm.send), so it returns false. SDK pm
    // forwards to its inject implementation.
    injectUserMessage(sessionKey, opts) {
      const target = routedPm(sessionKey);
      return typeof target.injectUserMessage === 'function'
        ? target.injectUserMessage(sessionKey, opts)
        : false;
    },
    resetSession(sessionKey, opts) {
      const target = routedPm(sessionKey);
      return typeof target.resetSession === 'function'
        ? target.resetSession(sessionKey, opts)
        : Promise.resolve({ closed: false, drainedPendings: 0 });
    },
    applyFlagSettings(sessionKey, settings) {
      const target = routedPm(sessionKey);
      return typeof target.applyFlagSettings === 'function'
        ? target.applyFlagSettings(sessionKey, settings)
        : Promise.resolve(false);
    },
    setModel(sessionKey, model) {
      const target = routedPm(sessionKey);
      return typeof target.setModel === 'function'
        ? target.setModel(sessionKey, model)
        : Promise.resolve(false);
    },
    requestRespawn(sessionKey, reason) {
      const target = routedPm(sessionKey);
      return typeof target.requestRespawn === 'function'
        ? target.requestRespawn(sessionKey, reason)
        : { killed: false, queued: 0 };
    },
    drainQueue(sessionKey, errCode) {
      const target = routedPm(sessionKey);
      return typeof target.drainQueue === 'function'
        ? target.drainQueue(sessionKey, errCode)
        : 0;
    },
    interrupt(sessionKey) {
      const target = routedPm(sessionKey);
      return typeof target.interrupt === 'function'
        ? target.interrupt(sessionKey)
        : Promise.resolve();
    },
  };
}

module.exports = { makeRouterPolicy, createPmRouter };
