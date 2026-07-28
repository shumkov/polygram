'use strict';

/**
 * sendRichMessage primitive.
 *
 * The contract that matters most here is negative: this thing NEVER throws
 * and never reports success it didn't get. Its caller owns a plain fallback,
 * so every failure has to come back as `wentRich: false` — a thrown error
 * would escape to the agent as `{ok:false}` with nothing delivered, which is
 * strictly worse than the flat rendering this feature exists to replace.
 * Error classification decides only whether to latch, never whether the user
 * gets the message.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRichSender } = require('../lib/telegram/rich-send');
const {
  isRichCapabilityError,
  isRichCapabilityErrorExplicit,
  isRichContentError,
} = require('../lib/telegram/rich');
const { stripUrlCredentials } = require('../lib/error/net');

const fakeBot = {};
const BLOCKS = [{ type: 'heading', level: 1, text: 'Title' }];

function makeSender(overrides = {}) {
  const events = [];
  const rows = [];
  const tgCalls = [];
  let latched = false;

  const deps = {
    tg: async (_bot, method, params, meta) => {
      tgCalls.push({ method, params, meta });
      return { message_id: 777, date: 1700000000 };
    },
    botName: 'testbot',
    logEvent: (kind, detail) => events.push({ kind, detail }),
    redactBotToken: (s) => String(s ?? '').replace(/bot\d+:[\w-]+/g, 'bot<redacted>'),
    isRichCapabilityError,
    isRichCapabilityErrorExplicit,
    isRichContentError,
    getRichKnownUnsupported: () => latched,
    setRichKnownUnsupported: () => { latched = true; },
    getApiRoot: () => 'http://localhost:8082',
    stripUrlCreds: (s) => s,
    insertSentRow: (row) => rows.push(row),
    logger: { error: () => {}, warn: () => {} },
    ...overrides,
  };

  return {
    sendRich: createRichSender(deps),
    events,
    rows,
    tgCalls,
    isLatched: () => latched,
  };
}

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

const baseArgs = {
  bot: fakeBot,
  chatId: '12345',
  threadId: null,
  blocks: BLOCKS,
  sourceText: '# Title',
  meta: { turnId: 'turn-1', sessionId: 'sess-1' },
};

// ─── Success ───────────────────────────────────────────────────────────────

test('success reports rich, records the row, and emits the send-transport event', async () => {
  const { sendRich, events, rows, tgCalls } = makeSender();

  const out = await sendRich({ ...baseArgs, threadId: '77', replyParams: { message_id: 55 } });

  assert.equal(out.wentRich, true);
  assert.equal(out.result.message_id, 777);

  assert.equal(tgCalls.length, 1);
  assert.equal(tgCalls[0].method, 'sendRichMessage');
  assert.deepEqual(tgCalls[0].params.rich_message, { blocks: BLOCKS });
  assert.equal(tgCalls[0].params.chat_id, '12345');
  assert.equal(tgCalls[0].params.message_thread_id, '77',
    'topic routing must survive — a dropped thread id mis-delivers every rich reply');
  assert.deepEqual(tgCalls[0].params.reply_parameters, { message_id: 55 });

  assert.equal(rows.length, 1, 'exactly one transcript row');
  assert.equal(rows[0].text, '# Title', 'row stores the source markdown, not the block tree');
  assert.equal(rows[0].msg_id, 777);
  assert.equal(rows[0].direction, 'out');
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].reply_to_id, 55);
  // api.js leaves this method untracked, so this row is the ONLY record of
  // the reply. Without turn/session correlation it is an orphan that no
  // soak query can tie back to the turn that produced it.
  assert.equal(rows[0].turn_id, 'turn-1');
  assert.equal(rows[0].session_id, 'sess-1');
  assert.equal(rows[0].bot_name, 'testbot');
  assert.equal(tgCalls[0].meta.richSourceText, '# Title',
    'the source markdown rides along for any tracked caller');

  const sent = events.find(e => e.kind === 'rich-message-sent');
  assert.ok(sent, 'rich-message-sent emitted');
  assert.equal(sent.detail.transport, 'send',
    'transport distinguishes this from the streamer edit path in the soak');
});

test('optional params are omitted rather than sent as null', async () => {
  const { sendRich, tgCalls } = makeSender();
  await sendRich(baseArgs);
  assert.ok(!('message_thread_id' in tgCalls[0].params));
  assert.ok(!('reply_parameters' in tgCalls[0].params));
});

// ─── Latch ─────────────────────────────────────────────────────────────────

test('a tripped latch short-circuits before any network call', async () => {
  const { sendRich, tgCalls, rows } = makeSender({ getRichKnownUnsupported: () => true });
  const out = await sendRich(baseArgs);
  assert.equal(out.wentRich, false);
  assert.equal(tgCalls.length, 0, 'no call attempted once the server is known unsupported');
  assert.equal(rows.length, 0);
});

test('an explicit rich_message rejection latches on first sight', async () => {
  const { sendRich, events, isLatched } = makeSender({
    tg: async () => { throw err('Bad Request: unknown field rich_message'); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, false);
  assert.equal(isLatched(), true, 'the server named the capability — one strike is enough');
  assert.ok(events.some(e => e.kind === 'rich-capability-latched'));
});

test('a bare 404 needs two consecutive strikes to latch', async () => {
  // A single 404 is also what a restarting bot-api server returns. Latching
  // on it would permanently downgrade the path carrying most agent output
  // until the daemon restarts — far too much damage for one blip.
  const { sendRich, isLatched, events } = makeSender({
    tg: async () => { throw err('Not Found', { error_code: 404 }); },
  });

  const first = await sendRich(baseArgs);
  assert.equal(first.wentRich, false);
  assert.equal(isLatched(), false, 'one 404 is a blip, not a verdict');
  assert.ok(!events.some(e => e.kind === 'rich-capability-latched'));

  const second = await sendRich(baseArgs);
  assert.equal(second.wentRich, false);
  assert.equal(isLatched(), true, 'two in a row is a capability verdict');
  assert.ok(events.some(e => e.kind === 'rich-capability-latched'));
});

test('a success between two 404s resets the strike count', async () => {
  let mode = 'fail';
  const { sendRich, isLatched } = makeSender({
    tg: async () => {
      if (mode === 'fail') throw err('Not Found', { error_code: 404 });
      return { message_id: 5 };
    },
  });

  await sendRich(baseArgs);
  mode = 'ok';
  await sendRich(baseArgs);
  mode = 'fail';
  await sendRich(baseArgs);

  assert.equal(isLatched(), false, 'the 404s were not consecutive — the endpoint demonstrably works');
});

// ─── Content + unknown errors ──────────────────────────────────────────────

test('a non-capability error between two 404s resets the strike count', async () => {
  // "Consecutive" is the whole justification for the two-strike rule. A
  // content error proves the endpoint is there and answering, so the run of
  // 404s is broken and the next one starts over.
  const errors = [
    err('Not Found', { error_code: 404 }),
    err('Bad Request: RICH_MESSAGE_TOO_LONG'),
    err('Not Found', { error_code: 404 }),
  ];
  let i = 0;
  const { sendRich, isLatched } = makeSender({
    tg: async () => { throw errors[i++]; },
  });

  await sendRich(baseArgs);
  await sendRich(baseArgs);
  await sendRich(baseArgs);

  assert.equal(isLatched(), false, 'the 404s were not consecutive');
});

test('apiRoot credentials never reach the latch event', async () => {
  // Latch events mark a fleet-wide capability outage, so they are the ones
  // most likely to be pasted into an issue.
  const { sendRich, events } = makeSender({
    tg: async () => { throw err('Bad Request: unknown field rich_message'); },
    getApiRoot: () => 'http://svc:hunter2@localhost:8082',
    stripUrlCreds: stripUrlCredentials,
  });

  await sendRich(baseArgs);

  const logged = JSON.stringify(events);
  assert.ok(logged.includes('rich-capability-latched'), 'the latch event fired');
  assert.ok(!logged.includes('hunter2'), `apiRoot credentials leaked: ${logged}`);
});

test('a content error falls back once without latching', async () => {
  const { sendRich, events, isLatched, rows } = makeSender({
    tg: async () => { throw err('Bad Request: RICH_MESSAGE_TOO_LONG'); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, false);
  assert.equal(out.fallback, 'content-error',
    'the class carries a side effect (cache eviction) — it may not be applied by accident');
  assert.equal(isLatched(), false, 'this payload was bad, not the server');
  assert.ok(events.some(e => e.kind === 'rich-content-fallback'));
  assert.equal(rows.length, 0, 'a failed attempt leaves no transcript row to duplicate');
});

test('an unknown error degrades instead of propagating', async () => {
  const { sendRich, events, isLatched } = makeSender({
    tg: async () => { throw err('socket hang up', { code: 'ECONNRESET' }); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, false, 'the caller delivers plain — the reply is not lost');
  assert.equal(out.fallback, 'error');
  assert.equal(isLatched(), false);
  assert.ok(events.some(e => e.kind === 'rich-send-error'));
});

test('bot tokens never reach the event log', async () => {
  const { sendRich, events } = makeSender({
    tg: async () => {
      throw err('request to https://api.telegram.org/bot123456:AAHsecrettoken/sendRichMessage failed');
    },
  });

  await sendRich(baseArgs);

  const logged = JSON.stringify(events);
  assert.ok(!logged.includes('AAHsecrettoken'), `token leaked into events: ${logged}`);
  assert.ok(logged.includes('bot<redacted>'), 'the redacted marker is present');
});

test('a DB failure does not turn a delivered rich message into a failure', async () => {
  const { sendRich } = makeSender({
    insertSentRow: () => { throw new Error('database is locked'); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, true, 'Telegram delivery is the truth; the transcript is best-effort');
});

test('an unusable blocks payload is refused before any network call', async () => {
  // Not just the empty array: a non-array would reach the wire as
  // `rich_message: { blocks: undefined }`, which is a malformed request
  // rather than an honest decline.
  for (const blocks of [[], undefined, null, 'not-an-array', {}]) {
    const { sendRich, tgCalls, rows } = makeSender();
    const out = await sendRich({ ...baseArgs, blocks });
    assert.equal(out.wentRich, false, `blocks=${JSON.stringify(blocks)}`);
    assert.equal(tgCalls.length, 0, `blocks=${JSON.stringify(blocks)} reached the network`);
    assert.equal(rows.length, 0);
  }
});

test('a delivered message is never un-reported by bookkeeping that fails after it', async () => {
  // The caller treats a throw as "rich did not happen" and delivers the same
  // reply again as plain text. Anything after the send has landed must not
  // be able to cause that.
  const { sendRich, tgCalls } = makeSender({
    logEvent: () => { throw new Error('event sink exploded'); },
  });

  const out = await sendRich(baseArgs);

  assert.equal(tgCalls.length, 1, 'the message was sent');
  assert.equal(out.wentRich, true, 'a delivered message must stay reported as delivered');
});

test('a response without a message id is a fallback, not a delivery', async () => {
  // The reply tool promises the agent an id it can edit. Without one there is
  // no ownership claim and no transcript row, so reporting success hands back
  // a contract the caller cannot honor; the plain path can.
  const { sendRich, rows, events } = makeSender({
    tg: async () => ({ date: 1 }),
  });

  const out = await sendRich(baseArgs);

  assert.equal(out.wentRich, false, 'the caller must fall back rather than report success');
  assert.equal(out.fallback, 'no-message-id',
    'not content-error: that class evicts cached ids, and an unreadable response '
    + 'says nothing about whether they are stale');
  assert.equal(rows.length, 0, 'no row rather than one keyed on a placeholder id');
  const ev = events.find(e => e.kind === 'rich-content-fallback');
  assert.ok(ev, `expected a content-class fallback: ${JSON.stringify(events.map(e => e.kind))}`);
  assert.match(ev.detail.error, /message_id/);
});

test('sendRich never throws, whatever the failure', async () => {
  for (const thrown of [
    err('Not Found', { error_code: 404 }),
    err('Bad Request: RICH_MESSAGE_BAD_BLOCK'),
    err('unknown field rich_message'),
    err('ETIMEDOUT'),
    'a bare string rejection',
    null,
  ]) {
    const { sendRich } = makeSender({ tg: async () => { throw thrown; } });
    const out = await sendRich(baseArgs);
    assert.equal(out.wentRich, false, `threw for ${String(thrown)}`);
  }
});

// ─── Media ─────────────────────────────────────────────────────────────────
//
// Local media reaches this function as `{source, fingerprint}` envelopes and
// is materialized here, through the caller's preflight, immediately before
// the request. Two things must hold: nothing uploads when a source no longer
// matches what was resolved, and that abort — like every other failure — is a
// decline rather than a throw.

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const {
  makeRichMediaResolver,
  createMediaPreflight,
  createMediaFileIdCache,
} = require('../lib/telegram/rich-media');
const { FILE_FIELD_BY_METHOD } = require('../lib/telegram/input-file');

const mediaTempDirs = new Set();
test.after(() => {
  for (const dir of mediaTempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// One workspace, one real file, and the two halves wired the way polygram
// wires them: same roots, same cache, module-default stat on both sides.
function mediaFixture({ fileIdCache = null } = {}) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'polygram-rich-send-'));
  mediaTempDirs.add(dir);
  const file = nodePath.join(dir, 'chart.png');
  fs.writeFileSync(file, Buffer.alloc(64, 1));

  const cache = fileIdCache;
  const resolve = makeRichMediaResolver({ allowedRoots: [dir], chatId: '12345', fileIdCache: cache });
  const mediaContext = createMediaPreflight({ allowedRoots: [dir], fileIdCache: cache });
  const [resolved] = resolve([{ src: file, caption: 'the chart' }]);
  const blocks = [
    { type: 'paragraph', text: 'Here it is' },
    { type: 'photo', photo: { type: 'photo', media: resolved.media }, caption: { text: 'the chart' } },
  ];
  return { dir, file, resolve, mediaContext, blocks, cache };
}

test('a local photo is materialized into an uploadable file just before the send', async () => {
  const { file, mediaContext, blocks } = mediaFixture();
  const uploads = [];
  const { sendRich, tgCalls, events } = makeSender({
    makeInputFile: (source) => { uploads.push(source); return { upload: source }; },
  });

  const out = await sendRich({ ...baseArgs, blocks, mediaContext });

  assert.equal(out.wentRich, true);
  const sentBlocks = tgCalls[0].params.rich_message.blocks;
  assert.notEqual(sentBlocks, blocks, 'the caller keeps its JSON-safe tree');
  assert.deepEqual(uploads, [fs.realpathSync(file)],
    'the resolved realpath is what goes up, never the path the agent typed');
  assert.deepEqual(sentBlocks[1].photo.media, { upload: fs.realpathSync(file) });
  assert.equal(sentBlocks[1].caption.text, 'the chart');
  const sent = events.find(e => e.kind === 'rich-message-sent');
  assert.equal(sent.detail.media_count, 1,
    'media that silently stops being delivered is invisible without this counter');
});

test('a source changed since it was resolved uploads nothing and never throws', async () => {
  const { file, mediaContext, blocks } = mediaFixture();
  const { sendRich, tgCalls, events, rows } = makeSender();

  fs.writeFileSync(file, Buffer.alloc(96, 2));   // swapped between resolve and send

  const out = await sendRich({ ...baseArgs, blocks, mediaContext });

  assert.deepEqual(out, { wentRich: false, fallback: 'media-source-changed' },
    'the caller needs the reason to decide whether a different render is worth a retry');
  assert.equal(tgCalls.length, 0, 'not one byte of the swapped file reached Telegram');
  assert.equal(rows.length, 0);
  const ev = events.find(e => e.kind === 'rich-content-fallback');
  assert.equal(ev.detail.error, 'media-source-changed');
  assert.equal(ev.detail.media_count, 1);
});

test('a changed source is never mistaken for a missing capability', async () => {
  // It never reached Telegram, so it says nothing about the server. Latching
  // on it would disable rich for the whole process over one swapped file.
  const { file, mediaContext, blocks } = mediaFixture();
  const { sendRich, isLatched } = makeSender();
  fs.writeFileSync(file, Buffer.alloc(96, 2));

  await sendRich({ ...baseArgs, blocks, mediaContext });
  await sendRich({ ...baseArgs, blocks, mediaContext });

  assert.equal(isLatched(), false, 'two media aborts in a row must not latch anything');
});

test('a rejected preflight declines without a throw and without a bubble', async () => {
  // A synchronous throw out of here surfaces to the agent as {ok:false} with
  // nothing delivered — strictly worse than a flat reply.
  const { mediaContext, blocks } = mediaFixture();
  const { sendRich, tgCalls } = makeSender();
  const alwaysRejects = { ...mediaContext, preflightMedia: () => ({ ok: false }) };

  const out = await sendRich({ ...baseArgs, blocks, mediaContext: alwaysRejects });

  assert.equal(out.wentRich, false);
  assert.equal(tgCalls.length, 0);
});

test('a content error evicts the cached ids in the payload so the next reply re-uploads', async () => {
  // A file_id Telegram has forgotten still has a MATCHING fingerprint, so
  // preflight would keep handing it back and every later reply embedding that
  // unchanged file would fail forever. "The cache self-heals" is false.
  const cache = createMediaFileIdCache();
  const { file, resolve, mediaContext } = mediaFixture({ fileIdCache: cache });
  const [cold] = resolve([{ src: file, caption: '' }]);
  cache.set('photo', cold.media.source, cold.media.fingerprint, 'stale-id');
  const [warm] = resolve([{ src: file, caption: '' }]);
  assert.equal(warm.media.fileId, 'stale-id', 'fixture: the send goes out with the cached id');

  const { sendRich, events } = makeSender({
    tg: async () => { throw err('Bad Request: wrong remote file identifier specified'); },
  });

  const out = await sendRich({
    ...baseArgs,
    blocks: [{ type: 'photo', photo: { type: 'photo', media: warm.media } }],
    mediaContext,
  });

  assert.equal(out.fallback, 'content-error');
  assert.equal(cache.get('photo', warm.media.source, warm.media.fingerprint), null,
    'the stale id is gone');
  const [again] = resolve([{ src: file, caption: '' }]);
  assert.equal(again.media.fileId, undefined, 'the next reply uploads the bytes again');
  assert.equal(events.find(e => e.kind === 'rich-content-fallback').detail.media_count, 1);
});

test('a success teaches the shared cache, so the next reply reuses the id', async () => {
  // The send path is ~80% of output. Without learning here the cache would
  // only ever be filled by the streamer, and every reply would re-upload.
  const cache = createMediaFileIdCache();
  const { file, resolve, mediaContext, blocks } = mediaFixture({ fileIdCache: cache });
  const { sendRich } = makeSender({
    tg: async (_bot, _method, params) => ({
      message_id: 777,
      date: 1,
      // The server echoes the sent blocks; that echo is what the cache learns from.
      rich_message: {
        blocks: [{ type: 'photo', photo: [{ file_id: 'learned-id', width: 40, height: 30 }] }],
      },
    }),
  });

  const out = await sendRich({
    ...baseArgs,
    blocks: [blocks[1]],
    mediaContext,
  });

  assert.equal(out.wentRich, true);
  const [next] = resolve([{ src: file, caption: '' }]);
  assert.equal(next.media.fileId, 'learned-id');
});

test('cache learning that fails cannot un-deliver a landed message', async () => {
  const { blocks } = mediaFixture();
  const { sendRich } = makeSender();
  const brokenContext = {
    preflightMedia: () => ({ ok: true, value: 'file-id' }),
    learnRichResult: () => { throw new Error('cache exploded'); },
  };

  const out = await sendRich({ ...baseArgs, blocks, mediaContext: brokenContext });

  assert.equal(out.wentRich, true);
});

test('the resolver caps are the ONLY per-file limit on this payload', () => {
  // api.js enforces the outbound size cap by looking up the method's file
  // field. sendRichMessage has none — its media lives nested inside
  // rich_message — so nothing downstream re-checks these bytes. If that ever
  // changes, the caps in richMediaResolverOptions stop being load-bearing and
  // this comment stops being true.
  assert.equal(FILE_FIELD_BY_METHOD.sendRichMessage, undefined);
});

test('requiring rich-send first still yields both modules complete', () => {
  // rich-send reads MEDIA_SOURCE_CHANGED and the materializer from rich-edit.
  // Run in a child process so a module another test already loaded cannot
  // hide a cycle.
  const { execFileSync } = require('node:child_process');
  const sendPath = require.resolve('../lib/telegram/rich-send');
  const editPath = require.resolve('../lib/telegram/rich-edit');

  for (const [first, second] of [[sendPath, editPath], [editPath, sendPath]]) {
    const probe = `
      require(${JSON.stringify(first)});
      require(${JSON.stringify(second)});
      const s = require(${JSON.stringify(sendPath)});
      const e = require(${JSON.stringify(editPath)});
      process.stdout.write(JSON.stringify({
        send: typeof s.createRichSender,
        materialize: typeof e.materializeMediaBlocks,
        code: e.MEDIA_SOURCE_CHANGED,
      }));
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }));
    assert.deepEqual(out, {
      send: 'function',
      materialize: 'function',
      code: 'RICH_MEDIA_SOURCE_CHANGED',
    });
  }
});

test('a landed message keeps its transcript row even if cache learning explodes', async () => {
  // Ordering, not tolerance: the row and the event are what the agent's
  // preloaded history is built from, and the cache is an optimization. Run
  // ahead of them, one throwing caller-supplied dependency would cost a
  // delivered reply its history — and the agent would answer twice.
  const { blocks } = mediaFixture();
  const { sendRich, rows, events } = makeSender();

  const out = await sendRich({
    ...baseArgs,
    blocks,
    mediaContext: {
      preflightMedia: () => ({ ok: true, value: 'file-id' }),
      learnRichResult: () => { throw new Error('cache exploded'); },
    },
  });

  assert.equal(out.wentRich, true);
  assert.equal(rows.length, 1, 'the transcript row survives');
  assert.ok(events.some(e => e.kind === 'rich-message-sent'), 'and so does the telemetry');
});

test('nothing downstream inspects media nested inside rich_message', async () => {
  // The resolver's caps are the ONLY per-file limit on this payload, and that
  // claim rests on api.js not walking rich_message. Asserted behaviorally,
  // not by checking a table for a missing key: a future recursive walk would
  // keep FILE_FIELD_BY_METHOD.sendRichMessage undefined and still change what
  // reaches the wire.
  const { coerceFileParams } = require('../lib/telegram/input-file');
  const envelope = { source: '/definitely/not/a/real/file.png' };
  const params = {
    chat_id: '1',
    rich_message: {
      blocks: [{ type: 'photo', photo: { type: 'photo', media: envelope } }],
    },
  };

  coerceFileParams('sendRichMessage', params);

  assert.equal(params.rich_message.blocks[0].photo.media, envelope,
    'the nested value is untouched — materialization is the only thing that converts it');
});
