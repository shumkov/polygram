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

// ─── finalizing on a dead turn ──────────────────────────────────────
//
// When a turn dies (error, /stop, a deploy mid-stream) the caller finalizes
// with no final text. Passing '' REPLACED the drafted body — the user watched a
// partial answer appear and then get wiped by the very failure that was
// supposed to leave it standing, and with an error suffix they were left with
// a bubble containing nothing but "⚠️ …". null keeps what was written.

test('finalize(null) keeps the drafted body instead of blanking the bubble', async () => {
  const edits = [];
  const streamer = createStreamer({
    send: async () => ({ message_id: 7 }),
    edit: async (_id, text) => { edits.push(text); },
    minChars: 5,
    logger: { error: () => {} },
  });

  await streamer.onChunk('Half of an answer the user was reading');
  const fin = await streamer.finalize(null);

  assert.equal(fin.finalText, 'Half of an answer the user was reading');
  assert.equal(fin.finalEditOk, true);
});

test('an error suffix APPENDS to the drafted body', async () => {
  const edits = [];
  const streamer = createStreamer({
    send: async () => ({ message_id: 7 }),
    edit: async (_id, text) => { edits.push(text); },
    minChars: 5,
    logger: { error: () => {} },
  });

  await streamer.onChunk('Half of an answer');
  const fin = await streamer.finalize(null, { errorSuffix: 'stream interrupted' });

  assert.equal(fin.finalText, 'Half of an answer\n\n⚠️ stream interrupted');
  assert.equal(edits.at(-1), 'Half of an answer\n\n⚠️ stream interrupted');
});

test('latestText exposes the newest draft, not just what is on screen', async () => {
  // A throttled edit may still be pending, so the bubble can lag the draft. A
  // caller reconciling at turn end needs the draft, not the stale bubble.
  const streamer = createStreamer({
    send: async () => ({ message_id: 7 }),
    edit: async () => {},
    minChars: 5,
    throttleMs: 100000,             // guarantees the follow-up edit stays pending
    logger: { error: () => {} },
  });

  await streamer.onChunk('First part');
  await streamer.onChunk('First part, second part');

  assert.equal(streamer.currentText, 'First part', 'the bubble still shows the first chunk');
  assert.equal(streamer.latestText, 'First part, second part');

  // The pending edit this test deliberately leaves queued is a live timer for
  // the full throttle window. Left armed it holds the event loop open until it
  // fires — draining it is this test's cleanup, not part of what it asserts.
  await streamer.flushDraft();
});
