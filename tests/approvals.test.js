/**
 * Tests for lib/approvals.js
 * Run: node --test tests/approvals.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const {
  createStore, matchesAnyPattern, patternToRegex, digestInput, newToken,
} = require('../lib/approvals');

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
  const { tokensEqual } = require('../lib/approvals');
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
