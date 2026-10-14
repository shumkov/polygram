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
