/**
 * Tests for lib/history.js
 * Run: node --test tests/history.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const history = require('../lib/history');

let db;
let dbPath;

function seed(db, rows) {
  for (const r of rows) {
    db.insertMessage({
      chat_id: r.chat_id,
      thread_id: r.thread_id || null,
      msg_id: r.msg_id,
      user: r.user || null,
      user_id: r.user_id || null,
      text: r.text || '',
      direction: r.direction || 'in',
      source: r.source || 'polygram',
      bot_name: r.bot_name || null,
      ts: r.ts,
    });
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────

describe('fts5Escape', () => {
  test('wraps each token in double quotes', () => {
    assert.equal(history.fts5Escape('hello world'), '"hello" "world"');
  });

  test('neutralizes FTS operators', () => {
    assert.equal(history.fts5Escape('cat AND dog'), '"cat" "AND" "dog"');
    assert.equal(history.fts5Escape('foo OR bar*'), '"foo" "OR" "bar*"');
  });

  test('escapes internal double quotes', () => {
    assert.equal(history.fts5Escape('say "hi"'), '"say" """hi"""');
  });

  test('empty / whitespace → empty string', () => {
    assert.equal(history.fts5Escape(''), '');
    assert.equal(history.fts5Escape('   '), '');
    assert.equal(history.fts5Escape(null), '');
    assert.equal(history.fts5Escape(undefined), '');
  });

  test('preserves unicode tokens', () => {
    assert.equal(history.fts5Escape('привет มั่นใจ'), '"привет" "มั่นใจ"');
  });
});

describe('clampLimit', () => {
  test('defaults when given 0 / NaN / null', () => {
    assert.equal(history.clampLimit(null, 20), 20);
    assert.equal(history.clampLimit(undefined, 50), 50);
    assert.equal(history.clampLimit('abc', 10), 10);
  });

  test('floors to 1 minimum', () => {
    assert.equal(history.clampLimit(-5), 1);
    assert.equal(history.clampLimit(0.4), 1); // truthy, n<1 → 1
    assert.equal(history.clampLimit(0, 20), 20); // 0 is falsy → default
  });

  test('caps at HARD_LIMIT', () => {
    assert.equal(history.clampLimit(99999), history.HARD_LIMIT);
    assert.equal(history.clampLimit(history.HARD_LIMIT + 1), history.HARD_LIMIT);
  });

  test('floors fractional', () => {
    assert.equal(history.clampLimit(3.9), 3);
  });
});

describe('parseSinceMs', () => {
  test('d = days', () => {
    assert.equal(history.parseSinceMs('3d'), 3 * 86_400_000);
    assert.equal(history.parseSinceMs('7'), 7 * 86_400_000); // default unit = d
  });

  test('h = hours', () => {
    assert.equal(history.parseSinceMs('2h'), 2 * 3_600_000);
  });

  test('m = minutes', () => {
    assert.equal(history.parseSinceMs('30m'), 30 * 60_000);
  });

  test('case-insensitive', () => {
    assert.equal(history.parseSinceMs('2H'), 2 * 3_600_000);
  });

  test('null for invalid / empty', () => {
    assert.equal(history.parseSinceMs(''), null);
    assert.equal(history.parseSinceMs(null), null);
    assert.equal(history.parseSinceMs('bogus'), null);
    assert.equal(history.parseSinceMs('3y'), null);
  });
});

// ─── Query functions ────────────────────────────────────────────────

describe('recent', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('history-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('returns chat-scoped rows in chronological (ascending) order', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'oldest', ts: now - 300_000, user: 'a' },
      { chat_id: '1', msg_id: 2, text: 'middle', ts: now - 200_000, user: 'b' },
      { chat_id: '1', msg_id: 3, text: 'newest', ts: now - 100_000, user: 'c' },
      { chat_id: '2', msg_id: 4, text: 'other-chat', ts: now, user: 'x' },
    ]);
    const rows = history.recent(db, { chatId: '1', limit: 10 });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.text), ['oldest', 'middle', 'newest']);
  });

  test('limit caps result count (keeps most recent)', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'a', ts: now - 400_000 },
      { chat_id: '1', msg_id: 2, text: 'b', ts: now - 300_000 },
      { chat_id: '1', msg_id: 3, text: 'c', ts: now - 200_000 },
      { chat_id: '1', msg_id: 4, text: 'd', ts: now - 100_000 },
    ]);
    const rows = history.recent(db, { chatId: '1', limit: 2 });
    assert.deepEqual(rows.map((r) => r.text), ['c', 'd']);
  });

  test('threadId filter', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', thread_id: '10', msg_id: 1, text: 'thread-a', ts: now - 200_000 },
      { chat_id: '1', thread_id: '20', msg_id: 2, text: 'thread-b', ts: now - 100_000 },
    ]);
    const rows = history.recent(db, { chatId: '1', threadId: '10' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'thread-a');
  });

  test('includeOutbound=false excludes direction=out', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'in', direction: 'in', ts: now - 200_000 },
      { chat_id: '1', msg_id: 2, text: 'out', direction: 'out', ts: now - 100_000 },
    ]);
    const rows = history.recent(db, { chatId: '1', includeOutbound: false });
    assert.deepEqual(rows.map((r) => r.text), ['in']);
  });

  test('since filter excludes older than window', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'old', ts: now - 3 * 86_400_000 },
      { chat_id: '1', msg_id: 2, text: 'new', ts: now - 1 * 3_600_000 },
    ]);
    const rows = history.recent(db, { chatId: '1', since: '2h' });
    assert.deepEqual(rows.map((r) => r.text), ['new']);
  });

  test('allowedChatIds scopes even when chatId is in a denied list', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '42', msg_id: 1, text: 'forbidden', ts: now },
    ]);
    const rows = history.recent(db, { chatId: '42', allowedChatIds: ['99'] });
    assert.equal(rows.length, 0);
  });
});

describe('around', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('history-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('returns before + anchor + after in chronological order', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'a', ts: now - 500 },
      { chat_id: '1', msg_id: 2, text: 'b', ts: now - 400 },
      { chat_id: '1', msg_id: 3, text: 'ANCHOR', ts: now - 300 },
      { chat_id: '1', msg_id: 4, text: 'd', ts: now - 200 },
      { chat_id: '1', msg_id: 5, text: 'e', ts: now - 100 },
    ]);
    const rows = history.around(db, { chatId: '1', msgId: 3, before: 2, after: 2 });
    assert.deepEqual(rows.map((r) => r.text), ['a', 'b', 'ANCHOR', 'd', 'e']);
  });

  test('asymmetric before/after', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'a', ts: now - 500 },
      { chat_id: '1', msg_id: 2, text: 'b', ts: now - 400 },
      { chat_id: '1', msg_id: 3, text: 'ANCHOR', ts: now - 300 },
      { chat_id: '1', msg_id: 4, text: 'd', ts: now - 200 },
    ]);
    const rows = history.around(db, { chatId: '1', msgId: 3, before: 1, after: 0 });
    assert.deepEqual(rows.map((r) => r.text), ['b', 'ANCHOR']);
  });

  test('unknown msgId → empty array', () => {
    seed(db, [{ chat_id: '1', msg_id: 1, text: 'a', ts: Date.now() }]);
    const rows = history.around(db, { chatId: '1', msgId: 999 });
    assert.deepEqual(rows, []);
  });

  test('allowedChatIds excludes the entire chat even if anchor exists', () => {
    seed(db, [{ chat_id: '1', msg_id: 1, text: 'a', ts: Date.now() }]);
    const rows = history.around(db, { chatId: '1', msgId: 1, allowedChatIds: ['2'] });
    assert.deepEqual(rows, []);
  });
});

describe('search', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('history-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('FTS5 token match', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'invoice from Xero', ts: now - 200 },
      { chat_id: '1', msg_id: 2, text: 'unrelated chatter', ts: now - 100 },
    ]);
    const rows = history.search(db, { query: 'invoice' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].msg_id, 1);
  });

  test('empty query → empty array', () => {
    seed(db, [{ chat_id: '1', msg_id: 1, text: 'hello', ts: Date.now() }]);
    assert.deepEqual(history.search(db, { query: '' }), []);
    assert.deepEqual(history.search(db, { query: '   ' }), []);
  });

  test('neutralizes FTS operators — AND is searched literally', () => {
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'cats dogs', ts: Date.now() - 100 },
      { chat_id: '1', msg_id: 2, text: 'cats AND dogs', ts: Date.now() },
    ]);
    const rows = history.search(db, { query: 'cats AND dogs' });
    // Treating AND as a token, only the row with literal "AND" matches.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].msg_id, 2);
  });

  test('user filter applies LIKE', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'hello', user: 'Ivan', ts: now - 100 },
      { chat_id: '1', msg_id: 2, text: 'hello', user: 'Bob', ts: now },
    ]);
    const rows = history.search(db, { query: 'hello', user: 'Iv' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user, 'Ivan');
  });

  test('chatId + threadId filters', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', thread_id: '10', msg_id: 1, text: 'query match', ts: now - 200 },
      { chat_id: '1', thread_id: '20', msg_id: 2, text: 'query match', ts: now - 100 },
      { chat_id: '2', msg_id: 3, text: 'query match', ts: now },
    ]);
    const rows = history.search(db, { query: 'query', chatId: '1', threadId: '10' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].msg_id, 1);
  });

  test('days filter restricts time window', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'old match', ts: now - 30 * 86_400_000 },
      { chat_id: '1', msg_id: 2, text: 'new match', ts: now - 1 * 86_400_000 },
    ]);
    const rows = history.search(db, { query: 'match', days: 7 });
    assert.deepEqual(rows.map((r) => r.msg_id), [2]);
  });

  test('allowedChatIds scopes results', () => {
    seed(db, [
      { chat_id: '1', msg_id: 1, text: 'secret', ts: Date.now() - 100 },
      { chat_id: '2', msg_id: 2, text: 'secret', ts: Date.now() },
    ]);
    const rows = history.search(db, { query: 'secret', allowedChatIds: ['2'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chat_id, '2');
  });
});

describe('byUser', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('history-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('LIKE match on user', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, user: 'Ivan', text: 'a', ts: now - 200 },
      { chat_id: '1', msg_id: 2, user: 'Ivan Shumkov', text: 'b', ts: now - 100 },
      { chat_id: '1', msg_id: 3, user: 'Bob', text: 'c', ts: now },
    ]);
    const rows = history.byUser(db, { user: 'Ivan' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => /Ivan/.test(r.user)));
  });

  test('days filter', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, user: 'Ivan', text: 'old', ts: now - 30 * 86_400_000 },
      { chat_id: '1', msg_id: 2, user: 'Ivan', text: 'new', ts: now - 1 * 86_400_000 },
    ]);
    const rows = history.byUser(db, { user: 'Ivan', days: 7 });
    assert.deepEqual(rows.map((r) => r.text), ['new']);
  });

  test('allowedChatIds scopes results', () => {
    seed(db, [
      { chat_id: '1', msg_id: 1, user: 'Ivan', text: 'a', ts: Date.now() },
      { chat_id: '2', msg_id: 2, user: 'Ivan', text: 'b', ts: Date.now() },
    ]);
    const rows = history.byUser(db, { user: 'Ivan', allowedChatIds: ['1'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].chat_id, '1');
  });
});

describe('getMsg', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('history-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('returns row by msgId', () => {
    seed(db, [{ chat_id: '1', msg_id: 42, text: 'the one', ts: Date.now() }]);
    const row = history.getMsg(db, { msgId: 42 });
    assert.ok(row);
    assert.equal(row.text, 'the one');
  });

  test('null when not found', () => {
    const row = history.getMsg(db, { msgId: 9999 });
    assert.equal(row, null);
  });

  test('chatId scope', () => {
    seed(db, [
      { chat_id: '1', msg_id: 42, text: 'from-1', ts: Date.now() - 100 },
      { chat_id: '2', msg_id: 42, text: 'from-2', ts: Date.now() },
    ]);
    const row = history.getMsg(db, { msgId: 42, chatId: '2' });
    assert.equal(row.text, 'from-2');
  });

  test('allowedChatIds enforced', () => {
    seed(db, [{ chat_id: '1', msg_id: 42, text: 'x', ts: Date.now() }]);
    const row = history.getMsg(db, { msgId: 42, allowedChatIds: ['99'] });
    assert.equal(row, null);
  });
});

describe('stats', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('history-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('groups by user + direction', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, user: 'Ivan', direction: 'in', text: '', ts: now - 3000 },
      { chat_id: '1', msg_id: 2, user: 'Ivan', direction: 'in', text: '', ts: now - 2000 },
      { chat_id: '1', msg_id: 3, user: 'Bob', direction: 'in', text: '', ts: now - 1000 },
      { chat_id: '1', msg_id: 4, user: null, direction: 'out', bot_name: 'shumabit', text: '', ts: now },
    ]);
    const rows = history.stats(db, {});
    // 3 groups: Ivan/in=2, Bob/in=1, null/out=1
    const ivanIn = rows.find((r) => r.user === 'Ivan' && r.direction === 'in');
    assert.ok(ivanIn);
    assert.equal(ivanIn.count, 2);
    assert.equal(rows.length, 3);
  });

  test('days window is applied', () => {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, user: 'old', direction: 'in', text: '', ts: now - 30 * 86_400_000 },
      { chat_id: '1', msg_id: 2, user: 'new', direction: 'in', text: '', ts: now - 1 * 86_400_000 },
    ]);
    const rows = history.stats(db, { days: 7 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user, 'new');
  });

  test('allowedChatIds scopes', () => {
    seed(db, [
      { chat_id: '1', msg_id: 1, user: 'a', direction: 'in', text: '', ts: Date.now() },
      { chat_id: '2', msg_id: 2, user: 'b', direction: 'in', text: '', ts: Date.now() },
    ]);
    const rows = history.stats(db, { allowedChatIds: ['1'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user, 'a');
  });
});

// ─── Scope semantics: [] must mean deny-all, never all-access ────────
// Regression guard against the subtle `allowedChatIds?.length` bug where
// an empty array was conflated with null (scope disabled), leaking every
// chat back to a newly-configured bot that hadn't yet been mapped to any
// chat in the config.

describe('allowedChatIds — empty array is deny-all (not scope-disabled)', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('history-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  function seedCrossChat() {
    const now = Date.now();
    seed(db, [
      { chat_id: '1', msg_id: 1, user: 'Ivan', text: 'secret one', direction: 'in', ts: now - 300 },
      { chat_id: '2', msg_id: 2, user: 'Ivan', text: 'secret two', direction: 'in', ts: now - 200 },
      { chat_id: '3', msg_id: 3, user: 'Ivan', text: 'secret three', direction: 'out', bot_name: 'x', ts: now - 100 },
    ]);
  }

  test('recent([]) returns nothing even when chatId matches seeded row', () => {
    seedCrossChat();
    const rows = history.recent(db, { chatId: '1', allowedChatIds: [] });
    assert.deepEqual(rows, []);
  });

  test('recent(null) is scope-disabled and returns chat rows normally', () => {
    seedCrossChat();
    const rows = history.recent(db, { chatId: '1', allowedChatIds: null });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'secret one');
  });

  test('around([]) short-circuits before any DB read', () => {
    seedCrossChat();
    const rows = history.around(db, { chatId: '1', msgId: 1, allowedChatIds: [] });
    assert.deepEqual(rows, []);
  });

  test('search([]) returns nothing', () => {
    seedCrossChat();
    const rows = history.search(db, { query: 'secret', allowedChatIds: [] });
    assert.deepEqual(rows, []);
  });

  test('byUser([]) returns nothing', () => {
    seedCrossChat();
    const rows = history.byUser(db, { user: 'Ivan', allowedChatIds: [] });
    assert.deepEqual(rows, []);
  });

  test('getMsg([]) returns null', () => {
    seedCrossChat();
    const row = history.getMsg(db, { msgId: 1, allowedChatIds: [] });
    assert.equal(row, null);
  });

  test('stats([]) returns empty rows', () => {
    seedCrossChat();
    const rows = history.stats(db, { allowedChatIds: [] });
    assert.deepEqual(rows, []);
  });
});

describe('formatPretty', () => {
  test('renders [HH:MM] user: text (msg N)', () => {
    const ts = new Date('2026-04-19T10:05:00').getTime();
    const out = history.formatPretty([
      { ts, user: 'Ivan', direction: 'in', text: 'hello there', msg_id: 7 },
    ]);
    assert.match(out, /^\[\d{2}:\d{2}\] Ivan: hello there \(msg 7\)$/);
  });

  test('outbound shows [bot:<name>]', () => {
    const out = history.formatPretty([
      { ts: Date.now(), bot_name: 'shumabit', direction: 'out', text: 'reply', msg_id: 9 },
    ]);
    assert.match(out, /\[bot:shumabit\]/);
  });

  test('collapses whitespace and truncates long text', () => {
    const long = 'x'.repeat(500);
    const out = history.formatPretty([
      { ts: Date.now(), user: 'u', direction: 'in', text: `line1\n\nline2  ${long}`, msg_id: 1 },
    ]);
    // Truncated at 200 chars payload
    assert.ok(out.includes('line1 line2'));
    assert.ok(!out.includes('\n'));
  });
});
