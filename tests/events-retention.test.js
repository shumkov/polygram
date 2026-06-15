'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const {
  pruneEvents,
  resolveRetentionPolicy,
  validatePolicy,
  DEFAULT_POLICY,
} = require('../lib/db/events-retention');

const DAY = 86_400_000;
const NOW = 1_750_000_000_000; // fixed clock for determinism

// Minimal events table matching migrations/001-initial.sql:85.
function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      chat_id TEXT,
      kind TEXT NOT NULL,
      detail_json TEXT
    );
    CREATE INDEX idx_events_recent ON events(ts DESC);
    CREATE INDEX idx_events_kind ON events(kind, ts DESC);
  `);
  return db;
}

// seed n rows of `kind` at `ageDays` old (relative to NOW).
function seed(db, kind, ageDays, n = 1) {
  const stmt = db.prepare('INSERT INTO events (ts, chat_id, kind, detail_json) VALUES (?,?,?,?)');
  const ts = NOW - Math.round(ageDays * DAY);
  for (let i = 0; i < n; i++) stmt.run(ts, '123', kind, null);
}

const countKind = (db, kind) => db.prepare('SELECT count(*) c FROM events WHERE kind=?').get(kind).c;
const total = (db) => db.prepare('SELECT count(*) c FROM events').get().c;

// Base test policy: permissive mass-delete guard so it doesn't interfere with
// functional tests; small cap for fast cap-tests. Individual tests override.
function policy(over = {}) {
  return {
    enabled: true,
    dryRun: false,
    diagnosticDays: 14,
    defaultDays: 90,
    diagnosticKinds: ['reactor-state', 'hook-lag-sample'],
    keepForeverKinds: ['polygram-start', 'handler-error', 'events-pruned', 'events-prune-preview', 'events-prune-skipped'],
    maxPerKind: 1_000_000, // large by default; cap-specific tests override small
    maxDeleteFraction: 0.99,
    batchSize: 1000,
    compactKinds: ['compact-command', 'compact-boundary', 'compact-replay', 'compact-failed-restart'],
    minCompactRetentionMs: 3 * 3600 * 1000,
    ...over,
  };
}

describe('events-retention: time tiers', () => {
  test('1. diagnostic kind pruned at 14d (13d survives, 15d deleted)', () => {
    const db = freshDb();
    seed(db, 'reactor-state', 13);
    seed(db, 'reactor-state', 15);
    pruneEvents(db, NOW, policy());
    assert.equal(countKind(db, 'reactor-state'), 1, 'only the 15d row should be deleted');
    // the survivor is the 13d one
    const row = db.prepare('SELECT ts FROM events WHERE kind=?').get('reactor-state');
    assert.equal(row.ts, NOW - 13 * DAY);
  });

  test('2. default kind pruned at 90d (89d survives, 91d deleted)', () => {
    const db = freshDb();
    seed(db, 'autosteer', 89);
    seed(db, 'autosteer', 91);
    seed(db, 'autosteer', 1, 5); // recent filler so mass-delete guard stays low
    pruneEvents(db, NOW, policy());
    assert.equal(countKind(db, 'autosteer'), 6, 'only the 91d row deleted');
    assert.equal(db.prepare('SELECT count(*) c FROM events WHERE kind=? AND ts=?').get('autosteer', NOW - 91 * DAY).c, 0);
  });

  test('5. recent rows of all kinds survive', () => {
    const db = freshDb();
    seed(db, 'reactor-state', 1);
    seed(db, 'autosteer', 1);
    seed(db, 'polygram-start', 1);
    pruneEvents(db, NOW, policy());
    assert.equal(total(db), 3);
  });

  test('6. boundary: row exactly at cutoff survives (pins ts < cutoff)', () => {
    const db = freshDb();
    // exactly defaultDays old → ts == cutoff → must survive (exclusive)
    seed(db, 'autosteer', 90);
    pruneEvents(db, NOW, policy());
    assert.equal(countKind(db, 'autosteer'), 1, 'row exactly at the cutoff must be kept');
  });
});

describe('events-retention: universal per-kind cap (incident-proofing)', () => {
  test('3. keep-forever survives by time but the cap still trims past maxPerKind', () => {
    const db = freshDb();
    seed(db, 'handler-error', 400, 8); // 8 rows, all ancient, keep-forever-by-time
    pruneEvents(db, NOW, policy({ maxPerKind: 5 }));
    assert.equal(countKind(db, 'handler-error'), 5, 'keep-forever is still bounded by the universal cap');
  });

  test('4. unlisted/new high-volume kind is capped even though it falls in default tier', () => {
    const db = freshDb();
    seed(db, 'some-new-sampler', 1, 9); // recent, so time-tier keeps all; cap must bite
    pruneEvents(db, NOW, policy({ maxPerKind: 5 }));
    assert.equal(countKind(db, 'some-new-sampler'), 5, 'cap bounds an unlisted kind');
  });

  test('cap keeps the MOST RECENT rows (by id)', () => {
    const db = freshDb();
    // seed oldest→newest; ids ascend with insertion
    for (let d = 9; d >= 1; d--) seed(db, 'foo', d); // 9 rows, ages 9d..1d
    pruneEvents(db, NOW, policy({ maxPerKind: 3 }));
    const rows = db.prepare('SELECT ts FROM events WHERE kind=? ORDER BY ts DESC').all('foo');
    assert.equal(rows.length, 3);
    // the 3 kept must be the 3 newest (ages 1,2,3)
    assert.deepEqual(rows.map((r) => (NOW - r.ts) / DAY), [1, 2, 3]);
  });
});

describe('events-retention: safety guards', () => {
  test('9. genuine backward clock (most rows future-dated) → skip, delete nothing', () => {
    const db = freshDb();
    seed(db, 'autosteer', -2, 8); // 8 rows 2d in the FUTURE — clock went back, most data "future"
    seed(db, 'autosteer', 100, 2); // 2 ancient
    const res = pruneEvents(db, NOW, policy({ maxDeleteFraction: 0.5 }));
    assert.equal(res.skipped, true);
    assert.match(res.reason, /clock/i);
    assert.equal(total(db), 10, 'nothing deleted under a suspect clock');
  });

  test('9b. a SINGLE future-dated outlier does NOT disable pruning (review finding #3)', () => {
    const db = freshDb();
    seed(db, 'autosteer', 100, 20); // 20 ancient, prunable (default 90d)
    seed(db, 'reactor-state', -2); // 1 outlier row 2d in the future (skew/import)
    for (let i = 0; i < 30; i++) seed(db, 'r' + i, 1); // recent filler so the prune isn't >50%
    const res = pruneEvents(db, NOW, policy({ maxDeleteFraction: 0.5 }));
    assert.equal(res.skipped, undefined, 'one future row must not poison MAX(ts) and skip everything');
    assert.equal(countKind(db, 'autosteer'), 0, 'the 20 ancient rows were pruned');
    assert.equal(countKind(db, 'reactor-state'), 1, 'the future row is kept (not old)');
  });

  test('10b. mass-delete guard does NOT over-count time∩cap overlap (review finding #1)', () => {
    const db = freshDb();
    seed(db, 'autosteer', 100, 30); // 30 ancient default-tier rows — ALSO over a small cap
    for (let i = 0; i < 60; i++) seed(db, 'k' + i, 1); // 60 recent singletons → true delete = 30/90 = 33%
    const res = pruneEvents(db, NOW, policy({ maxPerKind: 10, maxDeleteFraction: 0.5 }));
    assert.equal(res.skipped, undefined, 'guard must see 30 (33%), not the double-counted 50 (56%)');
    assert.equal(countKind(db, 'autosteer'), 0, 'all 30 ancient autosteer pruned');
    assert.equal(total(db), 60, 'the 60 recent singletons survive');
  });

  test('batchedDelete iterates multiple batches (25 rows, batchSize 10 → 3 batches)', () => {
    const db = freshDb();
    seed(db, 'autosteer', 100, 25); // 25 ancient → deleted across batches
    for (let i = 0; i < 20; i++) seed(db, 'f' + i, 1); // recent filler so 25/45 < the guard
    const res = pruneEvents(db, NOW, policy({ batchSize: 10, maxDeleteFraction: 0.99 }));
    assert.equal(res.deleted.default, 25, '10 + 10 + 5 across three batches');
    assert.equal(countKind(db, 'autosteer'), 0);
  });

  test('10. mass-delete guard: bucket would remove >fraction → refuse, delete nothing', () => {
    const db = freshDb();
    seed(db, 'autosteer', 100, 10); // all ancient → all 10 deletable = 100% of table
    const res = pruneEvents(db, NOW, policy({ maxDeleteFraction: 0.5 }));
    assert.equal(res.skipped, true);
    assert.match(res.reason, /mass.?delete|fraction/i);
    assert.equal(total(db), 10, 'refused — nothing deleted');
  });

  test('11. dryRun: counts what it would delete, deletes nothing', () => {
    const db = freshDb();
    seed(db, 'reactor-state', 30); // would be pruned (diagnostic 14d)
    seed(db, 'autosteer', 100); // would be pruned (default 90d)
    const res = pruneEvents(db, NOW, policy({ dryRun: true }));
    assert.equal(res.dryRun, true);
    assert.equal(total(db), 2, 'dryRun deletes nothing');
    assert.ok(res.preview && res.preview.total >= 2, 'preview reports what would be deleted');
  });

  test('disabled policy → no-op', () => {
    const db = freshDb();
    seed(db, 'autosteer', 100);
    const res = pruneEvents(db, NOW, policy({ enabled: false }));
    assert.equal(res.skipped, true);
    assert.equal(total(db), 1);
  });
});

describe('events-retention: policy validation (fail loud)', () => {
  test('8. overlapping diagnostic + keep-forever throws', () => {
    assert.throws(
      () => validatePolicy(policy({ diagnosticKinds: ['reactor-state', 'handler-error'] })),
      /both|disjoint/i,
    );
  });

  test('7b. compact-* retention below the replay window throws', () => {
    // put a compact kind into the diagnostic tier with a window below the 3h floor
    assert.throws(
      () => validatePolicy(policy({
        diagnosticKinds: ['reactor-state', 'compact-command'],
        diagnosticDays: 0.05, // ~72 min < 3h floor
      })),
      /compact|replay/i,
    );
  });

  test('null/empty kind in a tier throws', () => {
    assert.throws(() => validatePolicy(policy({ keepForeverKinds: ['polygram-start', ''] })), /null|empty/i);
  });

  test('valid default policy passes validation', () => {
    assert.doesNotThrow(() => validatePolicy(DEFAULT_POLICY));
  });
});

describe('events-retention: consumer safety + IN-list binding', () => {
  test('7. compact-command + handled marker at 20d both survive (no re-surface)', () => {
    const db = freshDb();
    seed(db, 'compact-command', 20);
    seed(db, 'compact-failed-restart', 20);
    pruneEvents(db, NOW, policy());
    // both are in the default 90d tier → both survive at 20d → dedup still works
    assert.equal(countKind(db, 'compact-command'), 1);
    assert.equal(countKind(db, 'compact-failed-restart'), 1);
  });

  test('12. IN-list actually bound: keep-forever survives past default cutoff AND a non-protected kind same age is deleted', () => {
    const db = freshDb();
    seed(db, 'handler-error', 200); // keep-forever → survives
    seed(db, 'autosteer', 200); // default tier, ancient → deleted
    seed(db, 'autosteer', 1, 5); // filler to keep mass-delete fraction low
    pruneEvents(db, NOW, policy());
    assert.equal(countKind(db, 'handler-error'), 1, 'keep-forever NOT deleted (proves NOT IN list bound, no NULL no-op)');
    assert.equal(db.prepare('SELECT count(*) c FROM events WHERE kind=? AND ts=?').get('autosteer', NOW - 200 * DAY).c, 0, 'unprotected old row WAS deleted');
  });
});

describe('events-retention: return value', () => {
  test('13. reports per-bucket deleted counts', () => {
    const db = freshDb();
    seed(db, 'reactor-state', 30); // diagnostic delete
    seed(db, 'autosteer', 100); // default delete
    seed(db, 'foo', 1, 8); // cap delete (maxPerKind 5 → 3 over)
    seed(db, 'autosteer', 1, 10); // filler so fraction stays low
    const res = pruneEvents(db, NOW, policy({ maxPerKind: 5 }));
    assert.equal(res.skipped, undefined);
    assert.ok(res.deleted.total >= 1 + 1 + 3, 'total reflects diagnostic + default + cap deletes');
    assert.ok(res.deleted.diagnostic >= 1);
    assert.ok(res.deleted.default >= 1);
    assert.ok(res.deleted.cap >= 3);
  });
});

describe('events-retention: resolveRetentionPolicy', () => {
  test('merges config override onto defaults', () => {
    const p = resolveRetentionPolicy({ defaults: { events_retention: { defaultDays: 30, dryRun: true } } });
    assert.equal(p.defaultDays, 30);
    assert.equal(p.dryRun, true);
    assert.equal(p.diagnosticDays, DEFAULT_POLICY.diagnosticDays, 'unspecified keys fall back to defaults');
  });

  test('no config → defaults', () => {
    const p = resolveRetentionPolicy(undefined);
    assert.equal(p.defaultDays, DEFAULT_POLICY.defaultDays);
    assert.equal(p.enabled, true);
  });
});

describe('events-retention: numeric policy validation (review finding #2)', () => {
  // An unvalidated batchSize<=0 makes batchedDelete spin forever (DELETE LIMIT 0
  // deletes 0, never < batchSize) → wedges the synchronous daemon.
  for (const [label, over] of [
    ['batchSize 0', { batchSize: 0 }],
    ['batchSize -1', { batchSize: -1 }],
    ['batchSize non-int', { batchSize: 2.5 }],
    ['maxPerKind 0', { maxPerKind: 0 }],
    ['maxDeleteFraction > 1', { maxDeleteFraction: 1.5 }],
    ['maxDeleteFraction 0', { maxDeleteFraction: 0 }],
    ['defaultDays 0', { defaultDays: 0 }],
    ['diagnosticDays -1', { diagnosticDays: -1 }],
  ]) {
    test(`validatePolicy throws on ${label}`, () => {
      assert.throws(() => validatePolicy(policy(over)), /events_retention/);
    });
  }

  test('DEFAULT_POLICY passes numeric validation', () => {
    assert.doesNotThrow(() => validatePolicy(DEFAULT_POLICY));
  });
});

describe('events-retention: dryRun on empty table (review finding #4)', () => {
  test('returns the dryRun shape, not the deleted shape', () => {
    const db = freshDb();
    const res = pruneEvents(db, NOW, policy({ dryRun: true }));
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.preview, { default: 0, diagnostic: 0, cap: 0, total: 0 });
  });
});
