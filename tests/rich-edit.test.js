/**
 * Tests for rich-message edits, capability/content fallbacks, and
 * transient-error propagation.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createRichEditor } = require('../lib/telegram/rich-edit');

function makeDeps(overrides = {}) {
  const events = [];
  const tgCalls = [];
  return {
    events, tgCalls,
    deps: {
      tg: async (bot, method, params, meta) => {
        tgCalls.push({ method, params, meta });
        if (overrides.tgError && tgCalls.length === 1) throw overrides.tgError;
        return { message_id: 42 };
      },
      botName: 'test-bot',
      logEvent: (kind, detail) => events.push({ kind, detail }),
      redactBotToken: (s) => (typeof s === 'string' ? s.replace(/bot\d+:[\w-]+/g, 'bot<redacted>') : s),
      isRichCapabilityError: overrides.isRichCapabilityError || (() => false),
      isRichContentError: overrides.isRichContentError || (() => false),
      getRichKnownUnsupported: () => overrides.richKnownUnsupported ?? false,
      setRichKnownUnsupported: overrides.setRichKnownUnsupported || (() => {}),
      getApiRoot: overrides.getApiRoot || (() => null),
    },
  };
}

const baseArgs = {
  bot: { fake: true },
  chatId: '12345',
  threadId: null,
  messageId: 99,
  blocks: [{ type: 'paragraph', text: 'hi' }],
  sourceText: 'hi',
};

describe('richEditMessageText — success path', () => {
  test('sends rich_message with the blocks, returns the API result', async () => {
    const m = makeDeps();
    const editor = createRichEditor(m.deps);
    const res = await editor(baseArgs);
    assert.deepEqual(res, { result: { message_id: 42 }, wentRich: true },
      'wentRich:true lets the caller (streamer.js) distinguish a genuine rich send from a fallback');
    assert.equal(m.tgCalls.length, 1);
    assert.equal(m.tgCalls[0].method, 'editMessageText');
    assert.deepEqual(m.tgCalls[0].params.rich_message, { blocks: baseArgs.blocks });
    assert.equal(m.tgCalls[0].params.text, undefined, 'success path must not send a text field');
  });

  test('threads sourceText through as meta.richSourceText (transcript, not sent to Telegram)', async () => {
    const m = makeDeps();
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    assert.equal(m.tgCalls[0].meta.richSourceText, 'hi');
    assert.equal(m.tgCalls[0].params.richSourceText, undefined, 'must not leak into the API params');
  });

  test('logs rich-message-sent with block/char counts, does not trip the latch', async () => {
    const m = makeDeps();
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    const ev = m.events.find((e) => e.kind === 'rich-message-sent');
    assert.ok(ev);
    assert.equal(ev.detail.block_count, 1);
    assert.equal(ev.detail.char_count, 2);
    assert.equal(ev.detail.streaming, true);
    assert.equal(m.events.some((e) => e.kind === 'rich-capability-latched'), false);
  });
});

describe('richEditMessageText — capability error → latch + plain fallback', () => {
  test('an already-latched editor skips the rich request and sends plain text directly', async () => {
    const m = makeDeps({ richKnownUnsupported: true });
    const editor = createRichEditor(m.deps);
    const res = await editor(baseArgs);
    assert.deepEqual(res, { result: { message_id: 42 }, wentRich: false });
    assert.equal(m.tgCalls.length, 1);
    assert.equal(m.tgCalls[0].params.text, baseArgs.sourceText);
    assert.equal(m.tgCalls[0].params.rich_message, undefined);
    assert.equal(m.events.length, 0, 'a known capability result must not be logged repeatedly');
  });

  test('trips the latch exactly once', async () => {
    let latched = 0;
    const m = makeDeps({
      tgError: new Error('method not found'),
      isRichCapabilityError: () => true,
      setRichKnownUnsupported: () => { latched++; },
    });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    assert.equal(latched, 1);
  });

  test('falls back to a plain editMessageText carrying the same sourceText', async () => {
    const m = makeDeps({ tgError: new Error('method not found'), isRichCapabilityError: () => true });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    assert.equal(m.tgCalls.length, 2, 'rich attempt + plain fallback');
    const fallback = m.tgCalls[1];
    assert.equal(fallback.method, 'editMessageText');
    assert.equal(fallback.params.text, baseArgs.sourceText, 'fallback must send sourceText, not blocks or undefined');
    assert.equal(fallback.params.rich_message, undefined);
  });

  test('fallback resolves successfully — the caller sees the reply as delivered, not lost', async () => {
    const m = makeDeps({ tgError: new Error('method not found'), isRichCapabilityError: () => true });
    const editor = createRichEditor(m.deps);
    const res = await editor(baseArgs);
    assert.deepEqual(res, { result: { message_id: 42 }, wentRich: false },
      'wentRich:false signals the caller must NOT treat this as a successful rich edit — see streamer.js currentRichJson handling');
  });

  test('logs rich-capability-latched with the redacted error and api_root', async () => {
    const m = makeDeps({
      tgError: new Error('Bad Request: bot123456:AAFakeTokenValue method not found'),
      isRichCapabilityError: () => true,
      getApiRoot: () => 'http://localhost:8082',
    });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    const ev = m.events.find((e) => e.kind === 'rich-capability-latched');
    assert.ok(ev);
    assert.equal(ev.detail.api_root, 'http://localhost:8082');
    assert.doesNotMatch(ev.detail.error, /AAFakeTokenValue/, 'bot token must be redacted before logging');
  });

  test('api_root falls back to "cloud" label when unset', async () => {
    const m = makeDeps({
      tgError: new Error('method not found'), isRichCapabilityError: () => true, getApiRoot: () => null,
    });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    const ev = m.events.find((e) => e.kind === 'rich-capability-latched');
    assert.equal(ev.detail.api_root, 'cloud');
  });

  test('apiRoot with embedded basic auth is stripped before logging', async () => {
    const { stripUrlCredentials } = require('../lib/error/net');
    const m = makeDeps({
      tgError: new Error('method not found'),
      isRichCapabilityError: () => true,
      getApiRoot: () => 'http://admin:s3cr3t@localhost:8082',
    });
    m.deps.stripUrlCreds = stripUrlCredentials; // wire the real util, not the identity default
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    const ev = m.events.find((e) => e.kind === 'rich-capability-latched');
    assert.equal(ev.detail.api_root, 'http://localhost:8082');
    assert.doesNotMatch(ev.detail.api_root, /s3cr3t/);
  });

  test('does NOT log rich-content-fallback for a capability error (mutually exclusive)', async () => {
    const m = makeDeps({ tgError: new Error('method not found'), isRichCapabilityError: () => true });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    assert.equal(m.events.some((e) => e.kind === 'rich-content-fallback'), false);
  });
});

describe('richEditMessageText — content error → plain fallback, NO latch', () => {
  test('does NOT trip the latch', async () => {
    let latched = 0;
    const m = makeDeps({
      tgError: new Error('RICH_MESSAGE_BLOCKS_TOO_MANY'),
      isRichContentError: () => true,
      setRichKnownUnsupported: () => { latched++; },
    });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    assert.equal(latched, 0, 'a content error is per-message, the next message may be fine — must not latch');
  });

  test('falls back to plain with the same sourceText', async () => {
    const m = makeDeps({ tgError: new Error('RICH_MESSAGE_BLOCKS_TOO_MANY'), isRichContentError: () => true });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    assert.equal(m.tgCalls[1].params.text, baseArgs.sourceText);
  });

  test('logs rich-content-fallback, not rich-capability-latched', async () => {
    const m = makeDeps({ tgError: new Error('RICH_MESSAGE_BLOCKS_TOO_MANY'), isRichContentError: () => true });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    assert.ok(m.events.find((e) => e.kind === 'rich-content-fallback'));
    assert.equal(m.events.some((e) => e.kind === 'rich-capability-latched'), false);
  });

  test('terminal content fallback rescues accepted photos after the plain text edit', async () => {
    const order = [];
    const m = makeDeps({
      tgError: new Error('RICH_MESSAGE_BLOCKS_TOO_MANY'),
      isRichContentError: () => true,
    });
    const originalTg = m.deps.tg;
    m.deps.tg = async (...args) => {
      const result = await originalTg(...args);
      order.push(args[1] === 'editMessageText' && args[2].rich_message ? 'rich' : 'plain');
      return result;
    };
    const mediaContext = {
      rescueBlocks: async () => { order.push('photo'); },
    };
    const editor = createRichEditor(m.deps);
    await editor({
      ...baseArgs,
      phase: 'final',
      mediaContext,
      blocks: [
        { type: 'paragraph', text: 'See the result.' },
        {
          type: 'photo',
          photo: { type: 'photo', media: { source: '/validated/result.png', fingerprint: 'fp' } },
          caption: { text: 'Result' },
        },
      ],
      sourceText: 'See the result.\n\n![Result](/validated/result.png)',
    });

    assert.deepEqual(order, ['plain', 'photo'],
      'the failed rich attempt is not recorded because it throws; plain text must land before rescue');
  });

  test('preview content fallback stays plain and does not start a rescue', async () => {
    const m = makeDeps({
      tgError: new Error('RICH_MESSAGE_BLOCKS_TOO_MANY'),
      isRichContentError: () => true,
    });
    let rescues = 0;
    const editor = createRichEditor(m.deps);
    await editor({
      ...baseArgs,
      phase: 'preview',
      mediaContext: { rescueBlocks: async () => { rescues += 1; } },
    });

    assert.equal(rescues, 0);
    assert.equal(m.tgCalls.length, 2, 'preview uses only the existing rich-then-plain fallback');
  });

  test('media-only terminal fallback deletes the placeholder before anchored rescue', async () => {
    const order = [];
    const m = makeDeps({
      tgError: new Error('RICH_MESSAGE_BLOCKS_TOO_MANY'),
      isRichContentError: () => true,
    });
    m.deps.sanitizeFallbackText = () => '';
    const mediaContext = {
      deletePlaceholder: async (messageId) => {
        order.push(`delete:${messageId}`);
        return true;
      },
      rescueBlocks: async (_blocks, opts) => {
        order.push(`photo:${opts.anchorFirst}`);
      },
    };
    const editor = createRichEditor(m.deps);
    const result = await editor({
      ...baseArgs,
      phase: 'final',
      hadReplyAnchor: true,
      mediaContext,
    });

    assert.deepEqual(order, ['delete:99', 'photo:true']);
    assert.equal(m.tgCalls.length, 1, 'an empty fallback never attempts editMessageText');
    assert.equal(result.bubbleRemoved, true);
  });

  test('a changed local file never reaches the rich API and terminally falls back before rescue', async () => {
    const m = makeDeps();
    let rescues = 0;
    const editor = createRichEditor(m.deps);
    const result = await editor({
      ...baseArgs,
      phase: 'final',
      mediaContext: {
        preflightMedia: () => ({ ok: false }),
        rescueBlocks: async () => { rescues += 1; },
      },
      blocks: [{
        type: 'photo',
        photo: {
          type: 'photo',
          media: { source: '/validated/result.png', fingerprint: 'old-fingerprint' },
        },
        caption: { text: 'Result' },
      }],
      sourceText: 'See the result.\n\n![Result](/validated/result.png)',
    });

    assert.equal(result.wentRich, false);
    assert.equal(m.tgCalls.length, 1, 'preflight rejection must skip the rich Telegram request');
    assert.equal(m.tgCalls[0].params.rich_message, undefined);
    assert.equal(m.tgCalls[0].params.text, 'See the result.\n\n![Result](/validated/result.png)');
    assert.equal(rescues, 1, 'terminal recovery still owns the one best-effort rescue pass');
    assert.ok(m.events.some((event) => event.kind === 'rich-content-fallback'));
  });
});

describe('richEditMessageText — transient error → rethrows, no fallback, no latch', () => {
  test('rethrows the original error unchanged', async () => {
    const err = new Error('Internal Server Error');
    const m = makeDeps({ tgError: err }); // neither classifier matches by default
    const editor = createRichEditor(m.deps);
    await assert.rejects(() => editor(baseArgs), /Internal Server Error/);
  });

  test('does NOT attempt a plain fallback (only ONE tg call, the failed rich one)', async () => {
    const m = makeDeps({ tgError: new Error('Internal Server Error') });
    const editor = createRichEditor(m.deps);
    await assert.rejects(() => editor(baseArgs));
    assert.equal(m.tgCalls.length, 1, 'a swallowed transient error would falsely tell the streamer the edit landed');
  });

  test('does not trip the latch', async () => {
    let latched = 0;
    const m = makeDeps({ tgError: new Error('ETIMEDOUT'), setRichKnownUnsupported: () => { latched++; } });
    const editor = createRichEditor(m.deps);
    await assert.rejects(() => editor(baseArgs));
    assert.equal(latched, 0);
  });

  test('logs telegram-edit-failed (existing plain-path event shape, not a rich-specific one)', async () => {
    const m = makeDeps({ tgError: new Error('Internal Server Error') });
    const editor = createRichEditor(m.deps);
    await assert.rejects(() => editor(baseArgs));
    assert.ok(m.events.find((e) => e.kind === 'telegram-edit-failed'));
    assert.equal(m.events.some((e) => e.kind === 'rich-content-fallback' || e.kind === 'rich-capability-latched'), false);
  });
});

describe('richEditMessageText — classifier precedence (mutual exclusivity)', () => {
  test('when a fake classifier configuration marks BOTH capability and content true, capability wins (checked first)', async () => {
    // Documents actual precedence — real classifiers in lib/telegram/rich.js
    // are mutually exclusive by construction, but this pins the editor's
    // own if/else-if ordering independent of that.
    let latched = 0;
    const m = makeDeps({
      tgError: new Error('ambiguous'),
      isRichCapabilityError: () => true,
      isRichContentError: () => true,
      setRichKnownUnsupported: () => { latched++; },
    });
    const editor = createRichEditor(m.deps);
    await editor(baseArgs);
    assert.equal(latched, 1);
    assert.equal(m.events.some((e) => e.kind === 'rich-content-fallback'), false);
  });
});
