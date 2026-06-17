'use strict';

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
 * @returns {{recover: Array, skip: Array, notices: Array<{chat_id, thread_id, items: Array}>}}
 */
function classifyReplay({ candidates = [], cleanShutdown = false, hasCompletedTurn, announceable } = {}) {
  const answered = typeof hasCompletedTurn === 'function' ? hasCompletedTurn : () => false;
  const pending = (candidates || []).filter((c) => !answered(c));

  if (!cleanShutdown) {
    // Crash: recover everything unanswered (unchanged rc.57 behavior).
    return { recover: pending, skip: [], notices: [] };
  }

  // Deliberate restart: skip ALL pending (none re-answered), and group the
  // ANNOUNCEABLE ones per (chat, thread) for one visibility notice each
  // (isolateTopics-safe). announceable excludes admin/slash + abort-shaped rows
  // (H5) — those are skipped silently, mirroring the crash path's redelivery
  // gate which never re-executes them. Default: everything announceable.
  const isAnnounceable = typeof announceable === 'function' ? announceable : () => true;
  const SEP = String.fromCharCode(0); // NUL separator (H8, collision-proof)
  const groups = new Map();
  for (const c of pending) {
    if (!isAnnounceable(c)) continue;
    const thread = c.thread_id == null ? null : c.thread_id;
    const key = `${c.chat_id}${SEP}${thread == null ? '' : thread}`;
    let g = groups.get(key);
    if (!g) { g = { chat_id: c.chat_id, thread_id: thread, items: [] }; groups.set(key, g); }
    g.items.push(c);
  }
  return { recover: [], skip: pending, notices: Array.from(groups.values()) };
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
 * @param {{recover:Array, skip:Array, notices:Array}} opts.plan
 * @param {object} opts.deps
 * @param {(candidate)=>Promise<{ok:boolean}>} opts.deps.recover  crash-path re-dispatch
 * @param {(group)=>Promise<{ok:boolean, messageId?:any, error?:string}>} opts.deps.sendNotice
 * @param {(candidate)=>void} opts.deps.markSkipped  mark row terminal 'replay-skipped'
 * @param {(kind, detail)=>void} [opts.deps.logEvent]
 * @returns {Promise<{recovered:number, skipped:number, noticed:number, noticeFailed:number}>}
 */
async function executeReplayPlan({ plan, deps }) {
  const { recover = [], skip = [], notices = [] } = plan || {};
  const log = (deps && deps.logEvent) || (() => {});
  let recovered = 0; let skipped = 0; let noticed = 0; let noticeFailed = 0;

  // CRASH branch — recover each (unchanged rc.57 behavior).
  for (const c of recover) {
    // eslint-disable-next-line no-await-in-loop
    const r = await deps.recover(c);
    if (r && r.ok) recovered += 1; else skipped += 1;
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
  return { recovered, skipped, noticed, noticeFailed };
}

module.exports = { classifyReplay, executeReplayPlan };
