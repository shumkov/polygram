'use strict';

/**
 * sendRichMessage primitive.
 *
 * The contract that matters most here is negative: this thing NEVER throws
 * and never reports success it didn't get. Its caller owns a plain fallback,
 * so every failure has to come back as `wentRich: false` — a thrown error
 * would escape to the agent as `{ok:false}` with nothing delivered, which is
 * strictly worse than the flat rendering this feature exists to replace.
 * Error classification decides only whether to latch, never whether the user
 * gets the message.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRichSender } = require('../lib/telegram/rich-send');
const {
  isRichCapabilityError,
  isRichCapabilityErrorExplicit,
  isRichContentError,
} = require('../lib/telegram/rich');
const { stripUrlCredentials } = require('../lib/error/net');

const fakeBot = {};
const BLOCKS = [{ type: 'heading', level: 1, text: 'Title' }];

function makeSender(overrides = {}) {
  const events = [];
  const rows = [];
  const tgCalls = [];
  let latched = false;

  const deps = {
    tg: async (_bot, method, params, meta) => {
      tgCalls.push({ method, params, meta });
      return { message_id: 777, date: 1700000000 };
    },
    botName: 'testbot',
    logEvent: (kind, detail) => events.push({ kind, detail }),
    redactBotToken: (s) => String(s ?? '').replace(/bot\d+:[\w-]+/g, 'bot<redacted>'),
    isRichCapabilityError,
    isRichCapabilityErrorExplicit,
    isRichContentError,
    getRichKnownUnsupported: () => latched,
    setRichKnownUnsupported: () => { latched = true; },
    getApiRoot: () => 'http://localhost:8082',
    stripUrlCreds: (s) => s,
    insertSentRow: (row) => rows.push(row),
    logger: { error: () => {}, warn: () => {} },
    ...overrides,
  };

  return {
    sendRich: createRichSender(deps),
    events,
    rows,
    tgCalls,
    isLatched: () => latched,
  };
}

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

const baseArgs = {
  bot: fakeBot,
  chatId: '12345',
  threadId: null,
  blocks: BLOCKS,
  sourceText: '# Title',
  meta: { turnId: 'turn-1', sessionId: 'sess-1' },
};

// ─── Success ───────────────────────────────────────────────────────────────

test('success reports rich, records the row, and emits the send-transport event', async () => {
  const { sendRich, events, rows, tgCalls } = makeSender();

  const out = await sendRich({ ...baseArgs, threadId: '77', replyParams: { message_id: 55 } });

  assert.equal(out.wentRich, true);
  assert.equal(out.result.message_id, 777);

  assert.equal(tgCalls.length, 1);
  assert.equal(tgCalls[0].method, 'sendRichMessage');
  assert.deepEqual(tgCalls[0].params.rich_message, { blocks: BLOCKS });
  assert.equal(tgCalls[0].params.chat_id, '12345');
  assert.equal(tgCalls[0].params.message_thread_id, '77',
    'topic routing must survive — a dropped thread id mis-delivers every rich reply');
  assert.deepEqual(tgCalls[0].params.reply_parameters, { message_id: 55 });

  assert.equal(rows.length, 1, 'exactly one transcript row');
  assert.equal(rows[0].text, '# Title', 'row stores the source markdown, not the block tree');
  assert.equal(rows[0].msg_id, 777);
  assert.equal(rows[0].direction, 'out');
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].reply_to_id, 55);
  // api.js leaves this method untracked, so this row is the ONLY record of
  // the reply. Without turn/session correlation it is an orphan that no
  // soak query can tie back to the turn that produced it.
  assert.equal(rows[0].turn_id, 'turn-1');
  assert.equal(rows[0].session_id, 'sess-1');
  assert.equal(rows[0].bot_name, 'testbot');
  assert.equal(tgCalls[0].meta.richSourceText, '# Title',
    'the source markdown rides along for any tracked caller');

  const sent = events.find(e => e.kind === 'rich-message-sent');
  assert.ok(sent, 'rich-message-sent emitted');
  assert.equal(sent.detail.transport, 'send',
    'transport distinguishes this from the streamer edit path in the soak');
});

test('optional params are omitted rather than sent as null', async () => {
  const { sendRich, tgCalls } = makeSender();
  await sendRich(baseArgs);
  assert.ok(!('message_thread_id' in tgCalls[0].params));
  assert.ok(!('reply_parameters' in tgCalls[0].params));
});

// ─── Latch ─────────────────────────────────────────────────────────────────

test('a tripped latch short-circuits before any network call', async () => {
  const { sendRich, tgCalls, rows } = makeSender({ getRichKnownUnsupported: () => true });
  const out = await sendRich(baseArgs);
  assert.equal(out.wentRich, false);
  assert.equal(tgCalls.length, 0, 'no call attempted once the server is known unsupported');
  assert.equal(rows.length, 0);
});

test('an explicit rich_message rejection latches on first sight', async () => {
  const { sendRich, events, isLatched } = makeSender({
    tg: async () => { throw err('Bad Request: unknown field rich_message'); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, false);
  assert.equal(isLatched(), true, 'the server named the capability — one strike is enough');
  assert.ok(events.some(e => e.kind === 'rich-capability-latched'));
});

test('a bare 404 needs two consecutive strikes to latch', async () => {
  // A single 404 is also what a restarting bot-api server returns. Latching
  // on it would permanently downgrade the path carrying most agent output
  // until the daemon restarts — far too much damage for one blip.
  const { sendRich, isLatched, events } = makeSender({
    tg: async () => { throw err('Not Found', { error_code: 404 }); },
  });

  const first = await sendRich(baseArgs);
  assert.equal(first.wentRich, false);
  assert.equal(isLatched(), false, 'one 404 is a blip, not a verdict');
  assert.ok(!events.some(e => e.kind === 'rich-capability-latched'));

  const second = await sendRich(baseArgs);
  assert.equal(second.wentRich, false);
  assert.equal(isLatched(), true, 'two in a row is a capability verdict');
  assert.ok(events.some(e => e.kind === 'rich-capability-latched'));
});

test('a success between two 404s resets the strike count', async () => {
  let mode = 'fail';
  const { sendRich, isLatched } = makeSender({
    tg: async () => {
      if (mode === 'fail') throw err('Not Found', { error_code: 404 });
      return { message_id: 5 };
    },
  });

  await sendRich(baseArgs);
  mode = 'ok';
  await sendRich(baseArgs);
  mode = 'fail';
  await sendRich(baseArgs);

  assert.equal(isLatched(), false, 'the 404s were not consecutive — the endpoint demonstrably works');
});

// ─── Content + unknown errors ──────────────────────────────────────────────

test('a non-capability error between two 404s resets the strike count', async () => {
  // "Consecutive" is the whole justification for the two-strike rule. A
  // content error proves the endpoint is there and answering, so the run of
  // 404s is broken and the next one starts over.
  const errors = [
    err('Not Found', { error_code: 404 }),
    err('Bad Request: RICH_MESSAGE_TOO_LONG'),
    err('Not Found', { error_code: 404 }),
  ];
  let i = 0;
  const { sendRich, isLatched } = makeSender({
    tg: async () => { throw errors[i++]; },
  });

  await sendRich(baseArgs);
  await sendRich(baseArgs);
  await sendRich(baseArgs);

  assert.equal(isLatched(), false, 'the 404s were not consecutive');
});

test('apiRoot credentials never reach the latch event', async () => {
  // Latch events mark a fleet-wide capability outage, so they are the ones
  // most likely to be pasted into an issue.
  const { sendRich, events } = makeSender({
    tg: async () => { throw err('Bad Request: unknown field rich_message'); },
    getApiRoot: () => 'http://svc:hunter2@localhost:8082',
    stripUrlCreds: stripUrlCredentials,
  });

  await sendRich(baseArgs);

  const logged = JSON.stringify(events);
  assert.ok(logged.includes('rich-capability-latched'), 'the latch event fired');
  assert.ok(!logged.includes('hunter2'), `apiRoot credentials leaked: ${logged}`);
});

test('a content error falls back once without latching', async () => {
  const { sendRich, events, isLatched, rows } = makeSender({
    tg: async () => { throw err('Bad Request: RICH_MESSAGE_TOO_LONG'); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, false);
  assert.equal(isLatched(), false, 'this payload was bad, not the server');
  assert.ok(events.some(e => e.kind === 'rich-content-fallback'));
  assert.equal(rows.length, 0, 'a failed attempt leaves no transcript row to duplicate');
});

test('an unknown error degrades instead of propagating', async () => {
  const { sendRich, events, isLatched } = makeSender({
    tg: async () => { throw err('socket hang up', { code: 'ECONNRESET' }); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, false, 'the caller delivers plain — the reply is not lost');
  assert.equal(isLatched(), false);
  assert.ok(events.some(e => e.kind === 'rich-send-error'));
});

test('bot tokens never reach the event log', async () => {
  const { sendRich, events } = makeSender({
    tg: async () => {
      throw err('request to https://api.telegram.org/bot123456:AAHsecrettoken/sendRichMessage failed');
    },
  });

  await sendRich(baseArgs);

  const logged = JSON.stringify(events);
  assert.ok(!logged.includes('AAHsecrettoken'), `token leaked into events: ${logged}`);
  assert.ok(logged.includes('bot<redacted>'), 'the redacted marker is present');
});

test('a DB failure does not turn a delivered rich message into a failure', async () => {
  const { sendRich } = makeSender({
    insertSentRow: () => { throw new Error('database is locked'); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, true, 'Telegram delivery is the truth; the transcript is best-effort');
});

test('an unusable blocks payload is refused before any network call', async () => {
  // Not just the empty array: a non-array would reach the wire as
  // `rich_message: { blocks: undefined }`, which is a malformed request
  // rather than an honest decline.
  for (const blocks of [[], undefined, null, 'not-an-array', {}]) {
    const { sendRich, tgCalls, rows } = makeSender();
    const out = await sendRich({ ...baseArgs, blocks });
    assert.equal(out.wentRich, false, `blocks=${JSON.stringify(blocks)}`);
    assert.equal(tgCalls.length, 0, `blocks=${JSON.stringify(blocks)} reached the network`);
    assert.equal(rows.length, 0);
  }
});

test('a delivered message is never un-reported by bookkeeping that fails after it', async () => {
  // The caller treats a throw as "rich did not happen" and delivers the same
  // reply again as plain text. Anything after the send has landed must not
  // be able to cause that.
  const { sendRich, tgCalls } = makeSender({
    logEvent: () => { throw new Error('event sink exploded'); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(tgCalls.length, 1, 'the message was sent');
  assert.equal(out.wentRich, true, 'a delivered message must stay reported as delivered');
});

test('a response without a message id is a fallback, not a delivery', async () => {
  // The reply tool promises the agent an id it can edit. Without one there is
  // no ownership claim and no transcript row, so reporting success hands back
  // a contract the caller cannot honor; the plain path can.
  const { sendRich, rows, events } = makeSender({
    tg: async () => ({ date: 1 }),
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, false, 'the caller must fall back rather than report success');
  assert.equal(rows.length, 0, 'no row rather than one keyed on a placeholder id');
  const ev = events.find(e => e.kind === 'rich-content-fallback');
  assert.ok(ev, `expected a content-class fallback: ${JSON.stringify(events.map(e => e.kind))}`);
  assert.match(ev.detail.error, /message_id/);
});

test('sendRich never throws, whatever the failure', async () => {
  for (const thrown of [
    err('Not Found', { error_code: 404 }),
    err('Bad Request: RICH_MESSAGE_BAD_BLOCK'),
    err('unknown field rich_message'),
    err('ETIMEDOUT'),
    'a bare string rejection',
    null,
  ]) {
    const { sendRich } = makeSender({ tg: async () => { throw thrown; } });
    const out = await sendRich(baseArgs);
    assert.equal(out.wentRich, false, `threw for ${String(thrown)}`);
  }
});
