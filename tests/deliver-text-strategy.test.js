'use strict';

/**
 * The `deliverText` seam: an optional strategy that replaces ONE step of the
 * shared agent-reply pipeline — chunk + deliverReplies — and nothing else.
 *
 * The seam exists because branching outside the pipeline is where the bugs are:
 * secret redaction would run twice (firing the fail-loud no-match event on
 * every successful redaction), or sticker/reaction handling would be skipped
 * entirely. So these tests care most about ORDER and ONCE-NESS, and about the
 * default path staying exactly as it was for every caller that passes nothing.
 *
 * Run: node --test tests/deliver-text-strategy.test.js
 */

const test = require('node:test');
const { describe } = require('node:test');
const assert = require('node:assert/strict');

const { processAndDeliverAgentText } = require('../lib/telegram/process-agent-reply');
const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');
const { parseResponse } = require('../lib/telegram/parse');
const { sanitizeAssistantReply } = require('../lib/telegram/sanitize-reply');
const { chunkMarkdownText } = require('../lib/telegram/chunk');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

function pipelineHarness({ deliverText = null, redactInbound = null } = {}) {
  const order = [];
  const delivered = [];
  const tgCalls = [];
  const deliverReplies = async ({ chunks }) => {
    order.push('default-deliver');
    delivered.push([...chunks]);
    return { sent: chunks.map((_, i) => ({ message_id: 900 + i })), failed: [] };
  };
  const run = (text, extra = {}) => processAndDeliverAgentText({
    text,
    bot: {},
    tg: async (_b, method, params) => { order.push(`tg:${method}`); tgCalls.push({ method, params }); return { message_id: 1 }; },
    chatId: '5',
    threadId: null,
    replyToMessageId: 42,
    source: 'test',
    meta: { botName: 'testbot' },
    parseResponse: (t) => {
      order.push('parse');
      return parseResponse(t, { stickerMap: { wave: 'sticker-file-id' } });
    },
    sanitizeAssistantReply: (t) => { order.push('sanitize'); return sanitizeAssistantReply(t); },
    chunkMarkdownText,
    deliverReplies,
    logEvent: () => {},
    logger: quietLogger,
    redactInbound: redactInbound
      ? (...args) => { order.push('redact'); return redactInbound(...args); }
      : null,
    deliverText,
    ...extra,
  });
  return { run, order, delivered, tgCalls };
}

describe('deliverText seam', () => {
  test('no strategy: the default chunked path runs, unchanged', async () => {
    const h = pipelineHarness();
    const summary = await h.run('An ordinary reply.');
    assert.deepEqual(h.delivered, [['An ordinary reply.']]);
    assert.deepEqual(summary.deliverResult.sent, [{ message_id: 900 }]);
  });

  test('a claiming strategy replaces chunk+deliver entirely', async () => {
    const seen = [];
    const h = pipelineHarness({
      deliverText: async (args) => { seen.push(args); return { handled: true, sent: [77], failed: [] }; },
    });
    const summary = await h.run('An answer the caller already put on screen.');

    assert.deepEqual(h.delivered, [], 'the default deliverer must not also run');
    assert.deepEqual(summary.deliverResult, { sent: [77], failed: [] });
    assert.equal(seen.length, 1, 'exactly once per reply');
    assert.equal(seen[0].text, 'An answer the caller already put on screen.');
    assert.equal(seen[0].chatId, '5');
    assert.equal(seen[0].replyToMessageId, 42);
  });

  test('handled:false (and a strategy that returns nothing) falls through', async () => {
    for (const outcome of [{ handled: false }, undefined, null]) {
      const h = pipelineHarness({ deliverText: async () => outcome });
      await h.run('Fall through to chunks.');
      assert.deepEqual(h.delivered, [['Fall through to chunks.']]);
    }
  });

  test('the strategy runs AFTER parse/redact/sanitize and BEFORE stickers and reactions', async () => {
    let harnessRef;
    harnessRef = pipelineHarness({
      deliverText: async () => {
        harnessRef.order.push('strategy');
        return { handled: true, sent: [1], failed: [] };
      },
      redactInbound: () => ({ redacted: 1 }),
    });
    await harnessRef.run('Answer [redact:hunter2] here [sticker:wave] [react:👍]');

    const idx = (name) => harnessRef.order.indexOf(name);
    assert.ok(idx('parse') < idx('redact'), 'parse before redact');
    assert.ok(idx('redact') < idx('strategy'), 'the strategy must see redacted text');
    assert.ok(idx('sanitize') < idx('strategy'), 'the strategy must see sanitized text');
    assert.ok(idx('strategy') < idx('tg:sendSticker'), 'stickers land after the text');
    assert.ok(idx('strategy') < idx('tg:setMessageReaction'), 'reactions land after the text');
  });

  test('redaction still fires exactly once when the strategy claims the reply', async () => {
    let redactions = 0;
    const h = pipelineHarness({
      deliverText: async () => ({ handled: true, sent: [1], failed: [] }),
      redactInbound: () => { redactions += 1; return { redacted: 1 }; },
    });
    const summary = await h.run('Here is the token [redact:hunter2]');
    assert.equal(redactions, 1);
    assert.equal(summary.secretsRedacted, 1);
  });

  test('stickers and reactions are unaffected either way', async () => {
    for (const deliverText of [null, async () => ({ handled: true, sent: [1], failed: [] })]) {
      const h = pipelineHarness({ deliverText });
      const summary = await h.run('Done [sticker:wave] [react:👍]');
      assert.equal(summary.stickersSent, 1);
      assert.equal(summary.reactionsApplied, 1);
    }
  });
});

describe('dispatcher wiring', () => {
  function dispatcherHarness({ makeDeliverText = null } = {}) {
    const factoryArgs = [];
    const delivered = [];
    const dispatcher = createChannelsToolDispatcher({
      bot: {},
      send: async () => ({ message_id: 1 }),
      chunkText: chunkMarkdownText,
      deliverReplies: async ({ chunks }) => {
        delivered.push([...chunks]);
        return { sent: chunks.map((_, i) => ({ message_id: 500 + i })), failed: [] };
      },
      parseResponse,
      sanitizeAssistantReply,
      makeDeliverText: makeDeliverText
        ? (args) => { factoryArgs.push(args); return makeDeliverText(args); }
        : null,
      logger: quietLogger,
    });
    return { dispatcher, factoryArgs, delivered };
  }

  test('the factory receives the per-call context, including interim', async () => {
    const h = dispatcherHarness({ makeDeliverText: () => null });
    await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', threadId: '7', toolName: 'reply',
      text: 'hi there', sessionCwd: '/work', interim: true,
    });
    assert.deepEqual(h.factoryArgs, [{
      sessionKey: 'chat:1', sessionCwd: '/work', chatId: '1', threadId: '7', interim: true,
    }]);
  });

  test('interim defaults to false rather than undefined', async () => {
    const h = dispatcherHarness({ makeDeliverText: () => null });
    await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'hi there',
    });
    assert.equal(h.factoryArgs[0].interim, false);
  });

  test('a factory returning null leaves delivery on the default path', async () => {
    const h = dispatcherHarness({ makeDeliverText: () => null });
    const res = await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'plain reply',
    });
    assert.deepEqual(h.delivered, [['plain reply']]);
    assert.deepEqual(res, { ok: true, message_id: 500 });
  });

  test('a claiming strategy supplies the message_id the agent gets back', async () => {
    const h = dispatcherHarness({
      makeDeliverText: () => async () => ({ handled: true, sent: [4242], failed: [] }),
    });
    const res = await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'consumed by the preview',
    });
    assert.deepEqual(h.delivered, []);
    assert.deepEqual(res, { ok: true, message_id: 4242 });
  });

  test('a bubble the strategy delivered becomes editable by that session', async () => {
    // Ownership is what gates edit_message; without it the agent gets an id it
    // is then forbidden from using.
    const h = dispatcherHarness({
      makeDeliverText: () => async () => ({ handled: true, sent: [4242], failed: [] }),
    });
    await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'consumed by the preview',
    });
    const edit = await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'edit_message',
      messageId: 4242, text: 'a status update',
    });
    assert.deepEqual(edit, { ok: true, message_id: 4242 });
  });

  test('no factory at all: byte-identical to the pre-seam dispatcher', async () => {
    const h = dispatcherHarness();
    const res = await h.dispatcher({
      sessionKey: 'chat:1', chatId: '1', toolName: 'reply', text: 'plain reply',
    });
    assert.deepEqual(h.delivered, [['plain reply']]);
    assert.deepEqual(res, { ok: true, message_id: 500 });
  });

  test('the dispatcher never requires the delivery modules itself', () => {
    // rich-media.js requires this module; a direct require here would close a
    // cycle. Everything arrives by injection.
    const src = require('node:fs').readFileSync(
      require.resolve('../lib/process/channels-tool-dispatcher'), 'utf8',
    );
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of requires) {
      assert.ok(
        !/rich|live-preview|streamer/.test(r),
        `dispatcher must not require ${r} — inject it instead`,
      );
    }
  });
});
