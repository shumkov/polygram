'use strict';

/**
 * The delivery-strategy seam in the shared reply pipeline.
 *
 * The strategy had to go INSIDE processAndDeliverAgentText rather than
 * beside it. Branching outside would either run secret redaction twice —
 * firing the fail-loud "flagged but matched 0 rows" event on every
 * successful redact — or skip the sticker/reaction handling that lives
 * after delivery. So the ordering and once-ness assertions below are the
 * point of this file, not incidental detail.
 *
 * Assertions are on observable calls rather than a recorded sequence
 * snapshot: a snapshot passes for the wrong reason the moment anything
 * unrelated moves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { processAndDeliverAgentText } = require('../lib/telegram/process-agent-reply');

const quietLogger = { log: () => {}, error: () => {}, warn: () => {} };

function harness(overrides = {}) {
  const order = [];
  const deliverCalls = [];
  const tgCalls = [];

  const base = {
    bot: {},
    tg: async (_b, method, params) => {
      order.push(`tg:${method}`);
      tgCalls.push({ method, params });
      return { message_id: 1 };
    },
    chatId: '12345',
    threadId: null,
    source: 'test-source',
    parseResponse: (text) => {
      order.push('parse');
      const redactions = [];
      const cleaned = text.replace(/\[redact:(.+?)\]/g, (_m, s) => { redactions.push(s); return ''; });
      const stickers = [];
      const stripped = cleaned.replace(/\[sticker:([\w-]+)\]/g, (_m, n) => {
        stickers.push({ name: n, fileId: `file-${n}` });
        return '';
      });
      return {
        text: stripped.trim(), sticker: null, stickerLabel: null,
        stickers, reaction: null, reactions: [], redactions,
      };
    },
    sanitizeAssistantReply: (text) => {
      order.push('sanitize');
      return { text, replaced: false };
    },
    chunkMarkdownText: (text) => [text],
    deliverReplies: async ({ chunks }) => {
      order.push('deliverReplies');
      deliverCalls.push([...chunks]);
      return { sent: chunks.map((_, i) => ({ message_id: 10 + i })), failed: [], results: [] };
    },
    redactInbound: () => {
      order.push('redact');
      return { redacted: 1 };
    },
    logEvent: (kind) => order.push(`event:${kind}`),
    logger: quietLogger,
    ...overrides,
  };

  return { opts: base, order, deliverCalls, tgCalls };
}

// ─── Ordering and once-ness ────────────────────────────────────────────────

test('the strategy runs after redaction and sanitize, never before', async () => {
  const { opts, order } = harness();
  const seen = [];

  await processAndDeliverAgentText({
    ...opts,
    text: 'Secret is [redact:hunter2] — here it is.',
    deliverText: async ({ text }) => {
      order.push('strategy');
      seen.push(text);
      return { handled: true, sent: [{ message_id: 9 }], failed: [] };
    },
  });

  assert.ok(order.indexOf('redact') < order.indexOf('strategy'),
    `redaction must precede the strategy: ${order.join(' → ')}`);
  assert.ok(order.indexOf('sanitize') < order.indexOf('strategy'),
    `sanitize must precede the strategy: ${order.join(' → ')}`);
  assert.ok(!seen[0].includes('[redact:'),
    'the strategy receives cleaned text, not raw agent output');
});

test('a redaction fires exactly once when the strategy handles delivery', async () => {
  // Running the rich branch outside the pipeline would redact twice; the
  // second pass matches nothing and trips the fail-loud no-match event,
  // making every successful redaction look like a broken one.
  const { opts, order, deliverCalls } = harness();

  await processAndDeliverAgentText({
    ...opts,
    text: 'Found [redact:hunter2] in your message.',
    deliverText: async () => ({ handled: true, sent: [{ message_id: 9 }], failed: [] }),
  });

  assert.equal(order.filter(s => s === 'redact').length, 1);
  assert.ok(!order.includes('event:secret-redact-requested-no-match'),
    'the fail-loud no-match event must not fire on a successful redaction');
  assert.ok(order.includes('event:secret-redacted-by-agent'));
  // Without this the test also passes when the strategy is ignored entirely
  // and the chunked path does the delivering — i.e. it would go green against
  // the very code this guard exists to rule out.
  assert.deepEqual(deliverCalls, [], 'the strategy, not the chunked path, delivered');
});

test('the strategy receives the same meta the chunked path would have', async () => {
  // The strategy's transcript row is the only record of a rich reply, since
  // the send method is deliberately untracked. If turn/session correlation
  // stops reaching it, every rich reply becomes an orphan row that no soak
  // query can tie back to the turn that produced it.
  const { opts } = harness();
  let seen = null;

  await processAndDeliverAgentText({
    ...opts,
    text: 'body',
    meta: { sessionKey: 'sess-1', turnId: 'turn-1', botName: 'testbot' },
    deliverText: async ({ meta }) => {
      seen = meta;
      return { handled: true, sent: [{ message_id: 9 }], failed: [] };
    },
  });

  assert.equal(seen.turnId, 'turn-1');
  assert.equal(seen.sessionKey, 'sess-1');
  assert.equal(seen.botName, 'testbot');
  assert.equal(seen.source, 'test-source', 'source identifies the calling path in events');
});

test('the strategy is consulted once per reply', async () => {
  const { opts } = harness();
  let calls = 0;

  await processAndDeliverAgentText({
    ...opts,
    text: 'some text',
    deliverText: async () => { calls += 1; return { handled: true, sent: [], failed: [] }; },
  });

  assert.equal(calls, 1);
});

test('stickers still fire after a strategy-handled delivery', async () => {
  const { opts, order, tgCalls, deliverCalls } = harness();

  await processAndDeliverAgentText({
    ...opts,
    text: 'Nice work [sticker:pumped]',
    deliverText: async () => ({ handled: true, sent: [{ message_id: 9 }], failed: [] }),
  });

  assert.ok(tgCalls.some(c => c.method === 'sendSticker' && c.params.sticker === 'file-pumped'),
    `sticker must still be sent: ${order.join(' → ')}`);
  assert.deepEqual(deliverCalls, [], 'the strategy handled delivery');
});

test('reactions still fire after a strategy-handled delivery', async () => {
  const { opts, tgCalls, deliverCalls } = harness({
    parseResponse: (text) => ({
      text, sticker: null, stickerLabel: null, stickers: [],
      reaction: null, reactions: ['🔥'], redactions: [],
    }),
  });

  await processAndDeliverAgentText({
    ...opts,
    text: 'done',
    replyToMessageId: 42,
    deliverText: async () => ({ handled: true, sent: [{ message_id: 9 }], failed: [] }),
  });

  const react = tgCalls.find(c => c.method === 'setMessageReaction');
  assert.ok(react, 'reaction must still be applied');
  assert.equal(react.params.message_id, 42);
  assert.deepEqual(deliverCalls, [], 'the strategy handled delivery');
});

// ─── Fall-through and isolation ────────────────────────────────────────────

test('a declining strategy leaves the chunked path exactly as it was', async () => {
  const { opts, deliverCalls } = harness();

  const summary = await processAndDeliverAgentText({
    ...opts,
    text: 'plain body',
    deliverText: async () => ({ handled: false }),
  });

  assert.deepEqual(deliverCalls, [['plain body']]);
  assert.deepEqual(summary.deliverResult.sent, [{ message_id: 10 }]);
});

test('a declining strategy can rewrite the fallback body', async () => {
  const { opts, deliverCalls } = harness();

  await processAndDeliverAgentText({
    ...opts,
    text: 'raw ![cap](/abs/path.png) body',
    deliverText: async () => ({ handled: false, text: 'raw cap body' }),
  });

  assert.deepEqual(deliverCalls, [['raw cap body']]);
});

test('no strategy — chunk and deliver run exactly as before', async () => {
  const { opts, deliverCalls, order } = harness();

  await processAndDeliverAgentText({ ...opts, text: 'untouched body' });

  assert.deepEqual(deliverCalls, [['untouched body']]);
  assert.ok(!order.includes('strategy'));
});

test('a handled delivery does not also chunk-and-deliver', async () => {
  const { opts, deliverCalls } = harness();

  await processAndDeliverAgentText({
    ...opts,
    text: 'body',
    deliverText: async () => ({ handled: true, sent: [{ message_id: 9 }], failed: [] }),
  });

  assert.deepEqual(deliverCalls, [], 'double delivery would post the reply twice');
});

test('a throwing strategy falls back to chunked delivery', async () => {
  const { opts, deliverCalls, order } = harness();

  const summary = await processAndDeliverAgentText({
    ...opts,
    text: 'important body',
    deliverText: async () => { throw new Error('kaboom'); },
  });

  assert.deepEqual(deliverCalls, [['important body']], 'the reply must still land');
  assert.ok(summary.deliverResult, 'the caller sees a successful delivery');
  assert.ok(order.includes('event:deliver-strategy-error'), 'the failure is observable');
});

test('a body emptied by the strategy sends nothing rather than an empty message', async () => {
  // An uncaptioned image is the real case: stripping it leaves nothing to
  // say. Sending the empty string would trip the API's empty-text guard and
  // surface to the agent as a failed reply.
  const { opts, deliverCalls } = harness();

  const summary = await processAndDeliverAgentText({
    ...opts,
    text: '![](/abs/path.png)',
    deliverText: async () => ({ handled: false, text: '' }),
  });

  assert.deepEqual(deliverCalls, []);
  assert.equal(summary.deliverResult, null);
});
