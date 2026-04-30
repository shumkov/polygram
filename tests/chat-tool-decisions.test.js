/**
 * Tests for the chat_tool_decisions table operations added in
 * lib/db.js (Phase 1 step 8 / migration 010).
 *
 * Covers all three match_type semantics (exact / prefix / regex) +
 * expiry + per-bot scoping.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { open } = require('../lib/db');

let tmp;
let db;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-test-'));
  db = open(path.join(tmp, 'test.db'));
});

afterEach(() => {
  db.raw.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('chat_tool_decisions — match_type', () => {
  test('exact match: input must equal pattern', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'exact',
      input_pattern: '{"command":"git status"}',
      decision: 'allow',
    });
    const hit = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"git status"}',
    });
    assert.equal(hit.decision, 'allow');
    const miss = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"git diff"}',
    });
    assert.equal(miss, null);
  });

  test('prefix match: input must start with pattern', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'prefix',
      input_pattern: '{"command":"npm test',
      decision: 'allow',
    });
    const a = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"npm test"}',
    });
    assert.equal(a.decision, 'allow');
    const b = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"npm test --watch"}',
    });
    assert.equal(b.decision, 'allow');
    const c = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"rm -rf /"}',
    });
    assert.equal(c, null);
  });

  test('regex match: pattern is a regex', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'regex',
      input_pattern: '"command":"(ls|pwd)"',
      decision: 'allow',
    });
    const a = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"ls"}',
    });
    assert.equal(a.decision, 'allow');
    const b = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"pwd"}',
    });
    assert.equal(b.decision, 'allow');
    const c = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"git diff"}',
    });
    assert.equal(c, null);
  });

  test('malformed regex pattern is gracefully skipped (no throw)', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'regex',
      input_pattern: '[unclosed',
      decision: 'allow',
    });
    const r = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{"command":"ls"}',
    });
    assert.equal(r, null);
  });
});

describe('chat_tool_decisions — expiry', () => {
  test('expires_ts in past → row not returned', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'exact',
      input_pattern: '{}',
      decision: 'allow',
      expires_ts: Date.now() - 1000,
    });
    const r = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.equal(r, null);
  });

  test('expires_ts in future → row returned', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'exact',
      input_pattern: '{}',
      decision: 'allow',
      expires_ts: Date.now() + 60_000,
    });
    const r = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.equal(r?.decision, 'allow');
  });

  test('expires_ts NULL → never expires', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'exact',
      input_pattern: '{}',
      decision: 'allow',
      expires_ts: null,
    });
    const r = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
      now: Date.now() + 10 * 365 * 86400_000,    // 10 years from now
    });
    assert.equal(r?.decision, 'allow');
  });
});

describe('chat_tool_decisions — per-bot scoping', () => {
  test('row in bot A is invisible to bot B (ship-breaker H7)', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'exact',
      input_pattern: '{}',
      decision: 'allow',
    });
    const aHit = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.equal(aHit?.decision, 'allow');
    const bMiss = db.lookupChatToolDecision({
      bot_name: 'umi-assistant', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.equal(bMiss, null);
  });

  test('row in chat A is invisible to chat B', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'exact',
      input_pattern: '{}',
      decision: 'allow',
    });
    const miss = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c2', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.equal(miss, null);
  });

  test('row for tool A is invisible to tool B', () => {
    db.insertChatToolDecision({
      bot_name: 'shumabit',
      chat_id: 'c1',
      tool_name: 'Bash',
      match_type: 'exact',
      input_pattern: '{}',
      decision: 'allow',
    });
    const miss = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Read',
      canonical_input: '{}',
    });
    assert.equal(miss, null);
  });
});

describe('chat_tool_decisions — deletion', () => {
  test('deleteChatToolDecision removes the row', () => {
    const result = db.insertChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      match_type: 'exact', input_pattern: '{}', decision: 'allow',
    });
    const id = result.lastInsertRowid;
    const hit = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.ok(hit);
    db.deleteChatToolDecision({ bot_name: 'shumabit', chat_id: 'c1', id });
    const miss = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.equal(miss, null);
  });

  test('deleteChatToolDecision with WRONG bot_name does NOT delete', () => {
    const result = db.insertChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      match_type: 'exact', input_pattern: '{}', decision: 'allow',
    });
    const id = result.lastInsertRowid;
    db.deleteChatToolDecision({ bot_name: 'umi-assistant', chat_id: 'c1', id });
    const hit = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.ok(hit, 'cross-bot delete must not affect rows owned by another bot');
  });

  test('deleteChatToolDecision with WRONG chat_id does NOT delete', () => {
    const result = db.insertChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      match_type: 'exact', input_pattern: '{}', decision: 'allow',
    });
    const id = result.lastInsertRowid;
    db.deleteChatToolDecision({ bot_name: 'shumabit', chat_id: 'c2', id });
    const hit = db.lookupChatToolDecision({
      bot_name: 'shumabit', chat_id: 'c1', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.ok(hit);
  });

  test('deleteChatToolDecision with non-existent id is a no-op', () => {
    const result = db.deleteChatToolDecision({ bot_name: 'b', chat_id: 'c', id: 99999 });
    assert.equal(result.changes, 0);
  });
});

describe('chat_tool_decisions — lookup priority', () => {
  test('first-inserted decision wins when multiple match', () => {
    // Two exact-match decisions for the same input — first row by id
    // wins (no ORDER BY → SQLite scans in insertion order).
    db.insertChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      match_type: 'exact', input_pattern: '{}', decision: 'allow',
    });
    db.insertChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      match_type: 'exact', input_pattern: '{}', decision: 'deny',
    });
    const hit = db.lookupChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      canonical_input: '{}',
    });
    assert.equal(hit.decision, 'allow', 'first-inserted (id ASC) wins');
  });

  test('exact + prefix overlap: prefix wins ONLY if exact does not match', () => {
    // Pre-insert: exact='{"cmd":"ls"}' allow; prefix='{"cmd":"' deny.
    // Lookup canonical_input='{"cmd":"ls"}' — exact matches → allow.
    db.insertChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      match_type: 'exact', input_pattern: '{"cmd":"ls"}', decision: 'allow',
    });
    db.insertChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      match_type: 'prefix', input_pattern: '{"cmd":"', decision: 'deny',
    });
    const hit = db.lookupChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      canonical_input: '{"cmd":"ls"}',
    });
    // First row wins by id ASC; both match this input.
    assert.equal(hit.decision, 'allow');
  });

  test('canonical_input null/undefined does not crash', () => {
    db.insertChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      match_type: 'prefix', input_pattern: 'something', decision: 'allow',
    });
    assert.doesNotThrow(() => db.lookupChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      canonical_input: null,
    }));
    assert.doesNotThrow(() => db.lookupChatToolDecision({
      bot_name: 'b', chat_id: 'c', tool_name: 'Bash',
      canonical_input: undefined,
    }));
  });
});
