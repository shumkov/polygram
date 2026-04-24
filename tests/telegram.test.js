/**
 * Tests for lib/telegram.js
 * Run: node --test tests/telegram.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { open } = require('../lib/db');
const { send, createSender, nextPendingId } = require('../lib/telegram');

let db;
let dbPath;

function freshDb() {
  dbPath = path.join(os.tmpdir(), `telegram-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  return open(dbPath);
}

function cleanup() {
  if (db) { try { db.raw.close(); } catch {} db = null; }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
}

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
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

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
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

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
    assert.match(detail.error, /Forbidden/);
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

describe('send — reactions skip DB row', () => {
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

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
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

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
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

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
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

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
  beforeEach(() => { db = freshDb(); });
  afterEach(() => cleanup());

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
