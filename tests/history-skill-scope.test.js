'use strict';

/**
 * The history skill must read only the calling session's own chat.
 *
 * In a bot whose chats all share one cwd (the UMI bot runs eleven chats from
 * one directory), a scope derived from the cwd covers every chat of the bot,
 * so a team member's DM session could read the operator's DM. The fixture
 * reproduces that layout: two DMs and a forum with isolated topics, all
 * mapped to the same cwd.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { open } = require('../lib/db');

const SCRIPT = path.join(__dirname, '..', 'skills', 'history', 'scripts', 'query.js');
const BOT = 'testbot';
const OPERATOR_DM = '1001';
const MEMBER_DM = '1002';
const FORUM = '-1003';
const SECOND_DM = '1004';

let polygramDir;
let sharedCwd;
let config;
let db;

before(() => {
  polygramDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-polygram-')));
  sharedCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-cwd-')));
  config = {
    bots: { [BOT]: { adminChatId: Number(OPERATOR_DM) } },
    // The daemon's view of its own bot section, as config.bot is set at boot.
    bot: { adminChatId: Number(OPERATOR_DM) },
    chats: {
      [OPERATOR_DM]: { bot: BOT, cwd: sharedCwd },
      [MEMBER_DM]: { bot: BOT, cwd: sharedCwd },
      [FORUM]: { bot: BOT, cwd: sharedCwd, isolateTopics: true },
      [SECOND_DM]: { bot: BOT, cwd: sharedCwd },
    },
  };
  fs.writeFileSync(path.join(polygramDir, 'config.json'), JSON.stringify(config));
  db = open(path.join(polygramDir, `${BOT}.db`));
  const now = Date.now();
  const rows = [
    { chat_id: OPERATOR_DM, msg_id: 1, user: 'Operator', text: 'operatorsecret salary figures', ts: now - 5000 },
    { chat_id: MEMBER_DM, msg_id: 1, user: 'Member', text: 'memberown question about shifts', ts: now - 4000 },
    { chat_id: FORUM, thread_id: null, msg_id: 1, user: 'Member', text: 'generaltopic hello', ts: now - 3000 },
    { chat_id: FORUM, thread_id: '11', msg_id: 2, user: 'Member', text: 'ordertopic invoice', ts: now - 2000 },
    { chat_id: FORUM, thread_id: '12', msg_id: 3, user: 'Member', text: 'billingtopic invoice', ts: now - 1000 },
    { chat_id: SECOND_DM, msg_id: 1, user: 'Second', text: 'seconddm inbound', ts: now - 900 },
    { chat_id: SECOND_DM, msg_id: 2, user: null, text: 'seconddm reply', direction: 'out', ts: now - 800 },
  ];
  for (const r of rows) {
    db.insertMessage({ thread_id: null, user_id: null, direction: 'in', source: 'polygram', bot_name: BOT, ...r });
  }
});

after(() => {
  try { db.raw.close(); } catch {}
  for (const dir of [polygramDir, sharedCwd]) fs.rmSync(dir, { recursive: true, force: true });
});

const runLegacy = (args, extraEnv = {}) => promisify(execFile)(process.execPath, [SCRIPT, ...args], {
  cwd: sharedCwd,
  env: { ...process.env, POLYGRAM_DIR: polygramDir, ...extraEnv },
}).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

describe('history skill scope', () => {
  test('a DM session can read another chat\'s history: the shared-cwd invocation must not return it', async () => {
    // Exactly what a member's DM session can run from the bot's shared cwd.
    const asked = await runLegacy(['recent', OPERATOR_DM]);
    assert.doesNotMatch(asked.stdout, /operatorsecret/, `the member session read the operator's DM:\n${asked.stdout}`);
    const searched = await runLegacy(['search', 'operatorsecret']);
    assert.doesNotMatch(searched.stdout, /operatorsecret/, `search crossed into the operator's DM:\n${searched.stdout}`);
    // The removed environment overrides and an explicit DB path do not reopen it.
    const widened = await runLegacy(['recent', OPERATOR_DM], { POLYGRAM_ADMIN: '1', CLAUDE_CHANNEL_BOT: BOT, POLYGRAM_DB: path.join(polygramDir, `${BOT}.db`) });
    assert.doesNotMatch(widened.stdout, /operatorsecret/, `an env override widened the scope:\n${widened.stdout}`);
    // Refused outright, not merely empty: a crash would also print nothing.
    for (const result of [asked, searched, widened]) {
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Usage: query\.js <bot> <token>/);
    }
  });
});

// The daemon side: a real history service behind the real IPC server, and the
// skill script invoked with the command polygram injects for each session.
describe('history skill: the daemon binds every read to the calling session', () => {
  let ipcDir;
  let ipc;
  let service;
  let otherCwd;

  before(async () => {
    const server = require('../lib/ipc/server');
    const { createIpcHandlers } = require('../lib/ipc/handlers');
    const { createHistoryService } = require('../lib/history-scope');
    // The IPC directory refuses temporary locations, as in production.
    ipcDir = fs.mkdtempSync(path.join(process.cwd(), '.hist-'));
    otherCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-elsewhere-')));
    service = createHistoryService({ config, db, botName: BOT, ipcDir });
    const options = { env: { POLYGRAM_IPC_DIR: ipcDir } };
    const secret = server.writeSecret(BOT, options);
    ipc = await server.start({ path: server.socketPathFor(BOT, options), secret, logger: { error() {}, log() {} }, handlers: createIpcHandlers({ history: service }) });
  });

  after(async () => {
    await ipc?.close();
    for (const dir of [ipcDir, otherCwd]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // Runs the script exactly as the injected command does, from a cwd and
  // environment that carry no scope at all.
  const run = (sessionKey, args, { cwd = otherCwd, env = {}, token = service.scope(sessionKey) } = {}) => promisify(execFile)(
    process.execPath, [SCRIPT, BOT, token, ...args],
    { cwd, env: { ...process.env, POLYGRAM_IPC_DIR: ipcDir, POLYGRAM_IPC_SECRET: '', ...env } },
  ).then((r) => ({ code: 0, rows: JSON.parse(r.stdout), stderr: r.stderr }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const texts = (result) => {
    assert.equal(result.code, 0, `the read failed: ${result.stderr}`);
    return result.rows.map((row) => row.text);
  };
  const refused = (result, pattern) => {
    assert.equal(result.code, 1, `expected a refusal, got exit ${result.code}: ${result.stdout}`);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stdout || '', /operatorsecret|memberown|ordertopic|billingtopic|generaltopic/);
  };

  test('the injected command names this script, the bot and a token bound to the session', () => {
    const block = service.instructions(MEMBER_DM);
    assert.ok(block.includes(JSON.stringify(SCRIPT)) && block.includes(JSON.stringify(BOT)));
    assert.ok(block.includes(JSON.stringify(service.scope(MEMBER_DM))));
    assert.ok(block.includes(`POLYGRAM_IPC_DIR=${JSON.stringify(ipcDir)}`));
    assert.notEqual(service.scope(MEMBER_DM), service.scope(OPERATOR_DM), 'each session has its own token');
  });

  test('the injected command line runs as written through a shell with a Codex-style bare environment', async () => {
    // Codex runs commands with inherit = "none": only HOME, TMPDIR and PATH,
    // none of them the daemon's. The command must carry everything else.
    const block = service.instructions(MEMBER_DM);
    const command = block.slice(block.indexOf('run ') + 4, block.indexOf(' recent ['));
    const env = { HOME: otherCwd, TMPDIR: otherCwd, PATH: '/usr/bin:/bin' };
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `${command} search shifts`], { cwd: otherCwd, env });
    assert.deepEqual(JSON.parse(stdout).map((row) => row.text), ['memberown question about shifts']);
  });

  test('every prompt mints a new token; the last few still read and older ones are refused', async () => {
    const minted = Array.from({ length: 6 }, () => /"([0-9a-f-]{36})"/.exec(service.instructions(SECOND_DM))[1]);
    assert.equal(new Set(minted).size, 6, 'each prompt carries a fresh token');
    assert.equal(service.scope(SECOND_DM), minted.at(-1));
    refused(await run(SECOND_DM, ['recent'], { token: minted[0] }), /use the history command from your current turn/);
    for (const token of minted.slice(1)) {
      assert.equal(service.query(token, { sub: 'recent' }).rows.length, 2, 'a recent command keeps working');
    }
  });

  test('a member DM session reads its own chat and nothing else', async () => {
    assert.deepEqual(texts(await run(MEMBER_DM, ['recent'])), ['memberown question about shifts']);
    refused(await run(MEMBER_DM, ['recent', OPERATOR_DM]), /only its own chat/);
    refused(await run(MEMBER_DM, ['recent', '--chat', OPERATOR_DM]), /only its own chat/);
    refused(await run(MEMBER_DM, ['search', 'operatorsecret', OPERATOR_DM]), /only its own chat/);
    assert.deepEqual(texts(await run(MEMBER_DM, ['search', 'operatorsecret'])), []);
    assert.deepEqual(texts(await run(MEMBER_DM, ['by-user', 'Operator'])), []);
    // Telegram message ids repeat across chats: both DMs have a message 1.
    assert.deepEqual(texts(await run(MEMBER_DM, ['msg', '1'])), ['memberown question about shifts']);
    refused(await run(MEMBER_DM, ['msg', '1', OPERATOR_DM]), /only its own chat/);
    assert.deepEqual(texts(await run(MEMBER_DM, ['around', '--msg-id', '1', '--before', '50', '--after', '50'])), ['memberown question about shifts']);
    const stats = await run(MEMBER_DM, ['stats', '--days', '30']);
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(stats.rows.map((row) => row.user), ['Member']);
  });

  test('--include-outbound false drops the bot\'s own messages', async () => {
    assert.deepEqual(texts(await run(SECOND_DM, ['recent'])), ['seconddm inbound', 'seconddm reply']);
    assert.deepEqual(texts(await run(SECOND_DM, ['recent', '--include-outbound', 'false'])), ['seconddm inbound']);
  });

  test('a deferred external job reuses its token on every retry, so a long human turn keeps its command', () => {
    const tokenOf = (block) => /"([0-9a-f-]{36})"/.exec(block)[1];
    const human = tokenOf(service.instructions(MEMBER_DM));
    const job = { routeId: 'session:1002', requestId: 'mailbox:m_0000000000000001' };
    const retries = Array.from({ length: 10 }, () => tokenOf(service.instructions(MEMBER_DM, job)));
    assert.equal(new Set(retries).size, 1, 'every retry of one job carries the same token');
    assert.equal(service.query(human, { sub: 'recent' }).rows.length, 1, 'the human turn\'s command still reads');
    const other = tokenOf(service.instructions(MEMBER_DM, { ...job, requestId: 'mailbox:m_0000000000000002' }));
    assert.notEqual(other, retries[0], 'another job gets its own token');
  });

  test('unquoted words, unknown flags and stray arguments are refused with a hint, not read as another chat', async () => {
    const plain = (result, pattern) => { assert.equal(result.code, 1); assert.match(result.stderr, pattern); };
    plain(await run(MEMBER_DM, ['by-user', 'Member', 'Ivanova']), /quote a multi-word term or name/);
    plain(await run(MEMBER_DM, ['search', 'invoice', 'march']), /quote a multi-word term or name/);
    plain(await run(MEMBER_DM, ['recent', '--topic', '12']), /unknown flag --topic/);
    plain(await run(MEMBER_DM, ['around', '1']), /use --msg-id N/);
    plain(await run(MEMBER_DM, ['dump']), /unknown subcommand: dump/);
  });

  test('Ivan\'s admin DM reads any chat of the bot, while a member DM still cannot', async () => {
    // The admin chat is the bot's adminChatId; the daemon knows which session
    // a token was minted for, so no argument can claim it.
    assert.deepEqual(texts(await run(OPERATOR_DM, ['recent'])), ['operatorsecret salary figures'], 'without --chat the admin reads its own chat');
    assert.deepEqual(texts(await run(OPERATOR_DM, ['recent', '--chat', MEMBER_DM])), ['memberown question about shifts']);
    assert.deepEqual(texts(await run(OPERATOR_DM, ['recent', MEMBER_DM])), ['memberown question about shifts'], 'the legacy positional chat id works for the admin');
    assert.deepEqual(texts(await run(OPERATOR_DM, ['search', 'invoice', '--chat', FORUM, '--thread', '12'])), ['billingtopic invoice']);
    assert.deepEqual(texts(await run(OPERATOR_DM, ['search', 'memberown', '--chat', 'all'])), ['memberown question about shifts']);
    assert.deepEqual(texts(await run(OPERATOR_DM, ['msg', '1', '--chat', MEMBER_DM])), ['memberown question about shifts']);
    refused(await run(MEMBER_DM, ['recent', '--chat', OPERATOR_DM]), /only its own chat/);
    refused(await run(MEMBER_DM, ['search', 'operatorsecret', '--chat', 'all']), /only its own chat/);
  });

  test('the admin tier has edges: one chat for recent/around/msg, only the bot\'s chats, and it follows the live config', async () => {
    const plain = (result, pattern) => { assert.equal(result.code, 1); assert.match(result.stderr, pattern); };
    plain(await run(OPERATOR_DM, ['recent', '--chat', 'all']), /name one chat/);
    plain(await run(OPERATOR_DM, ['search', 'invoice', '--chat', 'all', '--thread', '11']), /--thread needs one chat/);
    refused(await run(OPERATOR_DM, ['recent', '--chat', '999999']), /Not a chat of this bot/);
    assert.deepEqual(texts(await run(OPERATOR_DM, ['search', 'invoice', '--chat', 'all'])).sort(), ['billingtopic invoice', 'ordertopic invoice']);
    assert.match(service.instructions(OPERATOR_DM), /--chat all/);
    assert.doesNotMatch(service.instructions(MEMBER_DM), /--chat/);
    // Revoking adminChatId in the live config revokes the tier at once.
    const live = JSON.parse(JSON.stringify(config));
    const svc = createHistoryServiceFor(live);
    const token = svc.scope(OPERATOR_DM);
    assert.equal(svc.query(token, { sub: 'recent', chatId: MEMBER_DM }).rows.length, 1);
    delete live.bot.adminChatId;
    assert.throws(() => svc.query(token, { sub: 'recent', chatId: MEMBER_DM }), /only its own chat/);
  });

  test('a job turn in the admin chat gets own-chat reach only, and its send demotes the admin\'s earlier commands', () => {
    // Any same-user process can submit an external job or mailbox message into
    // the admin chat, so a job-started turn must not carry the admin tier.
    const tokenOf = (block) => /"([0-9a-f-]{36})"/.exec(block)[1];
    const humanBlock = service.instructions(OPERATOR_DM);
    const human = tokenOf(humanBlock);
    const job = { routeId: 'session:1001', requestId: 'external:probe-1', target: { sessionKey: OPERATOR_DM } };
    const jobBlock = service.instructions(OPERATOR_DM, job);
    const jobToken = tokenOf(jobBlock);
    assert.doesNotMatch(jobBlock, /--chat/, 'a job prompt does not advertise admin reach');
    assert.throws(() => service.query(jobToken, { sub: 'search', query: 'memberown', chatId: 'all' }), /only its own chat/);
    assert.equal(service.query(jobToken, { sub: 'recent' }).rows.length, 1, 'the job turn still reads its own chat');
    // Deferred, the job has not reached the session: the human turn keeps admin.
    assert.equal(service.query(human, { sub: 'recent', chatId: MEMBER_DM }).rows.length, 1);
    service.noteJobSend(job);
    assert.throws(() => service.query(human, { sub: 'recent', chatId: MEMBER_DM }), /only its own chat/,
      'once the job prompt is sent, an older command in the session context no longer reaches other chats');
    const next = tokenOf(service.instructions(OPERATOR_DM));
    assert.equal(service.query(next, { sub: 'recent', chatId: MEMBER_DM }).rows.length, 1, 'the next human prompt brings admin reach back');
  });

  test('a group set as adminChatId grants no cross-chat read to its sessions', () => {
    const svc = createHistoryServiceFor({ ...config, bot: { adminChatId: Number(FORUM) } });
    assert.throws(() => svc.query(svc.scope(FORUM), { sub: 'recent', chatId: MEMBER_DM }), /only its own chat/);
    assert.throws(() => svc.query(svc.scope(`${FORUM}:11`), { sub: 'search', query: 'operatorsecret', chatId: 'all' }), /only its own chat/);
  });

  test('an isolated topic reads only its topic, and the General topic only rows without a thread', async () => {
    const orders = `${FORUM}:11`;
    assert.deepEqual(texts(await run(orders, ['search', 'invoice'])), ['ordertopic invoice']);
    assert.deepEqual(texts(await run(orders, ['recent'])), ['ordertopic invoice']);
    refused(await run(orders, ['recent', FORUM, '12']), /only its own topic/);
    refused(await run(orders, ['stats', '--thread', '12']), /only its own topic/);
    assert.deepEqual(texts(await run(orders, ['msg', '3'])), [], 'a sibling topic\'s message is not reachable by id');
    assert.deepEqual(texts(await run(orders, ['around', '--msg-id', '2', '--before', '50', '--after', '50'])), ['ordertopic invoice']);
    assert.deepEqual(texts(await run(orders, ['by-user', 'Member', '--days', '30'])), ['ordertopic invoice']);
    const stats = await run(orders, ['stats', '--days', '30']);
    assert.equal(stats.code, 0, stats.stderr);
    assert.deepEqual(stats.rows.map((row) => [row.user, row.count]), [['Member', 1]]);
    assert.deepEqual(texts(await run(FORUM, ['msg', '2'])), [], 'the General topic cannot fetch a topic message by id');
    assert.deepEqual(texts(await run(FORUM, ['by-user', 'Member', '--days', '30'])), ['generaltopic hello']);
    assert.deepEqual(texts(await run(FORUM, ['recent'])), ['generaltopic hello']);
    assert.deepEqual(texts(await run(FORUM, ['search', 'invoice'])), []);
    refused(await run(FORUM, ['recent', '--thread', '11']), /only its own topic/);
  });

  test('a chat-wide session reads every topic of its own chat and may narrow to one', async () => {
    const wide = createHistoryServiceFor({ ...config, chats: { ...config.chats, [FORUM]: { bot: BOT, cwd: sharedCwd } } });
    assert.deepEqual(wide.query(wide.scope(FORUM), { sub: 'search', query: 'invoice' }).rows.map((row) => row.text).sort(), ['billingtopic invoice', 'ordertopic invoice']);
    assert.deepEqual(wide.query(wide.scope(FORUM), { sub: 'search', query: 'invoice', threadId: '12' }).rows.map((row) => row.text), ['billingtopic invoice']);
    assert.throws(() => wide.query(wide.scope(FORUM), { sub: 'recent', chatId: MEMBER_DM }), /only its own chat/);
  });

  test('nothing but a live token opens a read: forged tokens, env overrides and cwd are ignored', async () => {
    refused(await run(MEMBER_DM, ['recent'], { token: '00000000-0000-4000-8000-000000000000' }), /scope is not valid/);
    refused(await run(MEMBER_DM, ['recent', OPERATOR_DM], { token: OPERATOR_DM }), /scope is not valid/);
    // The member's own token, with every environment knob the old skill read
    // and the bot's shared cwd, still reads only the member's chat.
    const env = { POLYGRAM_ADMIN: '1', CLAUDE_CHANNEL_BOT: BOT, POLYGRAM_DIR: polygramDir, POLYGRAM_DB: path.join(polygramDir, `${BOT}.db`) };
    assert.deepEqual(texts(await run(MEMBER_DM, ['search', 'operatorsecret'], { cwd: sharedCwd, env })), []);
    refused(await run(MEMBER_DM, ['recent', OPERATOR_DM], { cwd: sharedCwd, env }), /only its own chat/);
  });

  test('a chat removed from the config stops being readable at once', () => {
    const live = { ...config, chats: { ...config.chats } };
    const svc = createHistoryServiceFor(live);
    const token = svc.scope(MEMBER_DM);
    assert.equal(svc.query(token, { sub: 'recent' }).rows.length, 1);
    delete live.chats[MEMBER_DM];
    assert.throws(() => svc.query(token, { sub: 'recent' }), /scope is not valid/);
  });

  test('the daemon refuses unknown fields and subcommands instead of ignoring them', () => {
    const token = service.scope(MEMBER_DM);
    assert.throws(() => service.query(token, { sub: 'recent', allowedChatIds: null }), /Unknown history field/);
    assert.throws(() => service.query(token, { sub: 'dump' }), /Unknown history subcommand/);
    assert.throws(() => service.query(token, { sub: 'recent', chatId: { toString: () => MEMBER_DM } }), /Invalid history chat/);
    assert.throws(() => service.query(token, { sub: 'search', query: ['operatorsecret'] }), /Invalid history search term/);
    assert.equal(service.query(token, { sub: 'recent', chatId: Number(MEMBER_DM) }).rows.length, 1, 'a numeric own chat id is accepted');
  });

  test('without a database the service hands out no command', () => {
    const { createHistoryService } = require('../lib/history-scope');
    const none = createHistoryService({ config, db: null, botName: BOT });
    assert.equal(none.scope(MEMBER_DM), null);
    assert.equal(none.instructions(MEMBER_DM), '');
  });

  test('history_query passes the token separately and strips transport fields', async () => {
    const { createIpcHandlers } = require('../lib/ipc/handlers');
    const seen = [];
    const handlers = createIpcHandlers({ history: { query: (token, input) => { seen.push([token, input]); return { rows: [] }; } } });
    await handlers.history_query({ op: 'history_query', id: 'x', secret: 's', token: 'tok', sub: 'recent' });
    assert.deepEqual(seen, [['tok', { sub: 'recent' }]]);
    await assert.rejects(async () => createIpcHandlers().history_query({ token: 't', sub: 'recent' }), /not available/);
  });
});

// polygram.js wires services at module scope, where it cannot be imported in
// isolation; these checks pin the wiring the tests above rely on.
describe('history skill wiring in the daemon', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');
  test('every human prompt carries the session\'s history command', () => {
    const start = src.indexOf('function formatPrompt(');
    const format = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(format, /historyService\?\.instructions\(sessionKey\)/);
  });
  test('external jobs carry it too, and the IPC server serves the same service', () => {
    assert.match(src, /historyService = createHistoryService\(\{ config, db, botName: BOT_NAME, ipcDir: ipcRuntimeDir \}\)/);
    assert.match(src, /createExternalJobDispatch\(\{[\s\S]*?getHistory: \(\) => historyService,/);
    assert.match(src, /createIpcHandlers\(\{[\s\S]*?history: historyService,/);
  });
  test('the fresh-session preload no longer points at a cwd-scoped invocation', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'lib', 'history-preload.js'), 'utf8');
    assert.doesNotMatch(preload, /auto-resolved from cwd|node skills\/history\/scripts\/query\.js/);
  });
});

function createHistoryServiceFor(cfg) {
  const { createHistoryService } = require('../lib/history-scope');
  return createHistoryService({ config: cfg, db, botName: BOT });
}
