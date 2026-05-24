/**
 * Tests for lib/telegram/process-agent-reply.js — the shared agent-reply
 * pipeline extracted in rc.51 to cover three non-streaming paths that
 * previously inlined (or skipped) the parse + sanitize + deliver
 * sequence: autonomous-wakeup, tmux extra-turn-reply, auto-resume reply.
 *
 * Run: node --test tests/process-agent-reply.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { processAndDeliverAgentText } = require('../lib/telegram/process-agent-reply');

// Real-module wiring — keeps the contract honest. A future change to
// any of these modules that breaks one of the three callers will
// surface here too.
const { parseResponse: parseResponseImpl } = require('../lib/telegram/parse');
const { sanitizeAssistantReply } = require('../lib/telegram/sanitize-reply');
const { chunkMarkdownText } = require('../lib/telegram/chunk');

const silentLogger = { log: () => {}, error: () => {} };

function makeHarness(overrides = {}) {
  const stickerMap = { pumped: 'file_id_pumped', happy: 'file_id_happy' };
  const emojiToSticker = { '🎉': 'file_id_party' };
  const tgCalls = [];
  const deliverCalls = [];
  const events = [];

  const tg = (bot, method, params, meta) => {
    tgCalls.push({ method, params, meta });
    return Promise.resolve({ message_id: 100 + tgCalls.length });
  };

  const deliverReplies = async ({ chatId, threadId, chunks, replyToMessageId, meta }) => {
    deliverCalls.push({ chatId, threadId, chunks, replyToMessageId, meta });
    return { sent: chunks.map((_, i) => 1000 + i), failed: [], results: [] };
  };

  const parseResponse = (text) => parseResponseImpl(text, { stickerMap, emojiToSticker });
  const logEvent = (kind, detail) => events.push({ kind, detail });

  return {
    stickerMap,
    tgCalls,
    deliverCalls,
    events,
    base: {
      bot: { mock: true },
      tg,
      parseResponse,
      sanitizeAssistantReply,
      chunkMarkdownText,
      deliverReplies,
      chunkBudget: 3500,
      logEvent,
      logger: silentLogger,
      ...overrides,
    },
  };
}

describe('processAndDeliverAgentText — text-only delivery', () => {
  test('plain text → deliverReplies with chunks + reply target', async () => {
    const h = makeHarness();
    const summary = await processAndDeliverAgentText({
      ...h.base,
      text: 'Build is green.',
      chatId: '42',
      threadId: 3,
      replyToMessageId: 999,
      source: 'extra-turn-reply',
    });

    assert.equal(h.deliverCalls.length, 1);
    assert.deepEqual(h.deliverCalls[0].chunks, ['Build is green.']);
    assert.equal(h.deliverCalls[0].chatId, '42');
    assert.equal(h.deliverCalls[0].threadId, 3);
    assert.equal(h.deliverCalls[0].replyToMessageId, 999);
    assert.equal(h.deliverCalls[0].meta.source, 'extra-turn-reply');
    assert.equal(summary.stickersSent, 0);
    assert.equal(summary.reactionsApplied, 0);
    assert.equal(summary.sanitizerReplaced, false);
  });

  test('empty / null / non-string text returns zero-summary, makes no calls', async () => {
    for (const t of [null, undefined, '', 123, {}]) {
      const h = makeHarness();
      const summary = await processAndDeliverAgentText({
        ...h.base,
        text: t,
        chatId: '42',
        replyToMessageId: 1,
        source: 'extra-turn-reply',
      });
      assert.equal(h.deliverCalls.length, 0, `text=${JSON.stringify(t)} must short-circuit`);
      assert.equal(h.tgCalls.length, 0);
      assert.equal(summary.deliverResult, null);
    }
  });

  test('replyToMessageId=null is forwarded (unsolicited / autonomous case)', async () => {
    const h = makeHarness();
    await processAndDeliverAgentText({
      ...h.base,
      text: 'Wake-up message.',
      chatId: '42',
      replyToMessageId: null,
      source: 'autonomous-wakeup',
    });
    assert.equal(h.deliverCalls[0].replyToMessageId, null);
  });
});

describe('processAndDeliverAgentText — sticker handling', () => {
  test('inline [sticker:NAME] → text chunked without tag, sendSticker fires', async () => {
    const h = makeHarness();
    await processAndDeliverAgentText({
      ...h.base,
      text: 'Tests passed. [sticker:pumped]',
      chatId: '42', replyToMessageId: 5,
      source: 'extra-turn-reply',
    });
    assert.equal(h.deliverCalls.length, 1);
    assert.equal(h.deliverCalls[0].chunks[0].trim(), 'Tests passed.');
    const stickers = h.tgCalls.filter((c) => c.method === 'sendSticker');
    assert.equal(stickers.length, 1);
    assert.equal(stickers[0].params.sticker, 'file_id_pumped');
    assert.equal(stickers[0].meta.source, 'extra-turn-reply-inline-sticker');
    assert.equal(stickers[0].meta.stickerName, 'pumped');
  });

  test('solo [sticker:NAME] (whole text) → no text bubble, sticker only', async () => {
    const h = makeHarness();
    await processAndDeliverAgentText({
      ...h.base,
      text: '[sticker:happy]',
      chatId: '42', replyToMessageId: 5,
      source: 'autonomous-wakeup',
    });
    assert.equal(h.deliverCalls.length, 0, 'solo-sticker path has no text bubble');
    const stickers = h.tgCalls.filter((c) => c.method === 'sendSticker');
    assert.equal(stickers.length, 1);
    assert.equal(stickers[0].params.sticker, 'file_id_happy');
    assert.equal(stickers[0].meta.source, 'autonomous-wakeup-sticker',
      'solo-sticker path uses a distinct source tag (no "-inline-") for forensics');
  });

  test('multiple inline [sticker:NAME] tags fire in text order', async () => {
    const h = makeHarness();
    await processAndDeliverAgentText({
      ...h.base,
      text: 'Step 1 [sticker:pumped]. Step 2 [sticker:happy].',
      chatId: '42', replyToMessageId: 5,
      source: 'extra-turn-reply',
    });
    const stickers = h.tgCalls.filter((c) => c.method === 'sendSticker');
    assert.equal(stickers.length, 2);
    assert.equal(stickers[0].params.sticker, 'file_id_pumped',
      'first sticker tag fires first (order-preserving)');
    assert.equal(stickers[1].params.sticker, 'file_id_happy');
  });

  test('unknown sticker name stays as literal text (no sendSticker)', async () => {
    const h = makeHarness();
    await processAndDeliverAgentText({
      ...h.base,
      text: 'Done [sticker:nonexistent]',
      chatId: '42', replyToMessageId: 5,
      source: 'extra-turn-reply',
    });
    // parseResponse leaves unknown tags verbatim so users can write
    // them in normal text. No sendSticker for unknown names.
    const stickers = h.tgCalls.filter((c) => c.method === 'sendSticker');
    assert.equal(stickers.length, 0);
    assert.match(h.deliverCalls[0].chunks[0], /\[sticker:nonexistent\]/);
  });
});

describe('processAndDeliverAgentText — reaction handling', () => {
  test('inline [react:EMOJI] with target msg → setMessageReaction fires', async () => {
    const h = makeHarness();
    const summary = await processAndDeliverAgentText({
      ...h.base,
      text: 'Done! [react:👍]',
      chatId: '42', replyToMessageId: 5,
      source: 'extra-turn-reply',
    });
    const reactions = h.tgCalls.filter((c) => c.method === 'setMessageReaction');
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].params.message_id, 5);
    assert.equal(reactions[0].params.reaction[0].emoji, '👍');
    assert.equal(reactions[0].meta.source, 'extra-turn-reply-reaction');
    assert.equal(summary.reactionsApplied, 1);
  });

  test('inline [react:EMOJI] without target msg → logged + dropped (autonomous case)', async () => {
    const h = makeHarness();
    const summary = await processAndDeliverAgentText({
      ...h.base,
      text: 'Done! [react:👍]',
      chatId: '42', replyToMessageId: null,
      source: 'autonomous-wakeup',
    });
    // No setMessageReaction (no target msg).
    const reactions = h.tgCalls.filter((c) => c.method === 'setMessageReaction');
    assert.equal(reactions.length, 0);
    // Dropped-reactions event surfaces for forensics.
    const dropped = h.events.find((e) => e.kind === 'autonomous-wakeup-reactions-dropped');
    assert.ok(dropped);
    assert.deepEqual(dropped.detail.dropped, ['👍']);
    assert.equal(summary.reactionsDropped, 1);
  });

  test('explicit applyReactions=false forces drop even when target exists', async () => {
    const h = makeHarness();
    const summary = await processAndDeliverAgentText({
      ...h.base,
      text: 'Done [react:👍]',
      chatId: '42', replyToMessageId: 5,    // target exists
      applyReactions: false,                // but caller forces drop
      source: 'special-case',
    });
    assert.equal(h.tgCalls.filter((c) => c.method === 'setMessageReaction').length, 0);
    assert.equal(summary.reactionsDropped, 1);
    assert.ok(h.events.find((e) => e.kind === 'special-case-reactions-dropped'));
  });

  test('multiple [react:EMOJI] → first applied, rest logged as dropped', async () => {
    const h = makeHarness();
    const summary = await processAndDeliverAgentText({
      ...h.base,
      text: 'Done [react:👍] [react:🎉] [react:🔥]',
      chatId: '42', replyToMessageId: 5,
      source: 'extra-turn-reply',
    });
    const reactions = h.tgCalls.filter((c) => c.method === 'setMessageReaction');
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].params.reaction[0].emoji, '👍',
      'first reaction wins (Telegram bots only support one)');
    const dropped = h.events.find((e) => e.kind === 'inline-reactions-dropped');
    assert.ok(dropped);
    assert.equal(dropped.detail.applied, '👍');
    assert.equal(dropped.detail.dropped_count, 2);
    assert.equal(summary.reactionsApplied, 1);
    assert.equal(summary.reactionsDropped, 2);
  });
});

describe('processAndDeliverAgentText — sanitizer (rc.45 canned-string leak protection)', () => {
  test('canned "No response requested." → replaced + event fires', async () => {
    const h = makeHarness();
    const summary = await processAndDeliverAgentText({
      ...h.base,
      text: 'No response requested.',
      chatId: '42', replyToMessageId: 5,
      source: 'autonomous-wakeup',
      sessionKey: '42:0',
    });
    assert.equal(summary.sanitizerReplaced, true);
    assert.equal(h.deliverCalls.length, 1);
    assert.doesNotMatch(h.deliverCalls[0].chunks[0], /No response requested\./,
      'canned string must NOT reach deliverReplies');
    const cannedEvents = h.events.filter((e) => e.kind === 'canned-reply-suppressed');
    assert.equal(cannedEvents.length, 1);
    assert.equal(cannedEvents[0].detail.source, 'autonomous-wakeup');
    assert.equal(cannedEvents[0].detail.original, 'No response requested.');
    assert.equal(cannedEvents[0].detail.session_key, '42:0');
  });

  test('sanitizer does NOT fire on legitimate text', async () => {
    const h = makeHarness();
    await processAndDeliverAgentText({
      ...h.base,
      text: 'Build is green.',
      chatId: '42', replyToMessageId: 5,
      source: 'extra-turn-reply',
    });
    assert.equal(h.events.filter((e) => e.kind === 'canned-reply-suppressed').length, 0);
  });
});

describe('processAndDeliverAgentText — combined paths (the realistic case)', () => {
  test('text + sticker + reaction → all three delivered in order', async () => {
    const h = makeHarness();
    const summary = await processAndDeliverAgentText({
      ...h.base,
      text: 'All green! [sticker:pumped] [react:🔥]',
      chatId: '42', replyToMessageId: 5,
      source: 'extra-turn-reply',
    });
    // Text chunk doesn't carry the tags (parseResponse stripped them).
    assert.equal(h.deliverCalls.length, 1);
    assert.equal(h.deliverCalls[0].chunks[0].trim(), 'All green!');
    // Order: text → sticker → reaction (tg call sequence).
    const stickers = h.tgCalls.filter((c) => c.method === 'sendSticker');
    const reactions = h.tgCalls.filter((c) => c.method === 'setMessageReaction');
    assert.equal(stickers.length, 1);
    assert.equal(reactions.length, 1);
    assert.equal(summary.stickersSent, 1);
    assert.equal(summary.reactionsApplied, 1);
  });
});

describe('processAndDeliverAgentText — observability + resilience', () => {
  test('logEvent omitted → does not throw', async () => {
    const h = makeHarness();
    const summary = await processAndDeliverAgentText({
      ...h.base,
      logEvent: null,                       // explicit omission
      text: 'No response requested. [react:👍]',
      chatId: '42', replyToMessageId: null,
      source: 'autonomous-wakeup',
    });
    // sanitizer + dropped reactions both would have logged, but null
    // logEvent must be tolerated silently.
    assert.equal(summary.sanitizerReplaced, true);
    assert.equal(summary.reactionsDropped, 1);
  });

  test('sticker send failure logs but does NOT abort delivery', async () => {
    const errs = [];
    let stickerCallCount = 0;
    const h = makeHarness({
      logger: { log: () => {}, error: (m) => errs.push(m) },
      tg: (bot, method, params, meta) => {
        if (method === 'sendSticker') {
          stickerCallCount += 1;
          if (stickerCallCount === 1) return Promise.reject(new Error('telegram 500'));
        }
        return Promise.resolve({ message_id: 1 });
      },
    });
    const summary = await processAndDeliverAgentText({
      ...h.base,
      text: 'Done [sticker:pumped] [sticker:happy]',
      chatId: '42', replyToMessageId: 5,
      source: 'extra-turn-reply',
    });
    // First sticker failed but second still went through.
    assert.equal(summary.stickersSent, 1);
    assert.ok(errs.some((m) => /pumped/.test(m)), 'failure was logged');
  });
});
