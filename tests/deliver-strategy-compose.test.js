'use strict';

/**
 * Two features want the same delivery step, and neither may switch the other
 * off: the live preview (a reply consumes the bubble it was streaming into) and
 * rich rendering (a structured reply goes out as blocks).
 *
 * The four combinations that matter are consume/fallback × rich/plain, driven
 * here through the REAL live-preview and rich factories over a fake Telegram —
 * the composition is exactly where a wiring mistake silently disables one
 * feature, and where "it works in isolation" proves nothing.
 *
 * Run: node --test tests/deliver-strategy-compose.test.js
 */

const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');

const { composeDeliverTextFactories } = require('../lib/telegram/deliver-strategy');
const { createStreamer } = require('../lib/telegram/streamer');
const {
  createStreamerRegistry, createDeliverTextFactory,
} = require('../lib/telegram/live-preview');
const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');

const RICH_TABLE = 'Results:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
const PLAIN_PROSE = 'Just an ordinary sentence with no structure in it.';

function harness({ richEnabled = true, previewEnabled = true, maxLen = 4096 } = {}) {
  const tg = { nextId: 200, sent: [], edits: [], deleted: [] };
  const richSends = [];
  const streamer = createStreamer({
    send: async (text) => {
      const message_id = tg.nextId++;
      tg.sent.push({ message_id, text });
      return { message_id };
    },
    edit: async (msgId, text) => {
      if (msgId == null) throw new Error('message_id required');
      tg.edits.push({ msgId, text });
    },
    deleteMessage: async (id) => { tg.deleted.push(id); },
    minChars: 5,
    throttleMs: 0,
    maxLen,
    logger: { error: () => {}, warn: () => {} },
  });
  const registry = createStreamerRegistry();
  const deliveredTexts = [];
  if (previewEnabled) {
    registry.register('chat:1', { streamer, chatId: '1', deliveredTexts, getTurnId: () => null });
  }

  const makeDeliverText = composeDeliverTextFactories([
    createDeliverTextFactory({
      registry,
      logEvent: () => {},
      persistBubbleText: () => {},
      logger: { error: () => {} },
      botName: 'testbot',
    }),
    createRichDeliveryFactory({
      bot: {},
      sendRich: async ({ blocks, sourceText }) => {
        richSends.push({ blocks, sourceText });
        return { wentRich: true, result: { message_id: 999 } };
      },
      isRichTextEnabled: () => richEnabled,
      logger: { error: () => {} },
    }),
  ]);

  const deliver = (opts = {}) => makeDeliverText({
    sessionKey: 'chat:1', chatId: '1', threadId: null, interim: false, turnId: null, ...opts,
  });
  return { tg, streamer, richSends, deliver, deliveredTexts };
}

describe('live preview × rich, composed', () => {
  test('consume × rich content: the preview wins and rich never sends', async () => {
    // The preview bubble already renders rich through the streamer's own
    // toRichPayload, so consuming loses nothing — and a second rich send would
    // be the duplicate bubble this whole feature exists to prevent.
    const h = harness();
    await h.streamer.onChunk('Results so far');

    const out = await h.deliver()({ text: RICH_TABLE });

    assert.equal(out.handled, true);
    assert.deepEqual(out.sent, [200], 'the reply IS the preview bubble');
    assert.deepEqual(h.richSends, []);
    assert.equal(h.tg.sent.length, 1, 'exactly one bubble');
  });

  test('consume × plain content: still the preview, still one bubble', async () => {
    const h = harness();
    await h.streamer.onChunk('Composing a plain answer');

    const out = await h.deliver()({ text: PLAIN_PROSE });

    assert.equal(out.handled, true);
    assert.deepEqual(h.richSends, []);
    assert.equal(h.tg.sent.length, 1);
  });

  test('fallback × rich content: rich delivers it', async () => {
    // No preview is live (nothing streamed), so the preview strategy declines
    // and the reply must still get its structure.
    const h = harness();

    const out = await h.deliver()({ text: RICH_TABLE });

    assert.equal(out.handled, true, 'rich claimed the reply');
    assert.deepEqual(out.sent, [{ message_id: 999 }]);
    assert.equal(h.richSends.length, 1);
    assert.equal(h.tg.sent.length, 0, 'no preview bubble was involved');
  });

  test('fallback × plain content: both decline, the chunked path takes it', async () => {
    const h = harness();

    const out = await h.deliver()({ text: PLAIN_PROSE });

    assert.equal(out.handled, false);
    assert.deepEqual(h.richSends, [], 'prose is not rich-worthy');
  });

  test('a preview too small to consume still lets rich deliver', async () => {
    // The answer outgrew one bubble: the preview discards itself and declines,
    // and rich must still get first refusal on the whole body.
    const h = harness({ maxLen: 60 });
    await h.streamer.onChunk('A long answer starting here');

    const out = await h.deliver()({ text: `${RICH_TABLE}${'x'.repeat(200)}` });

    assert.deepEqual(h.tg.deleted, [200], 'the preview stump is gone');
    assert.equal(out.handled, true, 'rich picked up what the preview could not hold');
    assert.equal(h.richSends.length, 1);
  });

  test('an interim status goes to rich, never into the preview', async () => {
    const h = harness();
    await h.streamer.onChunk('The real answer is still being written');

    const out = await h.deliver({ interim: true })({ text: RICH_TABLE });

    assert.equal(out.handled, true, 'the status is delivered by rich');
    assert.equal(h.richSends.length, 1);
    assert.equal(h.tg.edits.length, 0, 'the live preview was not touched');
  });

  test('with rich off, the preview still consumes', async () => {
    const h = harness({ richEnabled: false });
    await h.streamer.onChunk('Composing');
    const out = await h.deliver()({ text: RICH_TABLE });
    assert.equal(out.handled, true);
    assert.deepEqual(h.richSends, []);
  });

  test('with previews off, rich still delivers', async () => {
    const h = harness({ previewEnabled: false });
    const out = await h.deliver()({ text: RICH_TABLE });
    assert.equal(out.handled, true);
    assert.equal(h.richSends.length, 1);
  });
});

describe('the chain itself', () => {
  test('a declining strategy\'s rewritten body reaches the next one, and the fallback', async () => {
    const seen = [];
    const make = composeDeliverTextFactories([
      () => async ({ text }) => { seen.push(text); return { handled: false, text: `${text} [projected]` }; },
      () => async ({ text }) => { seen.push(text); return { handled: false }; },
    ]);
    const out = await make({})({ text: 'body' });
    assert.deepEqual(seen, ['body', 'body [projected]']);
    assert.equal(out.text, 'body [projected]', 'the chunked path gets the projection');
  });

  test('the first claimer stops the chain', async () => {
    let secondRan = false;
    const make = composeDeliverTextFactories([
      () => async () => ({ handled: true, sent: [1], failed: [] }),
      () => async () => { secondRan = true; return { handled: true, sent: [2], failed: [] }; },
    ]);
    const out = await make({})({ text: 'body' });
    assert.deepEqual(out.sent, [1]);
    assert.equal(secondRan, false);
  });

  test('a factory that builds nothing is skipped, and an all-empty chain returns null', async () => {
    const make = composeDeliverTextFactories([
      () => null,
      () => async () => ({ handled: true, sent: [7], failed: [] }),
    ]);
    assert.deepEqual((await make({})({ text: 'x' })).sent, [7]);

    assert.equal(composeDeliverTextFactories([() => null])({}), null,
      'no strategy for this call → the pipeline delivers normally');
    assert.equal(composeDeliverTextFactories([]), null);
    assert.equal(composeDeliverTextFactories(null), null);
  });
});

describe('live preview × rich media', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {
    makeRichMediaResolver, createMediaPreflight,
  } = require('../lib/telegram/rich-media');

  const dirs = new Set();
  test.after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function workspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-compose-media-'));
    dirs.add(dir);
    const file = path.join(dir, 'chart.png');
    fs.writeFileSync(file, Buffer.alloc(64, 1));
    return { dir, file };
  }

  // The same two-strategy chain as above, with media wired into the rich half
  // the way polygram wires it.
  function mediaHarness({ previewEnabled = true } = {}) {
    const tg = { nextId: 300, sent: [], edits: [], deleted: [] };
    const richSends = [];
    const streamer = createStreamer({
      send: async (text) => {
        const message_id = tg.nextId++;
        tg.sent.push({ message_id, text });
        return { message_id };
      },
      edit: async (msgId, text) => {
        if (msgId == null) throw new Error('message_id required');
        tg.edits.push({ msgId, text });
      },
      deleteMessage: async (id) => { tg.deleted.push(id); },
      minChars: 5,
      throttleMs: 0,
      logger: { error: () => {}, warn: () => {} },
    });
    const registry = createStreamerRegistry();
    if (previewEnabled) {
      registry.register('chat:1', {
        streamer, chatId: '1', deliveredTexts: [], getTurnId: () => null,
      });
    }

    const makeDeliverText = composeDeliverTextFactories([
      createDeliverTextFactory({
        registry, logEvent: () => {}, persistBubbleText: () => {},
        logger: { error: () => {} }, botName: 'testbot',
      }),
      createRichDeliveryFactory({
        bot: {},
        sendRich: async ({ blocks }) => {
          richSends.push(blocks);
          return { wentRich: true, result: { message_id: 999 } };
        },
        isRichTextEnabled: () => true,
        logger: { error: () => {} },
        makeMediaWiring: ({ allowedRoots, chatId, threadId }) => ({
          resolveMedia: makeRichMediaResolver({
            allowedRoots, chatId, threadId, allowUrlMedia: false,
          }),
          mediaContext: createMediaPreflight({ allowedRoots }),
        }),
      }),
    ]);

    const deliver = (allowedRoots, opts = {}) => makeDeliverText({
      sessionKey: 'chat:1', chatId: '1', threadId: null,
      interim: false, turnId: null, allowedRoots, ...opts,
    });
    return { tg, streamer, richSends, deliver };
  }

  test('a live preview still consumes a media-bearing reply', async () => {
    // Media must not quietly switch the preview off: the bubble on screen is
    // this answer, and a second rich bubble below it would be a duplicate.
    const { dir, file } = workspace();
    const h = mediaHarness();
    await h.streamer.onChunk('Working on the chart');

    const out = await h.deliver([dir])({ text: `## Results\n\n![the chart](${file})` });

    assert.equal(out.handled, true);
    assert.deepEqual(out.sent, [300], 'the reply IS the preview bubble');
    assert.deepEqual(h.richSends, [], 'and rich did not send a second one');
  });

  test('what the preview declines still reaches rich WITH its media', async () => {
    // The composed order must not cost media on the fallback path: this is
    // the common shape (no preview live, or one too small to hold the answer).
    const { dir, file } = workspace();
    const h = mediaHarness({ previewEnabled: false });

    const out = await h.deliver([dir])({ text: `## Results\n\n![the chart](${file})` });

    assert.equal(out.handled, true);
    assert.equal(h.richSends.length, 1);
    const photo = h.richSends[0].find(b => b.type === 'photo');
    assert.ok(photo, `expected a photo block: ${JSON.stringify(h.richSends[0])}`);
    assert.equal(photo.photo.media.source, fs.realpathSync(file));
    assert.equal(h.tg.sent.length, 0, 'no preview bubble was involved');
  });

  test('an interim status with media goes to rich, never into the live preview', async () => {
    const { dir, file } = workspace();
    const h = mediaHarness();
    await h.streamer.onChunk('The real answer is still being written');

    const out = await h.deliver([dir], { interim: true })({
      text: `## Status\n\n![the chart](${file})`,
    });

    assert.equal(out.handled, true);
    assert.equal(h.richSends.length, 1);
    assert.ok(h.richSends[0].some(b => b.type === 'photo'));
    assert.equal(h.tg.edits.length, 0, 'the live preview was not touched');
  });
});
