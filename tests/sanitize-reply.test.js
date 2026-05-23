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

  test('multi-bubble combined text — canned string as a substring still gets replaced (rc.45)', () => {
    // The rc.45 production trigger: claude split its reply into two
    // assistant-message blocks. The first was substantive ("Nothing
    // to stop."), the second was the canned `No response
    // requested.`. polygram concatenates them into combined text;
    // exact-match wouldn't fire. Substring replace does.
    const combined = 'Nothing to stop.\n\nNo response requested.';
    const r = sanitizeAssistantReply(combined);
    assert.equal(r.replaced, true,
      'combined text containing the canned phrase as a substring MUST be sanitized');
    assert.ok(r.text.includes('Nothing to stop.'),
      'substantive content before the canned string must survive');
    assert.ok(!r.text.includes('No response requested.'),
      'canned phrase must be removed from the output');
    assert.ok(r.text.includes(SANITIZED_REPLACEMENT),
      'replacement text must be present');
  });

  test('reply that MENTIONS the canned phrase WILL have the substring replaced (rc.45 trade-off)', () => {
    // Substring-replace's downside: a legitimate discussion of the
    // canned phrase has its inner mention rewritten. Cost is
    // cosmetic — the surrounding prose survives. The exact-match
    // approach failed in production (rc.39) because claude's
    // multi-bubble reply made an exact match impossible; substring
    // accepts this trade-off explicitly. Documented in the
    // sanitize-reply.js header.
    const txt = 'The model sometimes leaks the literal string "No response requested." — that is the bug.';
    const r = sanitizeAssistantReply(txt);
    assert.equal(r.replaced, true);
    assert.ok(r.text.includes('The model sometimes leaks'),
      'surrounding prose must survive');
    assert.ok(!r.text.includes('No response requested.'),
      'inner canned-phrase mention IS replaced (cost of the trade-off)');
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
