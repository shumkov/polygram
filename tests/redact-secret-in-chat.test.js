/**
 * Tests for db.redactSecretInChat (0.15) — the agent-flagged redaction path.
 *
 * When the agent emits `[redact:<secret>]`, polygram calls this to wipe the
 * exact literal from the stored inbound row(s) of that chat. This is distinct
 * from the deterministic background sweep (lib/db/secret-sweep.js): here the
 * MODEL identified the secret (a prose password the regex tiers won't catch),
 * so we redact the literal string it reported rather than a regex match.
 *
 * WHY each behavior matters:
 *  - Wipes ALL occurrences in a row (a secret pasted twice must be fully gone).
 *  - Scopes to direction='in' (never rewrites the agent's own outbound text).
 *  - Thread scoping (a forum topic's secret must not bleed across topics).
 *  - Audit row with sha256 fingerprint (forensics without storing the secret).
 *  - Purges FTS (a redacted secret must not remain searchable).
 *  - Rejects too-short input (guards against redacting "ok"/"hi" → nuking text).
 *
 * Run: node --test tests/redact-secret-in-chat.test.js   (FAKE secrets only)
 */
'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');

let db; let dbPath;
const NOW = 1_800_000_000_000;
const PLACEHOLDER = '‹redacted:reported›'; // ‹redacted:reported›
const SECRET = 'hunter2-super-secret-passphrase';

let nextId = 1;
function insert(text, { chat = '-100', thread = null, dir = 'in' } = {}) {
  const id = nextId++;
  db.raw.prepare(
    `INSERT INTO messages (id, chat_id, thread_id, msg_id, direction, text, ts) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, chat, thread, id, dir, text, NOW);
  return id;
}
const textOf = (id) => db.raw.prepare('SELECT text FROM messages WHERE id=?').get(id).text;
const audits = () => db.raw.prepare('SELECT * FROM secret_redactions ORDER BY id').all();

describe('db.redactSecretInChat', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('redact-in-chat')); nextId = 1; });
  afterEach(() => cleanupDb(dbPath, db));

  test('wipes the literal from the matching inbound row + returns count', () => {
    const id = insert(`here is my key: ${SECRET} ok?`);
    const res = db.redactSecretInChat({ chat_id: '-100', secret: SECRET, now: NOW });
    assert.equal(res.redacted, 1);
    assert.equal(textOf(id), `here is my key: ${PLACEHOLDER} ok?`);
    assert.doesNotMatch(textOf(id), /hunter2/);
  });

  test('wipes ALL occurrences in a single row', () => {
    const id = insert(`${SECRET} and again ${SECRET}`);
    const res = db.redactSecretInChat({ chat_id: '-100', secret: SECRET, now: NOW });
    assert.equal(res.redacted, 1); // one row touched
    assert.equal(textOf(id), `${PLACEHOLDER} and again ${PLACEHOLDER}`);
  });

  test('NEVER rewrites the agent\'s own outbound rows', () => {
    const out = insert(`I noted your ${SECRET}`, { dir: 'out' });
    const inn = insert(`my secret is ${SECRET}`, { dir: 'in' });
    db.redactSecretInChat({ chat_id: '-100', secret: SECRET, now: NOW });
    assert.match(textOf(out), /hunter2/, 'outbound untouched');
    assert.doesNotMatch(textOf(inn), /hunter2/, 'inbound wiped');
  });

  test('thread scoping: only the named topic is redacted', () => {
    const a = insert(`topic A ${SECRET}`, { thread: '7' });
    const b = insert(`topic B ${SECRET}`, { thread: '9' });
    const res = db.redactSecretInChat({ chat_id: '-100', thread_id: '7', secret: SECRET, now: NOW });
    assert.equal(res.redacted, 1);
    assert.doesNotMatch(textOf(a), /hunter2/);
    assert.match(textOf(b), /hunter2/, 'other topic untouched');
  });

  test('no thread_id → scans the whole chat (all topics)', () => {
    const a = insert(`one ${SECRET}`, { thread: '7' });
    const b = insert(`two ${SECRET}`, { thread: '9' });
    const res = db.redactSecretInChat({ chat_id: '-100', secret: SECRET, now: NOW });
    assert.equal(res.redacted, 2);
    assert.doesNotMatch(textOf(a), /hunter2/);
    assert.doesNotMatch(textOf(b), /hunter2/);
  });

  test('audit row carries sha256 fingerprint + rule/tier=reported, never the secret', () => {
    insert(`key ${SECRET}`);
    db.redactSecretInChat({ chat_id: '-100', secret: SECRET, now: NOW });
    const a = audits();
    assert.equal(a.length, 1);
    assert.equal(a[0].action, 'redacted');
    assert.equal(a[0].rule, 'reported');
    assert.equal(a[0].tier, 'reported');
    assert.equal(a[0].length, SECRET.length);
    assert.equal(a[0].sha256, crypto.createHash('sha256').update(SECRET).digest('hex'));
    // the audit table must not store the plaintext anywhere
    assert.doesNotMatch(JSON.stringify(a[0]), /hunter2/);
  });

  test('purges the secret from the FTS index', () => {
    // Hyphen-free so the FTS5 MATCH query itself is well-formed (a bare hyphen
    // is an FTS operator); the redaction logic is identical either way.
    const FTS_SECRET = 'hunter2supersecretpassphrase';
    insert(`searchable ${FTS_SECRET} token`);
    assert.ok(db.raw.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').get(FTS_SECRET));
    db.redactSecretInChat({ chat_id: '-100', secret: FTS_SECRET, now: NOW });
    assert.equal(db.raw.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').get(FTS_SECRET), undefined);
  });

  test('no match → 0 redacted, no audit, text untouched', () => {
    const id = insert('nothing sensitive here');
    const res = db.redactSecretInChat({ chat_id: '-100', secret: SECRET, now: NOW });
    assert.equal(res.redacted, 0);
    assert.equal(audits().length, 0);
    assert.equal(textOf(id), 'nothing sensitive here');
  });

  test('rejects too-short secret (<3 chars) so a stray [redact:ok] cannot nuke text', () => {
    const id = insert('ok cool, ok then');
    const res = db.redactSecretInChat({ chat_id: '-100', secret: 'ok', now: NOW });
    assert.equal(res.redacted, 0);
    assert.equal(textOf(id), 'ok cool, ok then');
    assert.equal(audits().length, 0);
  });

  test('non-string secret is rejected safely', () => {
    insert('whatever');
    assert.equal(db.redactSecretInChat({ chat_id: '-100', secret: null, now: NOW }).redacted, 0);
    assert.equal(db.redactSecretInChat({ chat_id: '-100', secret: undefined, now: NOW }).redacted, 0);
  });

  // Window boundary (correctness + security reviewers): the scan only covers the
  // last `limit` inbound rows. A secret older than that window is silently
  // missed — pin the boundary so a future limit change is deliberate and the
  // caller's no-match fail-loud log remains the safety net.
  test('limit window: a secret older than `limit` inbound rows is NOT redacted', () => {
    const old = insert(`old secret ${SECRET}`);       // id 1 — oldest
    for (let i = 0; i < 5; i++) insert('chatter');     // 5 newer inbound rows
    const res = db.redactSecretInChat({ chat_id: '-100', secret: SECRET, now: NOW, limit: 3 });
    assert.equal(res.redacted, 0, 'older-than-window row is outside the scan');
    assert.match(textOf(old), /hunter2/, 'still present (caller logs the no-match)');
  });

  test('limit window: same secret IS redacted when within the window', () => {
    const recent = insert(`recent secret ${SECRET}`);
    insert('chatter'); insert('chatter');
    const res = db.redactSecretInChat({ chat_id: '-100', secret: SECRET, now: NOW, limit: 3 });
    assert.equal(res.redacted, 1);
    assert.doesNotMatch(textOf(recent), /hunter2/);
  });

  // handleMessage passes thread_id as a NUMBER (msg.message_thread_id) while
  // inbound rows store it as a STRING. A type mismatch here = a secret silently
  // surviving, so pin that the String() coercion matches a string-stored row.
  test('numeric thread_id matches a string-stored row (coercion)', () => {
    const id = insert(`topic secret ${SECRET}`, { thread: '42' });
    const res = db.redactSecretInChat({ chat_id: '-100', thread_id: 42, secret: SECRET, now: NOW });
    assert.equal(res.redacted, 1, 'numeric threadId must match the string-stored thread_id');
    assert.doesNotMatch(textOf(id), /hunter2/);
  });
});
