'use strict';

const {
  classifyCodexRecoveryEvidence,
} = require('../db/auto-resume');

function providerReplayDisposition(candidate, getProviderRecovery) {
  if (typeof getProviderRecovery === 'function') {
    let evidence;
    try {
      evidence = getProviderRecovery(candidate);
    } catch {
      return {
        provider: 'unknown',
        action: 'defer',
        reason: 'provider-recovery-unavailable',
      };
    }
    if (evidence?.provider === 'claude') {
      return { provider: 'claude', action: 'legacy' };
    }
    if (evidence?.provider === 'codex') {
      return {
        provider: 'codex',
        ...classifyCodexRecoveryEvidence(evidence),
      };
    }
    return {
      provider: 'unknown',
      action: 'defer',
      reason: 'provider-recovery-unavailable',
    };
  }

  const provider = candidate?.provider ?? candidate?.runtime;
  if (provider === 'codex') {
    return {
      provider: 'codex',
      ...classifyCodexRecoveryEvidence(candidate),
    };
  }
  return { provider: provider || 'claude', action: 'legacy' };
}

/**
 * Boot-replay disposition (0.14) — decide what to do with the replay candidate
 * set, given whether the last shutdown was a DELIBERATE restart or a CRASH.
 *
 * Pure function (no I/O) so it's unit-testable without booting the daemon; the
 * caller performs the actual dispatch / skip-marking / notice-sending from the
 * returned plan (see executeReplayPlan).
 *
 *   - CRASH (cleanShutdown=false): recover every still-unanswered candidate —
 *     the existing rc.57 behavior. An unexpected exit must never silently drop
 *     interrupted work.
 *   - CLEAN (cleanShutdown=true): a deliberate restart. Prod data (n=3430)
 *     showed skip-vs-recover CANNOT be auto-classified (53% of turns run >=30s
 *     so ordinary interactive turns are replay-pending just like a long task,
 *     and the rc.57 Xero case is itself a user message). So we decide by RESTART
 *     INTENT, not message state: skip ALL pending candidates (don't re-answer
 *     stale messages) and surface ONE visibility notice per chat/topic so a
 *     genuinely-needed reply can be re-sent. rc.57's harm was *silent* loss;
 *     this makes the skip *visible*.
 *
 * Dedup: a candidate already answered (hasCompletedTurn -> true) is dropped from
 * the plan entirely — never recovered, never announced. The caller wires this to
 * db.hasCompletedTurnFor (turn_metrics), NOT hasOutboundReplyTo (rc.51).
 *
 * @param {object} opts
 * @param {Array<{chat_id, thread_id?, msg_id}>} opts.candidates
 * @param {boolean} opts.cleanShutdown  true iff the clean-shutdown marker was present+fresh
 * @param {(candidate)=>boolean} [opts.hasCompletedTurn]  already-answered predicate (default: none)
 * @param {(candidate)=>boolean} [opts.announceable]  notice-eligible predicate (default: all). Excludes
 *   admin/slash + abort-shaped rows so we don't announce "I didn't resume your /new".
 * @param {(candidate)=>object} [opts.getProviderRecovery] authoritative provider
 *   and durable-recovery evidence. When supplied, unknown/error results defer
 *   rather than enter the legacy recovery path.
 * @returns {{recover: Array, recoverCodex?: Array, skip: Array,
 *   defer?: Array, notices: Array<{chat_id, thread_id, items: Array}>}}
 */
function classifyReplay({
  candidates = [],
  cleanShutdown = false,
  hasCompletedTurn,
  announceable,
  getProviderRecovery,
} = {}) {
  const answered = typeof hasCompletedTurn === 'function' ? hasCompletedTurn : () => false;
  const pending = (candidates || []).filter((c) => !answered(c));
  const legacy = [];
  const recoverCodex = [];
  const cancelled = [];
  const defer = [];

  for (const candidate of pending) {
    const disposition = providerReplayDisposition(
      candidate,
      getProviderRecovery,
    );
    if (disposition.action === 'legacy') {
      legacy.push(candidate);
    } else if (disposition.action === 'recover') {
      recoverCodex.push(candidate);
    } else if (disposition.action === 'skip') {
      cancelled.push(candidate);
    } else {
      defer.push(candidate);
    }
  }

  if (!cleanShutdown) {
    // Legacy providers retain crash recovery. Codex requests use a separate
    // recoverer so they cannot accidentally fail over to Claude.
    const plan = {
      recover: legacy,
      skip: cancelled,
      notices: [],
    };
    if (recoverCodex.length > 0) plan.recoverCodex = recoverCodex;
    if (defer.length > 0) plan.defer = defer;
    return plan;
  }

  // Deliberate restart: skip ALL pending (none re-answered), and group the
  // ANNOUNCEABLE ones per (chat, thread) for one visibility notice each
  // (isolateTopics-safe). announceable excludes admin/slash + abort-shaped rows
  // (H5) — those are skipped silently, mirroring the crash path's redelivery
  // gate which never re-executes them. Default: everything announceable.
  const isAnnounceable = typeof announceable === 'function' ? announceable : () => true;
  const SEP = String.fromCharCode(0); // NUL separator (H8, collision-proof)
  const groups = new Map();
  const restartSkipped = [...legacy, ...recoverCodex];
  for (const c of restartSkipped) {
    if (!isAnnounceable(c)) continue;
    const thread = c.thread_id == null ? null : c.thread_id;
    const key = `${c.chat_id}${SEP}${thread == null ? '' : thread}`;
    let g = groups.get(key);
    if (!g) { g = { chat_id: c.chat_id, thread_id: thread, items: [] }; groups.set(key, g); }
    g.items.push(c);
  }
  const plan = {
    recover: [],
    skip: [...restartSkipped, ...cancelled],
    notices: Array.from(groups.values()),
  };
  if (defer.length > 0) plan.defer = defer;
  return plan;
}

/**
 * Execute a classified plan (0.14, H6). Pure-ish: all I/O via injected deps, so
 * it's unit-testable and the crash-seam ordering can be asserted.
 *
 * Ordering (fail-toward-recovery): the caller has already read-and-cleared the
 * marker BEFORE this runs, so a crash mid-execution leaves un-marked rows as
 * candidates -> next boot has no marker -> CRASH branch recovers them (never a
 * silent drop). Within the clean branch: send each group's notice FIRST; only on
 * a CONFIRMED send mark that group's rows terminal ('replay-skipped'); on a send
 * FAILURE leave the rows recoverable and emit replay-notice-failed. Gate-blocked
 * skip items (not in any notice group) are marked terminal silently.
 *
 * @param {object} opts
 * @param {{recover:Array, recoverCodex?:Array, skip:Array, defer?:Array,
 *   notices:Array}} opts.plan
 * @param {object} opts.deps
 * @param {(candidate)=>Promise<{ok:boolean}>} opts.deps.recover  crash-path re-dispatch
 * @param {(candidate)=>Promise<{ok:boolean}>} [opts.deps.recoverCodex]
 *   exact-runtime Codex crash-path re-dispatch
 * @param {(group)=>Promise<{ok:boolean, messageId?:any, error?:string}>} opts.deps.sendNotice
 * @param {(candidate)=>void} opts.deps.markSkipped  mark row terminal 'replay-skipped'
 * @param {(kind, detail)=>void} [opts.deps.logEvent]
 * @returns {Promise<{recovered:number, skipped:number, noticed:number,
 *   noticeFailed:number, deferred?:number}>}
 */
async function executeReplayPlan({ plan, deps }) {
  const {
    recover = [],
    recoverCodex = [],
    skip = [],
    notices = [],
    defer = [],
  } = plan || {};
  const log = (deps && deps.logEvent) || (() => {});
  let recovered = 0; let skipped = 0; let noticed = 0; let noticeFailed = 0;
  let deferred = defer.length;

  // Legacy provider crash recovery.
  for (const c of recover) {
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await deps.recover(c);
    } catch (error) {
      if (error?.code !== 'CODEX_SCOPE_DISABLED') throw error;
      deferred += 1;
      log('codex-replay-deferred', {
        chat_id: c.chat_id,
        thread_id: c.thread_id == null ? null : c.thread_id,
        msg_id: c.msg_id,
        reason: 'scope-disabled',
      });
      continue;
    }
    if (r && r.ok) recovered += 1; else skipped += 1;
  }

  // Codex recovery is deliberately separate from the legacy recoverer. If the
  // caller has not wired an exact-runtime path, leave the row pending.
  for (const c of recoverCodex) {
    if (typeof deps.recoverCodex !== 'function') {
      deferred += 1;
      log('codex-replay-deferred', {
        chat_id: c.chat_id,
        thread_id: c.thread_id == null ? null : c.thread_id,
        msg_id: c.msg_id,
        reason: 'codex-recoverer-unavailable',
      });
      continue;
    }
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await deps.recoverCodex(c);
    } catch (error) {
      if (error?.code !== 'CODEX_SCOPE_DISABLED') throw error;
      deferred += 1;
      log('codex-replay-deferred', {
        chat_id: c.chat_id,
        thread_id: c.thread_id == null ? null : c.thread_id,
        msg_id: c.msg_id,
        reason: 'scope-disabled',
      });
      continue;
    }
    if (r && r.ok) recovered += 1; else deferred += 1;
  }

  // CLEAN branch — notice-then-mark, per group.
  const inNotices = new Set();
  for (const g of notices) for (const c of g.items) inNotices.add(c);
  for (const g of notices) {
    let res;
    // eslint-disable-next-line no-await-in-loop
    try { res = await deps.sendNotice(g); } catch (e) { res = { ok: false, error: e && e.message }; }
    if (res && res.ok) {
      for (const c of g.items) { deps.markSkipped(c); skipped += 1; }
      noticed += 1;
      log('replay-notice-sent', { chat_id: g.chat_id, thread_id: g.thread_id, count: g.items.length, notice_msg_id: res.messageId });
    } else {
      noticeFailed += 1;
      log('replay-notice-failed', { chat_id: g.chat_id, thread_id: g.thread_id, count: g.items.length, error: res && res.error });
      // leave rows recoverable (no markSkipped) — next boot's crash branch recovers them
    }
  }
  // Gate-blocked skip items (never in a notice group) -> terminal, silent.
  for (const c of skip) {
    if (!inNotices.has(c)) { deps.markSkipped(c); skipped += 1; }
  }
  const result = { recovered, skipped, noticed, noticeFailed };
  if (deferred > 0) result.deferred = deferred;
  return result;
}

module.exports = {
  classifyReplay,
  executeReplayPlan,
  classifyCodexRecoveryEvidence,
};
