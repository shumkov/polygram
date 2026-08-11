'use strict';

/**
 * events-table retention (#3, spec docs/0.13-events-retention-spec.md).
 *
 * `events` is append-only and grew unbounded fleet-wide (the table that
 * ballooned shumabit.db to 4.4GB in the May-3 EIO storm). This caps it with:
 *   - time tiers: diagnostic kinds (high-frequency, short forensic value) pruned
 *     at `diagnosticDays`; everything else at `defaultDays`; a keep-forever set
 *     (lifecycle + errors) never pruned by time.
 *   - a UNIVERSAL per-kind row cap (`maxPerKind`) applied to EVERY kind incl.
 *     keep-forever — the real safety net so hardcoded tier lists aren't
 *     load-bearing and an incident-storm of one kind (12k/sec handler-error,
 *     the May-3 shape) can't balloon the table.
 *   - safety guards: `enabled` kill switch, `dryRun`, clock-backward skip, and a
 *     mass-delete fraction guard (refuse if a run would remove > a fraction of
 *     the table — the check that would have made May-3 a deliberate act).
 *
 * `pruneEvents` is PURE w.r.t. the events log: it deletes + returns counts but
 * writes NO event rows. The caller (polygram boot) emits the `events-pruned` /
 * `-preview` / `-skipped` audit event from the returned result (those kinds are
 * in keepForever, so the audit trail survives its own prune).
 */

const DAY_MS = 86_400_000;
// A few minutes of grace so rows written ~now (between Date.now() capture and the
// COUNT) don't read as "future". Genuine backward-clock detection is fraction-based.
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

const DEFAULT_POLICY = {
  enabled: true,
  dryRun: false,
  diagnosticDays: 14,
  defaultDays: 90,
  diagnosticKinds: [
    'reactor-state', 'hook-lag-sample', 'tool-result', 'cli-ups-seen',
    // dormant since 2026-05-25 but listed defensively in case re-enabled:
    'hook-event', 'turn-phase-change',
  ],
  keepForeverKinds: [
    'polygram-start', 'polygram-stop', 'shutdown-drain',
    'handler-error', 'auth-expired', 'resume-fail',
    // 0.14 boot-replay forensics — was a real task skipped-and-announced, or
    // silently lost? Kept so "why didn't my message get answered after the
    // restart?" is answerable beyond the 90d default (still capped).
    'replay-on-boot', 'replay-notice-sent', 'replay-notice-failed',
    'clean-restart-qualification-observed',
    // 0.15 secret-redaction audit — what was redacted/flagged, kept for review.
    'secret-sweep', 'secret-sweep-failed',
    'secret-redacted-by-agent', 'secret-redact-requested-no-match',
    // the prune's own audit trail — kept so it survives a prune (still capped):
    'events-pruned', 'events-prune-preview', 'events-prune-skipped',
  ],
  maxPerKind: 50_000,
  maxDeleteFraction: 0.5,
  batchSize: 5_000,
  // compact-* drive findOrphanedCompactCommands; their retention must stay above
  // the replay-window cap (2h) + margin or the rc.66 handled-/compact dedup can
  // re-surface an old /compact to a partner. Validated, not assumed.
  compactKinds: ['compact-command', 'compact-boundary', 'compact-replay', 'compact-failed-restart'],
  minCompactRetentionMs: 3 * 3600 * 1000, // 3h > 2h replay cap
};

/** Merge a `config.defaults.events_retention` override onto the defaults. */
function resolveRetentionPolicy(config) {
  const o = (config && config.defaults && config.defaults.events_retention) || {};
  return {
    ...DEFAULT_POLICY,
    ...o,
    // arrays don't deep-merge — fall back to defaults when not overridden
    diagnosticKinds: o.diagnosticKinds || DEFAULT_POLICY.diagnosticKinds,
    keepForeverKinds: o.keepForeverKinds || DEFAULT_POLICY.keepForeverKinds,
    compactKinds: o.compactKinds || DEFAULT_POLICY.compactKinds,
  };
}

/** Fail loud on a misconfigured policy. Called at load and defensively per-run. */
function validatePolicy(policy) {
  // Numeric sanity. An unvalidated batchSize<=0 makes batchedDelete spin forever
  // (DELETE LIMIT 0 deletes 0, `0 < 0` is false) and wedges the synchronous
  // daemon — the "a config typo must never take down the bot" promise depends on
  // catching it here, before the loop.
  if (!Number.isInteger(policy.batchSize) || policy.batchSize < 1) {
    throw new Error(`events_retention: batchSize must be a positive integer (got ${policy.batchSize})`);
  }
  if (!Number.isInteger(policy.maxPerKind) || policy.maxPerKind < 1) {
    throw new Error(`events_retention: maxPerKind must be a positive integer (got ${policy.maxPerKind})`);
  }
  if (!(typeof policy.maxDeleteFraction === 'number' && policy.maxDeleteFraction > 0 && policy.maxDeleteFraction <= 1)) {
    throw new Error(`events_retention: maxDeleteFraction must be in (0,1] (got ${policy.maxDeleteFraction})`);
  }
  for (const f of ['diagnosticDays', 'defaultDays']) {
    if (!(typeof policy[f] === 'number' && policy[f] > 0)) {
      throw new Error(`events_retention: ${f} must be a positive number (got ${policy[f]})`);
    }
  }

  const diag = policy.diagnosticKinds || [];
  const keep = policy.keepForeverKinds || [];
  for (const k of [...diag, ...keep]) {
    if (!k || typeof k !== 'string') {
      throw new Error('events_retention: null/empty kind in a tier list');
    }
  }
  const keepSet = new Set(keep);
  for (const k of diag) {
    if (keepSet.has(k)) {
      throw new Error(`events_retention: kind "${k}" is in both diagnostic and keep-forever (tiers must be disjoint)`);
    }
  }
  const diagSet = new Set(diag);
  for (const k of (policy.compactKinds || [])) {
    let ms;
    if (keepSet.has(k)) ms = Infinity;
    else if (diagSet.has(k)) ms = policy.diagnosticDays * DAY_MS;
    else ms = policy.defaultDays * DAY_MS;
    if (ms < policy.minCompactRetentionMs) {
      throw new Error(`events_retention: compact kind "${k}" retention (${ms}ms) is below the replay-window floor (${policy.minCompactRetentionMs}ms) — would re-arm the rc.66 re-surface bug`);
    }
  }
  return true;
}

/** Loop DELETE…LIMIT until a batch comes up short. Steady state = 1 batch. */
function batchedDelete(rawDb, sql, params, batchSize) {
  const stmt = rawDb.prepare(sql);
  let deleted = 0;
  for (;;) {
    const r = stmt.run(...params, batchSize);
    deleted += r.changes;
    // `=== 0` is the belt-and-suspenders against a pathological LIMIT (e.g. a
    // negative LIMIT = unlimited, which would otherwise loop on the empty set);
    // validatePolicy already rejects batchSize<1, so this is defense-in-depth.
    if (r.changes < batchSize || r.changes === 0) break;
  }
  return deleted;
}

/**
 * Prune the events table per `policy`. Returns one of:
 *   { skipped: true, reason }                         — disabled / clock / mass-delete
 *   { dryRun: true, preview: {default,diagnostic,cap,total}, before }
 *   { deleted: {default,diagnostic,cap,total}, before, after }
 * Never writes an event row (caller logs the audit event).
 */
function pruneEvents(rawDb, now, policy) {
  if (!policy.enabled) return { skipped: true, reason: 'disabled' };
  validatePolicy(policy);

  const diagSet = new Set(policy.diagnosticKinds);
  const keepSet = new Set(policy.keepForeverKinds);

  const totalBefore = rawDb.prepare('SELECT count(*) c FROM events').get().c;
  if (totalBefore === 0) {
    return policy.dryRun
      ? { dryRun: true, preview: { default: 0, diagnostic: 0, cap: 0, total: 0 }, before: 0 }
      : { deleted: { default: 0, diagnostic: 0, cap: 0, total: 0 }, before: 0, after: 0 };
  }

  // Clock-suspect guard. A genuine backward clock makes a LARGE fraction of rows
  // read as "future" relative to `now` — pruning under it would delete recent
  // data. But a SINGLE skewed/imported future row must NOT disable pruning, so
  // this is fraction-based, not max(ts)-based (review finding #3: one outlier
  // poisoning MAX(ts) silently stopped all pruning).
  const future = rawDb.prepare('SELECT count(*) c FROM events WHERE ts > ?').get(now + CLOCK_SKEW_TOLERANCE_MS).c;
  if (future > 0 && future / totalBefore > policy.maxDeleteFraction) {
    return { skipped: true, reason: `clock-suspect (${future}/${totalBefore} rows future-dated > ${policy.maxDeleteFraction})` };
  }

  const diagCut = now - policy.diagnosticDays * DAY_MS;
  const defCut = now - policy.defaultDays * DAY_MS;

  // Default-bucket predicate (for the actual bulk delete): old AND not diagnostic
  // AND not keep-forever. Explicit ?-placeholders — better-sqlite3 does NOT expand
  // a JS array from one param, and `NOT IN (…, NULL)` is a 3-valued-logic trap;
  // validatePolicy already guarantees no NULL members.
  const excluded = [...diagSet, ...keepSet];
  const ph = excluded.map(() => '?').join(',');
  const defWhere = `ts < ?${excluded.length ? ` AND kind NOT IN (${ph})` : ''}`;

  // ---- estimate (drives dryRun + the mass-delete guard) ----
  // Per-kind so the cap estimate counts SURVIVORS after the time-delete, not raw
  // counts. Otherwise a kind that is both old AND over-cap is counted twice
  // (time bucket + cap bucket), inflating estTotal past the real delete count and
  // tripping the mass-delete guard against the exact high-volume prune it exists
  // for — self-defeating (review finding #1). Each row is counted at most once.
  const cntOlder = rawDb.prepare('SELECT count(*) c FROM events WHERE kind = ? AND ts < ?');
  const kinds = rawDb.prepare('SELECT kind, count(*) c FROM events GROUP BY kind').all();
  let estDefault = 0;
  let estDiag = 0;
  let estCap = 0;
  for (const { kind, c } of kinds) {
    let timeDel = 0;
    if (keepSet.has(kind)) {
      timeDel = 0; // keep-forever: no time delete
    } else if (diagSet.has(kind)) {
      timeDel = cntOlder.get(kind, diagCut).c; estDiag += timeDel;
    } else {
      timeDel = cntOlder.get(kind, defCut).c; estDefault += timeDel;
    }
    const survivors = c - timeDel;
    if (survivors > policy.maxPerKind) estCap += survivors - policy.maxPerKind;
  }
  const estTotal = estDefault + estDiag + estCap;

  // dryRun returns the preview regardless of the mass-delete guard (you want to
  // SEE a would-be mass delete). Clock-backward already short-circuited above.
  if (policy.dryRun) {
    return {
      dryRun: true,
      preview: { default: estDefault, diagnostic: estDiag, cap: estCap, total: estTotal },
      before: totalBefore,
    };
  }

  // Mass-delete guard: refuse an anomalous run rather than execute it.
  if (estTotal > 0 && estTotal / totalBefore > policy.maxDeleteFraction) {
    return {
      skipped: true,
      reason: `mass-delete-guard (${estTotal}/${totalBefore} = ${(estTotal / totalBefore).toFixed(2)} > ${policy.maxDeleteFraction})`,
    };
  }

  // ---- execute (batched; steady state is a single batch) ----
  const delDefault = batchedDelete(rawDb, `DELETE FROM events WHERE ${defWhere} LIMIT ?`, [defCut, ...excluded], policy.batchSize);
  let delDiag = 0;
  for (const k of diagSet) {
    delDiag += batchedDelete(rawDb, 'DELETE FROM events WHERE kind = ? AND ts < ? LIMIT ?', [k, diagCut], policy.batchSize);
  }
  // Universal cap: for each kind, delete everything older (by id) than the
  // maxPerKind-th most-recent row. Applies to keep-forever too.
  let delCap = 0;
  for (const { kind, c } of kinds) {
    if (c <= policy.maxPerKind) continue;
    const thr = rawDb.prepare('SELECT id FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1 OFFSET ?').get(kind, policy.maxPerKind);
    if (!thr) continue; // a time-delete already brought it under the cap
    delCap += batchedDelete(rawDb, 'DELETE FROM events WHERE kind = ? AND id <= ? LIMIT ?', [kind, thr.id], policy.batchSize);
  }

  const totalDeleted = delDefault + delDiag + delCap;
  // Reclaim WAL slack after a large prune (steady-state prunes are tiny — skip).
  if (totalDeleted > policy.batchSize) {
    try { rawDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  }

  return {
    deleted: { default: delDefault, diagnostic: delDiag, cap: delCap, total: totalDeleted },
    before: totalBefore,
    after: totalBefore - totalDeleted,
  };
}

module.exports = { pruneEvents, resolveRetentionPolicy, validatePolicy, DEFAULT_POLICY };
