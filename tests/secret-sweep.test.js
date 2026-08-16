/**
 * Tests for lib/db/secret-sweep.js (0.15) against a real migrated DB.
 * Run: node --test tests/secret-sweep.test.js   (FAKE secrets only)
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { sweepSecrets } = require('../lib/db/secret-sweep');
const crypto = require('node:crypto');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

let db; let dbPath;
const NOW = 1_800_000_000_000;
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP';

let nextId = 1;
function insert(text, { chat = '-100', dir = 'in' } = {}) {
  const id = nextId++;
  db.raw.prepare(`INSERT INTO messages (id, chat_id, msg_id, direction, text, ts) VALUES (?,?,?,?,?,?)`)
    .run(id, chat, id, dir, text, NOW);
  return id;
}
const textOf = (id) => db.raw.prepare('SELECT text FROM messages WHERE id=?').get(id).text;
const auditFor = (id) => db.raw.prepare('SELECT * FROM secret_redactions WHERE msg_id=? ORDER BY id').all(id);

describe('secret sweep', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('secret-sweep')); nextId = 1; });
  afterEach(() => cleanupDb(dbPath, db));

  test('migration 014 artifacts remain present in later schemas', () => {
    assert.ok(db.raw.pragma('user_version', { simple: true }) >= 14);
    assert.ok(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secret_redactions'").get());
    assert.ok(db.raw.prepare('PRAGMA table_info(messages)').all().some((c) => c.name === 'secret_scanned_at'));
  });

  test('HIGH secret redacted in place + content-free audit + scanned stamp', () => {
    const id = insert(`my key is ${AWS} thanks`);
    const res = sweepSecrets(db.raw, { now: NOW });
    assert.equal(res.redactedMsgs, 1);
    assert.equal(textOf(id), 'my key is ‹redacted:aws-akia› thanks');
    const a = auditFor(id);
    assert.equal(a.length, 1);
    assert.equal(a[0].action, 'redacted');
    assert.equal(a[0].rule, 'aws-akia');
    // The audit says what was redacted and where — never a hash of the value,
    // which would be a correlation handle for the secret itself.
    assert.ok(!JSON.stringify(a[0]).includes(sha256(AWS)), 'no value fingerprint');
    assert.ok(db.raw.prepare('SELECT secret_scanned_at FROM messages WHERE id=?').get(id).secret_scanned_at);
  });

  test('LOW (kv-secret) FLAGGED not redacted — text unchanged, audit action=flagged', () => {
    const id = insert('password: required');   // FP-shaped — must NOT be destroyed
    sweepSecrets(db.raw, { now: NOW });
    assert.equal(textOf(id), 'password: required');
    const a = auditFor(id);
    assert.equal(a.length, 1);
    assert.equal(a[0].action, 'flagged');
    assert.equal(a[0].rule, 'kv-secret');
  });

  test('redaction purges the secret from the FTS index', () => {
    const id = insert(`token ${AWS} here`);
    // present before
    assert.ok(db.raw.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").get(AWS));
    sweepSecrets(db.raw, { now: NOW });
    // gone after
    assert.equal(db.raw.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").get(AWS), undefined);
  });

  test('clean messages: scanned + stamped, no redaction/audit', () => {
    const id = insert('please review the PR after CI');
    const res = sweepSecrets(db.raw, { now: NOW });
    assert.equal(res.redactedMsgs, 0);
    assert.equal(auditFor(id).length, 0);
    assert.ok(db.raw.prepare('SELECT secret_scanned_at FROM messages WHERE id=?').get(id).secret_scanned_at, 'still stamped so it isn\'t re-scanned');
  });

  test('dry-run mutates NOTHING but counts', () => {
    const id = insert(`key ${AWS} x`);
    const res = sweepSecrets(db.raw, { now: NOW, dryRun: true });
    assert.equal(res.redactedMsgs, 1);
    assert.equal(res.dryRun, true);
    assert.equal(textOf(id), `key ${AWS} x`, 'text unchanged in dry-run');
    assert.equal(auditFor(id).length, 0, 'no audit rows in dry-run');
    assert.equal(db.raw.prepare('SELECT secret_scanned_at FROM messages WHERE id=?').get(id).secret_scanned_at, null);
  });

  test('incremental: a second run skips already-scanned rows', () => {
    insert(`a ${AWS} b`);
    const r1 = sweepSecrets(db.raw, { now: NOW });
    assert.equal(r1.scanned, 1);
    const r2 = sweepSecrets(db.raw, { now: NOW });
    assert.equal(r2.scanned, 0, 'nothing left to scan');
    insert(`c ${JWT} d`);  // new row after first sweep
    const r3 = sweepSecrets(db.raw, { now: NOW });
    assert.equal(r3.scanned, 1, 'only the new row');
    assert.equal(r3.redactions, 1);
  });

  test('idempotent: redacted text is not re-redacted if re-scanned', () => {
    const id = insert(`k ${AWS} k`);
    sweepSecrets(db.raw, { now: NOW });
    const after = textOf(id);
    // force a re-scan by clearing the stamp
    db.raw.prepare('UPDATE messages SET secret_scanned_at = NULL WHERE id=?').run(id);
    const r = sweepSecrets(db.raw, { now: NOW });
    assert.equal(r.redactedMsgs, 0, 'placeholder does not re-match');
    assert.equal(textOf(id), after);
  });

  test('batchSize/maxPerRun validated', () => {
    assert.throws(() => sweepSecrets(db.raw, { batchSize: 0 }), /batchSize/);
    assert.throws(() => sweepSecrets(db.raw, { maxPerRun: 0 }), /maxPerRun/);
  });

  // Partial-preview signal (data-integrity reviewer): a run that hits maxPerRun
  // must report reachedCap + how many rows remain unscanned past its cursor, so
  // the operator never mistakes a capped dry-run for "the whole table is clean".
  test('reachedCap + remaining reported when a run hits maxPerRun', () => {
    for (let i = 0; i < 10; i++) insert('ordinary message');
    const res = sweepSecrets(db.raw, { now: NOW, batchSize: 2, maxPerRun: 4, dryRun: true });
    assert.equal(res.scanned, 4);
    assert.equal(res.reachedCap, true);
    assert.equal(res.remaining, 6, '10 rows, scanned 4, 6 remain past the cursor');
  });

  test('reachedCap false + remaining 0 when the table is exhausted', () => {
    for (let i = 0; i < 3; i++) insert('ordinary message');
    const res = sweepSecrets(db.raw, { now: NOW, batchSize: 2, maxPerRun: 100 });
    assert.equal(res.reachedCap, false);
    assert.equal(res.remaining, 0);
  });

  test('dry-run re-scans from the start each run (cursor not persisted) — documents the preview limit', () => {
    for (let i = 0; i < 6; i++) insert('ordinary message');
    const a = sweepSecrets(db.raw, { now: NOW, batchSize: 2, maxPerRun: 4, dryRun: true });
    const b = sweepSecrets(db.raw, { now: NOW, batchSize: 2, maxPerRun: 4, dryRun: true });
    // both runs scan the SAME first 4 rows (nothing stamped in dry-run), so the
    // tail (rows 5-6) is never previewed until enforcement mode stamps progress.
    assert.equal(a.scanned, 4);
    assert.equal(b.scanned, 4);
    assert.equal(a.reachedCap, true);
    assert.equal(b.reachedCap, true);
  });
});
