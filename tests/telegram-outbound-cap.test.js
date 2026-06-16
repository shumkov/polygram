/**
 * Outbound file-size cap at the send() choke point (0.13 bot/default tiers).
 *
 * Pins the enforcement the 5-persona spec review demanded:
 *   - over-cap local file → send() throws BEFORE any DB row is inserted
 *   - under-cap → sends normally
 *   - config:null → no cap (back-compat for legacy/test callers)
 *   - createSender(db, logger, config) actually threads config (the
 *     "silently inert on prod" regression guard)
 *   - the IPC/cron path (createHandleSendOverIpc → tg) is capped — this is
 *     the REAL agent file-send path on SDK prod
 *   - file_id / https-URL params are NOT capped (can't be sized locally)
 *
 * Run: node --test tests/telegram-outbound-cap.test.js
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { send, createSender } = require('../lib/telegram/api');
const { createHandleSendOverIpc } = require('../lib/handlers/ipc-send');
const { resolveMaxFileOverride } = require('../lib/attachments');
const { localFileBytes } = require('../lib/telegram/input-file');

let db;
let dbPath;
const tmpFiles = [];

function tmpFileOfBytes(n, label) {
  const p = path.join(os.tmpdir(), `polygram-captest-${label}-${n}.bin`);
  fs.writeFileSync(p, Buffer.alloc(n, 0x61));
  tmpFiles.push(p);
  return p;
}

function makeFakeBot({ result = { message_id: 1, date: 1700000000 } } = {}) {
  const calls = [];
  const handler = (method) => (params) => { calls.push({ method, params }); return Promise.resolve(result); };
  return { calls, api: { raw: new Proxy({}, { get: (_, method) => handler(method) }) } };
}
const silentLogger = () => ({ log: () => {}, error: () => {} });

// localApi:true (mimics prod local Bot API server) so the 1 MB override clamps
// to 1 MB, not the 2 GB ceiling. chats includes the test chat for IPC ownership.
const CAP = 1 * 1024 * 1024; // 1 MB
function capConfig() {
  return {
    defaults: {},
    bot: { apiRoot: 'http://localhost:8082', maxFileBytes: CAP },
    chats: { '-100': {} },
  };
}

describe('outbound cap — send() choke point', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('outbound-cap-test')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('over-cap local file throws AND leaves no messages row', async () => {
    const big = tmpFileOfBytes(CAP + 50_000, 'big');
    const bot = makeFakeBot();
    await assert.rejects(
      () => send({
        bot, method: 'sendDocument',
        params: { chat_id: '-100', document: { source: big } },
        db, logger: silentLogger(), config: capConfig(),
      }),
      /exceeds the .*MB send limit/,
    );
    // The throw is before insertOutboundPending → no orphan row.
    const rows = db.raw.prepare('SELECT * FROM messages WHERE chat_id=?').all('-100');
    assert.equal(rows.length, 0, 'no pending/failed row should exist for a cap rejection');
    assert.equal(bot.calls.length, 0, 'Telegram API must not be called');
  });

  test('under-cap local file sends normally', async () => {
    const small = tmpFileOfBytes(100_000, 'small');
    const bot = makeFakeBot({ result: { message_id: 777, date: 1 } });
    const res = await send({
      bot, method: 'sendDocument',
      params: { chat_id: '-100', document: { source: small }, caption: 'ok' },
      db, logger: silentLogger(), config: capConfig(),
    });
    assert.equal(res.message_id, 777);
    assert.equal(bot.calls.length, 1);
    assert.equal(bot.calls[0].method, 'sendDocument');
  });

  test('config:null → cap disabled (back-compat); over-cap file sends', async () => {
    const big = tmpFileOfBytes(CAP + 50_000, 'big');
    const bot = makeFakeBot({ result: { message_id: 5, date: 1 } });
    const res = await send({
      bot, method: 'sendDocument',
      params: { chat_id: '-100', document: { source: big } },
      db, logger: silentLogger(), // no config
    });
    assert.equal(res.message_id, 5);
    assert.equal(bot.calls.length, 1);
  });

  test('file_id / https-URL params are not capped (cannot be sized locally)', async () => {
    const bot = makeFakeBot({ result: { message_id: 6, date: 1 } });
    // a bare file_id string and a {source: https URL} both pass through
    await send({
      bot, method: 'sendDocument',
      params: { chat_id: '-100', document: 'BAADBAADrwADbig_file_id' },
      db, logger: silentLogger(), config: capConfig(),
    });
    await send({
      bot, method: 'sendPhoto',
      params: { chat_id: '-100', photo: { source: 'https://example.com/huge.jpg' } },
      db, logger: silentLogger(), config: capConfig(),
    });
    assert.equal(bot.calls.length, 2, 'both uncapped sends proceed');
  });

  test('non-file method (sendMessage) is never blocked by the cap', async () => {
    const bot = makeFakeBot({ result: { message_id: 9, date: 1 } });
    const res = await send({
      bot, method: 'sendMessage',
      params: { chat_id: '-100', text: 'hello' },
      db, logger: silentLogger(), config: capConfig(),
    });
    assert.equal(res.message_id, 9);
  });
});

describe('outbound cap — createSender threads config (silently-inert regression guard)', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('outbound-cap-sender')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('tg = createSender(db, logger, config) enforces the cap', async () => {
    const big = tmpFileOfBytes(CAP + 50_000, 'big');
    const bot = makeFakeBot();
    const tg = createSender(db, silentLogger(), capConfig());
    await assert.rejects(
      () => tg(bot, 'sendDocument', { chat_id: '-100', document: { source: big } }),
      /exceeds the .*MB send limit/,
    );
  });

  test('createSender(db, logger) without config → no cap (legacy 2-arg callers)', async () => {
    const big = tmpFileOfBytes(CAP + 50_000, 'big');
    const bot = makeFakeBot({ result: { message_id: 3, date: 1 } });
    const tg = createSender(db, silentLogger());
    const res = await tg(bot, 'sendDocument', { chat_id: '-100', document: { source: big } });
    assert.equal(res.message_id, 3);
  });
});

describe('outbound cap — IPC/cron path (the SDK-prod file route)', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('outbound-cap-ipc')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('IPC sendDocument over cap is rejected', async () => {
    const big = tmpFileOfBytes(CAP + 50_000, 'big');
    const cfg = capConfig();
    const bot = makeFakeBot();
    const tg = createSender(db, silentLogger(), cfg);
    const handler = createHandleSendOverIpc({ config: cfg, bot, tg, botName: 'shumabit' });
    await assert.rejects(
      () => handler({ method: 'sendDocument', params: { chat_id: '-100', document: { source: big } } }),
      /exceeds the .*MB send limit/,
    );
  });

  test('IPC sendDocument under cap is delivered', async () => {
    const small = tmpFileOfBytes(100_000, 'small');
    const cfg = capConfig();
    const bot = makeFakeBot({ result: { message_id: 42, date: 1 } });
    const tg = createSender(db, silentLogger(), cfg);
    const handler = createHandleSendOverIpc({ config: cfg, bot, tg, botName: 'shumabit' });
    const res = await handler({ method: 'sendDocument', params: { chat_id: '-100', document: { source: small } } });
    assert.equal(res.result.message_id, 42);
  });
});

describe('resolveMaxFileOverride — precedence topic → chat → bot → default → null', () => {
  const MB = 1024 * 1024;
  const cfg = {
    defaults: { maxFileBytes: 20 * MB },
    bot: { maxFileBytes: 100 * MB },
    chats: {
      '-100': { maxFileBytes: 50 * MB, topics: { '7': { name: 'T', maxFileBytes: 7 * MB } } },
      '-200': {},        // no chat override → bot tier
    },
  };
  test('topic wins', () => assert.equal(resolveMaxFileOverride(cfg, '-100', '7'), 7 * MB));
  test('chat beats bot/default', () => assert.equal(resolveMaxFileOverride(cfg, '-100', null), 50 * MB));
  test('bot beats default when no chat override', () => assert.equal(resolveMaxFileOverride(cfg, '-200', null), 100 * MB));
  test('default when no chat/bot', () => {
    const c = { defaults: { maxFileBytes: 20 * MB }, bot: {}, chats: { '-300': {} } };
    assert.equal(resolveMaxFileOverride(c, '-300', null), 20 * MB);
  });
  test('null when nothing set', () => {
    assert.equal(resolveMaxFileOverride({ bot: {}, chats: { '-400': {} } }, '-400', null), null);
  });
  test('null config → null (back-compat)', () => assert.equal(resolveMaxFileOverride(null, '-1', null), null));
  test('numeric chatId coerces to string key', () => assert.equal(resolveMaxFileOverride(cfg, -200, null), 100 * MB));
  test('0 / negative at a tier is "unset" → falls through to next tier (not 2GB backend)', () => {
    const c = { defaults: { maxFileBytes: 20 * MB }, bot: { maxFileBytes: 100 * MB }, chats: { '-100': { maxFileBytes: 0 } } };
    assert.equal(resolveMaxFileOverride(c, '-100', null), 100 * MB, '0 chat tier must fall through to bot, not short-circuit');
    const c2 = { defaults: { maxFileBytes: 20 * MB }, bot: { maxFileBytes: -5 }, chats: { '-100': {} } };
    assert.equal(resolveMaxFileOverride(c2, '-100', null), 20 * MB, 'negative bot tier falls through to default');
  });
});

describe('localFileBytes — only locally-statable files are sized', () => {
  test('relative {source} path IS sized (resolved against cwd, like grammy)', () => {
    // package.json always exists relative to the repo cwd
    assert.equal(localFileBytes({ source: 'package.json' }), fs.statSync('package.json').size);
  });
  test('absolute {source} is sized', () => {
    const p = tmpFileOfBytes(321, 'abs');
    assert.equal(localFileBytes({ source: p }), 321);
  });
  test('https {source} URL → null (remote)', () => assert.equal(localFileBytes({ source: 'https://x/y.pdf' }), null));
  test('bare-string file_id → null (never stat a bare string)', () => assert.equal(localFileBytes('BAADBAADrwAD'), null));
  test('Buffer → .length', () => assert.equal(localFileBytes(Buffer.alloc(99)), 99));
  test('missing {source} path → null (no throw)', () => assert.equal(localFileBytes({ source: '/no/such/file.bin' }), null));
});

// Cleanup any stragglers.
test.after(() => { for (const p of tmpFiles) { try { fs.unlinkSync(p); } catch {} } });
