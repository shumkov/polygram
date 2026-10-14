'use strict';

const { createInfraStore } = require('./store');

function validateDestination(config) {
  const route = config.bot?.infraAdmin;
  if (!route?.enabled) return null;
  const chat = config.chats?.[String(route.chatId)];
  if (!chat || chat.isolateTopics !== true || !chat.topics?.[String(route.threadId)]) {
    throw new Error('Infrastructure Admin requires a configured isolated topic');
  }
  return route;
}

function createInfraService({ config, db, botName, dispatch, notify = async () => {}, now = Date.now, logger = console }) {
  const route = validateDestination(config);
  const store = route ? createInfraStore(db.raw, { botName, route, now }) : null;
  let started = false;
  let draining = false;
  let scheduled = false;
  let timer = null;
  let nextNoticeAt = 0;

  async function drain() {
    scheduled = false;
    if (!started || draining || !store || store.status().paused) return;
    draining = true;
    try {
      for (let n = 0; started && n < 5; n++) {
        const work = store.claim();
        if (!work) break;
        try {
          const result = await dispatch(work);
          if (result?.deferred) {
            store.fail(work.token, 'Admin session busy or automation paused; delivery deferred');
            break;
          }
          store.complete(work.token, result?.reportReceipt ?? null);
        } catch (error) {
          store.fail(work.token, error.message || 'Infrastructure delivery failed');
          // A notification cannot feed intake. One outage reminder per window
          // bounds noise even when many distinct incidents fail together.
          if (started && !store.status().paused && now() >= nextNoticeAt) {
            nextNoticeAt = now() + 30 * 60000;
            try { await notify('Infrastructure automation could not complete a diagnosis. Alerts remain queued. Check /infra status and the daemon logs.'); }
            catch { logger.error?.('[infra] fallback notification failed'); }
          }
        }
      }
    } catch (error) {
      logger.error?.(`[infra] drain failed: ${error.code || error.name || 'Error'}`);
    } finally {
      draining = false;
    }
  }
  function schedule() {
    if (!started || scheduled || draining || !store) return;
    scheduled = true;
    setImmediate(() => { void drain(); });
  }
  function requireStore() {
    if (!store) throw new Error('Infrastructure automation is disabled');
    return store;
  }
  return {
    ingest(event) { const receipt = requireStore().ingest(event); schedule(); return receipt; },
    observe(event) { const receipt = requireStore().observe(event); if (!receipt.refreshed) schedule(); return receipt; },
    incidents(req) {
      const s = requireStore();
      if (req.action === 'list') {
        const incidents = s.list(req.before);
        return { incidents, nextBefore: incidents.length === 100 ? incidents.at(-1).sequence : null };
      }
      if (req.action === 'get') return { incident: s.get(req.incidentId, req.before) };
      if (req.action === 'update') { const { action, ...input } = req; return { incident: s.update(input) }; }
      throw new Error('Unknown incident action');
    },
    tick() { store?.tick(); schedule(); return { accepted: true, ...this.status() }; },
    status() { return store ? { ...store.status(), running: draining } : { enabled: false, paused: false, pending: 0, running: false }; },
    pause(paused) { const status = requireStore().setPaused(paused); if (!paused) schedule(); return status; },
    start() {
      if (started || !store) return;
      store.recover(); started = true;
      timer = setInterval(schedule, 60000); timer.unref?.(); schedule();
    },
    stop() { started = false; clearInterval(timer); timer = null; },
  };
}

module.exports = { createInfraService };
