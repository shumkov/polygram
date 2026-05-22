'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CANNED_STRINGS,
  SANITIZED_REPLACEMENT,
  sanitizeAssistantReply,
} = require('../lib/telegram/sanitize-reply');

describe('sanitizeAssistantReply — exact-match interception', () => {
  test('replaces `No response requested.` verbatim (the production trace)', () => {
    const r = sanitizeAssistantReply('No response requested.');
    assert.equal(r.replaced, true);
    assert.equal(r.original, 'No response requested.');
    assert.equal(r.text, SANITIZED_REPLACEMENT);
  });

  test('replaces `No response needed.` (rc.37-hint adjacent variant)', () => {
    const r = sanitizeAssistantReply('No response needed.');
    assert.equal(r.replaced, true);
    assert.equal(r.text, SANITIZED_REPLACEMENT);
  });

  test('trims surrounding whitespace before matching', () => {
    const r = sanitizeAssistantReply('  No response requested.\n');
    assert.equal(r.replaced, true);
  });
});

describe('sanitizeAssistantReply — passes legitimate text through unchanged', () => {
  test('substantive reply is unchanged', () => {
    const txt = 'Here is your answer: 42.';
    const r = sanitizeAssistantReply(txt);
    assert.equal(r.replaced, false);
    assert.equal(r.text, txt);
  });

  test('polygram R10 empty-turn fallback is NOT intercepted (it is intentional)', () => {
    // `No response generated. Please try again.` is polygram's own
    // fail-loud message when claude returned an empty turn. It must
    // pass through — otherwise we'd hide the very signal R10 was
    // built to surface.
    const txt = 'No response generated. Please try again.';
    const r = sanitizeAssistantReply(txt);
    assert.equal(r.replaced, false);
    assert.equal(r.text, txt);
  });

  test('`Stopped.` (polygram /stop confirmation) is NOT intercepted', () => {
    const r = sanitizeAssistantReply('Stopped.');
    assert.equal(r.replaced, false);
  });

  test('reply that MENTIONS the canned phrase but is longer is NOT intercepted', () => {
    // Substring guard — only EXACT full-text matches are rewritten.
    // A real reply discussing the canned-string leak itself must
    // survive the sanitizer.
    const txt = 'The model sometimes leaks the literal string "No response requested." — that is the bug.';
    const r = sanitizeAssistantReply(txt);
    assert.equal(r.replaced, false);
    assert.equal(r.text, txt);
  });
});

describe('sanitizeAssistantReply — defensive on bad inputs', () => {
  test('non-string input returns as-is with replaced:false', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      const r = sanitizeAssistantReply(v);
      assert.equal(r.replaced, false);
      assert.equal(r.text, v);
    }
  });

  test('empty string returns as-is (not a canned-string match)', () => {
    const r = sanitizeAssistantReply('');
    assert.equal(r.replaced, false);
  });

  test('whitespace-only string returns as-is', () => {
    const r = sanitizeAssistantReply('   \n  ');
    assert.equal(r.replaced, false);
  });
});

describe('CANNED_STRINGS — discipline against drift', () => {
  test('list stays narrow (≤5 entries — every entry must be a real production leak)', () => {
    assert.ok(CANNED_STRINGS.size <= 5,
      `CANNED_STRINGS has ${CANNED_STRINGS.size} entries — adding more without a documented production trace risks intercepting legitimate replies`);
  });

  test('explicitly does NOT include polygram-side legitimate strings', () => {
    assert.ok(!CANNED_STRINGS.has('No response generated. Please try again.'),
      'R10 empty-turn fallback must not be in the canned-strings set');
    assert.ok(!CANNED_STRINGS.has('Stopped.'),
      '/stop confirmation must not be in the canned-strings set');
  });
});
