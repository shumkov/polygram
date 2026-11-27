'use strict';
// A job turn can run for many minutes with nothing in its chat but the card
// that started it. While the turn runs, the chat shows typing and the card
// gets the status reactions a human message gets, ending 👍 even when the
// turn says nothing. None of this may ever fail the job.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createJobPresence } = require('../lib/external-jobs/presence');
const { resetChatTypingState } = require('../lib/telegram/typing');

const target = { chatId: '-1004292131077', threadId: '732', sessionKey: '-1004292131077:732' };
const job = { id: 7, routeId: 'ops', requestId: 'mailbox:m_0000000000000001', target };
const card = { chatId: '-1004292131077', threadId: '732', messageId: 501 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Lets queued reaction applies run.
const flush = async () => { for (let n = 0; n < 10; n++) await new Promise(setImmediate); };

beforeEach(() => resetChatTypingState());

function fixture({ typingError = null, reactionError = null, getAllowlist, allowlistTimeoutMs } = {}) {
  const f = { typing: [], reactions: [], events: [], errors: [] };
  const bot = { api: { sendChatAction: async (chatId, action, opts) => { f.typing.push({ chatId, action, opts }); if (typingError) throw typingError; return true; } } };
  const tg = async (_bot, method, params) => {
    assert.equal(method, 'setMessageReaction');
    f.reactions.push({ chatId: params.chat_id, messageId: params.message_id, emoji: params.reaction[0]?.emoji ?? null });
    if (reactionError) throw reactionError;
    return true;
  };
  f.presence = createJobPresence({ bot, tg, botName: 'shumabit', typingIntervalMs: 20, getAllowlist, allowlistTimeoutMs,
    logEvent: (kind, detail) => f.events.push([kind, detail]), logger: { error: (line) => f.errors.push(line), warn: (line) => f.errors.push(line) } });
  f.emojis = () => f.reactions.map((r) => r.emoji);
  return f;
}

test('nothing shows until the turn begins: a prepared job that defers stays invisible', async () => {
  const f = fixture();
  const handle = await f.presence.prepare(job, { card: Promise.resolve(card) });
  handle.end('succeeded');
  await wait(50); await flush();
  assert.deepEqual([f.typing, f.reactions], [[], []]);
});

test('a running job types in its topic and its card goes 🤔 then 👍 when the turn ends silently', async () => {
  const f = fixture();
  const handle = await f.presence.prepare(job, { card: Promise.resolve(card) });
  handle.begin();
  await wait(50); await flush();
  assert.ok(f.typing.length >= 2, 'typing repeats while the turn runs');
  assert.deepEqual(f.typing[0], { chatId: target.chatId, action: 'typing', opts: { message_thread_id: 732 } });
  assert.deepEqual(f.reactions[0], { chatId: card.chatId, messageId: 501, emoji: '🤔' });
  handle.end('succeeded');
  await flush();
  const typed = f.typing.length;
  await wait(60);
  assert.equal(f.typing.length, typed, 'typing stops when the turn ends');
  assert.equal(f.emojis().at(-1), '👍', 'a silent turn still shows that it finished');
  assert.deepEqual(f.events.find(([kind]) => kind === 'job-presence'), ['job-presence', { request_id: job.requestId, session_key: target.sessionKey, card: true }]);
  assert.ok(f.events.some(([kind, detail]) => kind === 'reactor-state' && detail.request_id === job.requestId && detail.to_state === 'DONE' && detail.msg_id === 501));
});

test('the card ends as a human message does: 🤯 on failure, 😨 on a timeout, none after a stop', async () => {
  const timeout = Object.assign(new Error('Turn exceeded 1800s wall-clock ceiling'), { code: 'TURN_MAX_EXCEEDED' });
  const apiError = Object.assign(new Error('API Error: 529'), { code: 'CLAUDE_API_ERROR' });
  const stopped = Object.assign(new Error('Interrupted'), { code: 'INTERRUPTED' });
  for (const [outcome, error, last] of [['failed', null, '🤯'], ['interrupted', null, null], ['unknown', null, null],
    ['unknown', timeout, '😨'], ['unknown', apiError, '🤯'], ['unknown', stopped, null],
    // A /reload, a shutdown or a closed process ends the turn from outside,
    // as a stop does: the card is cleared, not marked as a failure.
    ['unknown', Object.assign(new Error('Process killed'), { code: 'KILLED' }), null],
    ['unknown', Object.assign(new Error('Process closed'), { code: 'PROCESS_CLOSED' }), null]]) {
    resetChatTypingState();
    const f = fixture();
    const handle = await f.presence.prepare(job, { card: Promise.resolve(card) });
    handle.begin();
    await flush();
    handle.end(outcome, error);
    await flush();
    assert.deepEqual(f.emojis(), ['🤔', last], `${outcome} ${error?.code ?? ''}`);
    const typed = f.typing.length;
    await wait(50);
    assert.equal(f.typing.length, typed, `${outcome}: typing stops`);
  }
});

test('end is idempotent and begin after end shows nothing', async () => {
  const f = fixture();
  const handle = await f.presence.prepare(job, { card: Promise.resolve(card) });
  handle.begin(); await flush(); handle.end('succeeded');
  const typed = f.typing.length;
  handle.end('failed'); handle.begin();
  await wait(50); await flush();
  assert.deepEqual(f.emojis(), ['🤔', '👍']);
  assert.equal(f.typing.length, typed, 'typing does not start again');
});

test('an end before the turn began closes the handle: a later begin shows nothing', async () => {
  const f = fixture();
  const handle = await f.presence.prepare(job, { card: Promise.resolve(card) });
  handle.end('unknown');
  handle.begin();
  await wait(50); await flush();
  assert.deepEqual([f.typing, f.reactions], [[], []]);
});

test('a card that lands after the turn began gets its current face, not every face it missed', async () => {
  const f = fixture();
  let land;
  const handle = await f.presence.prepare(job, { card: new Promise((resolve) => { land = resolve; }) });
  handle.begin();
  handle.context.reactor.setState('CODING');
  await flush();
  assert.deepEqual(f.reactions, [], 'nothing to react on yet');
  land(card);
  await flush();
  assert.deepEqual(f.emojis(), ['👨‍💻'], 'the card shows what the turn is doing now');
  handle.end('succeeded');
  await flush();
  assert.deepEqual(f.emojis(), ['👨‍💻', '👍']);
});

test('a turn that ends before its card lands leaves the card at its final face only', async () => {
  for (const [outcome, faces] of [['succeeded', ['👍']], ['interrupted', []]]) {
    const f = fixture();
    let land;
    const handle = await f.presence.prepare(job, { card: new Promise((resolve) => { land = resolve; }) });
    handle.begin(); handle.end(outcome);
    land(card);
    await flush();
    assert.deepEqual(f.emojis(), faces, outcome);
  }
});

test('a card that failed to post, or landed in another chat or topic, gets no reaction', async () => {
  for (const landed of [null, { ...card, chatId: '-1009' }, { ...card, threadId: '1041' }, { ...card, threadId: null }]) {
    const f = fixture();
    const handle = await f.presence.prepare(job, { card: Promise.resolve(landed) });
    handle.begin(); handle.end('succeeded');
    await flush();
    assert.deepEqual(f.reactions, [], JSON.stringify(landed));
    assert.equal(f.typing.length, 1, 'typing still shows');
  }
});

test('a job without a card types only, and its typing stops however the turn ends', async () => {
  for (const outcome of ['succeeded', 'failed', 'interrupted', 'unknown']) {
    resetChatTypingState();
    const f = fixture();
    const handle = await f.presence.prepare({ ...job, requestId: 'notifications:1' }, { card: null });
    assert.equal(handle.context.reactor, undefined);
    handle.begin();
    await wait(30);
    handle.end(outcome);
    const typed = f.typing.length;
    assert.ok(typed >= 1, outcome);
    await wait(60);
    assert.equal(f.typing.length, typed, `${outcome}: typing stops`);
    assert.deepEqual(f.reactions, []);
    assert.deepEqual(f.events.find(([kind]) => kind === 'job-presence')[1].card, false);
  }
});

test('a job in a direct chat or a forum\'s General types without a thread', async () => {
  const f = fixture();
  const handle = await f.presence.prepare({ ...job, target: { chatId: '8744283195', threadId: null, sessionKey: '8744283195' } }, { card: null });
  handle.begin(); handle.end('succeeded');
  assert.deepEqual(f.typing[0], { chatId: '8744283195', action: 'typing', opts: {} });
});

test('the turn context pauses typing while the agent waits on a person, and resumes it', async () => {
  const f = fixture();
  const handle = await f.presence.prepare(job, { card: null });
  handle.context.typing.pause(); // before the turn begins: nothing to pause
  handle.begin();
  handle.context.typing.pause();
  const typed = f.typing.length;
  await wait(60);
  assert.equal(f.typing.length, typed, 'paused');
  handle.context.typing.resume();
  await flush();
  assert.ok(f.typing.length > typed, 'resumed');
  handle.end('succeeded');
});

test('Telegram errors on typing and on reactions are logged and never reach the job', async () => {
  const error = Object.assign(new Error('Bad Request: message to react not found'), { error_code: 400, description: 'Bad Request: message to react not found' });
  const f = fixture({ typingError: Object.assign(new Error('Internal'), { error_code: 500, description: 'Internal' }), reactionError: error });
  const handle = await f.presence.prepare(job, { card: Promise.resolve(card) });
  assert.doesNotThrow(() => handle.begin());
  assert.doesNotThrow(() => handle.end('succeeded'));
  await flush();
  assert.ok(f.errors.some((line) => /typing/.test(line)), 'the typing failure is logged');
  assert.ok(f.errors.some((line) => /reaction/.test(line) && line.includes(job.requestId)), 'the reaction failure is logged with the job');
});

test('a broken dependency never fails prepare, begin or end', async () => {
  const f = fixture({ getAllowlist: () => { throw new Error('getChat exploded'); } });
  const handle = await f.presence.prepare(job, { card: Promise.reject(new Error('card lookup failed')) });
  assert.doesNotThrow(() => handle.begin());
  assert.doesNotThrow(() => handle.end('succeeded'));
  await flush();
  assert.deepEqual(f.reactions, []);
  const broken = createJobPresence({ bot: null, tg: null, botName: 'x', logger: { error() {}, warn() {} } });
  const other = await broken.prepare(job, { card: Promise.resolve(card) });
  assert.doesNotThrow(() => { other.begin(); other.end('failed'); });
});

test('a slow reaction allowlist is not waited for: the default set is used, and the card ends bare', async () => {
  const f = fixture({ getAllowlist: () => new Promise(() => {}), allowlistTimeoutMs: 20 });
  const started = Date.now();
  const handle = await f.presence.prepare(job, { card: Promise.resolve(card) });
  assert.ok(Date.now() - started < 1000);
  handle.begin(); await flush(); handle.end('succeeded');
  await flush();
  // The chat may not allow 👍, and a refused 👍 would leave 🤔 behind.
  assert.deepEqual(f.emojis(), ['🤔', null]);
});

test('a chat that allows only some reactions gets the closest allowed ones; one with none gets none', async () => {
  const some = fixture({ getAllowlist: async () => new Set(['👍', '👀']) });
  const handle = await some.presence.prepare(job, { card: Promise.resolve(card) });
  handle.begin(); await flush(); handle.end('succeeded');
  await flush();
  assert.deepEqual(some.emojis(), ['👍'], '🤔 is not allowed, and its fallback 👍 equals the final face');
  // Without 👍 the reactor would fall back to 👀, which reads as "queued":
  // a finished turn then leaves the card bare instead.
  const noThumbs = fixture({ getAllowlist: async () => new Set(['🤔', '👀']) });
  const done = await noThumbs.presence.prepare(job, { card: Promise.resolve(card) });
  done.begin(); await flush(); done.end('succeeded');
  await flush();
  assert.deepEqual(noThumbs.emojis(), ['🤔', null]);
  const none = fixture({ getAllowlist: async () => new Set() });
  const quiet = await none.presence.prepare(job, { card: Promise.resolve(card) });
  quiet.begin(); quiet.end('succeeded');
  await flush();
  assert.deepEqual(none.reactions, []);
});
