/**
 * Pre-durable-write secret boundary — policy + the real SQLite/FTS chain.
 *
 * WHY each behavior matters:
 *  - The live provider turn must keep the ORIGINAL text (the user asked the
 *    agent about that credential); only the durable copy is masked.
 *  - messages.text feeds the external-content FTS index through triggers, so a
 *    raw credential in any text sink is also a raw credential in the index.
 *  - Durable error columns and events.detail_json are text sinks too: an error
 *    string or a telemetry payload can echo the inbound/provider content.
 *  - A narrow allowlist keeps obvious non-secret vocabulary ("password:
 *    required") readable — the boundary must not destroy ordinary prose.
 *  - Arbitrary prose with no detectable signal is NOT claimed to be caught;
 *    that limit is asserted so nobody reads the boundary as universal.
 *
 * Run: node --test tests/durable-secret-boundary.test.js   (FAKE secrets only)
 */
'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { createRecordInbound } = require('../lib/handlers/record-inbound');
const { createTranscribeVoiceAttachments } = require('../lib/handlers/voice');
const { sanitizeForDurableWrite, sanitizeDurableStructured } = require('../lib/secret-detect');
const { sweepSecrets } = require('../lib/db/secret-sweep');
const { createStore: createApprovalsStore } = require('../lib/approvals/store');
const { createQuestionStore } = require('../lib/questions/store');
const { createQuestionHandlers } = require('../lib/handlers/questions');

// Every fixture below is fake. Token bodies are assembled with repeat() so no
// contiguous provider-key-shaped literal exists in this source file.
const KV_SECRET = 'hunter2-fake-value';
const KV_TEXT = `the db password: ${KV_SECRET} — rotate it`;
const ALLOWED_TEXT = 'password: required for the staging box';
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const BEARER = `${'aB1x'.repeat(8)}`;
const PROSE_SECRET = 'swordfish-fake-value';
const PROSE_TEXT = `my password is ${PROSE_SECRET}, don't tell anyone`;

let db; let dbPath;

const textOf = (chatId, msgId) => db.raw
  .prepare('SELECT text FROM messages WHERE chat_id=? AND msg_id=?')
  .get(String(chatId), msgId).text;

const ftsHits = (term) => db.raw
  .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
  .all(term).length;

const lastDetail = (kind) => db.raw
  .prepare('SELECT detail_json FROM events WHERE kind=? ORDER BY id DESC LIMIT 1')
  .get(kind).detail_json;

describe('durable-write secret policy (pure)', () => {
  test('key/value credential value is masked, key text survives', () => {
    const res = sanitizeForDurableWrite(KV_TEXT);
    assert.ok(res.changed);
    assert.ok(!res.text.includes(KV_SECRET), res.text);
    assert.match(res.text, /password: ‹redacted:kv-secret›/);
    assert.deepEqual(res.masked.map((m) => m.rule), ['kv-secret']);
  });

  test('allowlisted non-secret vocabulary stays intact and is not masked', () => {
    const res = sanitizeForDurableWrite(ALLOWED_TEXT);
    assert.equal(res.text, ALLOWED_TEXT);
    assert.equal(res.changed, false);
    assert.deepEqual(res.masked, []);
    assert.deepEqual(res.allowed.map((a) => a.rule), ['kv-secret']);
  });

  test('trailing punctuation does not defeat the allowlist', () => {
    const res = sanitizeForDurableWrite('password: required.');
    assert.equal(res.text, 'password: required.');
    assert.equal(res.changed, false);
  });

  test('prose-form credential is masked (deterministic shape only)', () => {
    const res = sanitizeForDurableWrite(PROSE_TEXT);
    assert.ok(!res.text.includes(PROSE_SECRET), res.text);
    assert.deepEqual(res.masked.map((m) => m.rule), ['prose-secret']);
  });

  test('prose-form allowlist keeps "my password is required"', () => {
    const res = sanitizeForDurableWrite('my password is required');
    assert.equal(res.changed, false);
  });

  test('known-shape credentials are masked at the durable boundary', () => {
    assert.ok(!sanitizeForDurableWrite(`key ${AWS} x`).text.includes(AWS));
    assert.ok(!sanitizeForDurableWrite(`Authorization: Bearer ${BEARER}`).text.includes(BEARER));
  });

  test('arbitrary prose with no detectable signal is left alone (documented limit)', () => {
    // The boundary is deterministic shape/keyword detection, NOT semantic
    // understanding. This asserts the honest scope: an undeclared credential
    // in free prose passes through, which is why the publisher re-checks.
    const prose = 'the thing I told you about yesterday still opens the box';
    const res = sanitizeForDurableWrite(prose);
    assert.equal(res.text, prose);
    assert.equal(res.changed, false);
  });

  test('masking is idempotent — a masked value is not re-wrapped', () => {
    const once = sanitizeForDurableWrite(KV_TEXT).text;
    const twice = sanitizeForDurableWrite(once);
    assert.equal(twice.text, once);
    assert.equal(twice.changed, false);
  });

  test('detail sanitizer walks nested objects and arrays, keeps shape', () => {
    const out = sanitizeDurableStructured({
      chat_id: '1',
      text: KV_TEXT,
      nested: { list: [`Bearer ${BEARER}`, 'fine'], n: 7, ok: true, nil: null },
    });
    const json = JSON.stringify(out);
    assert.ok(!json.includes(KV_SECRET));
    assert.ok(!json.includes(BEARER));
    assert.equal(out.nested.list[1], 'fine');
    assert.equal(out.nested.n, 7);
    assert.equal(out.nested.ok, true);
    assert.equal(out.nested.nil, null);
  });
});

// Structured payloads are sanitized as VALUES, before serialization. Masking
// the serialized JSON instead misses any value whose quotes the serializer
// escaped, and can corrupt the document when a match spans a delimiter.
describe('structured sanitization before serialization', () => {
  test('a value the serializer would escape is still masked', () => {
    const input = { command: `login --password "${KV_SECRET}" --user me` };
    const out = sanitizeDurableStructured(input);
    const json = JSON.stringify(out);
    assert.ok(!json.includes(KV_SECRET), json);
    assert.equal(input.command.includes(KV_SECRET), true, 'input is never mutated');
  });

  test('escaped-quote text masks structurally where a string pass would miss it', () => {
    // Serializing first turns `password: "x"` into `password: \"x\"`, and the
    // value pattern no longer sees a quoted value at that position.
    const raw = { note: `password: "${KV_SECRET}"` };
    const serializedThenMasked = sanitizeForDurableWrite(JSON.stringify(raw)).text;
    const structured = JSON.stringify(sanitizeDurableStructured(raw));
    assert.ok(!structured.includes(KV_SECRET), structured);
    assert.equal(JSON.parse(structured).note.startsWith('password:'), true);
    assert.ok(typeof serializedThenMasked === 'string');
  });

  test('arrays and nesting keep their shape', () => {
    const out = sanitizeDurableStructured({
      opts: [{ env: { TOKEN: `token=${KV_SECRET}` } }, 'plain', 3, false, null],
    });
    assert.equal(Array.isArray(out.opts), true);
    assert.equal(out.opts[1], 'plain');
    assert.equal(out.opts[2], 3);
    assert.equal(out.opts[3], false);
    assert.equal(out.opts[4], null);
    assert.ok(!out.opts[0].env.TOKEN.includes(KV_SECRET));
  });

  test('a credential-named field is masked even with no prefix in the value', () => {
    // A structured tool input names the credential in the KEY, so the value
    // carries no `password:` prefix for the text rules to find. The key is
    // the declaration here.
    const input = { password: KV_SECRET, user: 'me' };
    const out = sanitizeDurableStructured(input);
    assert.ok(!JSON.stringify(out).includes(KV_SECRET), JSON.stringify(out));
    assert.equal(out.user, 'me', 'only the credential field is touched');
    assert.equal(input.password, KV_SECRET, 'the caller keeps its original');
  });

  test('environment-style and camelCase credential keys are covered', () => {
    const out = sanitizeDurableStructured({
      env: { DB_PASSWORD: KV_SECRET, GITHUB_TOKEN: `ghp_${'a'.repeat(36)}` },
      apiKey: KV_SECRET,
      'x-api-key': KV_SECRET,
      client_secret: KV_SECRET,
      secrets: [{ passphrase: KV_SECRET }],
    });
    const json = JSON.stringify(out);
    assert.ok(!json.includes(KV_SECRET), json);
    assert.ok(!json.includes('ghp_'), json);
    assert.equal(out.secrets[0].passphrase, '‹redacted:kv-secret›');
  });

  test('credential context reaches nested objects and arrays', () => {
    // A structured input can wrap the value: {"password":{"value":"…"}}. The
    // declaration is still the outer key, so the descendant leaves inherit it.
    const nested = sanitizeDurableStructured({ password: { value: KV_SECRET } });
    assert.equal(nested.password.value, '‹redacted:kv-secret›');

    const listed = sanitizeDurableStructured({
      credentials: [{ user: 'me', value: KV_SECRET }, KV_SECRET],
    });
    assert.equal(listed.credentials[0].value, '‹redacted:kv-secret›');
    assert.equal(listed.credentials[0].user, '‹redacted:kv-secret›',
      'every leaf under a credential key is masked, not just the likely one');
    assert.equal(listed.credentials[1], '‹redacted:kv-secret›');
  });

  test('allowlisted markers survive inherited credential context', () => {
    const out = sanitizeDurableStructured({
      password: { value: 'required', rotated: '‹redacted:kv-secret›' },
    });
    assert.deepEqual(out.password, { value: 'required', rotated: '‹redacted:kv-secret›' });
  });

  test('a key that itself carries a detectable secret is not persisted raw', () => {
    const keyed = { [`sk-ant-${'a'.repeat(28)}`]: 'v', command: 'npm test' };
    const out = sanitizeDurableStructured(keyed);
    const json = JSON.stringify(out);
    assert.ok(!json.includes('sk-ant-'), json);
    assert.equal(out.command, 'npm test', 'ordinary keys are untouched');
  });

  test('unsupported values cannot make the durable document unserializable', () => {
    // A BigInt throws inside JSON.stringify. The sanitized value must always
    // serialize, or the write is lost with no record of why.
    const out = sanitizeDurableStructured({ big: 10n, keep: 'ok', nested: { big: 1n } });
    let json;
    assert.doesNotThrow(() => { json = JSON.stringify(out); });
    assert.deepEqual(JSON.parse(json), { keep: 'ok', nested: {} });
  });

  test('key-awareness does not swallow ordinary keys or allowlisted values', () => {
    const out = sanitizeDurableStructured({
      cache_key: 'user-42', sort_key: 'name', keyboard: 'qwerty',
      password: 'required', token: '‹redacted:kv-secret›',
    });
    assert.deepEqual(out, {
      cache_key: 'user-42', sort_key: 'name', keyboard: 'qwerty',
      password: 'required', token: '‹redacted:kv-secret›',
    });
  });

  test('non-plain objects are dropped, never passed through', () => {
    class Weird { constructor() { this.secret = KV_SECRET; } }
    const out = sanitizeDurableStructured({
      when: new Date(0), map: new Map([['a', KV_SECRET]]),
      fn: () => KV_SECRET, weird: new Weird(), keep: 'ok',
    });
    assert.deepEqual(Object.keys(out), ['keep']);
    assert.ok(!JSON.stringify(out).includes(KV_SECRET));
  });

  test('a non-plain root yields an empty object rather than leaking', () => {
    assert.deepEqual(sanitizeDurableStructured(new Map([['a', KV_SECRET]])), {});
  });
});

describe('declared credential values are captured completely', () => {
  test('a quoted value with spaces is masked whole', () => {
    const res = sanitizeForDurableWrite('password: "correct horse battery" ok');
    assert.ok(!res.text.includes('correct horse battery'), res.text);
    assert.match(res.text, /password: "‹redacted:kv-secret›" ok/);
  });

  test('a single-quoted value is masked whole', () => {
    const res = sanitizeForDurableWrite("api_key='ab cd ef gh' next");
    assert.ok(!res.text.includes('ab cd ef gh'), res.text);
  });

  test('an unquoted multiword value is masked to a safe delimiter', () => {
    const res = sanitizeForDurableWrite('password: correct horse battery, then call me');
    assert.ok(!res.text.includes('correct horse battery'), res.text);
    assert.match(res.text, /, then call me$/, 'the delimiter ends the masked span');
  });

  test('a short explicit assignment is masked', () => {
    const res = sanitizeForDurableWrite('password=abc');
    assert.equal(res.text, 'password=‹redacted:kv-secret›');
  });

  test('the benign allowlist still survives, including multiword prose', () => {
    for (const t of ['password: required', 'password: required for the staging box',
      'secret: none', 'token: unset', 'password is required']) {
      assert.equal(sanitizeForDurableWrite(t).changed, false, t);
    }
  });

  test('an escaped-quote assignment in a raw string is still masked', () => {
    const res = sanitizeForDurableWrite(`{"cmd":"deploy --password=\\"${KV_SECRET}\\""}`);
    assert.ok(!res.text.includes(KV_SECRET), res.text);
  });
});

describe('durable text sinks mask before SQLite/FTS', () => {
  beforeEach(() => { ({ db, dbPath } = freshDb('durable-secret')); });
  afterEach(() => cleanupDb(dbPath, db));

  test('recordInbound: durable row + FTS carry no raw secret, live msg untouched', () => {
    const handler = createRecordInbound({
      db,
      dbWrite: (fn) => fn(),
      config: { chats: { 100: { model: 'sonnet' } } },
      botName: 'testbot',
      extractAttachments: () => [],
    });
    const msg = {
      message_id: 1, chat: { id: 100 }, date: 1700000000,
      from: { id: 42, first_name: 'Operator' },
      text: KV_TEXT,
    };
    handler(msg);

    assert.equal(msg.text, KV_TEXT, 'the live turn keeps the original text');
    assert.ok(!textOf(100, 1).includes(KV_SECRET), textOf(100, 1));
    assert.equal(ftsHits('"hunter2-fake-value"'), 0, 'secret must not be searchable');
  });

  test('recordInbound: caption path is masked too', () => {
    const handler = createRecordInbound({
      db,
      dbWrite: (fn) => fn(),
      config: { chats: {} },
      botName: 'testbot',
      extractAttachments: () => [],
    });
    handler({
      message_id: 2, chat: { id: 100 }, date: 1700000000,
      from: { id: 42 }, caption: `see ${AWS}`,
    });
    assert.ok(!textOf(100, 2).includes(AWS));
  });

  test('recordInbound: allowlisted prose is stored intact and stays searchable', () => {
    const handler = createRecordInbound({
      db,
      dbWrite: (fn) => fn(),
      config: { chats: {} },
      botName: 'testbot',
      extractAttachments: () => [],
    });
    handler({
      message_id: 3, chat: { id: 100 }, date: 1700000000,
      from: { id: 42 }, text: ALLOWED_TEXT,
    });
    assert.equal(textOf(100, 3), ALLOWED_TEXT);
    assert.equal(ftsHits('required'), 1);
  });

  test('insertMessage upsert (edited message) re-masks the new text', () => {
    const row = {
      chat_id: '100', msg_id: 4, direction: 'in', bot_name: 'testbot',
      text: 'harmless', ts: 1,
    };
    db.insertMessage(row);
    db.insertMessage({ ...row, text: PROSE_TEXT });
    assert.ok(!textOf(100, 4).includes(PROSE_SECRET), textOf(100, 4));
    assert.equal(ftsHits('"swordfish-fake-value"'), 0);
  });

  test('insertMessage: durable error column is masked', () => {
    db.insertMessage({
      chat_id: '100', msg_id: 5, direction: 'out', text: 'ok',
      status: 'failed', error: `send failed: Bearer ${BEARER}`, ts: 1,
    });
    const { error } = db.raw.prepare('SELECT error FROM messages WHERE chat_id=? AND msg_id=?').get('100', 5);
    assert.ok(!error.includes(BEARER), error);
  });

  test('insertOutboundPending masks the pending reply text', () => {
    const res = db.insertOutboundPending({
      chat_id: '100', text: KV_TEXT, pending_id: -1, ts: 1, bot_name: 'testbot',
    });
    const row = db.raw.prepare('SELECT text FROM messages WHERE id=?').get(res.lastInsertRowid);
    assert.ok(!row.text.includes(KV_SECRET), row.text);
    assert.equal(ftsHits('"hunter2-fake-value"'), 0);
  });

  test('updateOutboundText masks the finalized reply body and purges FTS', () => {
    db.insertMessage({ chat_id: '100', msg_id: 6, direction: 'out', text: 'partial', ts: 1 });
    db.updateOutboundText({ chat_id: '100', msg_id: 6, text: `full answer ${AWS}` });
    assert.ok(!textOf(100, 6).includes(AWS), textOf(100, 6));
    assert.equal(ftsHits(AWS), 0);
  });

  test('markOutboundFailed masks the persisted send error', () => {
    const res = db.insertOutboundPending({
      chat_id: '100', text: 'hi', pending_id: -2, ts: 1, bot_name: 'testbot',
    });
    db.markOutboundFailed(res.lastInsertRowid, new Error(`401 for key ${AWS}`));
    const row = db.raw.prepare('SELECT error FROM messages WHERE id=?').get(res.lastInsertRowid);
    assert.ok(!row.error.includes(AWS), row.error);
  });

  test('a truncated error never keeps half a placeholder', () => {
    // markOutboundFailed caps the stored error. Cutting mid-placeholder would
    // leave `‹redacted:kv-sec` — text that reads as ordinary content and no
    // longer survives a second masking pass unchanged.
    const res = db.insertOutboundPending({
      chat_id: '100', text: 'hi', pending_id: -9, ts: 1, bot_name: 'testbot',
    });
    const filler = 'x'.repeat(490);
    db.markOutboundFailed(res.lastInsertRowid, new Error(`${filler} password: ${KV_SECRET}`));
    const { error } = db.raw.prepare('SELECT error FROM messages WHERE id=?').get(res.lastInsertRowid);
    assert.ok(!error.includes(KV_SECRET), error);
    assert.ok(error.length <= 500);
    const opens = (error.match(/‹/g) || []).length;
    const closes = (error.match(/›/g) || []).length;
    assert.equal(opens, closes, `unbalanced placeholder in ${JSON.stringify(error)}`);
  });

  test('an open question keeps neither the agent question nor a flagged answer', async () => {
    // The last durable sink in `pending_questions`: both the provider's
    // question array and the user's typed answer used to sit in `state_json`
    // exactly, for as long as the prompt stayed open.
    const store = createQuestionStore(db.raw);
    const handlers = createQuestionHandlers({
      questions: store, bot: {}, botName: 'testbot', logEvent: () => {},
      logger: { error: () => {} },
      answerQuestion: () => true,
      tg: async (_b, method) => (method === 'sendMessage' ? { message_id: 1 } : { ok: true }),
    });
    await handlers.renderAsk({
      sessionKey: '100:main', chatId: '100', toolCallId: 'tc-durable',
      questions: [
        { header: 'Creds', question: `use ${KV_TEXT}?`, options: [{ label: 'skip' }] },
        { header: 'Next', question: 'anything else?', options: [{ label: 'no' }] },
      ],
    });
    const row = store.getOpenForSession('100:main');
    const tap = (action, token) => handlers.handleQuestionCallback({
      callbackQuery: { data: `q:${row.id}:${token}:${action}` },
      from: { id: 7 },
      answerCallbackQuery: async () => {},
    });
    const rawRow = () => db.raw
      .prepare('SELECT questions_json, state_json, status FROM pending_questions WHERE id=?')
      .get(row.id);

    assert.ok(!JSON.stringify(rawRow()).includes(KV_SECRET), 'at issue');
    await tap('other', row.callback_token);
    assert.ok(!JSON.stringify(rawRow()).includes(KV_SECRET), 'awaiting a typed answer');
    await handlers.tryConsumeAsAnswer({ sessionKey: '100:main', fromId: 7, text: `my ${KV_TEXT}` });
    const mid = rawRow();
    assert.equal(mid.status, 'pending', 'the window this closes is the pending one');
    assert.ok(!JSON.stringify(mid).includes(KV_SECRET), 'after the flagged answer');
    await tap('opt:0', store.getById(row.id).callback_token);
    assert.ok(!JSON.stringify(rawRow()).includes(KV_SECRET), 'after completion');
    assert.equal(handlers.liveAnswerCount(), 0);
  });

  test('setMessageText (voice transcript) masks before the FTS update trigger', () => {
    db.insertMessage({ chat_id: '100', msg_id: 7, direction: 'in', text: '', ts: 1 });
    db.setMessageText({ chat_id: '100', msg_id: 7, text: PROSE_TEXT });
    assert.ok(!textOf(100, 7).includes(PROSE_SECRET), textOf(100, 7));
    assert.equal(ftsHits('"swordfish-fake-value"'), 0);
  });

  test('setAttachmentTranscription masks the stored transcription JSON', () => {
    db.insertMessage({ chat_id: '100', msg_id: 8, direction: 'in', text: '', ts: 1 });
    const messageId = db.getInboundMessageId({ chat_id: '100', msg_id: 8 });
    db.insertAttachment({
      message_id: messageId, chat_id: '100', msg_id: 8, kind: 'voice',
      file_id: 'f1', name: 'v.ogg', ts: 1,
    });
    const attId = db.getAttachmentsByMessage(messageId)[0].id;
    db.setAttachmentTranscription(attId, JSON.stringify({ text: KV_TEXT, provider: 'openai' }));
    const { transcription } = db.raw.prepare('SELECT transcription FROM attachments WHERE id=?').get(attId);
    assert.ok(!transcription.includes(KV_SECRET), transcription);
    assert.equal(JSON.parse(transcription).provider, 'openai', 'stays valid JSON');
  });

  test('logEvent masks raw content anywhere in the detail payload', () => {
    db.logEvent('compact-command', {
      chat_id: '100', session_key: '100:main', text_len: KV_TEXT.length,
      text: KV_TEXT,
      nested: { probe: `Bearer ${BEARER}` },
    });
    const raw = lastDetail('compact-command');
    assert.ok(!raw.includes(KV_SECRET), raw);
    assert.ok(!raw.includes(BEARER), raw);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.session_key, '100:main', 'content-free fields survive');
    assert.equal(parsed.text_len, KV_TEXT.length);
  });

  test('logEvent drops a prose field and records only its name', () => {
    db.logEvent('handler-error', {
      chat_id: '100', error: ALLOWED_TEXT, error_class: 'Error', msg_id: 4,
    });
    const detail = JSON.parse(lastDetail('handler-error'));
    assert.equal(detail.error, undefined, 'prose has no field to ride in on');
    assert.equal(detail.error_class, 'Error', 'the typed classification survives');
    assert.equal(detail.msg_id, 4);
    assert.deepEqual(detail.dropped_fields, ['error']);
  });

  test('voice handler persists a masked transcript to both sinks', async () => {
    db.insertMessage({ chat_id: '100', msg_id: 9, direction: 'in', text: '', ts: 1 });
    const messageId = db.getInboundMessageId({ chat_id: '100', msg_id: 9 });
    db.insertAttachment({
      message_id: messageId, chat_id: '100', msg_id: 9, kind: 'voice',
      file_id: 'f2', name: 'v.ogg', ts: 1,
    });
    const att = db.getAttachmentsByMessage(messageId)[0];
    const downloaded = [{ ...att, path: '/tmp/fake.ogg' }];

    const transcribe = createTranscribeVoiceAttachments({
      config: { voice: { enabled: true, provider: 'openai', ackReaction: null } },
      db,
      dbWrite: (fn) => fn(),
      tg: async () => ({}),
      logEvent: (kind, detail) => db.logEvent(kind, detail),
      transcribeVoice: async () => ({
        text: KV_TEXT, provider: 'openai', language: 'en', duration_sec: 2, cost_usd: 0,
      }),
      isVoiceAttachment: () => true,
      botName: 'testbot',
      logger: { log: () => {}, error: () => {} },
    });
    await transcribe(downloaded, { chatId: '100', msgId: 9, label: 'test' });

    assert.equal(downloaded[0].transcription.text, KV_TEXT, 'live prompt keeps the original transcript');
    assert.ok(!textOf(100, 9).includes(KV_SECRET), textOf(100, 9));
    const { transcription } = db.raw
      .prepare('SELECT transcription FROM attachments WHERE id=?').get(att.id);
    assert.ok(!transcription.includes(KV_SECRET), transcription);
    assert.equal(ftsHits('"hunter2-fake-value"'), 0);
  });

  test('the background sweep stays defense-in-depth over already-masked rows', () => {
    db.insertMessage({ chat_id: '100', msg_id: 12, direction: 'in', text: KV_TEXT, ts: 1 });
    db.insertMessage({ chat_id: '100', msg_id: 13, direction: 'in', text: ALLOWED_TEXT, ts: 1 });
    const before = textOf(100, 12);
    sweepSecrets(db.raw, { now: 1_800_000_000_000 });
    assert.equal(textOf(100, 12), before, 'the sweep neither restores nor re-wraps the masked value');
    assert.equal(textOf(100, 13), ALLOWED_TEXT, 'allowlisted prose survives both layers');
  });

  test('approval rows store a masked tool input and never mutate the live call', () => {
    const approvals = createApprovalsStore(db.raw);
    const liveInput = { command: `curl -H "Authorization: Bearer ${BEARER}" https://x` };
    const row = approvals.issue({
      bot_name: 'testbot', requester_chat_id: '100', approver_chat_id: '200',
      tool_name: 'Bash', tool_input: liveInput, tool_use_id: 'tu-1',
    });
    assert.equal(liveInput.command.includes(BEARER), true,
      'the input the tool will execute with is untouched');
    assert.ok(!row.tool_input_json.includes(BEARER), row.tool_input_json);
    const stored = db.raw
      .prepare('SELECT tool_input_json, tool_input_digest FROM pending_approvals WHERE id=?')
      .get(row.id);
    assert.ok(!stored.tool_input_json.includes(BEARER));
    assert.equal(JSON.parse(stored.tool_input_json).command.startsWith('curl -H'), true,
      'the operation stays legible to the approver');
    // The dedupe digest is computed over the masked input, so it is no longer
    // a fingerprint of the credential — and still deterministic.
    assert.ok(!stored.tool_input_digest.includes(BEARER));
    const again = approvals.issue({
      bot_name: 'testbot', requester_chat_id: '100', approver_chat_id: '200',
      tool_name: 'Bash', tool_input: { ...liveInput }, tool_use_id: 'tu-1',
    });
    assert.equal(again.reused, true, 'repeated identical calls still dedupe');
  });

  test('an approval input given as serialized JSON is sanitized structurally', () => {
    const approvals = createApprovalsStore(db.raw);
    const row = approvals.issue({
      bot_name: 'testbot', requester_chat_id: '100', approver_chat_id: '200',
      tool_name: 'mcp__deploy', tool_use_id: 'tu-json',
      tool_input: JSON.stringify({ password: KV_SECRET, target: 'staging' }),
    });
    assert.ok(!row.tool_input_json.includes(KV_SECRET), row.tool_input_json);
    const parsed = JSON.parse(row.tool_input_json);
    assert.equal(parsed.target, 'staging', 'the document stays valid and legible');
    assert.equal(parsed.password, '‹redacted:kv-secret›');
  });

  test('a non-JSON approval input falls back to text masking', () => {
    const approvals = createApprovalsStore(db.raw);
    const row = approvals.issue({
      bot_name: 'testbot', requester_chat_id: '100', approver_chat_id: '200',
      tool_name: 'Bash', tool_use_id: 'tu-text',
      tool_input: `deploy --password=${KV_SECRET}`,
    });
    assert.ok(!row.tool_input_json.includes(KV_SECRET), row.tool_input_json);
    assert.ok(row.tool_input_json.startsWith('deploy --password='));
  });

  test('a serialized JSON input with nothing to mask still dedupes', () => {
    const approvals = createApprovalsStore(db.raw);
    const issue = () => approvals.issue({
      bot_name: 'testbot', turn_id: 'turn-json', requester_chat_id: '100',
      approver_chat_id: '200', tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'npm test' }),
    });
    const first = issue();
    const second = issue();
    assert.equal(second.id, first.id, 'reserialization must not look like a change');
    assert.equal(second.reused, true);
  });

  test('two different credentials in one turn never share an approval row', () => {
    // Without a tool_use_id the legacy dedupe key is (turn, digest of input).
    // Both calls mask to the same text, so a digest of the MASKED input makes
    // two genuinely different tool calls look identical — the second call
    // would reuse the first call's approval, and an operator's decision about
    // one command would silently authorize another.
    const approvals = createApprovalsStore(db.raw);
    const issue = (secret) => approvals.issue({
      bot_name: 'testbot', turn_id: 'turn-1', requester_chat_id: '100',
      approver_chat_id: '200', tool_name: 'Bash',
      tool_input: { command: `deploy --token=${secret}` },
    });
    const first = issue('aaaa1111bbbb2222');
    const second = issue('cccc3333dddd4444');
    assert.notEqual(first.id, second.id, 'distinct calls must get distinct rows');
    assert.ok(!second.reused, 'the second call must not reuse the first approval');
    const digests = db.raw
      .prepare('SELECT tool_input_digest FROM pending_approvals ORDER BY id').all()
      .map((r) => r.tool_input_digest);
    assert.notEqual(digests[0], digests[1], 'per-row identity, not a shared digest');
  });

  test('an unchanged input still dedupes within a turn', () => {
    const approvals = createApprovalsStore(db.raw);
    const issue = () => approvals.issue({
      bot_name: 'testbot', turn_id: 'turn-2', requester_chat_id: '100',
      approver_chat_id: '200', tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    const first = issue();
    const second = issue();
    assert.equal(second.id, first.id);
    assert.equal(second.reused, true);
  });

  test('a persisted always-rule pattern carries no raw credential', () => {
    db.insertChatToolDecision({
      bot_name: 'testbot', chat_id: '100', tool_name: 'Bash',
      match_type: 'prefix', input_pattern: `{"command":"deploy --token=${BEARER}"}`,
      decision: 'allow', issued_by_user_id: '1', expires_ts: null,
    });
    const { input_pattern: stored } = db.raw
      .prepare('SELECT input_pattern FROM chat_tool_decisions LIMIT 1').get();
    assert.ok(!stored.includes(BEARER), stored);
  });

  test('question state stays exact while pending and is masked once terminal', () => {
    const questions = createQuestionStore(db.raw, () => 1000);
    const answer = `my password is ${PROSE_SECRET}`;
    const row = questions.issue({
      bot_name: 'testbot', session_key: '100:main', chat_id: '100',
      tool_call_id: 'tc-1',
      questions: [{ header: 'Creds', question: `use ${PROSE_TEXT}?`, options: [{ label: 'yes' }] }],
      state: { qIndex: 0, answers: [] },
    });
    // The audit copy of the model's questions is masked — nothing reads it back.
    assert.ok(!row.questions_json.includes(PROSE_SECRET), row.questions_json);

    // The live state machine is replay input: every tap re-reads it and the
    // assembled answer goes to the provider, so it must round-trip exactly.
    questions.updateState(row.id, { qIndex: 1, answers: [answer] });
    const pending = questions.getById(row.id);
    assert.equal(JSON.parse(pending.state_json).answers[0], answer,
      'the pending answer reaches the provider unaltered');

    // Once the row is terminal nothing replays it, so the durable copy is masked.
    questions.resolve(row.id, 'answered');
    const done = questions.getById(row.id);
    assert.ok(!done.state_json.includes(PROSE_SECRET), done.state_json);
    assert.equal(JSON.parse(done.state_json).qIndex, 1, 'audit shape survives masking');
  });

  test('no inventoried sink leaves the secret searchable in FTS', () => {
    db.insertMessage({ chat_id: '100', msg_id: 10, direction: 'in', text: KV_TEXT, ts: 1 });
    db.insertOutboundPending({ chat_id: '100', text: KV_TEXT, pending_id: -3, ts: 1 });
    db.insertMessage({ chat_id: '100', msg_id: 11, direction: 'out', text: 'x', ts: 1 });
    db.updateOutboundText({ chat_id: '100', msg_id: 11, text: KV_TEXT });
    db.setMessageText({ chat_id: '100', msg_id: 10, text: KV_TEXT });
    assert.equal(ftsHits('"hunter2-fake-value"'), 0);
    const rows = db.raw.prepare("SELECT text FROM messages WHERE text LIKE '%hunter2-fake-value%'").all();
    assert.deepEqual(rows, []);
  });
});

// Recovery re-pushes a stored line into a live session. Anything that is not
// a compact command must never reach that path — a mention-suffixed command
// is normalized, and arbitrary text is refused outright.
describe('compact command normalization before replay', () => {
  const { normalizeCompactCommand } = require('../lib/handlers/slash-commands');

  test('a bare command passes through', () => {
    assert.equal(normalizeCompactCommand('/compact'), '/compact');
  });

  test('a hint is preserved', () => {
    assert.equal(normalizeCompactCommand('/compact keep the Q3 decisions'),
      '/compact keep the Q3 decisions');
  });

  test('a bot mention is normalized away', () => {
    assert.equal(normalizeCompactCommand('/compact@shumabit keep the Q3 decisions'),
      '/compact keep the Q3 decisions');
    assert.equal(normalizeCompactCommand('/compact@shumabit'), '/compact');
  });

  test('surrounding whitespace is trimmed', () => {
    assert.equal(normalizeCompactCommand('  /compact  hint  '), '/compact hint');
  });

  test('anything that is not a compact command is refused', () => {
    for (const text of ['hello there', '/compactify now', '@shumabit /compact',
      '/new', '', null, undefined, 42]) {
      assert.equal(normalizeCompactCommand(text), null, JSON.stringify(text));
    }
  });
});
