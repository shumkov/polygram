/**
 * Typed content-free schema for events.detail_json.
 *
 * WHY: event detail is a durable text sink written from hundreds of call
 * sites, in this repo and in Orchestra, which calls db.logEvent directly.
 * Masking alone cannot promise "no raw content in telemetry" — it removes
 * only what a detector recognizes — and a name-only allowlist leaves fields
 * like `error` as a standing invitation to log a message body under an
 * approved name. Every field therefore declares a type, and a value that does
 * not satisfy it is dropped with only its NAME recorded.
 *
 * Run: node --test tests/event-detail-schema.test.js
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  enforceEventDetailSchema,
  EVENT_DETAIL_FIELDS,
  REMOVED_FIELDS,
} = require('../lib/db/event-detail-schema');

describe('enforceEventDetailSchema', () => {
  test('keeps typed content-free fields untouched', () => {
    const { detail, dropped } = enforceEventDetailSchema({
      session_key: '100:main', msg_id: 7, text_len: 42, backend: 'cli', ok: true,
    });
    assert.deepEqual(detail, {
      session_key: '100:main', msg_id: 7, text_len: 42, backend: 'cli', ok: true,
    });
    assert.deepEqual(dropped, []);
  });

  test('a value of the wrong type is dropped even under an approved name', () => {
    // The whole point of typing: `reason` is a legitimate field name, so a
    // name-only allowlist would have persisted this sentence verbatim.
    const { detail, dropped } = enforceEventDetailSchema({
      msg_id: 1, reason: 'the user said their password is hunter2-fake-value',
    });
    assert.deepEqual(detail, { msg_id: 1 });
    assert.deepEqual(dropped, ['reason']);
  });

  test('an unknown field name is counted but never echoed', () => {
    // Field NAMES can be caller-controlled too — a spread of a map keyed by
    // user data puts arbitrary text in the key position. Only names drawn
    // from the schema's own closed vocabulary are safe to echo back; the
    // rest contribute to a count.
    const { detail, dropped, droppedCount } = enforceEventDetailSchema({
      msg_id: 1, surprise_payload: 'the user typed this',
    });
    assert.deepEqual(detail, { msg_id: 1 });
    assert.equal(droppedCount, 1, 'every rejection is counted');
    assert.deepEqual(dropped, [], 'an unknown name is not a safe thing to store');
    assert.ok(!JSON.stringify({ detail, dropped }).includes('surprise_payload'));
    assert.ok(!JSON.stringify({ detail, dropped }).includes('the user typed this'));
  });

  test('a secret-bearing rejected key never reaches the row', () => {
    const { detail, dropped, droppedCount } = enforceEventDetailSchema({
      msg_id: 1, 'password: hunter2-fake-value': 'v',
    });
    assert.deepEqual(detail, { msg_id: 1 });
    assert.equal(droppedCount, 1);
    assert.deepEqual(dropped, []);
    assert.ok(!JSON.stringify({ detail, dropped }).includes('hunter2-fake-value'));
  });

  test('the same field passes as a code', () => {
    const { detail, dropped } = enforceEventDetailSchema({ reason: 'spawn-failed' });
    assert.deepEqual(detail, { reason: 'spawn-failed' });
    assert.deepEqual(dropped, []);
  });

  test('prose-carrying field names are absent from the schema entirely', () => {
    for (const key of REMOVED_FIELDS) {
      assert.equal(EVENT_DETAIL_FIELDS[key], undefined, `${key} must stay removed`);
    }
    const { detail, dropped } = enforceEventDetailSchema({
      chat_id: '1', error: 'ENOENT: no such file', message: 'boom',
      path: '/home/me/sessions.json', stderr_tail: 'tmux: no server',
      old_value: 'sonnet', value: 'x', topics: [{ thread_id: '1' }],
    });
    assert.deepEqual(detail, { chat_id: '1' });
    assert.deepEqual(dropped,
      ['error', 'message', 'old_value', 'path', 'stderr_tail', 'topics', 'value']);
  });

  test('typing is recursive — a nested tail cannot hide inside a shape', () => {
    const { detail, dropped } = enforceEventDetailSchema({
      chat_id: '1',
      busy_probe: {
        busy: true, streaming: false, in_flight: false, pending_turns: 1,
        captured: true, pane_tail: '⏵ assistant transcript text',
      },
    });
    assert.deepEqual(detail, {
      chat_id: '1',
      busy_probe: { busy: true, streaming: false, in_flight: false, pending_turns: 1, captured: true },
    });
    assert.deepEqual(dropped, ['pane_tail']);
  });

  test('non-plain values are dropped, never serialized', () => {
    class Weird {}
    const { detail, dropped } = enforceEventDetailSchema({
      msg_id: 1, when: new Date(0), map: new Map(), weird: new Weird(),
      fn: () => 'x', busy_probe: 'not-an-object',
    });
    assert.deepEqual(detail, { msg_id: 1 });
    assert.deepEqual(dropped, ['busy_probe', 'when'], 'only schema-known names echo');
    assert.equal(enforceEventDetailSchema({
      msg_id: 1, when: new Date(0), map: new Map(), weird: new Weird(),
      fn: () => 'x', busy_probe: 'not-an-object',
    }).droppedCount, 5);
  });

  test('an absent field is not a loss and is not reported', () => {
    const { detail, dropped } = enforceEventDetailSchema({
      msg_id: 1, turn_id: undefined, reason: undefined,
    });
    assert.deepEqual(detail, { msg_id: 1 });
    assert.deepEqual(dropped, [], 'undefined is absence, not a dropped value');
  });

  test('null is a recorded value, not a type failure', () => {
    const { detail, dropped } = enforceEventDetailSchema({ turn_id: null, count: 0 });
    assert.deepEqual(detail, { turn_id: null, count: 0 });
    assert.deepEqual(dropped, []);
  });

  test('ids arrays are bounded and typed', () => {
    assert.deepEqual(enforceEventDetailSchema({ topic_ids: ['1', '2'] }).dropped, []);
    assert.deepEqual(
      enforceEventDetailSchema({ topic_ids: ['ok', 'a sentence with spaces'] }).dropped,
      ['topic_ids'],
    );
    assert.equal(
      enforceEventDetailSchema({ topic_ids: ['ok', 'a sentence with spaces'] }).droppedCount,
      1,
    );
  });

  test('real event payloads survive the schema intact', () => {
    // Shapes copied from live call sites in this repo and in Orchestra's
    // process telemetry. If a field here starts being dropped, the schema has
    // drifted from the producers and operators lose a signal they rely on.
    const payloads = {
      'handler-error': {
        session_key: '1:2', msg_id: 9, error_class: 'TypeError', code: 'ERR_X',
        cause_code: 'ECONNRESET', error_len: 120, stderr_len: 40,
      },
      'abort-requested': {
        user_id: 99, had_active: true, cancel_mode: 'interrupt',
        killed_background_shell: false, text_len: 4,
        busy_probe: { busy: true, streaming: true, in_flight: false, pending_turns: 1, captured: true },
      },
      'compact-command': { thread_id: '24', session_key: '1:24', text_len: 8, msg_id: 5, user_id: 1 },
      'voice-transcribed': { msg_id: 3, provider: 'openai', language: 'en', duration_sec: 2, chars: 40, cost_usd: 0.01 },
      'events-pruned': { default: 1, diagnostic: 2, cap: 0, total: 3, before: {}, after: {}, trigger: 'boot' },
      'clean-resume-fallback': { bot: 'b', session_key: '1:2', source_message_id: 4, policy_version: 2, reason: 'stale' },
      'clean-restart-qualification-observed': {
        bot: 'b', restart_request_sha256: 'f'.repeat(64), daemon_instance_id: 'd1',
        package_version: '0.38.2', observed_at_ms: 1, generation_digest: 'a'.repeat(64),
        expected_activity_epoch: 1, observed_activity_epoch: 1, process_state: 'Idle',
        active_turn_count: 0, pending_delivery_count: 0, background_owner_count: 0,
        background_terminal_count: 0, background_terminal_registry_complete: true,
        exact_match: true, outcome_code: 'eligible',
      },
      // Orchestra's own producers, under their real names.
      'cli-turn-resolved-by-stop': { turn_id: 't1', session_key: '1:2', backend: 'cli', reply_count: 2, final_len: 120 },
      'cli-hook-stream-stalled': { turn_id: 't1', last_hook_age_ms: 9000, session_key: '1:2' },
      'cli-bg-work-stall-selfcheck': { idle_ms: 1000, shell_count: 2, session_key: '1:2' },
      'cli-input-acked': { turn_id: 't1', source: 'primary', backend: 'cli' },
      'panic-exit': { bot_name: 'b', count: 3, window_ms: 60000 },
      'workflow-completion-ineligible': { reason: 'snapshot-missing', turn_id: 't1' },
      'session-age-dialog-fallback': { tmux_name: 'polygram-1-2', phase: 'startup-gate' },
    };
    for (const [kind, payload] of Object.entries(payloads)) {
      const { dropped } = enforceEventDetailSchema(payload);
      assert.deepEqual(dropped, [], `${kind} lost fields: ${dropped.join(', ')}`);
    }
  });
});
