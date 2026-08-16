/**
 * Tests for lib/telegram.js
 * Run: node --test tests/telegram.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { send, createSender, nextPendingId } = require('../lib/telegram/api');

let db;
let dbPath;

// ─── Fake grammy bot ────────────────────────────────────────────────

function makeFakeBot({ result = null, error = null } = {}) {
  const calls = [];
  const handler = (method) => (params) => {
    calls.push({ method, params });
    if (error) throw error;
    return Promise.resolve(result ?? { message_id: 12345, date: 1700000000 });
  };
  return {
    calls,
    api: {
      raw: new Proxy({}, { get: (_, method) => handler(method) }),
    },
  };
}

function silentLogger() {
  return { log: () => {}, error: () => {} };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('nextPendingId', () => {
  test('returns negative unique IDs', () => {
    const a = nextPendingId();
    const b = nextPendingId();
    assert.ok(a < 0);
    assert.ok(b < 0);
    assert.notEqual(a, b);
  });

  test('high-volume generation: no collisions in 10k IDs', () => {
    const seen = new Set();
    for (let i = 0; i < 10_000; i++) seen.add(nextPendingId());
    assert.equal(seen.size, 10_000);
  });

  test('IDs fit within SQLite signed int64 range', () => {
    for (let i = 0; i < 1000; i++) {
      const id = nextPendingId();
      assert.ok(id >= Number.MIN_SAFE_INTEGER, `id ${id} below safe int`);
      assert.ok(Number.isInteger(id));
    }
  });
});

describe('send — success path', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('insert pending then mark sent on success', async () => {
    const bot = makeFakeBot({ result: { message_id: 999, date: 1700000000 } });
    const res = await send({
      bot, method: 'sendMessage',
      params: { chat_id: '-100', text: 'hi' },
      db, logger: silentLogger(),
      meta: { source: 'bot-reply', botName: 'shumabit', sessionId: 'abc', turnId: 'turn-1' },
    });
    assert.equal(res.message_id, 999);

    const rows = db.raw.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY id').all('-100');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].msg_id, 999);
    assert.equal(rows[0].text, 'hi');
    assert.equal(rows[0].source, 'bot-reply');
    assert.equal(rows[0].session_id, 'abc');
    assert.equal(rows[0].turn_id, 'turn-1');
    assert.equal(rows[0].direction, 'out');
  });

  test('ts comes from Telegram res.date when provided', async () => {
    const bot = makeFakeBot({ result: { message_id: 1, date: 1700000000 } });
    await send({ bot, method: 'sendMessage', params: { chat_id: '1', text: 't' }, db, logger: silentLogger() });
    const row = db.raw.prepare('SELECT ts FROM messages').get();
    assert.equal(row.ts, 1700000000 * 1000);
  });

  test('caption used when text missing (photo replies)', async () => {
    const bot = makeFakeBot({ result: { message_id: 2, date: 1700000000 } });
    await send({ bot, method: 'sendPhoto', params: { chat_id: '1', photo: 'x', caption: 'a photo' }, db, logger: silentLogger() });
    const row = db.raw.prepare('SELECT text FROM messages').get();
    assert.equal(row.text, 'a photo');
  });

  test('thread_id recorded when present', async () => {
    const bot = makeFakeBot({ result: { message_id: 1, date: 1 } });
    await send({ bot, method: 'sendMessage', params: { chat_id: '-100', message_thread_id: 5379, text: 't' }, db, logger: silentLogger() });
    const row = db.raw.prepare('SELECT thread_id FROM messages').get();
    assert.equal(row.thread_id, '5379');
  });

  test('sendSticker with stickerName meta is recorded as [sticker:<name>]', async () => {
    const bot = makeFakeBot({ result: { message_id: 10, date: 1 } });
    await send({
      bot, method: 'sendSticker',
      params: { chat_id: '1', sticker: 'CAACAgIAAxkBAA...' },
      db, logger: silentLogger(),
      meta: { source: 'bot-reply', stickerName: '🔥' },
    });
    const row = db.raw.prepare('SELECT text FROM messages').get();
    assert.equal(row.text, '[sticker:🔥]');
  });

  test('sendSticker without stickerName meta falls back to file_id', async () => {
    const bot = makeFakeBot({ result: { message_id: 11, date: 1 } });
    await send({
      bot, method: 'sendSticker',
      params: { chat_id: '1', sticker: 'CAACFILEID' },
      db, logger: silentLogger(),
    });
    const row = db.raw.prepare('SELECT text FROM messages').get();
    assert.equal(row.text, '[sticker:CAACFILEID]');
  });

  test('sendSticker with no sticker param or meta uses "unknown"', async () => {
    const bot = makeFakeBot({ result: { message_id: 12, date: 1 } });
    await send({
      bot, method: 'sendSticker',
      params: { chat_id: '1' },
      db, logger: silentLogger(),
    });
    const row = db.raw.prepare('SELECT text FROM messages').get();
    assert.equal(row.text, '[sticker:unknown]');
  });
});

describe('send — failure path', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('marks row failed + logs event on API error', async () => {
    const bot = makeFakeBot({ error: new Error('Forbidden: bot was blocked') });
    await assert.rejects(() => send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'hi' },
      db, logger: silentLogger(),
    }), /Forbidden/);

    const row = db.raw.prepare('SELECT * FROM messages').get();
    assert.equal(row.status, 'failed');
    assert.match(row.error, /Forbidden/);

    const ev = db.raw.prepare("SELECT * FROM events WHERE kind='telegram-api-error'").get();
    assert.ok(ev, 'telegram-api-error event should be logged');
    const detail = JSON.parse(ev.detail_json);
    assert.equal(detail.method, 'sendMessage');
    // The API's message can echo the text that was refused, so the event keeps
    // the class and the size; the row's own `error` column still carries the
    // (masked) message for that message's own history.
    assert.equal(detail.error, undefined);
    assert.ok(detail.error_code, 'the failure is still classified');
    assert.ok(detail.error_len > 0);
  });

  test('api error without db doesn\'t crash — just re-throws', async () => {
    const bot = makeFakeBot({ error: new Error('network down') });
    await assert.rejects(() => send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'x' },
      db: null, logger: silentLogger(),
    }), /network down/);
  });
});

describe('send — editMessageText with rich_message', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('rich_message payload is NOT rejected by the plain-text emptiness guard', async () => {
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await send({
      bot, method: 'editMessageText',
      params: { chat_id: '1', message_id: 5, rich_message: { blocks: [{ type: 'paragraph', text: 'hi' }] } },
      db, logger: silentLogger(),
    });
    assert.equal(bot.calls.length, 1);
    assert.equal(bot.calls[0].method, 'editMessageText');
    assert.ok(bot.calls[0].params.rich_message);
  });

  test('editMessageText with neither text nor rich_message still throws "text is empty"', async () => {
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await assert.rejects(() => send({
      bot, method: 'editMessageText',
      params: { chat_id: '1', message_id: 5 },
      db, logger: silentLogger(),
    }), /text is empty/);
  });

  test('editMessageText with an empty rich_message.blocks array throws before hitting the API', async () => {
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await assert.rejects(() => send({
      bot, method: 'editMessageText',
      params: { chat_id: '1', message_id: 5, rich_message: { blocks: [] } },
      db, logger: silentLogger(),
    }), /rich_message\.blocks is empty/);
    assert.equal(bot.calls.length, 0, 'must fail BEFORE the API call, like the plain-text guard does');
  });

  test('editMessageText with rich_message.blocks not an array throws', async () => {
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await assert.rejects(() => send({
      bot, method: 'editMessageText',
      params: { chat_id: '1', message_id: 5, rich_message: {} },
      db, logger: silentLogger(),
    }), /rich_message\.blocks is empty/);
  });

  test('a plain editMessageText call (no rich_message) is unaffected — still requires text', async () => {
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await send({
      bot, method: 'editMessageText',
      params: { chat_id: '1', message_id: 5, text: 'plain edit' },
      db, logger: silentLogger(),
    });
    assert.equal(bot.calls[0].params.text, 'plain edit');
  });
});

describe('send — sendRichMessage', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  const blocks = [{ type: 'paragraph', text: 'hi' }];

  test('a blocks payload reaches the API untouched', async () => {
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await send({
      bot, method: 'sendRichMessage',
      params: { chat_id: '1', rich_message: { blocks } },
      db, logger: silentLogger(),
    });
    assert.equal(bot.calls.length, 1);
    assert.deepEqual(bot.calls[0].params.rich_message.blocks, blocks);
  });

  test('no transcript row is written here', async () => {
    // The send is a try: any failure degrades to the plain chunked path,
    // which writes its own rows. A row written here would survive a failed
    // attempt and show the agent its own answer twice on the next preload.
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await send({
      bot, method: 'sendRichMessage',
      params: { chat_id: '1', rich_message: { blocks } },
      db, logger: silentLogger(),
    });
    const rows = db.raw.prepare('SELECT * FROM messages WHERE chat_id = ?').all('1');
    assert.equal(rows.length, 0, 'the rich sender owns this row, on success only');
  });

  test('empty blocks are refused before the API call', async () => {
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await assert.rejects(() => send({
      bot, method: 'sendRichMessage',
      params: { chat_id: '1', rich_message: { blocks: [] } },
      db, logger: silentLogger(),
    }), /rich_message\.blocks is empty/);
    assert.equal(bot.calls.length, 0);
  });

  test('a missing rich_message is refused', async () => {
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await assert.rejects(() => send({
      bot, method: 'sendRichMessage',
      params: { chat_id: '1' },
      db, logger: silentLogger(),
    }), /rich_message is missing/);
    assert.equal(bot.calls.length, 0);
  });

  test('a rich_message smuggled under another method is refused too', async () => {
    // The guard keys on the payload, not the verb. Keyed on the method it
    // would wave this through, and a new caller is exactly what that looks
    // like — the capability regex already anticipates sendRichMessageDraft.
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    await assert.rejects(() => send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'decoy', rich_message: { blocks, html: '<b>x</b>' } },
      db, logger: silentLogger(),
    }), /html\/markdown is not supported/);
    assert.equal(bot.calls.length, 0);
  });

  for (const field of ['html', 'markdown']) {
    test(`rich_message.${field} is refused at the choke point`, async () => {
      // Typed blocks are the only rich payload polygram renders. These
      // alternatives hand Telegram a string it re-parses, reintroducing the
      // markup-injection surface the block renderer exists to close, and
      // nothing downstream sanitizes them.
      const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
      await assert.rejects(() => send({
        bot, method: 'sendRichMessage',
        params: { chat_id: '1', rich_message: { blocks, [field]: '<b>x</b>' } },
        db, logger: silentLogger(),
      }), /html\/markdown is not supported/);
      assert.equal(bot.calls.length, 0);
    });

    test(`editMessageText also refuses rich_message.${field}`, async () => {
      const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
      await assert.rejects(() => send({
        bot, method: 'editMessageText',
        params: { chat_id: '1', message_id: 5, rich_message: { blocks, [field]: '<b>x</b>' } },
        db, logger: silentLogger(),
      }), /html\/markdown is not supported/);
      assert.equal(bot.calls.length, 0);
    });
  }
});

describe('send — reactions skip DB row', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('setMessageReaction does not insert message row', async () => {
    const bot = makeFakeBot({ result: true });
    await send({
      bot, method: 'setMessageReaction',
      params: { chat_id: '1', message_id: 5, reaction: [{ type: 'emoji', emoji: '🔥' }] },
      db, logger: silentLogger(),
    });
    const count = db.raw.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    assert.equal(count, 0);
  });

  test('setMessageReaction failure does not write row', async () => {
    const bot = makeFakeBot({ error: new Error('reaction failed') });
    await assert.rejects(() => send({
      bot, method: 'setMessageReaction',
      params: { chat_id: '1', message_id: 5, reaction: [] },
      db, logger: silentLogger(),
    }));
    const count = db.raw.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    assert.equal(count, 0);
  });
});

describe('send — DB resilience', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('DB insert failure does not block send', async () => {
    const bot = makeFakeBot({ result: { message_id: 42, date: 1 } });
    const brokenDb = {
      insertOutboundPending: () => { throw new Error('DB gone'); },
    };
    const logs = [];
    const logger = { log: () => {}, error: (m) => logs.push(m) };

    const res = await send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'hi' },
      db: brokenDb, logger,
    });
    assert.equal(res.message_id, 42);
    assert.ok(logs.some((l) => l.includes('DB gone')));
  });

  test('markOutboundSent failure logs but returns success', async () => {
    const bot = makeFakeBot({ result: { message_id: 42, date: 1 } });
    let insertedRowId = null;
    const flakeyDb = {
      insertOutboundPending: () => { insertedRowId = 99; return { lastInsertRowid: 99, changes: 1 }; },
      markOutboundSent: () => { throw new Error('UPDATE failed'); },
      markOutboundFailed: () => { throw new Error('should not be called'); },
      logEvent: () => {},
    };
    const logs = [];
    const logger = { log: () => {}, error: (m) => logs.push(m) };
    const res = await send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'x' },
      db: flakeyDb, logger,
    });
    assert.equal(res.message_id, 42);
    assert.ok(logs.some((l) => l.includes('markOutboundSent')));
  });

  test('pending rows older than threshold are swept by markStalePending', async () => {
    // Simulate a crash: insert pending, never mark sent.
    db.insertOutboundPending({
      chat_id: '1', msg_id: -99999999, text: 'crashed',
      source: 'bot-reply', pending_id: -99999999,
      ts: Date.now() - 120_000, // 2 min old
    });
    const swept = db.markStalePending(60_000);
    assert.equal(swept.changes, 1);
    const row = db.raw.prepare('SELECT status, error FROM messages').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'crashed-mid-send');
  });
});

describe('createSender factory', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('binds db + logger', async () => {
    const bot = makeFakeBot({ result: { message_id: 7, date: 1 } });
    const sender = createSender(db, silentLogger());
    const res = await sender(bot, 'sendMessage', { chat_id: '1', text: 'hi' }, { source: 'cron' });
    assert.equal(res.message_id, 7);
    const row = db.raw.prepare('SELECT source FROM messages').get();
    assert.equal(row.source, 'cron');
  });
});

describe('send — pre-connect retry', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  function makeFlakyPreConnectBot() {
    let first = true;
    const calls = [];
    return {
      calls,
      api: {
        raw: new Proxy({}, {
          get: (_, method) => (params) => {
            calls.push({ method });
            if (first) {
              first = false;
              const err = new Error('getaddrinfo EAI_AGAIN api.telegram.org');
              err.code = 'EAI_AGAIN';
              throw err;
            }
            return Promise.resolve({ message_id: 99, date: 1 });
          },
        }),
      },
    };
  }

  test('retries once on pre-connect error (EAI_AGAIN) and succeeds', async () => {
    const bot = makeFlakyPreConnectBot();
    const res = await send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'hi' },
      db, logger: silentLogger(),
    });
    assert.equal(res.message_id, 99);
    assert.equal(bot.calls.length, 2);
    // Logged as retry event.
    const ev = db.raw.prepare("SELECT kind FROM events WHERE kind = 'telegram-retry'").get();
    assert.equal(ev?.kind, 'telegram-retry');
  });

  test('does NOT retry ETIMEDOUT (message may have landed)', async () => {
    let callCount = 0;
    const bot = {
      api: {
        raw: new Proxy({}, {
          get: () => () => {
            callCount += 1;
            const err = new Error('request timed out');
            err.code = 'ETIMEDOUT';
            throw err;
          },
        }),
      },
    };
    await assert.rejects(() => send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'hi' },
      db, logger: silentLogger(),
    }), /timed out/);
    assert.equal(callCount, 1, 'must not retry post-connect timeout');
  });
});

describe('send — thread-not-found fallback', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('telegram-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  // Fake bot that fails the first call with a thread-not-found, succeeds on retry.
  function makeFlakyThreadBot() {
    const calls = [];
    let firstCall = true;
    return {
      calls,
      api: {
        raw: new Proxy({}, {
          get: (_, method) => (params) => {
            calls.push({ method, params });
            if (firstCall) {
              firstCall = false;
              const err = new Error('Bad Request: message thread not found');
              throw err;
            }
            return Promise.resolve({ message_id: 42, date: 1 });
          },
        }),
      },
    };
  }

  test('retries without thread_id when thread is missing', async () => {
    const bot = makeFlakyThreadBot();
    const res = await send({
      bot, method: 'sendMessage',
      params: { chat_id: '-100', text: 'hi', message_thread_id: 123 },
      db, logger: silentLogger(),
    });
    assert.equal(res.message_id, 42);
    assert.equal(bot.calls.length, 2);
    assert.equal(bot.calls[0].params.message_thread_id, 123);
    assert.equal(bot.calls[1].params.message_thread_id, undefined);
    // Event logged.
    const ev = db.raw.prepare('SELECT kind FROM events WHERE kind = ?').get('telegram-thread-fallback');
    assert.equal(ev?.kind, 'telegram-thread-fallback');
    // Message row marked sent (not failed).
    const row = db.raw.prepare('SELECT status, msg_id FROM messages').get();
    assert.equal(row.status, 'sent');
    assert.equal(row.msg_id, 42);
  });

  test('propagates error if retry also fails', async () => {
    let callCount = 0;
    const bot = {
      api: {
        raw: new Proxy({}, {
          get: () => () => {
            callCount += 1;
            if (callCount === 1) throw new Error('Bad Request: message thread not found');
            throw new Error('Bad Request: chat not found');
          },
        }),
      },
    };
    await assert.rejects(
      () => send({
        bot, method: 'sendMessage',
        params: { chat_id: '-100', text: 'hi', message_thread_id: 9 },
        db, logger: silentLogger(),
      }),
      /chat not found/,
    );
    assert.equal(callCount, 2);
    // Row should be marked failed with the RETRY's error, not the first.
    const row = db.raw.prepare('SELECT status, error FROM messages').get();
    assert.equal(row.status, 'failed');
    assert.match(row.error, /chat not found/);
  });

  test('non-thread errors do NOT trigger retry', async () => {
    let callCount = 0;
    const bot = {
      api: {
        raw: new Proxy({}, {
          get: () => () => {
            callCount += 1;
            throw new Error('Forbidden: bot was blocked by the user');
          },
        }),
      },
    };
    await assert.rejects(
      () => send({
        bot, method: 'sendMessage',
        params: { chat_id: '-100', text: 'hi', message_thread_id: 9 },
        db, logger: silentLogger(),
      }),
      /bot was blocked/,
    );
    assert.equal(callCount, 1, 'should not retry for non-thread errors');
  });
});

// ─── 0.7.0: HTML→plain fallback ─────────────────────────────────────

describe('HTML→plain parse fallback', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-tg')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('retries as plain text when Telegram rejects HTML with parse error', async () => {
    let callCount = 0;
    const calls = [];
    const bot = {
      api: {
        raw: new Proxy({}, {
          get: (_, method) => (params) => {
            callCount += 1;
            calls.push({ params: { ...params } });
            // First call (HTML) fails with parse error; second (plain) succeeds.
            if (callCount === 1) {
              const err = new Error("Bad Request: can't parse entities: Unmatched tag");
              throw err;
            }
            return Promise.resolve({ message_id: 999, date: 1700000000 });
          },
        }),
      },
    };
    const res = await send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'Some **bold** content' },
      db, logger: silentLogger(),
    });
    assert.equal(res.message_id, 999);
    assert.equal(callCount, 2);
    // First call had parse_mode set; second did not.
    assert.equal(calls[0].params.parse_mode, 'HTML');
    assert.equal(calls[1].params.parse_mode, undefined);
    // Second call's text is the raw markdown, not the converted HTML.
    assert.match(calls[1].params.text, /\*\*bold\*\*/);
    // Event logged.
    const ev = db.raw.prepare("SELECT kind FROM events WHERE kind = 'telegram-html-fallback'").get();
    assert.ok(ev, 'expected telegram-html-fallback event');
  });

  test('DOES NOT retry as plain on non-parse errors', async () => {
    let callCount = 0;
    const bot = {
      api: {
        raw: new Proxy({}, {
          get: () => () => {
            callCount += 1;
            throw new Error('Forbidden: bot was kicked');
          },
        }),
      },
    };
    await assert.rejects(
      () => send({
        bot, method: 'sendMessage',
        params: { chat_id: '1', text: 'hi' },
        db, logger: silentLogger(),
      }),
      /kicked/,
    );
    assert.equal(callCount, 1, 'no fallback for non-parse errors');
  });

  test('DOES NOT retry as plain when caller passed plainText meta (no formatting was applied)', async () => {
    let callCount = 0;
    const bot = {
      api: {
        raw: new Proxy({}, {
          get: () => () => {
            callCount += 1;
            throw new Error("Bad Request: can't parse entities: x");
          },
        }),
      },
    };
    // plainText:true means applyFormatting skipped — there's no parse_mode
    // to fall back from. The error must propagate.
    await assert.rejects(
      () => send({
        bot, method: 'sendMessage',
        params: { chat_id: '1', text: '<b>hi</b>' },
        db, meta: { plainText: true }, logger: silentLogger(),
      }),
      /can't parse/,
    );
    assert.equal(callCount, 1);
  });
});

describe('MESSAGE_NOT_MODIFIED filter', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-tg')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('editMessageText: 400 message-not-modified is swallowed as success', async () => {
    let callCount = 0;
    const bot = {
      api: {
        raw: new Proxy({}, {
          get: () => () => {
            callCount += 1;
            throw new Error('Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
          },
        }),
      },
    };
    const res = await send({
      bot, method: 'editMessageText',
      params: { chat_id: '1', message_id: 42, text: 'unchanged' },
      db, logger: silentLogger(),
    });
    // Synthetic success; message_id is what we passed.
    assert.equal(res.message_id, 42);
    assert.equal(res._notModified, true);
    assert.equal(callCount, 1, 'no retry — swallowed on first attempt');
    // Event logged so ops can spot a hot debounce loop.
    const ev = db.raw.prepare("SELECT kind FROM events WHERE kind = 'telegram-edit-skip-not-modified'").get();
    assert.ok(ev, 'expected telegram-edit-skip-not-modified event');
  });

  test('sendMessage: not-modified error is NOT swallowed (sendMessage cannot produce it)', async () => {
    // If a sendMessage somehow returns this error, treat it like any
    // other 400 — propagate. The filter is editMessageText-specific
    // because the streamer's debounced edit loop is the only path that
    // generates spurious no-op edits.
    const bot = {
      api: {
        raw: new Proxy({}, {
          get: () => () => {
            throw new Error('Bad Request: message is not modified');
          },
        }),
      },
    };
    await assert.rejects(
      () => send({
        bot, method: 'sendMessage',
        params: { chat_id: '1', text: 'hi' },
        db, logger: silentLogger(),
      }),
      /not modified/,
    );
  });
});

// ─── 0.7.0: link-preview opt-out ──────────────────────────────────

describe('linkPreview meta flag', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-tg')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('meta.linkPreview=false adds link_preview_options.is_disabled to sendMessage', async () => {
    const calls = [];
    const bot = {
      api: { raw: new Proxy({}, { get: () => (params) => {
        calls.push(params);
        return Promise.resolve({ message_id: 1, date: 1700000000 });
      } }) },
    };
    await send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'see http://example.com' },
      db, meta: { linkPreview: false }, logger: silentLogger(),
    });
    assert.deepEqual(calls[0].link_preview_options, { is_disabled: true });
  });

  test('meta.linkPreview=false also applies to editMessageText', async () => {
    const calls = [];
    const bot = {
      api: { raw: new Proxy({}, { get: () => (params) => {
        calls.push(params);
        return Promise.resolve({ message_id: 1, date: 1700000000 });
      } }) },
    };
    await send({
      bot, method: 'editMessageText',
      params: { chat_id: '1', message_id: 42, text: 'updated' },
      db, meta: { linkPreview: false }, logger: silentLogger(),
    });
    assert.deepEqual(calls[0].link_preview_options, { is_disabled: true });
  });

  test('meta.linkPreview not set: no link_preview_options', async () => {
    const calls = [];
    const bot = {
      api: { raw: new Proxy({}, { get: () => (params) => {
        calls.push(params);
        return Promise.resolve({ message_id: 1, date: 1700000000 });
      } }) },
    };
    await send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'hi' },
      db, logger: silentLogger(),
    });
    assert.equal(calls[0].link_preview_options, undefined);
  });

  test('meta.linkPreview=true does NOT touch params (only false opts out)', async () => {
    const calls = [];
    const bot = {
      api: { raw: new Proxy({}, { get: () => (params) => {
        calls.push(params);
        return Promise.resolve({ message_id: 1, date: 1700000000 });
      } }) },
    };
    await send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'hi' },
      db, meta: { linkPreview: true }, logger: silentLogger(),
    });
    assert.equal(calls[0].link_preview_options, undefined);
  });

  test('caller-set link_preview_options is preserved (not overwritten)', async () => {
    const calls = [];
    const bot = {
      api: { raw: new Proxy({}, { get: () => (params) => {
        calls.push(params);
        return Promise.resolve({ message_id: 1, date: 1700000000 });
      } }) },
    };
    await send({
      bot, method: 'sendMessage',
      params: {
        chat_id: '1', text: 'hi',
        link_preview_options: { url: 'http://example.com', prefer_small_media: true },
      },
      db, meta: { linkPreview: false }, logger: silentLogger(),
    });
    // Caller-supplied options win.
    assert.deepEqual(calls[0].link_preview_options, {
      url: 'http://example.com', prefer_small_media: true,
    });
  });

  test('does NOT apply to non-message methods (e.g. setMessageReaction)', async () => {
    const calls = [];
    const bot = {
      api: { raw: new Proxy({}, { get: () => (params) => {
        calls.push(params);
        return Promise.resolve({ ok: true });
      } }) },
    };
    await send({
      bot, method: 'setMessageReaction',
      params: { chat_id: '1', message_id: 5, reaction: [] },
      db, meta: { linkPreview: false }, logger: silentLogger(),
    });
    assert.equal(calls[0].link_preview_options, undefined);
  });
});

describe('429 rate-limit retry', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('polygram-tg')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('on 429 with retry_after, sleeps and retries once', async () => {
    let count = 0;
    const startTs = Date.now();
    const bot = {
      api: { raw: new Proxy({}, {
        get: () => (params) => {
          count += 1;
          if (count === 1) {
            const err = Object.assign(new Error('Too Many Requests: retry after 1'), {
              parameters: { retry_after: 1 },
            });
            throw err;
          }
          return Promise.resolve({ message_id: 999, date: 1700000000 });
        },
      }) },
    };
    const res = await send({
      bot, method: 'sendMessage',
      params: { chat_id: '1', text: 'hi' },
      db, logger: silentLogger(),
    });
    assert.equal(res.message_id, 999);
    assert.equal(count, 2, 'one retry after 429');
    const elapsed = Date.now() - startTs;
    assert.ok(elapsed >= 900, 'should have slept ~1s, elapsed=' + elapsed);
    // Event recorded
    const ev = db.raw.prepare("SELECT kind, detail_json FROM events WHERE kind = 'telegram-rate-limit'").get();
    assert.ok(ev);
    const detail = JSON.parse(ev.detail_json);
    assert.equal(detail.retry_after_ms, 1000);
  });

  test('429 retry that ALSO 429s propagates', async () => {
    let count = 0;
    const bot = {
      api: { raw: new Proxy({}, {
        get: () => () => {
          count += 1;
          throw Object.assign(new Error('Too Many Requests: retry after 0'), {
            parameters: { retry_after: 0 },
          });
        },
      }) },
    };
    await assert.rejects(
      () => send({
        bot, method: 'sendMessage',
        params: { chat_id: '1', text: 'hi' },
        db, logger: silentLogger(),
      }),
      /Too Many Requests/,
    );
    assert.equal(count, 2, 'tried once + one retry, then gave up');
  });
});
