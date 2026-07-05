'use strict';

/**
 * Tests for the PreCompact/PostCompact hook plumbing (0.12.0-rc.13).
 *
 * The compaction warning needs claude to emit PreCompact (auto-compaction
 * imminent) and PostCompact (compaction done) into the hook ndjson, and the
 * tail to normalize them into typed events carrying the `trigger`
 * (auto|manual) field — so polygram can react ONLY to the dangerous auto
 * case. Verified against the pinned binary (2.1.142) in the rc.13 spike.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { HOOK_EVENTS } = require('@shumkov/orchestra').hookSettings;
const { normalizeHookEvent } = require('@shumkov/orchestra').hookEventTail;

test('HOOK_EVENTS registers PreCompact + PostCompact (claude must emit them to the ndjson)', () => {
  assert.ok(HOOK_EVENTS.includes('PreCompact'), 'PreCompact must be registered');
  assert.ok(HOOK_EVENTS.includes('PostCompact'), 'PostCompact must be registered');
});

test('normalizeHookEvent: PreCompact is typed and carries trigger + customInstructions', () => {
  const ev = normalizeHookEvent({
    hook_event_name: 'PreCompact',
    session_id: 's1',
    transcript_path: '/t.jsonl',
    trigger: 'auto',
    custom_instructions: 'keep the track decisions',
  });
  assert.equal(ev.type, 'PreCompact', 'must NOT fall through to "unknown"');
  assert.equal(ev.trigger, 'auto', 'trigger distinguishes auto vs manual — required to react only to auto');
  assert.equal(ev.customInstructions, 'keep the track decisions');
  assert.equal(ev.sessionId, 's1');
  assert.equal(ev.transcriptPath, '/t.jsonl');
});

test('normalizeHookEvent: PostCompact is typed (used to reset the warn-once state)', () => {
  const ev = normalizeHookEvent({ hook_event_name: 'PostCompact', session_id: 's1', trigger: 'auto' });
  assert.equal(ev.type, 'PostCompact');
  assert.equal(ev.trigger, 'auto');
});

test('normalizeHookEvent: manual trigger preserved (so we can suppress the warning for user-driven /compact)', () => {
  const ev = normalizeHookEvent({ hook_event_name: 'PreCompact', trigger: 'manual' });
  assert.equal(ev.trigger, 'manual');
});

test('normalizeHookEvent: trigger absent on non-compact events → null (no crash)', () => {
  const ev = normalizeHookEvent({ hook_event_name: 'Stop', session_id: 's1' });
  assert.equal(ev.type, 'Stop');
  assert.equal(ev.trigger, null);
});
