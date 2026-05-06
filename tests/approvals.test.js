/**
 * Tests for lib/approvals.js
 * Run: node --test tests/approvals.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const {
  createStore, matchesAnyPattern, patternToRegex, digestInput, newToken,
} = require('../lib/approvals/store');

let db, dbPath, store;
let fakeNow;

function setup() {
  ({ db, dbPath } = freshDb('approvals-test'));
  fakeNow = 1_700_000_000_000;
  store = createStore(db.raw, () => fakeNow);
}

function cleanup() {
  cleanupDb(dbPath, db);
  db = null;
}

describe('patternToRegex', () => {
  test('bare tool name matches tool only', () => {
    const p = patternToRegex('Bash');
    assert.ok(p.toolRe.test('Bash'));
    assert.equal(p.argRe, null);
  });

  test('tool(glob) splits into tool + arg', () => {
    const p = patternToRegex('Bash(rm *)');
    assert.ok(p.toolRe.test('Bash'));
    assert.ok(p.argRe.test('rm -rf foo'));
    assert.ok(!p.argRe.test('ls -la'));
  });

  test('mcp prefix globs work', () => {
    const p = patternToRegex('mcp__*__invoice_create');
    assert.ok(p.toolRe.test('mcp__shopify__invoice_create'));
    assert.ok(p.toolRe.test('mcp__xero__invoice_create'));
    assert.ok(!p.toolRe.test('mcp__shopify__invoice_read'));
  });

  test('regex metacharacters in tool names are escaped', () => {
    const p = patternToRegex('Tool.Name');
    assert.ok(p.toolRe.test('Tool.Name'));
    assert.ok(!p.toolRe.test('ToolXName'), 'dot should be literal, not wildcard');
  });
});

describe('matchesAnyPattern', () => {
  test('no patterns → no match', () => {
    const r = matchesAnyPattern('Bash', { command: 'rm -rf /' }, []);
    assert.equal(r.matched, false);
  });

  test('tool-only pattern matches any input', () => {
    const r = matchesAnyPattern('Bash', { command: 'ls' }, ['Bash']);
    assert.equal(r.matched, true);
    assert.equal(r.pattern, 'Bash');
  });

  test('Bash(rm *) matches rm commands, not ls', () => {
    const r1 = matchesAnyPattern('Bash', { command: 'rm -rf /tmp/x' }, ['Bash(rm *)']);
    const r2 = matchesAnyPattern('Bash', { command: 'ls -la' }, ['Bash(rm *)']);
    assert.equal(r1.matched, true);
    assert.equal(r2.matched, false);
  });

  test('WebFetch(https://example.com/*) matches url param', () => {
    const r1 = matchesAnyPattern('WebFetch', { url: 'https://example.com/foo' }, ['WebFetch(https://example.com/*)']);
    const r2 = matchesAnyPattern('WebFetch', { url: 'https://other.com/foo' }, ['WebFetch(https://example.com/*)']);
    assert.equal(r1.matched, true);
    assert.equal(r2.matched, false);
  });

  test('multiple patterns: any match wins', () => {
    const r = matchesAnyPattern('Bash', { command: 'git push origin main' }, [
      'Bash(rm *)', 'Bash(git push *)', 'Bash(sudo *)',
    ]);
    assert.equal(r.matched, true);
    assert.equal(r.pattern, 'Bash(git push *)');
  });

  test('MCP tool name match without arg constraint', () => {
    const r = matchesAnyPattern(
      'mcp__xero__invoice_create',
      { contact_id: 'abc' },
      ['mcp__*__invoice_create'],
    );
    assert.equal(r.matched, true);
  });

  test('non-Bash/non-WebFetch falls back to JSON stringify for arg match', () => {
    const r = matchesAnyPattern(
      'OtherTool',
      { op: 'destroy' },
      ['OtherTool(*destroy*)'],
    );
    assert.equal(r.matched, true);
  });
});

describe('digestInput + newToken', () => {
  test('digest is deterministic', () => {
    const a = digestInput({ cmd: 'rm' });
    const b = digestInput({ cmd: 'rm' });
    assert.equal(a, b);
    assert.equal(a.length, 16);
  });

  test('digest differs for different inputs', () => {
    assert.notEqual(digestInput({ cmd: 'rm' }), digestInput({ cmd: 'ls' }));
  });

  test('digest is order-independent across object keys', () => {
    // Pre-fix: JSON.stringify preserved insertion order so
    // {a:1,b:2} and {b:2,a:1} produced different digests.
    // Dedup contract requires logical equivalence.
    const a = digestInput({ a: 1, b: 2, c: 3 });
    const b = digestInput({ c: 3, b: 2, a: 1 });
    assert.equal(a, b);
  });

  test('digest is order-independent for nested objects', () => {
    const a = digestInput({ outer: { x: 1, y: 2 }, top: 'first' });
    const b = digestInput({ top: 'first', outer: { y: 2, x: 1 } });
    assert.equal(a, b);
  });

  test('digest preserves array ORDER (not a set)', () => {
    // Arrays are sequence-significant — [a,b] and [b,a] are
    // semantically different tool inputs (e.g. argv to Bash).
    assert.notEqual(
      digestInput({ args: ['a', 'b'] }),
      digestInput({ args: ['b', 'a'] }),
    );
  });

  test('digest of string input is unchanged by canonicalisation', () => {
    // String inputs bypass JSON.stringify; canonicalize is a no-op.
    const s = 'rm -rf /tmp';
    const before = digestInput(s);
    // Same string → same digest, regardless of fix.
    assert.equal(digestInput(s), before);
  });

  test('realistic Bash tool input order-stability (regression: keys swapped)', () => {
    const a = digestInput({ command: 'ls -la', description: 'list files' });
    const b = digestInput({ description: 'list files', command: 'ls -la' });
    assert.equal(a, b, 'Bash input dedup must be order-stable');
  });

  test('newToken produces base64url of ≥128 bits', () => {
    const t = newToken();
    // 16 random bytes → 22 b64url chars (no padding).
    assert.equal(t.length, 22);
    assert.match(t, /^[A-Za-z0-9_-]+$/);
  });

  test('newToken values are unique across many calls', () => {
    const set = new Set();
    for (let i = 0; i < 500; i++) set.add(newToken());
    assert.equal(set.size, 500);
  });
});

describe('tokensEqual', () => {
  const { tokensEqual } = require('../lib/approvals/store');
  test('equal strings → true', () => {
    assert.equal(tokensEqual('abc', 'abc'), true);
  });
  test('different strings same length → false', () => {
    assert.equal(tokensEqual('abc', 'abd'), false);
  });
  test('different lengths → false without throwing', () => {
    assert.equal(tokensEqual('a', 'abc'), false);
  });
  test('non-string inputs → false', () => {
    assert.equal(tokensEqual(null, 'x'), false);
    assert.equal(tokensEqual('x', undefined), false);
    assert.equal(tokensEqual(undefined, undefined), false);
  });
});

describe('approvals store', () => {
  beforeEach(setup);
  afterEach(cleanup);

  test('issue inserts a pending row', () => {
    const row = store.issue({
      bot_name: 'shumabit',
      turn_id: 't1',
      requester_chat_id: '-100',
      approver_chat_id: '111111111',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/x' },
    });
    assert.equal(row.status, 'pending');
    assert.equal(row.tool_name, 'Bash');
    assert.match(row.tool_input_digest, /^[0-9a-f]{16}$/);
    assert.equal(row.approver_chat_id, '111111111');
  });

  test('dedup: same turn + same input reuses row', () => {
    const r1 = store.issue({
      bot_name: 'shumabit', turn_id: 't1',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: { command: 'rm' },
    });
    const r2 = store.issue({
      bot_name: 'shumabit', turn_id: 't1',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: { command: 'rm' },
    });
    assert.equal(r2.id, r1.id);
    assert.equal(r2.reused, true);
  });

  test('dedup does not fire across different turns', () => {
    const r1 = store.issue({
      bot_name: 'shumabit', turn_id: 't1',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: { command: 'rm' },
    });
    const r2 = store.issue({
      bot_name: 'shumabit', turn_id: 't2',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: { command: 'rm' },
    });
    assert.notEqual(r2.id, r1.id);
  });

  // 0.9.0-cleanup commit 10: tool_use_id dedup. Migration 010 added the
  // column + partial index but the insert path never populated it
  // until now. Pre-fix, dedup relied on (turn_id, tool_input_digest);
  // a JSON-key reordering between retries within the same turn would
  // miss dedup and produce duplicate approval cards.
  test('dedup by tool_use_id reuses row across input-digest changes', () => {
    // Same SDK call (same tool_use_id), but the SDK reorders JSON keys
    // on retry — input digest differs but tool_use_id is stable.
    const r1 = store.issue({
      bot_name: 'shumabit', turn_id: 'turn-A', tool_use_id: 'toolu_abc',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: { command: 'rm', cwd: '/tmp' },
    });
    const r2 = store.issue({
      bot_name: 'shumabit', turn_id: 'turn-A', tool_use_id: 'toolu_abc',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: { cwd: '/tmp', command: 'rm' }, // reordered
    });
    assert.equal(r2.id, r1.id, 'tool_use_id dedup should reuse row');
    assert.equal(r2.reused, true);
    assert.equal(r2.tool_use_id, 'toolu_abc');
  });

  test('tool_use_id dedup is scoped to bot_name (no cross-bot collision)', () => {
    const r1 = store.issue({
      bot_name: 'shumabit', tool_use_id: 'toolu_xyz',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: {},
    });
    const r2 = store.issue({
      bot_name: 'umi-assistant', tool_use_id: 'toolu_xyz',
      requester_chat_id: '-200', approver_chat_id: '222222222',
      tool_name: 'Bash', tool_input: {},
    });
    assert.notEqual(r2.id, r1.id, 'different bots must NOT dedup against each other');
  });

  test('tool_use_id NULL falls back to legacy (turn_id, digest) dedup', () => {
    // Pre-0.9.0 callers without SDK tool_use_id (cron, IPC) still
    // need dedup. Same input + same turn_id + null tool_use_id on
    // both inserts → reuse via legacy path.
    const r1 = store.issue({
      bot_name: 'shumabit', turn_id: 'cron-1',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: { command: 'ls' },
    });
    const r2 = store.issue({
      bot_name: 'shumabit', turn_id: 'cron-1',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: { command: 'ls' },
    });
    assert.equal(r2.id, r1.id);
    assert.equal(r2.reused, true);
    assert.equal(r1.tool_use_id, null);
  });

  test('tool_use_id row is INSERTed with the column populated', () => {
    const row = store.issue({
      bot_name: 'shumabit', tool_use_id: 'toolu_pin',
      requester_chat_id: '-100', approver_chat_id: '111111111',
      tool_name: 'Bash', tool_input: {},
    });
    assert.equal(row.tool_use_id, 'toolu_pin',
      'pre-rc.10 the column was NULL despite migration 010 — verify the fix');
  });

  test('setApproverMsgId updates the row', () => {
    const row = store.issue({
      bot_name: 'shumabit', requester_chat_id: '-100',
      approver_chat_id: '111111111', tool_name: 'Bash', tool_input: {},
    });
    assert.equal(store.setApproverMsgId(row.id, 12345), 1);
    assert.equal(store.getById(row.id).approver_msg_id, 12345);
  });

  test('resolve flips status and records decider', () => {
    const row = store.issue({
      bot_name: 'shumabit', requester_chat_id: '-100',
      approver_chat_id: '111111111', tool_name: 'Bash', tool_input: {},
    });
    assert.equal(store.resolve({
      id: row.id, status: 'approved',
      decided_by_user_id: 42, decided_by_user: 'Ivan',
    }), 1);
    const after = store.getById(row.id);
    assert.equal(after.status, 'approved');
    assert.equal(after.decided_by_user_id, 42);
    assert.equal(after.decided_by_user, 'Ivan');
  });

  test('resolve is idempotent (second call affects 0 rows)', () => {
    const row = store.issue({
      bot_name: 'shumabit', requester_chat_id: '-100',
      approver_chat_id: '111111111', tool_name: 'Bash', tool_input: {},
    });
    store.resolve({ id: row.id, status: 'approved' });
    assert.equal(store.resolve({ id: row.id, status: 'denied' }), 0);
    assert.equal(store.getById(row.id).status, 'approved');
  });

  test('sweepTimedOut returns rows past their deadline', () => {
    const row = store.issue({
      bot_name: 'shumabit', requester_chat_id: '-100',
      approver_chat_id: '111111111', tool_name: 'Bash', tool_input: {},
      timeoutMs: 1000,
    });
    fakeNow += 2000;
    const rows = store.sweepTimedOut();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, row.id);
  });

  test('listPending scopes to the bot', () => {
    store.issue({
      bot_name: 'shumabit', requester_chat_id: '-1',
      approver_chat_id: '1', tool_name: 'Bash', tool_input: { command: 'x' },
    });
    store.issue({
      bot_name: 'umi-assistant', requester_chat_id: '-2',
      approver_chat_id: '1', tool_name: 'Bash', tool_input: { command: 'y' },
    });
    assert.equal(store.listPending('shumabit').length, 1);
    assert.equal(store.listPending('umi-assistant').length, 1);
    assert.equal(store.listPending('ghost').length, 0);
  });
});
