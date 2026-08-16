'use strict';

/**
 * Background secret sweep (0.15) — scans un-scanned messages, redacts HIGH+MEDIUM
 * secrets in place, flags LOW, writes an audit fingerprint, and stamps the
 * incremental high-water (messages.secret_scanned_at) so it never rescans.
 * Modeled on lib/db/events-retention.js pruneEvents: takes the raw better-sqlite3
 * handle, batched + bounded, idempotent. NOT hot-path (boot + interval).
 *
 * dryRun (default for the first deploy): count + log what WOULD be redacted,
 * mutate nothing — so the operator reviews precision against real data before
 * enforcement.
 *
 * Uses an id cursor (id > lastId) so dry-run (which doesn't stamp) still advances
 * past processed rows instead of looping the same batch.
 */

const { redactText } = require('../secret-detect');

function sweepSecrets(rawDb, opts = {}) {
  const {
    now = Date.now(),
    batchSize = 500,
    maxPerRun = 5000,
    dryRun = false,
    redactTiers = ['high', 'medium'],
  } = opts;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('sweepSecrets: batchSize must be a positive integer');
  if (!Number.isInteger(maxPerRun) || maxPerRun < 1) throw new Error('sweepSecrets: maxPerRun must be a positive integer');

  const sel = rawDb.prepare(`
    SELECT id, chat_id, msg_id, text FROM messages
     WHERE id > ? AND secret_scanned_at IS NULL AND text IS NOT NULL AND text != ''
     ORDER BY id LIMIT ?`);
  const updText = rawDb.prepare('UPDATE messages SET text = ? WHERE id = ?');
  const stamp = rawDb.prepare('UPDATE messages SET secret_scanned_at = ? WHERE id = ?');
  // The audit records what was redacted and where. It deliberately stores no
  // digest of the value: an unsalted hash of a guessable secret is a
  // correlation handle for the secret itself.
  const insAudit = rawDb.prepare(`INSERT INTO secret_redactions
    (chat_id, msg_id, rule, tier, length, action, ts) VALUES (?,?,?,?,?,?,?)`);

  let scanned = 0; let redactedMsgs = 0; let redactions = 0; let flagged = 0;
  const ruleCounts = {};
  let lastId = 0;

  while (scanned < maxPerRun) {
    const rows = sel.all(lastId, Math.min(batchSize, maxPerRun - scanned));
    if (rows.length === 0) break;
    const apply = rawDb.transaction((batch) => {
      for (const row of batch) {
        const res = redactText(row.text, { redactTiers });
        if (!dryRun) {
          if (res.changed) updText.run(res.text, row.id);                 // FTS re-indexes via the UPDATE trigger
          for (const r of res.redacted) insAudit.run(String(row.chat_id), row.msg_id, r.rule, r.tier, r.length, 'redacted', now);
          for (const f of res.flagged) insAudit.run(String(row.chat_id), row.msg_id, f.rule, f.tier, f.length, 'flagged', now);
          stamp.run(now, row.id);
        }
        if (res.changed) redactedMsgs += 1;
        redactions += res.redacted.length;
        flagged += res.flagged.length;
        for (const r of [...res.redacted, ...res.flagged]) ruleCounts[r.rule] = (ruleCounts[r.rule] || 0) + 1;
        scanned += 1;
      }
    });
    apply(rows);
    lastId = rows[rows.length - 1].id;
    if (rows.length < batchSize) break;
  }

  // We stopped either because the table ran dry or because we hit maxPerRun.
  // In dryRun nothing is stamped, so the next interval run re-scans from id=0 —
  // meaning a single dry-run NEVER previews rows beyond the first maxPerRun.
  // Surface `reachedCap` + the count still unscanned past our cursor so the
  // caller can log a partial-preview warning (the operator must not read a
  // clean dry-run as "the whole table is safe"). See the spec's enable steps.
  const reachedCap = scanned >= maxPerRun;
  let remaining = 0;
  if (reachedCap) {
    remaining = rawDb.prepare(
      `SELECT COUNT(*) c FROM messages WHERE id > ? AND secret_scanned_at IS NULL AND text IS NOT NULL AND text != ''`,
    ).get(lastId).c;
  }

  return { scanned, redactedMsgs, redactions, flagged, ruleCounts, dryRun, reachedCap, remaining };
}

/**
 * Resolve config.defaults.secret_sweep. Conservative defaults: DISABLED unless
 * explicitly enabled, and dryRun ON when enabled (the operator flips dryRun off
 * after reviewing the dry-run logs). 6h interval.
 */
function resolveSecretSweepConfig(config) {
  const o = (config && config.defaults && config.defaults.secret_sweep) || {};
  const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  return {
    enabled: o.enabled === true,
    dryRun: o.dryRun !== false,
    batchSize: posInt(o.batchSize, 500),
    maxPerRun: posInt(o.maxPerRun, 5000),
    intervalMs: posInt(o.intervalMs, 6 * 3_600_000),
  };
}

module.exports = { sweepSecrets, resolveSecretSweepConfig };
