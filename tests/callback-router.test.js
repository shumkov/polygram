'use strict';

// The callback_query dispatcher decides which feature owns a button press.
// A press routed to the wrong handler is silently ignored by it, so the
// user's tap does nothing: every prefix must keep reaching its own handler.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCallbackQueryHandler, STALE_BUTTON } = require('../lib/handlers/callback-router');
const { isWellFormedCallbackQuery } = require('../lib/config');

const query = (data, extra = {}) => ({
  id: 'cbq-1', from: { id: 42 }, data,
  message: { chat: { id: -1001 }, message_id: 7 }, ...extra,
});

function fixture(routeOverrides = {}) {
  const calls = []; const events = []; const answers = []; const errors = [];
  const route = (name) => async () => { calls.push(name); };
  const routes = {
    config: route('config'), codexReconciliation: route('codexReconciliation'),
    question: route('question'), mailbox: route('mailbox'), approval: route('approval'),
    ...routeOverrides,
  };
  const handle = createCallbackQueryHandler({
    botName: 'test', isWellFormedCallbackQuery,
    logEvent: (kind, detail) => events.push({ kind, detail }),
    routes: () => routes,
    logger: { error: (line) => errors.push(line) },
  });
  const press = (callbackQuery) => handle({
    callbackQuery, update: { update_id: 9 },
    answerCallbackQuery: async (opts) => { answers.push(opts); },
  });
  return { press, calls, events, answers, errors };
}

test('each prefix reaches its own handler and anything else reaches the tool approval handler', async () => {
  const cases = [
    ['cfg:model:opus', 'config'], ['cxr:keep:1', 'codexReconciliation'], ['q:1:a', 'question'],
    ['mbx:go:m_1', 'mailbox'], ['approve:12:tok', 'approval'], ['anything', 'approval'],
  ];
  for (const [data, expected] of cases) {
    const f = fixture();
    await f.press(query(data));
    assert.deepEqual(f.calls, [expected], data);
  }
});

test('an inline-mode query is refused with the stale toast and reaches no handler', async () => {
  const f = fixture();
  const inline = query('approve:12:tok'); delete inline.message; inline.inline_message_id = 'AAAA';
  await f.press(inline);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.answers, [{ text: STALE_BUTTON }]);
  assert.equal(f.events[0].kind, 'malformed-update');
});

test('a mailbox press on a bot without the mailbox gets the stale toast', async () => {
  const f = fixture({ mailbox: null });
  await f.press(query('mbx:go:m_1'));
  assert.deepEqual(f.answers, [{ text: STALE_BUTTON }]);
});

test('a press for a feature that is off is dropped without an error', async () => {
  const f = fixture({ codexReconciliation: null, question: null });
  await f.press(query('cxr:keep:1'));
  await f.press(query('q:1:a'));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.errors, []);
});

test('a handler that throws is logged and does not escape into grammy', async () => {
  const f = fixture({ approval: async () => { throw new Error('boom'); } });
  await f.press(query('approve:12:tok'));
  assert.deepEqual(f.errors, ['[test] callback_query error: boom']);
});
