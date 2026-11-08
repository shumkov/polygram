'use strict';

const { createExternalJobStore } = require('./store');

function createExternalJobService({ config, db, botName, resolveTarget, dispatch, checkInactive = async () => false, recoverInactive,
  prepareReport = (text) => [text], deliverPart, now = Date.now, logger = console }) {
  const settings = config.bot?.externalJobs;
  const enabled = settings?.enabled === true;
  const store = enabled ? createExternalJobStore(db.raw, { botName, now }) : null;
  let started = false;
  let timer = null;
  let draining = null;
  let scheduled = false;
  let dirty = false;
  const inFlight = new Map();
  // Sessions whose claimed job is still settling. A job is terminal in the
  // store before its report is delivered, so the claim rule alone would let
  // the session's next turn overlap that delivery.
  const busy = new Set();
  const maxConcurrent = settings?.maxConcurrent ?? 4;
  if (enabled && (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)) throw new Error('Invalid externalJobs.maxConcurrent');
  const volatilePauses = new Set();
  const isPaused = (sessionKey) => volatilePauses.has(sessionKey) || (store ? store.isPaused(sessionKey) : false);
  function withPause(job) {
    return volatilePauses.size ? { ...job, paused: isPaused(store.work(job.id).target.sessionKey) } : job;
  }
  function requireStore() { if (!store) throw new Error('External jobs are disabled'); return store; }
  // Refusals carry a stable code so callers can log the reason without the
  // message text; the messages themselves are unchanged.
  const refusal = (code, message) => Object.assign(new Error(message), { code });
  function target(routeId) {
    const route = settings?.routes?.[routeId];
    if (!Object.hasOwn(settings?.routes || {}, routeId) || !route || route.enabled === false) throw refusal('EXTERNAL_JOB_ROUTE_UNAVAILABLE', 'External job route is unavailable');
    try { return resolveTarget(route, routeId); }
    catch (error) { if (error && typeof error === 'object' && !error.code) error.code = 'EXTERNAL_JOB_ROUTE_UNAVAILABLE'; throw error; }
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
        if (isPaused(job.target.sessionKey)) break;
        if (!matches(job)) { store.holdReport(job.id, 'Configured route changed or is unavailable'); break; }
        if (part.state === 'delivered') continue;
        if (!store.beginPart(part.id)) break;
        try { store.completePart(part.id, await deliverPart(job, part)); }
        catch (error) { store.failPart(part.id, error); break; }
      }
    }
  }
  // Resolves true once the job is terminal and its report delivery has ended,
  // false when the dispatch deferred and the job is queued again.
  async function settle(job) {
    let result;
    try { result = await dispatch(job, { onTurnId: (turnId) => store.setTurnId(job.id, turnId) }); }
    catch (error) { result = { outcome: 'unknown', error: error.message || 'Dispatch outcome unavailable' }; }
    if (result?.deferred && !store.work(job.id).turnId) {
      // A deferred job waits for the next tick, submit or resume, so a busy
      // target never makes the scheduler spin.
      store.defer(job.id, result.reason || 'Dispatch deferred'); return false;
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
    return true;
  }
  async function drain() {
    for (const job of store.unsettled()) {
      // A job this process is driving is settled by its own continuation.
      if (inFlight.has(job.id)) continue;
      try { if (await checkInactive(job) === true) store.setInactive(job.id); }
      catch { /* Lack of runtime evidence must keep the destination blocked. */ }
    }
    await reports();
    // Claims run synchronously from one snapshot; the claim rule keeps at most
    // one job per session, so each session's turns stay ordered by id.
    for (const queued of store.queued()) {
      if (!started || inFlight.size >= maxConcurrent) break;
      if (busy.has(queued.target.sessionKey) || isPaused(queued.target.sessionKey)) continue;
      if (!matches(queued)) { store.hold(queued.id, 'Configured route changed or is unavailable'); continue; }
      const job = store.claim(queued.id);
      if (!job) continue;
      const sessionKey = job.target.sessionKey;
      busy.add(sessionKey);
      let deferred = false;
      inFlight.set(job.id, settle(job)
        .then((terminal) => { deferred = !terminal; })
        .catch((error) => logger.error?.(`[external-jobs] settling job ${job.id} (${job.requestId}) failed: ${error.code || error.name || 'Error'}`))
        .finally(() => {
          inFlight.delete(job.id); busy.delete(sessionKey);
          // A settled or failed continuation frees its slot and may unblock
          // the session's next job; a deferral waits for the next tick,
          // submit or resume, so a busy target never spins.
          if (!deferred) schedule();
        }));
    }
  }
  // Any schedule request made during a pass marks it dirty and earns one more
  // pass, so a submit, resume or settled turn is never lost. Clearing
  // `draining` in the same synchronous step as the last dirty check leaves no
  // window where a request could be dropped.
  async function passes() {
    try {
      do {
        dirty = false;
        try { await drain(); }
        catch (error) { logger.error?.(`[external-jobs] processing failed: ${error.code || error.name || 'Error'}`); }
      } while (dirty && started);
    } finally { draining = null; }
  }
  // Resolves once the pass has ended and every dispatch in flight at that
  // moment has settled and reported. Jobs those settlements unblock run in
  // later passes, so a finished tick does not mean an empty queue.
  function tick() {
    if (!started || !store) return Promise.resolve();
    if (!draining) draining = passes();
    return draining.then(() => Promise.all(inFlight.values())).then(() => {});
  }
  function schedule() {
    if (!started) return;
    if (draining) { dirty = true; return; }
    if (scheduled) return;
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
      schedule(); return { ...receipt, job: withPause(receipt.job) };
    },
    get(input) { return { job: withPause(requireStore().get(input)) }; },
    async prepareRecovery(input) {
      const current = requireStore();
      const job = current.work(current.get(input).id);
      if (job.state !== 'unknown' || !matches(job) || isPaused(job.target.sessionKey)) throw refusal('EXTERNAL_JOB_RECOVERY_UNAVAILABLE', 'Unknown job recovery is unavailable');
      if (typeof recoverInactive !== 'function') throw refusal('EXTERNAL_JOB_RECOVERY_UNAVAILABLE', 'Session recovery is unavailable');
      let confirmed = false;
      const idle = await recoverInactive(job, () => {
        const fresh = current.work(job.id);
        if (fresh.state !== 'unknown' || !matches(fresh) || isPaused(fresh.target.sessionKey)) throw refusal('EXTERNAL_JOB_RECOVERY_CHANGED', 'Job changed during recovery');
        current.setInactive(job.id);
        confirmed = true;
      });
      if (!idle || !confirmed) throw refusal('EXTERNAL_JOB_RECOVERY_UNCONFIRMED', 'Recovered session inactivity is not confirmed');
      return { job: withPause(current.get(input)) };
    },
    status(input) {
      if (!store) return { enabled: false, paused: false, pending: 0, running: 0 };
      const routeId = typeof input === 'string' ? input : input?.routeId;
      const sessionKey = target(routeId).sessionKey;
      return { ...store.status(sessionKey), paused: isPaused(sessionKey) };
    },
    pauseSession(sessionKey, paused) {
      try {
        const status = requireStore().pauseSession(sessionKey, paused);
        volatilePauses.delete(sessionKey);
        if (!paused) schedule();
        return status;
      } catch (error) {
        // A storage failure must not authorize more work in this daemon.
        // Failed resume keeps the hold until a human can save it successfully.
        if (paused === true) volatilePauses.add(sessionKey);
        throw error;
      }
    },
    isPaused,
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
