/**
 * Tests for lib/telegram/streamer.js live-edit truncation.
 * Run: node --test tests/telegram-streamer.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamer } = require('../lib/telegram/streamer');

// A high surrogate not immediately followed by its low surrogate partner is
// unpaired — Telegram (and most renderers) show U+FFFD for it.
const hasLoneHighSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s);
const hasLoneLowSurrogate = (s) => /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test('truncateForLive never splits a surrogate pair at the maxLen boundary — odd alignment', async () => {
  // maxLen=21 puts the hard-cut offset (maxLen-3=18) one code unit inside a
  // surrogate pair for this odd-aligned run ('x' shifts every pair by one).
  let sentText = null;
  const streamer = createStreamer({
    send: async (text) => { sentText = text; return { message_id: 1 }; },
    edit: async () => {},
    maxLen: 21,
    minChars: 1,
  });

  await streamer.onChunk('x' + '😀'.repeat(20));

  assert.ok(sentText, 'the initial send should have fired');
  assert.ok(!hasLoneHighSurrogate(sentText), `truncated text has a lone high surrogate: ${JSON.stringify(sentText)}`);
  assert.ok(!hasLoneLowSurrogate(sentText), `truncated text has a lone low surrogate: ${JSON.stringify(sentText)}`);
});

test('truncateForLive leaves text under maxLen untouched', async () => {
  let sentText = null;
  const streamer = createStreamer({
    send: async (text) => { sentText = text; return { message_id: 1 }; },
    edit: async () => {},
    maxLen: 4096,
    minChars: 1,
  });

  const short = 'hello 😀 world';
  await streamer.onChunk(short);
  assert.equal(sentText, short);
});
