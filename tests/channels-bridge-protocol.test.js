'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBridgeToDaemonMessage,
  parseDaemonToBridgeMessage,
} = require('@shumkov/orchestra').bridgeProtocol;

test('parseBridgeToDaemonMessage accepts well-formed hello', () => {
  const r = parseBridgeToDaemonMessage({ kind: 'hello', session_key: 'sess', secret: 'sec' });
  assert.equal(r.ok, true);
  assert.equal(r.msg.session_key, 'sess');
});

test('parseBridgeToDaemonMessage rejects hello with missing secret', () => {
  const r = parseBridgeToDaemonMessage({ kind: 'hello', session_key: 'sess' });
  assert.equal(r.ok, false);
  assert.match(r.error, /secret/i);
});

test('parseBridgeToDaemonMessage accepts well-formed tool call', () => {
  const r = parseBridgeToDaemonMessage({
    kind: 'tool',
    session: 'sess',
    tool_call_id: 'abc',
    name: 'reply',
    args: { chat_id: '1', text: 'hi' },
  });
  assert.equal(r.ok, true);
});

test('parseBridgeToDaemonMessage rejects tool call with unknown name', () => {
  const r = parseBridgeToDaemonMessage({
    kind: 'tool',
    session: 'sess',
    tool_call_id: 'abc',
    name: 'whoami',
    args: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /name/);
});

test('parseBridgeToDaemonMessage rejects perm_req with missing request_id', () => {
  const r = parseBridgeToDaemonMessage({
    kind: 'perm_req',
    session: 'sess',
    tool_name: 'Bash',
    description: 'do',
    input_preview: 'ls',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /request_id/);
});

test('parseBridgeToDaemonMessage rejects unknown kind', () => {
  const r = parseBridgeToDaemonMessage({ kind: 'mystery', foo: 'bar' });
  assert.equal(r.ok, false);
});

test('parseDaemonToBridgeMessage accepts well-formed user_msg', () => {
  const r = parseDaemonToBridgeMessage({
    kind: 'user_msg', text: 'hello', chat_id: '1', user: 'alice', msg_id: '42', turn_id: 't1',
  });
  assert.equal(r.ok, true);
});

test('parseDaemonToBridgeMessage accepts perm_verdict allow', () => {
  const r = parseDaemonToBridgeMessage({ kind: 'perm_verdict', request_id: 'r1', behavior: 'allow' });
  assert.equal(r.ok, true);
});

test('parseDaemonToBridgeMessage rejects perm_verdict with bad behavior enum', () => {
  const r = parseDaemonToBridgeMessage({ kind: 'perm_verdict', request_id: 'r1', behavior: 'maybe' });
  assert.equal(r.ok, false);
  assert.match(r.error, /behavior/);
});

test('parseDaemonToBridgeMessage accepts tool_ack with optional error', () => {
  const r1 = parseDaemonToBridgeMessage({ kind: 'tool_ack', tool_call_id: 'tc1', ok: true });
  const r2 = parseDaemonToBridgeMessage({ kind: 'tool_ack', tool_call_id: 'tc2', ok: false, error: 'oops' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
});

test('0.13: tool_ack carries an optional message_id (reply → edit_message)', () => {
  const ok = parseDaemonToBridgeMessage({ kind: 'tool_ack', tool_call_id: 'tc', ok: true, message_id: 4242 });
  assert.equal(ok.ok, true);
  assert.equal(ok.msg.message_id, 4242, 'numeric message_id round-trips');
  // absent is fine (errors / re-acks don't carry one)
  assert.equal(parseDaemonToBridgeMessage({ kind: 'tool_ack', tool_call_id: 'tc', ok: true }).ok, true);
  // null is fine (solo sticker/reaction reply has no bubble id)
  assert.equal(parseDaemonToBridgeMessage({ kind: 'tool_ack', tool_call_id: 'tc', ok: true, message_id: null }).ok, true);
});

test('passthrough() preserves extra fields', () => {
  const r = parseBridgeToDaemonMessage({
    kind: 'tool',
    session: 'sess',
    tool_call_id: 'abc',
    name: 'reply',
    args: { chat_id: '1', text: 'hi' },
    extra_future_field: 'tolerated',
  });
  assert.equal(r.ok, true);
  assert.equal(r.msg.extra_future_field, 'tolerated');
});
