'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { send } = require('../lib/telegram/api');

test('frozen external-job destination never falls back to the chat root after topic deletion', async () => {
  const calls = [];
  const bot = { api: { raw: { sendMessage: async (params) => {
    calls.push({ ...params });
    if (params.message_thread_id) throw new Error('Bad Request: message thread not found');
    return { message_id: 123 };
  } } } };
  await assert.rejects(send({ bot, method: 'sendMessage', params: { chat_id: '-1001', message_thread_id: 22, text: 'Report' }, meta: { strictDestination: true, plainText: true }, logger: { error() {} } }), /thread not found/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message_thread_id, 22);
});

test('durable report delivery never retries a reset with an unknown send outcome', async () => {
  let sends = 0;
  const bot = { api: { raw: { sendMessage: async () => {
    sends++;
    const error = new Error('connection reset after request'); error.code = 'ECONNRESET'; throw error;
  } } } };
  await assert.rejects(send({ bot, method: 'sendMessage', params: { chat_id: '-1001', text: 'Report' }, meta: { durableDelivery: true, strictDestination: true, plainText: true }, logger: { error() {} } }), /reset/);
  assert.equal(sends, 1);
});

const { createReportDelivery, prepareReport } = require('../lib/external-jobs/delivery');
test('report adapter retains target and accepts only a concrete message receipt', async () => {
  const job = { target: { chatId: '-1001', threadId: 22, sessionKey: 'topic' }, turnId: 'turn' };
  let actual;
  const deliver = createReportDelivery({ botName: 'test', tg: async (...args) => { actual = args; return { message_id: 7 }; } });
  assert.equal((await deliver(job, { text: 'Report' })).messageId, 7);
  assert.equal(actual[2].message_thread_id, 22);
  assert.equal(actual[3].durableDelivery, true);
  for (const [error, retry] of [[Object.assign(new Error('rejected'), { error_code: 429 }), true], [Object.assign(new Error('reset'), { code: 'ECONNRESET' }), false]]) {
    const attempt = createReportDelivery({ tg: async () => { throw error; } });
    await assert.rejects(attempt(job, { text: 'Report' }), (e) => e.definitelyNotSent === retry);
  }
  const noReceipt = createReportDelivery({ tg: async () => ({}) });
  await assert.rejects(noReceipt(job, { text: 'Report' }), (e) => e.definitelyNotSent === false);
  assert.ok(prepareReport('Report '.repeat(1000)).every((part) => part.length <= 3500));
});

// A job report is the agent's final answer, written in the same markdown as a
// normal reply, so it must render the same way. Codex DM, 2026-11-24: a
// mailbox reply's job report arrived with literal **bold** markers and
// [ads](https://t.me/c/...) link syntax, while human-started turns in the same
// DM rendered. Nothing here depends on the backend: Claude CLI turns that end
// with text instead of the reply tool take this path too.
const REPORT = 'Done: **launch plan** is ready, see [ads](https://t.me/c/1234/56).';
const job = { target: { chatId: '-1001', threadId: 22, sessionKey: '-1001:22' }, turnId: 'turn' };
const viaRealSend = (bot) => async (b, method, params, meta) => send({ bot: b ?? bot, method, params, meta, logger: { error() {}, warn() {} } });

test('Codex job report shows raw markdown: a report part is converted to Telegram HTML like a normal reply', async () => {
  const calls = [];
  const bot = { api: { raw: { sendMessage: async (params) => { calls.push({ ...params }); return { message_id: 41, message_thread_id: 22 }; } } } };
  const deliver = createReportDelivery({ bot, botName: 'test', tg: viaRealSend(bot) });
  assert.equal((await deliver(job, { text: REPORT })).messageId, 41);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.match(calls[0].text, /<b>launch plan<\/b>/);
  assert.match(calls[0].text, /<a href="https:\/\/t\.me\/c\/1234\/56">ads<\/a>/);
  assert.doesNotMatch(calls[0].text, /\*\*/);
});

test('a report part Telegram refuses as HTML is sent once more as plain text, because the refusal proves nothing was sent', async () => {
  const calls = [];
  const bot = { api: { raw: { sendMessage: async (params) => {
    calls.push({ ...params });
    if (params.parse_mode) throw Object.assign(new Error("Bad Request: can't parse entities: unclosed tag"), { error_code: 400 });
    return { message_id: 42, message_thread_id: 22 };
  } } } };
  const deliver = createReportDelivery({ bot, botName: 'test', tg: viaRealSend(bot) });
  assert.equal((await deliver(job, { text: REPORT })).messageId, 42);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].parse_mode, undefined);
  assert.equal(calls[1].text, REPORT, 'the plain retry carries the agent\'s own text');
  assert.equal(calls[1].message_thread_id, 22, 'the retry keeps the frozen destination');
});

test('in a rich-enabled chat a report part goes rich, as a normal final reply does, and records where it landed', async () => {
  const tgCalls = [];
  const richCalls = [];
  const deliver = createReportDelivery({ botName: 'test', tg: async (...args) => { tgCalls.push(args); return { message_id: 1 }; },
    deliverRich: async (args) => { richCalls.push(args); return { handled: true, results: [{ message_id: 77, message_thread_id: 22 }] }; } });
  assert.deepEqual(await deliver(job, { text: REPORT }), { transport: 'telegram', chatId: '-1001', threadId: 22, messageId: 77 });
  assert.equal(tgCalls.length, 0);
  assert.equal(richCalls[0].text, REPORT);
  assert.deepEqual([richCalls[0].chatId, richCalls[0].threadId], ['-1001', 22]);
  assert.equal(richCalls[0].meta.strictDestination, true);
  const general = createReportDelivery({ botName: 'test', tg: async () => ({ message_id: 1 }),
    deliverRich: async () => ({ handled: true, results: [{ message_id: 78 }] }), logger: { warn() {} } });
  assert.equal((await general(job, { text: REPORT })).threadId, null, 'a rich send that a dropped topic put into General is recorded there, not in the topic');
});

test('a rich report that definitely did not land falls back to HTML; one that may have landed is never sent twice', async () => {
  const tgCalls = [];
  const declined = createReportDelivery({ botName: 'test', tg: async (...args) => { tgCalls.push(args); return { message_id: 9 }; },
    deliverRich: async () => ({ handled: false, text: 'stripped body' }) });
  assert.equal((await declined(job, { text: REPORT })).messageId, 9);
  assert.equal(tgCalls[0][2].text, 'stripped body', 'the HTML fallback sends the body the rich path prepared (media markdown stripped)');
  assert.notEqual(tgCalls[0][3].plainText, true, 'the fallback is formatted, not raw');
  for (const deliverRich of [async () => ({ handled: false, text: 'x', ambiguous: true }), async () => { throw new Error('boom'); }]) {
    const calls = [];
    const attempt = createReportDelivery({ botName: 'test', tg: async (...args) => { calls.push(args); return { message_id: 9 }; }, deliverRich });
    await assert.rejects(attempt(job, { text: REPORT }), (e) => e.definitelyNotSent === false, 'an unknown outcome stays unknown');
    assert.equal(calls.length, 0);
  }
});

test('a report part that is only a local image becomes a placeholder instead of an empty message that retries forever', async () => {
  const calls = [];
  const bot = { api: { raw: { sendMessage: async (params) => { calls.push({ ...params }); return { message_id: 43, message_thread_id: 22 }; } } } };
  const plain = createReportDelivery({ bot, botName: 'test', tg: viaRealSend(bot) });
  assert.equal((await plain(job, { text: '![](/Users/x/shot.png)' })).messageId, 43);
  assert.equal(calls[0].text, '(media unavailable)');
  assert.doesNotMatch(JSON.stringify(calls), /\/Users\/x/, 'a local path never reaches the chat');
  const richChat = createReportDelivery({ bot, botName: 'test', tg: viaRealSend(bot), deliverRich: async () => ({ handled: false, text: '' }) });
  assert.equal((await richChat(job, { text: '![](/Users/x/shot.png)' })).messageId, 43);
  assert.equal(calls[1].text, '(media unavailable)', 'the rich path\'s empty body is used, never the raw text with its path');
});

test('only an HTML refusal is retried as plain; any other 400 or a lost receipt is not', async () => {
  for (const [error, definitelyNotSent] of [
    [Object.assign(new Error('Bad Request: chat not found'), { error_code: 400 }), true],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), false],
  ]) {
    const calls = [];
    const bot = { api: { raw: { sendMessage: async (params) => { calls.push({ ...params }); throw error; } } } };
    const deliver = createReportDelivery({ bot, botName: 'test', tg: viaRealSend(bot) });
    await assert.rejects(deliver(job, { text: REPORT }), (e) => e.definitelyNotSent === definitelyNotSent);
    assert.equal(calls.length, 1, error.message);
  }
});

test('a chat that turned link previews off gets none under a report, as under a normal reply', async () => {
  const calls = [];
  const bot = { api: { raw: { sendMessage: async (params) => { calls.push({ ...params }); return { message_id: 44, message_thread_id: 22 }; } } } };
  const deliver = createReportDelivery({ bot, botName: 'test', tg: viaRealSend(bot), linkPreview: (chatId) => (chatId === '-1001' ? false : undefined) });
  await deliver(job, { text: REPORT });
  assert.deepEqual(calls[0].link_preview_options, { is_disabled: true });
  const rich = [];
  const richChat = createReportDelivery({ botName: 'test', tg: async () => ({ message_id: 1 }), linkPreview: () => false,
    deliverRich: async (args) => { rich.push(args); return { handled: true, results: [{ message_id: 2, message_thread_id: 22 }] }; } });
  await richChat(job, { text: REPORT });
  assert.equal(rich[0].meta.linkPreview, false);
});
