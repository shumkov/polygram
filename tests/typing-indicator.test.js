const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  startTyping,
  resetChatTypingState,
  getChatTypingState,
  isAuthFailure,
  backoffDelay,
} = require('../lib/typing-indicator');

function makeBot({ failWith = null, failFirst = 0 } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    api: {
      sendChatAction: async (chatId, action, opts) => {
        n += 1;
        calls.push({ chatId, action, opts, n });
        if (failWith && (failFirst === 0 || n <= failFirst)) {
          throw failWith;
        }
        return true;
      },
    },
  };
}

const authError = (code = 401, desc = 'Forbidden: bot was blocked by the user') =>
  Object.assign(new Error(desc), { error_code: code, description: desc });

describe('isAuthFailure', () => {
  test('matches 401 / 403 / Forbidden / Unauthorized', () => {
    assert.equal(isAuthFailure(authError(401)), true);
    assert.equal(isAuthFailure(authError(403)), true);
    assert.equal(isAuthFailure({ description: 'chat not found' }), true);
    assert.equal(isAuthFailure({ description: 'Forbidden: bot was kicked' }), true);
  });
  test('ignores transient errors', () => {
    assert.equal(isAuthFailure({ error_code: 500, description: 'Bad Gateway' }), false);
    assert.equal(isAuthFailure({ error_code: 429, description: 'Too Many Requests' }), false);
    assert.equal(isAuthFailure({ message: 'ECONNRESET' }), false);
    assert.equal(isAuthFailure(null), false);
  });
});

describe('backoffDelay', () => {
  test('grows exponentially then caps', () => {
    assert.equal(backoffDelay(1, 300_000), 1000);
    assert.equal(backoffDelay(2, 300_000), 2000);
    assert.equal(backoffDelay(3, 300_000), 4000);
    assert.equal(backoffDelay(9, 300_000), 256000);
    assert.equal(backoffDelay(20, 300_000), 300_000); // capped
  });
});

describe('startTyping — happy path', () => {
  beforeEach(() => resetChatTypingState());
  test('fires immediately and on interval', async () => {
    const bot = makeBot();
    const stop = startTyping({ bot, chatId: 1, intervalMs: 5 });
    await new Promise(r => setTimeout(r, 20));
    stop();
    assert.ok(bot.calls.length >= 2);
    assert.equal(bot.calls[0].action, 'typing');
  });
});

describe('startTyping — circuit breaker', () => {
  beforeEach(() => resetChatTypingState());

  test('auth failures increment the counter', async () => {
    const bot = makeBot({ failWith: authError() });
    const events = [];
    startTyping({ bot, chatId: 77, intervalMs: 1, onEvent: (e) => events.push(e), logger: { error: () => {} } });
    await new Promise(r => setTimeout(r, 30));
    const s = getChatTypingState(77);
    assert.ok(s.failures > 0, 'should have counted at least one failure');
  });

  test('suspends after N consecutive auth failures', async () => {
    const bot = makeBot({ failWith: authError() });
    const events = [];
    const stop = startTyping({
      bot, chatId: 88,
      // Fire faster than the longest partial-backoff so failures accrue
      // within the test window. Each failure sets suspendedUntil = now +
      // backoffDelay, so intervalMs just gates how often the wall-clock
      // re-checks suspendedUntil; what actually paces failures is the
      // backoff sequence. With maxBackoffMs=1 the exponential cap is 1ms.
      intervalMs: 1,
      maxConsecutive401: 3,
      maxBackoffMs: 1,
      onEvent: (e) => events.push(e),
      logger: { error: () => {} },
    });
    await new Promise(r => setTimeout(r, 50));
    stop();
    const suspendEvt = events.find(e => e.kind === 'typing-suspended');
    assert.ok(suspendEvt, 'should have emitted typing-suspended event');
    assert.equal(suspendEvt.chat_id, '88');
  });

  test('success after failures resets the counter', async () => {
    const bot = makeBot({ failWith: authError(), failFirst: 2 });
    const events = [];
    const stop = startTyping({
      bot, chatId: 99,
      intervalMs: 1,
      maxConsecutive401: 10,
      maxBackoffMs: 1,
      onEvent: (e) => events.push(e),
      logger: { error: () => {} },
    });
    await new Promise(r => setTimeout(r, 50));
    stop();
    const recovered = events.find(e => e.kind === 'typing-recovered');
    assert.ok(recovered, 'should have emitted typing-recovered');
    const s = getChatTypingState(99);
    assert.equal(s.failures, 0);
  });

  test('non-auth errors do not increment counter', async () => {
    const bot = makeBot({ failWith: { error_code: 500, description: 'server error' } });
    const stop = startTyping({
      bot, chatId: 123, intervalMs: 1,
      maxConsecutive401: 3,
      logger: { error: () => {} },
    });
    await new Promise(r => setTimeout(r, 30));
    stop();
    const s = getChatTypingState(123);
    assert.equal(s?.failures ?? 0, 0, 'server errors should not open the circuit');
  });
});
