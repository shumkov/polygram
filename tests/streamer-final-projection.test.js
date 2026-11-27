'use strict';

/**
 * The text a streamed bubble ends on is the finished projection, never the
 * stream-tick one.
 *
 * A stream tick may stop mid-construct, so its display projection cuts every
 * unreadable "![" fragment — the rest of a path may still be arriving. The
 * finished answer cannot be completed by anything, so cutting there only
 * delivers half a sentence: a consumed reply "Replaced vec![] with
 * Vec::new()" stayed on screen as "Replaced vec" while the transcript stored
 * the whole text. Two mechanisms carried it: the final plain edit went through
 * the tick projection, and when the last tick already equalled the final text
 * the streamer skipped the final edit altogether, leaving the cut tick up.
 *
 * These run the real chain: the streamer, polygram's live-text sanitizer, the
 * live-preview consume step, and the rich editor's plain fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createStreamer } = require('../lib/telegram/streamer');
const {
  createStreamerRegistry, createDeliverTextFactory, createLiveTextSanitizer,
} = require('../lib/telegram/live-preview');
const { createRichEditor } = require('../lib/telegram/rich-edit');
const { stripMediaMarkdown, projectStreamedText } = require('../lib/telegram/rich');
const { CASES, missing } = require('./fixtures/text-only-replies');

const quiet = { error() {}, warn() {}, log() {} };

// polygram.js's streamer glue, in shape: every plain send and edit goes
// through sanitizeLiveText, with the edit's phase passed along.
function streamOnScreen() {
  const sanitizer = createLiveTextSanitizer({ isRichEnabled: () => true });
  const screen = [];
  const streamer = createStreamer({
    send: async (payload) => {
      screen.push(sanitizer.sanitize(typeof payload === 'object' ? payload.plainText : payload));
      return { message_id: 41 };
    },
    edit: async (_id, payload, opts = {}) => { screen.push(sanitizer.sanitize(payload, opts)); },
    deleteMessage: async () => {},
    finalDisplayDiffers: sanitizer.finalDisplayDiffers,
    minChars: 1, throttleMs: 0, maxLen: 4096, logger: quiet,
  });
  return { streamer, screen };
}

async function streamThenConsume(full) {
  const { streamer, screen } = streamOnScreen();
  for (let i = 8; i < full.length; i += 7) {
    await streamer.onChunk(full.slice(0, i));
    await streamer.flushDraft();
  }
  await streamer.onChunk(full);
  await streamer.flushDraft();

  const registry = createStreamerRegistry();
  registry.register('sess-final', { streamer, chatId: '1', deliveredTexts: [], getTurnId: () => null });
  const out = await createDeliverTextFactory({
    registry, logEvent: () => {}, persistBubbleText: () => {}, logger: quiet, botName: 'test',
    projectConsumedText: (text) => stripMediaMarkdown(text),
  })({ sessionKey: 'sess-final', chatId: '1', threadId: null, interim: false, turnId: null })({ text: full });
  return { out, screen };
}

test('every text-only reply a live preview consumes ends whole on screen', async () => {
  const failures = [];
  for (const [name, text] of CASES) {
    const { out, screen } = await streamThenConsume(text);
    const cut = missing(text, screen[screen.length - 1] || '');
    if (!out.handled || cut.length) failures.push(`${name}: handled=${out.handled} cut=${JSON.stringify(cut)}`);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('a stream tick is still cut mid-construct, so a path still arriving never shows', async () => {
  const { streamer, screen } = streamOnScreen();
  await streamer.onChunk('Here it is ![shot](/Users/me/secret/pa');
  await streamer.flushDraft();
  assert.ok(screen.length > 0);
  for (const frame of screen) assert.ok(!frame.includes('/Users/me'), frame);
});

test('the final edit is skipped when the finished text shows exactly what the tick showed', async () => {
  // Forcing an edit with identical content costs a "message is not modified"
  // refusal, which the caller reads as a failed final edit.
  const { streamer, screen } = streamOnScreen();
  await streamer.onChunk('Plain words, nothing special here.');
  await streamer.flushDraft();
  const frames = screen.length;
  const fin = await streamer.finalize('Plain words, nothing special here.');
  assert.equal(fin.finalEditOk, true);
  assert.equal(screen.length, frames, 'no extra edit');
});

test('the rich editor\'s plain fallback projects by phase', async () => {
  // One editor serves stream ticks, the streamer's final rich edit, and the
  // edit tool. Only a tick may end mid-construct.
  const seen = [];
  const editor = createRichEditor({
    tg: async (_bot, method, params) => { seen.push(params.text); return { message_id: 5 }; },
    botName: 'test',
    logEvent: () => {},
    redactBotToken: (s) => s,
    isRichCapabilityError: () => false,
    isRichContentError: () => false,
    getRichKnownUnsupported: () => true,
    sanitizeFallbackText: projectStreamedText,
  });
  const text = 'Replaced vec![] with Vec::new() in src/lib.rs';
  await editor({ bot: {}, chatId: '1', messageId: 5, blocks: [], sourceText: text, phase: 'final' });
  await editor({ bot: {}, chatId: '1', messageId: 5, blocks: [], sourceText: text, phase: 'preview' });
  assert.equal(seen[0], text, 'a final edit is a finished text, kept whole');
  assert.equal(seen[1], 'Replaced vec', 'a tick keeps the mid-construct cut');
});

test('polygram wires the finished projection into every final edit', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
  assert.match(source, /createLiveTextSanitizer\(\{/, 'the live-text sanitizer is the shared one');
  assert.match(source, /finalDisplayDiffers: liveText\.finalDisplayDiffers/,
    'the streamer is told when the final text displays differently from the tick');
  assert.match(source, /edit: async \(messageId, payload, editOptions = \{\}\) =>/);
  assert.match(source, /text: sanitizeLiveText\(text, editOptions\)/, 'the plain edit passes its phase');
  assert.match(source, /sanitizeFallbackText: projectStreamedText/,
    'the rich editor (ticks, final rich edits, the edit tool) projects by phase');
  assert.doesNotMatch(source, /stripMediaMarkdown\(text, \{ partial: true \}\);\n\s*\/\/ An image-only chunk/,
    'no inline tick-only sanitizer is left behind');
});
