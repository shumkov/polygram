/**
 * Tests for lib/ops/auth-disabled-gate.js — the dedupe/re-arm gate that
 * decides whether an AUTH_DISABLED occurrence should page the operator.
 *
 * See docs/AUTH_DISABLED_HANDLING_SPEC.md, "Dedupe / re-arm".
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createAuthDisabledGate } = require('../lib/ops/auth-disabled-gate');

describe('createAuthDisabledGate — dedupe', () => {
  test('first noteFailure() returns true (should notify)', () => {
    const gate = createAuthDisabledGate();
    assert.equal(gate.noteFailure(), true);
  });

  test('repeated noteFailure() without an intervening noteSuccess() stays false', () => {
    const gate = createAuthDisabledGate();
    assert.equal(gate.noteFailure(), true);
    assert.equal(gate.noteFailure(), false);
    assert.equal(gate.noteFailure(), false);
  });

  test('noteSuccess() re-arms — the next noteFailure() returns true again', () => {
    const gate = createAuthDisabledGate();
    assert.equal(gate.noteFailure(), true);
    assert.equal(gate.noteFailure(), false);
    gate.noteSuccess();
    assert.equal(gate.noteFailure(), true);
  });

  test('noteSuccess() before any failure is a no-op (does not throw, gate stays armed)', () => {
    const gate = createAuthDisabledGate();
    gate.noteSuccess();
    assert.equal(gate.noteFailure(), true);
  });
});

describe('createAuthDisabledGate — count (heartbeat counter)', () => {
  test('count increments on every noteFailure() call, including deduped ones', () => {
    const gate = createAuthDisabledGate();
    gate.noteFailure();
    gate.noteFailure();
    gate.noteFailure();
    assert.equal(gate.snapshot().count, 3);
  });

  test('count does not reset on noteSuccess() — it is a lifetime occurrence counter', () => {
    const gate = createAuthDisabledGate();
    gate.noteFailure();
    gate.noteSuccess();
    gate.noteFailure();
    assert.equal(gate.snapshot().count, 2);
  });

  test('lastAt reflects the injected clock at the most recent noteFailure()', () => {
    let now = 1000;
    const gate = createAuthDisabledGate({ now: () => now });
    gate.noteFailure();
    now = 2000;
    gate.noteFailure();
    assert.equal(gate.snapshot().lastAt, 2000);
  });

  test('lastAt is null before any failure', () => {
    const gate = createAuthDisabledGate();
    assert.equal(gate.snapshot().lastAt, null);
  });
});

describe('createAuthDisabledGate — snapshot shape + safety', () => {
  test('snapshot() returns {count, lastAt, armed}', () => {
    const gate = createAuthDisabledGate();
    const snap = gate.snapshot();
    assert.deepEqual(Object.keys(snap).sort(), ['armed', 'count', 'lastAt']);
    assert.equal(snap.armed, true);
  });

  test('noteFailure()/noteSuccess() never throw across a long mixed sequence, and end state is exactly right', () => {
    const gate = createAuthDisabledGate();
    let failures = 0;
    assert.doesNotThrow(() => {
      for (let i = 0; i < 50; i++) {
        gate.noteFailure();
        failures += 1;
        if (i % 3 === 0) gate.noteSuccess();
      }
    });
    // "doesn't throw" alone proves nothing about the dedupe/count logic
    // staying correct across many cycles — assert the actual end state too.
    // i=49 is the last iteration; 49 % 3 !== 0, so the final call was
    // noteFailure() with no following noteSuccess() → gate stays disarmed.
    const snap = gate.snapshot();
    assert.equal(snap.count, failures, 'count must track every noteFailure() call exactly, with no drift across cycles');
    assert.equal(snap.armed, false, 'last call in the sequence was noteFailure() with no subsequent noteSuccess() — must stay disarmed');
  });
});
