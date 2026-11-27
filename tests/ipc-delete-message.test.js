/**
 * IPC deleteMessage, on the sender's own messages only.
 *
 * agent-org removes its approval cards once they can no longer be approved
 * (a newer card, a cancelled post, an expired request). A caller may delete
 * only a message this bot recorded as sent through IPC by that same sender:
 * never a person's message, another role's or polygram's own replies. When
 * Telegram refuses (a bot deletes its own group messages only for 48 hours
 * unless it is an admin allowed to delete), the error says so plainly, and
 * agent-org edits the card instead.
 *
 * Run: node --test tests/ipc-delete-message.test.js
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHandleSendOverIpc, IPC_SEND_ALLOWED_METHODS } = require('../lib/handlers/ipc-send');

const OWN = { direction: 'out', bot_name: 'testbot', source: 'agent-org' };
function fixture({ rows = { 501: OWN }, fail = null } = {}) {
  const calls = [];
  const tg = async (_bot, method, params) => {
    calls.push({ method, params });
    if (fail) throw Object.assign(new Error(`Call to '${method}' failed! (400: ${fail})`), { description: fail, error_code: 400 });
    return true;
  };
  const handler = createHandleSendOverIpc({
    config: { chats: { '111': {} } }, bot: {}, tg, botName: 'testbot',
    getMessage: (chatId, msgId) => (chatId === '111' ? rows[msgId] ?? null : null),
  });
  return { handler, calls };
}
const del = (handler, params, source = 'agent-org') => handler({ method: 'deleteMessage', source, params });

describe('deleteMessage over IPC', () => {
  test('is an allowed method, and deletes a message this IPC sender sent', async () => {
    assert.ok(IPC_SEND_ALLOWED_METHODS.has('deleteMessage'));
    const { handler, calls } = fixture();
    await del(handler, { chat_id: '111', message_id: 501 });
    assert.deepEqual(calls, [{ method: 'deleteMessage', params: { chat_id: '111', message_id: 501 } }]);
  });

  test('never a person\'s message, another sender\'s, an agent reply, another bot\'s, or one not on file', async () => {
    const rows = {
      501: OWN,
      502: { ...OWN, direction: 'in' },
      503: { ...OWN, source: 'cron' },
      504: { ...OWN, source: 'bot-reply' },
      505: { ...OWN, bot_name: 'otherbot' },
    };
    const { handler, calls } = fixture({ rows });
    for (const id of [502, 503, 504, 505, 506]) {
      await assert.rejects(() => del(handler, { chat_id: '111', message_id: id }), /was not sent by this IPC sender/, String(id));
    }
    // The same message, asked for by another sender.
    await assert.rejects(() => del(handler, { chat_id: '111', message_id: 501 }, 'cron'), /was not sent by this IPC sender \(cron\)/);
    assert.equal(calls.length, 0);
  });

  test('the addressing rules of the edits hold: an owned chat, chat_id and message_id, no inline messages', async () => {
    const { handler } = fixture();
    await assert.rejects(() => del(handler, { chat_id: '222', message_id: 501 }), /chat not owned by testbot: 222/);
    await assert.rejects(() => del(handler, { message_id: 501 }), /requires chat_id/);
    await assert.rejects(() => del(handler, { chat_id: '111' }), /requires message_id/);
    await assert.rejects(() => del(handler, { chat_id: '111', message_id: 501, inline_message_id: 'x' }), /inline_message_id/);
  });

  test('Telegram\'s refusal comes back plainly, naming the 48-hour rule', async () => {
    const { handler } = fixture({ fail: 'Bad Request: message can\'t be deleted for everyone' });
    await assert.rejects(
      () => del(handler, { chat_id: '111', message_id: 501 }),
      /deleteMessage refused by Telegram \(message can't be deleted for everyone\): a bot deletes its own messages in a group only within 48 hours, unless it is an admin allowed to delete messages/,
    );
    const gone = fixture({ fail: 'Bad Request: message to delete not found' });
    await assert.rejects(() => del(gone.handler, { chat_id: '111', message_id: 501 }), /deleteMessage: message to delete not found/);
  });
});
