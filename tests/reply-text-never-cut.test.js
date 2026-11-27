'use strict';

/**
 * A text-only reply is delivered whole, on every delivery path.
 *
 * Two failures this pins, both found by sweeping ordinary agent output
 * through the reply tool's real wiring:
 *   - text cut: the media projection dropped everything after any "![" that
 *     did not parse as an image ("Replaced vec![] with …" arrived as
 *     "Replaced vec"), and rewrote image syntax inside code spans and table
 *     cells to its alt text;
 *   - false refusal: prose whose "![…](" destination merely started like a
 *     path ("Toggle ![x] (/settings/page)") was refused as an image.
 *
 * The wiring mirrors polygram.js: dispatcher → compose([live preview, rich
 * strategy with the real media wiring]) → chunked path with the chat's
 * fallback projection. Five paths: a rich message, a consumed live preview,
 * a server latched off rich, a reply past the rich length cap, and a chat
 * with rich text off.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');
const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');
const { createRichSender } = require('../lib/telegram/rich-send');
const { makeReplyMediaWiring } = require('../lib/telegram/rich-media');
const { composeDeliverTextFactories } = require('../lib/telegram/deliver-strategy');
const { createStreamer } = require('../lib/telegram/streamer');
const { createStreamerRegistry, createDeliverTextFactory } = require('../lib/telegram/live-preview');
const {
  stripMediaMarkdown, isRichCapabilityError, isRichCapabilityErrorExplicit, isRichContentError,
} = require('../lib/telegram/rich');

const quiet = { warn() {}, error() {}, log() {}, debug() {}, info() {} };
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-never-cut-'));
test.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

function build(mode) {
  const richEnabled = mode !== 'plainchat';
  const latched = mode === 'latched';
  const tgCalls = [];
  const chunks = [];
  const finalized = [];
  const send = async (_bot, method, params) => {
    tgCalls.push({ method, params });
    return { message_id: 700 + tgCalls.length, date: 1 };
  };
  const sendRich = createRichSender({
    tg: send, botName: 'probe', logEvent: () => {}, redactBotToken: (s) => s,
    isRichCapabilityError, isRichCapabilityErrorExplicit, isRichContentError,
    getRichKnownUnsupported: () => latched, setRichKnownUnsupported: () => {},
    makeInputFile: (source) => ({ upload: source }), logger: quiet,
  });
  const richFactory = createRichDeliveryFactory({
    bot: {}, sendRich,
    isRichTextEnabled: () => richEnabled,
    getRichKnownUnsupported: () => latched,
    logger: quiet,
    ...(mode === 'long' ? { richMaxLen: 30 } : {}),
    makeMediaWiring: makeReplyMediaWiring({}),
  });
  const registry = createStreamerRegistry();
  let streamer = null;
  if (mode === 'stream') {
    streamer = createStreamer({
      send: async () => ({ message_id: 500 }),
      edit: async () => {},
      deleteMessage: async () => {},
      minChars: 5, throttleMs: 0, maxLen: 4096, logger: quiet,
    });
    const real = streamer.finalize.bind(streamer);
    streamer.finalize = async (t) => { finalized.push(t); return real(t); };
    registry.register('sess-cut', { streamer, chatId: '1', deliveredTexts: [], getTurnId: () => null });
  }
  const dispatcher = createChannelsToolDispatcher({
    bot: {}, send,
    chunkText: (t) => [t],
    deliverReplies: async ({ chunks: c }) => {
      chunks.push(...c);
      return { sent: c.map((_, i) => ({ message_id: 900 + i })), failed: [], results: [] };
    },
    parseResponse: (text) => ({ text, sticker: null, stickerLabel: null, stickers: [], reaction: null, reactions: [] }),
    sanitizeAssistantReply: (text) => ({ text, replaced: false }),
    logger: quiet,
    // polygram.js's projections, in shape.
    projectFallbackText: (text) => {
      if (!richEnabled) return text;
      const stripped = stripMediaMarkdown(text);
      return stripped.trim() ? stripped : '(media unavailable)';
    },
    makeDeliverText: composeDeliverTextFactories([
      createDeliverTextFactory({
        registry, logEvent: () => {}, persistBubbleText: () => {}, logger: quiet, botName: 'probe',
        projectConsumedText: (text) => (richEnabled ? stripMediaMarkdown(text) : text),
      }),
      richFactory,
    ]),
  });
  return { dispatcher, tgCalls, chunks, finalized, streamer };
}

// Every string a delivery put on the wire.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (['chat_id', 'message_thread_id', 'parse_mode', 'reply_parameters', 'type'].includes(k)) continue;
      strings(x, out);
    }
  }
  return out;
}

async function deliver(mode, text) {
  const h = build(mode);
  if (mode === 'stream') await h.streamer.onChunk('Working on the answer now');
  const res = await h.dispatcher({
    sessionKey: 'sess-cut', chatId: '1', threadId: null, toolName: 'reply',
    text, files: null, sessionCwd: cwd,
  });
  const wire = [...h.tgCalls.flatMap((c) => strings(c.params)), ...h.chunks, ...h.finalized].join('\n');
  return { res, wire };
}

const { CASES, missing } = require('./fixtures/text-only-replies');

for (const mode of ['rich', 'stream', 'latched', 'long', 'plainchat']) {
  test(`every text-only reply arrives whole and ok — ${mode}`, async () => {
    const failures = [];
    for (const [name, text] of CASES) {
      const { res, wire } = await deliver(mode, text);
      const cut = missing(text, wire);
      if (!res.ok || cut.length) failures.push(`${name}: ok=${res.ok} cut=${JSON.stringify(cut)} ${res.error || ''}`);
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });
}

test('code spans and table cells reach the reader verbatim, image syntax included', async () => {
  for (const mode of ['rich', 'stream', 'latched', 'plainchat']) {
    const { wire } = await deliver(mode, 'Use `![alt](/abs/path.png)` to embed. ENDMARK');
    assert.ok(wire.includes('![alt](/abs/path.png)'), `${mode}: ${wire}`);
  }
});
