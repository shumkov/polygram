/**
 * Producer tests for telemetry, run against a REAL database.
 *
 * WHY not the existing mock-sink tests: those collect what a producer passes
 * to `logEvent` and never reach the typed schema, so a field the schema drops
 * still looks present. Anything asserted here has survived the actual write —
 * which is the only place the guarantee (and the loss) is real.
 *
 * Run: node --test tests/telemetry-producers.test.js
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createSdkCallbacks } = require('../lib/sdk/callbacks');

let db; let dbPath;

const lastEvent = (kind) => {
  const row = db.raw
    .prepare('SELECT detail_json FROM events WHERE kind=? ORDER BY id DESC LIMIT 1')
    .get(kind);
  return row ? JSON.parse(row.detail_json) : null;
};

function hookCallbacks() {
  return createSdkCallbacks({
    db: { upsertSession() {}, upsertProviderSession() {} },
    dbWrite: (fn) => fn(),
    config: { chats: { 12345: {} }, bot: {} },
    bot: { mock: true },
    botName: 'test-bot',
    tg: () => Promise.resolve({ message_id: 1 }),
    logEvent: (kind, detail) => db.logEvent(kind, detail),
    classifyToolName: (name) => name,
    announce: () => {},
    shouldAnnounce: () => false,
    contextHintShown: new Set(),
    extractAssistantText: () => '',
    getChatIdFromKey: (key) => key.split(':')[0],
    logger: { log() {}, error() {}, warn() {} },
  });
}

describe('lifecycle and config telemetry survive the typed schema', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telemetry-producers-2')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('a topic-override sweep records which topics were cleared, by id', () => {
    // The sweep used to log the topics' old VALUES. What an operator needs is
    // which topics moved and how many — the values are configuration content
    // and the ids answer "explicable afterwards" on their own.
    const cleared = [
      { threadId: '24', value: 'sonnet' },
      { threadId: '77', value: 'opus' },
    ];
    db.logEvent('config-topic-override-swept', {
      chat_id: '-100',
      field: 'model',
      topic_ids: cleared.map((t) => String(t.threadId)),
      topics_cleared: cleared.length,
    });
    const detail = lastEvent('config-topic-override-swept');
    assert.deepEqual(detail.topic_ids, ['24', '77']);
    assert.equal(detail.topics_cleared, 2);
    assert.equal(detail.field, 'model');
    assert.equal(detail.dropped_field_count, undefined,
      'the producer and the schema must agree, with nothing dropped');
    assert.ok(!JSON.stringify(detail).includes('sonnet'));
  });

  test('daemon lifecycle identity survives', () => {
    db.logEvent('polygram-admission-open', {
      bot: 'test-bot',
      daemon_instance_id: 'd-1',
      pid: 4242,
      invocation_id: 'abcdef0123456789',
    });
    const detail = lastEvent('polygram-admission-open');
    assert.equal(detail.pid, 4242);
    assert.equal(detail.invocation_id, 'abcdef0123456789');
    assert.equal(detail.daemon_instance_id, 'd-1');
    assert.equal(detail.dropped_field_count, undefined);
  });

  test("Orchestra's own counters and identifiers survive", () => {
    db.logEvent('cost-threshold', {
      active: 3, totalCost: 1.25, newCost: 0.5, pinnedSkipped: 1,
      sessionKey: '12345:24', turnId: 't-1', turnTimeoutMs: 900000,
      queueCap: 20, drainedPendings: 2, background_shell: true, fired: false,
      callback: 'onStreamChunk',
    });
    const detail = lastEvent('cost-threshold');
    assert.equal(detail.dropped_field_count, undefined,
      `Orchestra fields dropped: ${JSON.stringify(detail)}`);
    assert.equal(detail.active, 3);
    assert.equal(detail.totalCost, 1.25);
    assert.equal(detail.sessionKey, '12345:24');
  });

  test('the inbox sweep counts files', () => {
    db.logEvent('inbox-swept', { files: 7, bytes: 1024, retention_days: 30 });
    const detail = lastEvent('inbox-swept');
    assert.equal(detail.files, 7);
    assert.equal(detail.dropped_field_count, undefined);
  });
});

describe('SDK hook telemetry survives the typed schema', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telemetry-producers')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('a PostToolUse hook keeps its identity, classification and timing', () => {
    const cbs = hookCallbacks();
    cbs.onHookEvent('12345:24', {
      type: 'PostToolUse',
      sessionId: 'claude-session-1',
      toolName: 'Bash',
      toolUseId: 'toolu_01',
      agentId: 'agent-1',
      agentType: 'general-purpose',
      durationMs: 1200,
      stopHookActive: false,
      receivedAtMs: 1_700_000_000_000,
    });

    const detail = lastEvent('hook-event');
    assert.ok(detail, 'hook-event must be persisted');
    assert.equal(detail.hook_type, 'PostToolUse');
    assert.equal(detail.claude_session_id, 'claude-session-1');
    assert.equal(detail.tool_name, 'Bash');
    assert.equal(detail.tool_use_id, 'toolu_01');
    assert.equal(detail.agent_id, 'agent-1');
    assert.equal(detail.agent_type, 'general-purpose');
    assert.equal(detail.duration_ms, 1200);
    assert.equal(detail.stop_hook_active, false);
    assert.equal(detail.received_at_ms, 1_700_000_000_000);
    assert.equal(detail.dropped_fields, undefined,
      `the schema dropped: ${JSON.stringify(detail.dropped_fields)}`);
  });

  test('a parse-error hook keeps a code and sizes, never the body', () => {
    const cbs = hookCallbacks();
    cbs.onHookEvent('12345:24', {
      type: 'parse-error',
      sessionId: 'claude-session-1',
      error: Object.assign(new Error('Unexpected token } in JSON at position 42'), { code: 'ERR_JSON' }),
      raw: { tool_input: { command: 'echo my password: hunter2-fake-value' } },
      receivedAtMs: 1_700_000_000_001,
    });

    const detail = lastEvent('hook-event');
    assert.ok(detail);
    assert.equal(detail.hook_type, 'parse-error');
    assert.equal(detail.parse_error_code, 'ERR_JSON');
    assert.ok(detail.parse_error_len > 0, 'the message size is still a signal');
    assert.ok(detail.raw_len > 0, 'the body size is still a signal');
    const serialized = JSON.stringify(detail);
    assert.ok(!serialized.includes('hunter2-fake-value'), serialized);
    assert.ok(!serialized.includes('Unexpected token'), serialized);
    assert.equal(detail.raw_truncated, undefined);
    assert.equal(detail.parse_error, undefined);
    assert.equal(detail.dropped_fields, undefined,
      `the schema dropped: ${JSON.stringify(detail.dropped_fields)}`);
  });

  test('a stop hook keeps stop_hook_active true', () => {
    const cbs = hookCallbacks();
    cbs.onHookEvent('12345:24', {
      type: 'Stop', sessionId: 's1', stopHookActive: true, receivedAtMs: 5,
    });
    const detail = lastEvent('hook-event');
    assert.equal(detail.stop_hook_active, true);
    assert.equal(detail.dropped_fields, undefined);
  });
});
