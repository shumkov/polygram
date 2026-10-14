'use strict';

const { createExternalJobStore } = require('./store');

function createExternalJobService({ config, db, botName, resolveTarget, dispatch, checkInactive = async () => false,
  prepareReport = (text) => [text], deliverPart, now = Date.now, logger = console }) {
  const settings = config.bot?.externalJobs;
  const enabled = settings?.enabled === true;
  const store = enabled ? createExternalJobStore(db.raw, { botName, now }) : null;
  let started = false;
  let timer = null;
  let draining = null;
  let scheduled = false;
  function requireStore() { if (!store) throw new Error('External jobs are disabled'); return store; }
  function target(routeId) {
    const route = settings?.routes?.[routeId];
    if (!Object.hasOwn(settings?.routes || {}, routeId) || !route || route.enabled === false) throw new Error('External job route is unavailable');
    return resolveTarget(route, routeId);
  }
  function matches(job) {
    try {
      const current = target(job.routeId);
      return current.sessionKey === job.target.sessionKey && String(current.chatId) === String(job.target.chatId)
        && String(current.threadId ?? '') === String(job.target.threadId ?? '');
    } catch { return false; }
  }
  async function reports() {
    for (const job of store.reports()) {
      for (const part of store.parts(job.id)) {
        if (!started || part.state === 'unknown') break;
        if (store.status(job.target.sessionKey).paused) break;
        if (!matches(job)) { store.holdReport(job.id, 'Configured route changed or is unavailable'); break; }
        if (part.state === 'delivered') continue;
        if (!store.beginPart(part.id)) break;
        try { store.completePart(part.id, await deliverPart(job, part)); }
        catch (error) { store.failPart(part.id, error); break; }
      }
    }
  }
  async function drain() {
    for (const job of store.unsettled()) {
      try { if (await checkInactive(job) === true) store.setInactive(job.id); }
      catch { /* Lack of runtime evidence must keep the destination blocked. */ }
    }
    await reports();
    let dispatched = 0;
    for (const queued of store.queued()) {
      if (!started || dispatched >= 5) break;
      if (!matches(queued)) { store.hold(queued.id, 'Configured route changed or is unavailable'); continue; }
      const job = store.claim(queued.id);
      if (!job) continue;
      dispatched++;
      let result;
      try { result = await dispatch(job, { onTurnId: (turnId) => store.setTurnId(job.id, turnId) }); }
      catch (error) { result = { outcome: 'unknown', error: error.message || 'Dispatch outcome unavailable' }; }
      if (result?.deferred && !store.work(job.id).turnId) {
        store.defer(job.id, result.reason || 'Dispatch deferred'); continue;
      }
      const outcome = ['succeeded', 'failed', 'interrupted', 'unknown'].includes(result?.outcome) ? result.outcome : 'unknown';
      result = { ...result, outcome };
      try {
        const parts = typeof result.text === 'string' && result.text.trim() && !result.channelsAcknowledged ? await prepareReport(result.text) : [];
        store.finish(job.id, result, parts);
      } catch (error) {
        // Rendering and report validation cannot erase a known turn outcome.
        store.finish(job.id, { ...result, reportError: error.message || 'Report preparation failed' });
      }
      await reports();
    }
  }
  function tick() {
    if (!started || !store) return Promise.resolve();
    if (draining) return draining;
    draining = drain().catch((error) => logger.error?.(`[external-jobs] processing failed: ${error.code || error.name || 'Error'}`)).finally(() => { draining = null; });
    return draining;
  }
  function schedule() {
    if (!started || scheduled || draining) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; void tick(); });
  }
  return {
    info() { return { protocolVersion: 1, enabled, supportedBackends: ['cli'] }; },
    submit(input) {
      const current = requireStore();
      // Identity lookup precedes route resolution so lost acknowledgements are
      // recoverable even after an operator removes or changes the destination.
      const existing = current.existing(input);
      const receipt = current.submit(input, existing ? null : target(input.routeId), settings.maxPending ?? 1000);
      schedule(); return receipt;
    },
    get(input) { return { job: requireStore().get(input) }; },
    status(input) {
      if (!store) return { enabled: false, paused: false, pending: 0, running: 0 };
      const routeId = typeof input === 'string' ? input : input?.routeId;
      return store.status(target(routeId).sessionKey);
    },
    pauseSession(sessionKey, paused) { const status = requireStore().pauseSession(sessionKey, paused); if (!paused) schedule(); return status; },
    isPaused(sessionKey) { return store ? store.status(sessionKey).paused : false; },
    tick,
    start() {
      if (started || !store) return;
      store.recover(); started = true;
      timer = setInterval(schedule, 60000); timer.unref?.(); schedule();
    },
    stop() { started = false; clearInterval(timer); timer = null; },
  };
}

module.exports = { createExternalJobService };
