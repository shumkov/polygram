'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isCodexProcess,
  isCodexResult,
  normalizeStreamText,
  normalizeFinalText,
} = require('../lib/codex/event-normalizer');

describe('Codex event normalizer', () => {
  test('recognizes the pinned process and result contracts', () => {
    assert.equal(isCodexProcess({ runtime: 'codex' }), true);
    assert.equal(isCodexProcess({ backend: 'codex' }), true);
    assert.equal(isCodexProcess({ runtime: 'claude', backend: 'sdk' }), false);
    assert.equal(isCodexResult({
      generationId: 'generation-a',
      providerTurnId: 'turn-a',
    }), true);
    assert.equal(isCodexResult({ sessionId: 'claude-session' }), false);
  });

  test('forwards cumulative Codex snapshots without appending prefixes', () => {
    const entry = { runtime: 'codex' };
    assert.deepEqual(
      ['Hel', 'Hello', 'Hello world'].map(
        (value) => normalizeStreamText(value, entry),
      ),
      ['Hel', 'Hello', 'Hello world'],
    );
    assert.equal(normalizeStreamText({ text: 'not the contract' }, entry), null);
  });

  test('leaves Claude stream values exactly untouched', () => {
    const value = { legacy: 'opaque callback value' };
    assert.equal(
      normalizeStreamText(value, { runtime: 'claude', backend: 'sdk' }),
      value,
    );
  });

  test('uses authoritative Codex final text even when it differs from a snapshot', () => {
    const result = {
      text: 'authoritative final',
      generationId: 'generation-a',
      providerTurnId: 'turn-a',
    };
    assert.equal(normalizeFinalText(result), 'authoritative final');
  });

  test('rejects malformed Codex final text but preserves Claude result behavior', () => {
    assert.throws(
      () => normalizeFinalText({
        text: 42,
        generationId: 'generation-a',
        providerTurnId: 'turn-a',
      }),
      (error) => error.code === 'CODEX_TEXT_EVENT_INVALID',
    );
    assert.equal(normalizeFinalText({ text: 42, sessionId: 'claude' }), 42);
  });
});
