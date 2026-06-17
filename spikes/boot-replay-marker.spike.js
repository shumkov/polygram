#!/usr/bin/env node
/**
 * SPIKE — prove the 0.14 clean-shutdown DB marker semantics against the REAL
 * polling_state constraints, before integrating into polygram.js. In-memory
 * SQLite, self-asserting. Run:  node spikes/boot-replay-marker.spike.js
 *
 * Hardened after re-review. It now models the production realities the first
 * cut glossed:
 *  - polling_state.last_update_id / ts are NOT NULL (migration 005) → the
 *    marker upsert must populate them (COALESCE from any existing row) or it
 *    throws on a fresh/quiet bot that has no polling_state row yet (the most
 *    common first-shutdown case — a row only appears on a non-empty getUpdates).
 *  - The marker is written UNCONDITIONALLY on a clean shutdown, NOT only when
 *    there are in-flight rows to mark replay-pending. (Real markReplayPending
 *    runs only in the `remaining>0` branch; the clean-drain `remaining===0`
 *    case must still write the marker, else a stale replay-pending row from a
 *    prior life gets crash-recovered on a deliberate restart = rc.57 re-fire.)
 *  - Read-and-clear at boot; fail-toward-crash on missing / stale / FUTURE
 *    (clock-skew) markers; recency bound derived from the replay window.
 *  - Atomicity: a crash mid-shutdown-txn leaves NEITHER marker NOR marking.
 *  - Per-bot isolation.
 *
 * NOTE: still a spike (not in the runner). The integration caller — read marker
 * (don't clear) → gate+classify → send notices → mark rows terminal on
 * confirmed send → clear marker last — is unwritten; its ordering is covered by
 * the v3.1 spec and must get its own crash-seam tests.
 */
'use strict';

const assert = require('node:assert/strict');
const Database = require('../node_modules/better-sqlite3');

const REPLAY_WINDOW_MS = 72 * 60 * 1000;          // ≈ shumabit's 1.2×maxTurn
const MARKER_MAX_AGE_MS = 2 * REPLAY_WINDOW_MS;    // derived, not a magic 6h

function freshDb() {
  const db = new Database(':memory:');
  // mirror migration 005 EXACTLY incl. NOT NULL, + the new nullable marker col
  db.exec(`CREATE TABLE polling_state (
    bot_name TEXT PRIMARY KEY,
    last_update_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    clean_shutdown_at INTEGER
  );`);
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, bot_name TEXT, direction TEXT, handler_status TEXT, ts INTEGER);`);
  return db;
}

// ── shutdown: mark in-flight rows (if any) AND write the marker, ONE txn,
//    UNCONDITIONALLY (marker always written on a clean shutdown). ──
function recordCleanShutdown(db, botName, now, { throwMidTxn = false } = {}) {
  const txn = db.transaction(() => {
    // markReplayPending-equivalent (real WHERE: direction='in' AND ts>cutoff AND in-flight)
    db.prepare(`UPDATE messages SET handler_status='replay-pending'
                WHERE bot_name=? AND direction='in' AND handler_status IN ('dispatched','processing')`).run(botName);
    if (throwMidTxn) throw new Error('simulated crash mid-shutdown-txn');
    // marker upsert that satisfies NOT NULL last_update_id/ts even with no prior row
    db.prepare(`INSERT INTO polling_state (bot_name, last_update_id, ts, clean_shutdown_at)
                VALUES (?,
                        COALESCE((SELECT last_update_id FROM polling_state WHERE bot_name=?), 0),
                        COALESCE((SELECT ts             FROM polling_state WHERE bot_name=?), ?),
                        ?)
                ON CONFLICT(bot_name) DO UPDATE SET clean_shutdown_at=excluded.clean_shutdown_at`)
      .run(botName, botName, botName, now, now);
  });
  txn();
}

// ── boot: read AND clear in one txn; classify. Any error → crash (caller wraps). ──
function consumeShutdownMarker(db, botName, now) {
  const clear = db.transaction(() => {
    const row = db.prepare('SELECT clean_shutdown_at FROM polling_state WHERE bot_name=?').get(botName);
    const at = row ? row.clean_shutdown_at : null;
    if (row) db.prepare('UPDATE polling_state SET clean_shutdown_at=NULL WHERE bot_name=?').run(botName);
    return at;
  });
  const at = clear();
  const age = typeof at === 'number' ? now - at : null;
  // fresh = present, not future-dated (clock skew), within the derived bound
  const clean = age != null && age >= 0 && age <= MARKER_MAX_AGE_MS;
  return { clean, markerAt: at };
}

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('  ok  ', name); } catch (e) { failures++; console.log('  FAIL', name, '→', e.message); } };
const NOW = 1_800_000_000_000;

check('1. clean shutdown WITH in-flight → row marked replay-pending + boot reads CLEAN (atomic)', () => {
  const db = freshDb();
  db.prepare("INSERT INTO messages VALUES (1,'shumabit','in','dispatched',?)").run(NOW);
  recordCleanShutdown(db, 'shumabit', NOW);
  assert.equal(db.prepare('SELECT handler_status h FROM messages WHERE id=1').get().h, 'replay-pending');
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW + 1000).clean, true);
});

check('2. clean shutdown with NOTHING in-flight, NO prior polling_state row → marker STILL written (NOT NULL satisfied), boot CLEAN', () => {
  const db = freshDb();
  // no messages, no polling_state row — the fresh/quiet-bot first-shutdown case
  recordCleanShutdown(db, 'shumabit', NOW);           // must not throw on NOT NULL
  const r = db.prepare('SELECT last_update_id, ts FROM polling_state WHERE bot_name=?').get('shumabit');
  assert.equal(r.last_update_id, 0);                   // default populated
  assert.equal(r.ts, NOW);
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW + 1000).clean, true);
});

check('3. marker write PRESERVES an existing polling_state row\'s last_update_id/ts', () => {
  const db = freshDb();
  db.prepare("INSERT INTO polling_state VALUES ('shumabit', 99999, ?, NULL)").run(NOW - 5000);
  recordCleanShutdown(db, 'shumabit', NOW);
  const r = db.prepare('SELECT last_update_id, ts FROM polling_state WHERE bot_name=?').get('shumabit');
  assert.equal(r.last_update_id, 99999, 'last_update_id preserved');
  assert.equal(r.ts, NOW - 5000, 'ts preserved');
});

check('4. read-and-clear: a SECOND boot (no new shutdown) reads CRASH', () => {
  const db = freshDb();
  recordCleanShutdown(db, 'shumabit', NOW);
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW + 1000).clean, true);
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW + 2000).clean, false);
});

check('5. stale marker (> bound; crash before next boot cleared it) → CRASH', () => {
  const db = freshDb();
  recordCleanShutdown(db, 'shumabit', NOW);
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW + MARKER_MAX_AGE_MS + 60_000).clean, false);
});

check('6. FUTURE-dated marker (clock stepped back) → CRASH (fail-toward-recovery)', () => {
  const db = freshDb();
  recordCleanShutdown(db, 'shumabit', NOW);
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW - 60_000).clean, false);
});

check('7. crash (handler never ran → no marker) → CRASH', () => {
  const db = freshDb();
  db.prepare("INSERT INTO messages VALUES (1,'shumabit','in','processing',?)").run(NOW);
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW).clean, false);
});

check('8. atomicity: crash MID-txn leaves NEITHER marker NOR replay-pending marking', () => {
  const db = freshDb();
  db.prepare("INSERT INTO messages VALUES (1,'shumabit','in','dispatched',?)").run(NOW);
  assert.throws(() => recordCleanShutdown(db, 'shumabit', NOW, { throwMidTxn: true }));
  assert.equal(db.prepare('SELECT handler_status h FROM messages WHERE id=1').get().h, 'dispatched', 'row NOT marked');
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW).clean, false, 'no marker → crash');
});

check('9. per-bot isolation', () => {
  const db = freshDb();
  recordCleanShutdown(db, 'shumabit', NOW);
  assert.equal(consumeShutdownMarker(db, 'umi-assistant', NOW + 1000).clean, false);
  assert.equal(consumeShutdownMarker(db, 'shumabit', NOW + 1000).clean, true);
});

console.log(failures === 0 ? '\nSPIKE PASS — marker semantics hold against the real polling_state constraints' : `\nSPIKE FAIL — ${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
