/**
 * Tests for lib/sessions.js
 * Run: node --test tests/sessions.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { open } = require('../lib/db');
const { migrateJsonToDb, getClaudeSessionId } = require('../lib/sessions');

let db;
let dbPath;
let jsonPath;

function freshEnv() {
  const rand = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  dbPath = path.join(os.tmpdir(), `sessions-test-${rand}.db`);
  jsonPath = path.join(os.tmpdir(), `sessions-test-${rand}.json`);
  db = open(dbPath);
}

function cleanup() {
  if (db) { try { db.raw.close(); } catch {} db = null; }
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm', jsonPath]) {
    try { fs.unlinkSync(p); } catch {}
  }
  // Clean migrated / malformed sidecars
  const dir = path.dirname(jsonPath);
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(path.basename(jsonPath)) && (f.includes('.migrated-') || f.includes('.malformed-'))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  }
}

const chatConfigs = {
  '123': { agent: 'shumabit', cwd: '/tmp/a', model: 'opus', effort: 'medium' },
  '-100456': { agent: 'umi-assistant', cwd: '/tmp/b', model: 'sonnet', effort: 'low' },
};

describe('migrateJsonToDb', () => {
  beforeEach(() => freshEnv());
  afterEach(() => cleanup());

  test('returns no-json when file is absent', () => {
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.equal(res.renamed, false);
    assert.equal(res.reason, 'no-json');
  });

  test('imports empty DB from JSON, renames file', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({
      '123': 'abc-123',
      '-100456:789': 'def-456',
    }));
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 2);
    assert.equal(res.renamed, true);
    assert.equal(res.reason, 'imported');
    assert.equal(fs.existsSync(jsonPath), false);

    const row1 = db.getSession('123');
    assert.equal(row1.claude_session_id, 'abc-123');
    assert.equal(row1.agent, 'shumabit');
    assert.equal(row1.cwd, '/tmp/a');

    const row2 = db.getSession('-100456:789');
    assert.equal(row2.claude_session_id, 'def-456');
    assert.equal(row2.thread_id, '789');
    assert.equal(row2.agent, 'umi-assistant');
  });

  test('does not overwrite populated DB, still renames JSON', () => {
    db.upsertSession({
      session_key: '123', chat_id: '123', claude_session_id: 'existing',
      model: 'opus', effort: 'high',
    });
    fs.writeFileSync(jsonPath, JSON.stringify({ '123': 'different' }));
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.equal(res.renamed, true);
    assert.equal(res.reason, 'db-already-populated');
    assert.equal(fs.existsSync(jsonPath), false);

    const row = db.getSession('123');
    assert.equal(row.claude_session_id, 'existing', 'DB value wins');
    assert.equal(row.effort, 'high', 'existing row untouched');
  });

  test('second call is a no-op (file already gone)', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({ '1': 'a' }));
    migrateJsonToDb(db, jsonPath, chatConfigs);
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.reason, 'no-json');
  });

  test('skips falsy session ids', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({
      '123': 'good',
      'null-key': null,
      'empty-key': '',
    }));
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 1);
  });

  test('survives missing chat config (unknown chat id)', () => {
    fs.writeFileSync(jsonPath, JSON.stringify({
      '999unknown': 'orphan-session',
    }));
    const res = migrateJsonToDb(db, jsonPath, {});
    assert.equal(res.imported, 1);
    const row = db.getSession('999unknown');
    assert.equal(row.claude_session_id, 'orphan-session');
    assert.equal(row.agent, null);
    assert.equal(row.cwd, null);
  });

  test('renamed file contains original content (for forensics)', () => {
    const payload = { '123': 'abc' };
    fs.writeFileSync(jsonPath, JSON.stringify(payload));
    migrateJsonToDb(db, jsonPath, chatConfigs);
    const dir = path.dirname(jsonPath);
    const base = path.basename(jsonPath);
    const archived = fs.readdirSync(dir).find((f) => f.startsWith(base) && f.includes('.migrated-'));
    assert.ok(archived, 'archived file should exist');
    const content = JSON.parse(fs.readFileSync(path.join(dir, archived), 'utf8'));
    assert.deepEqual(content, payload);
  });
});

describe('migrateJsonToDb — malformed JSON does not crash boot', () => {
  beforeEach(() => freshEnv());
  afterEach(() => cleanup());

  test('syntactically invalid JSON is quarantined, returns malformed-json reason', () => {
    fs.writeFileSync(jsonPath, '{this is not {{ valid json');
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.equal(res.renamed, true);
    assert.match(res.reason, /^malformed-json/);
    // Original file should no longer exist at its original path
    assert.equal(fs.existsSync(jsonPath), false);
    // A .malformed- sidecar should exist
    const dir = path.dirname(jsonPath);
    const base = path.basename(jsonPath);
    const quarantined = fs.readdirSync(dir).find((f) => f.startsWith(base) && f.includes('.malformed-'));
    assert.ok(quarantined, 'quarantined file should exist');
  });

  test('JSON array (not object) is quarantined', () => {
    fs.writeFileSync(jsonPath, JSON.stringify(['not', 'an', 'object']));
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.equal(res.renamed, true);
    assert.match(res.reason, /not an object/);
    assert.equal(fs.existsSync(jsonPath), false);
  });

  test('JSON null is quarantined', () => {
    fs.writeFileSync(jsonPath, 'null');
    const res = migrateJsonToDb(db, jsonPath, chatConfigs);
    assert.equal(res.imported, 0);
    assert.match(res.reason, /not an object/);
  });

  test('sessions-json-malformed event is logged when db.logEvent exists', () => {
    fs.writeFileSync(jsonPath, 'not json');
    migrateJsonToDb(db, jsonPath, chatConfigs);
    const ev = db.raw.prepare("SELECT * FROM events WHERE kind='sessions-json-malformed'").get();
    assert.ok(ev, 'sessions-json-malformed event should be logged');
    const detail = JSON.parse(ev.detail_json);
    assert.ok(detail.quarantined_to.includes('.malformed-'));
  });

  test('works even when db lacks logEvent (no crash)', () => {
    fs.writeFileSync(jsonPath, 'not json');
    const stub = {
      raw: db.raw,
      getSession: db.getSession.bind(db),
      upsertSession: db.upsertSession.bind(db),
      // intentionally no logEvent
    };
    const res = migrateJsonToDb(stub, jsonPath, chatConfigs);
    assert.equal(res.renamed, true);
    assert.match(res.reason, /^malformed-json/);
  });
});

describe('getClaudeSessionId', () => {
  beforeEach(() => freshEnv());
  afterEach(() => cleanup());

  test('returns null when db is null', () => {
    assert.equal(getClaudeSessionId(null, '123'), null);
  });

  test('returns null when session does not exist', () => {
    assert.equal(getClaudeSessionId(db, 'unknown'), null);
  });

  test('returns claude_session_id when present', () => {
    db.upsertSession({ session_key: '123', chat_id: '123', claude_session_id: 'abc' });
    assert.equal(getClaudeSessionId(db, '123'), 'abc');
  });
});
