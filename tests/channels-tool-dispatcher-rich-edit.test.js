'use strict';

/**
 * Rich `edit_message` on the channels dispatcher.
 *
 * Before this, an agent could post a rich checklist through `reply` and then
 * never tick an item off: every edit re-sent the bubble as flat text under a
 * 4,000-char cap, which made the checkboxes decorative. These tests pin the
 * seam that fixes it, and the three things that seam has to get right:
 *
 *   - the cap depends on the MODE, and the mode is resolved BEFORE anything
 *     reaches the network (an over-cap edit must be an agent-actionable
 *     {ok:false}, never Telegram's raw "message is too long" surfacing from a
 *     degraded rich attempt);
 *   - a rich edit that throws (rich-edit.js rethrows transients) comes back as
 *     {ok:false} instead of taking the dispatcher down;
 *   - a successful edit — rich or plain — brings the stored transcript row up
 *     to what the bubble now says.
 *
 * The dispatcher must never require the rich modules itself: rich-media.js
 * already requires the dispatcher, so the reverse direction is a cycle.
 * Everything arrives by dependency injection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');
const { createRichEditStrategy } = require('../lib/telegram/rich-edit-dispatch');
const { createRichEditor } = require('../lib/telegram/rich-edit');
const { RICH_MAX_LEN } = require('../lib/telegram/rich');

const fakeBot = {};
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };
const passthroughParse = (text) => ({ text, sticker: null, stickers: [], reaction: null, reactions: [] });
const passthroughSanitize = (text) => ({ text, replaced: false });

const CHECKLIST = '- [ ] fetch\n- [ ] parse\n- [ ] report';
const CHECKED = '- [x] fetch\n- [ ] parse\n- [ ] report';

// A strategy stub with the shape polygram injects: a pure plan(), then an
// edit() that talks to Telegram.
function stubStrategy({ mode = 'rich', maxLen = RICH_MAX_LEN, blocks = [{ type: 'paragraph', text: 'x' }], edit } = {}) {
  const planned = [];
  const edited = [];
  return {
    planned,
    edited,
    strategy: {
      plan: (args) => {
        planned.push(args);
        return mode === 'rich'
          ? { mode: 'rich', text: args.text, blocks, maxLen }
          : { mode: 'plain', text: args.text, maxLen };
      },
      edit: edit || (async (args) => { edited.push(args); return { result: { message_id: args.messageId }, wentRich: true }; }),
    },
  };
}

function build({ richEdit = null, persistEditedText = null, deliverSent = [500], ...extra } = {}) {
  const sent = [];
  const persisted = [];
  const send = async (_bot, method, params) => { sent.push({ method, params }); return { message_id: 1 }; };
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (t) => [t],
    deliverReplies: async () => ({ sent: deliverSent, failed: [], results: [] }),
    parseResponse: passthroughParse,
    sanitizeAssistantReply: passthroughSanitize,
    logger: quietLogger,
    richEdit,
    persistEditedText: persistEditedText
      || ((chatId, msgId, text) => { persisted.push({ chatId, msgId, text }); }),
    ...extra,
  });
  // Every test edits a bubble this session owns; establish that the way the
  // real flow does, through a reply.
  const own = (sessionKey = 's') => dispatcher({
    sessionKey, chatId: '1', threadId: null, toolName: 'reply', text: 'on it',
  });
  const edit = (text, over = {}) => dispatcher({
    sessionKey: 's', chatId: '1', threadId: null, toolName: 'edit_message',
    messageId: 500, text, ...over,
  });
  return { dispatcher, sent, persisted, own, edit };
}

// ─── the seam ─────────────────────────────────────────────────────────────

test('a rich-planned edit goes through the strategy, not through a plain editMessageText', async () => {
  const { strategy, edited } = stubStrategy();
  const { own, edit, sent } = build({ richEdit: strategy });
  await own();
  const res = await edit(CHECKED);
  assert.equal(res.ok, true);
  assert.equal(res.message_id, 500);
  assert.equal(edited.length, 1, 'the rich editor did the edit');
  assert.equal(edited[0].messageId, 500);
  assert.equal(sent.filter(c => c.method === 'editMessageText').length, 0, 'no plain edit alongside it');
});

test('a plain-planned edit still goes through the ordinary send path', async () => {
  const { strategy, edited } = stubStrategy({ mode: 'plain', maxLen: 4000 });
  const { own, edit, sent } = build({ richEdit: strategy });
  await own();
  const res = await edit('halfway there');
  assert.equal(res.ok, true);
  assert.equal(edited.length, 0);
  const edits = sent.filter(c => c.method === 'editMessageText');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].params.text, 'halfway there');
});

test('no strategy injected → the plain path and the plain cap, exactly as before', async () => {
  const { own, edit, sent } = build({ maxChunkLen: 50 });
  await own();
  assert.equal((await edit('short')).ok, true);
  assert.equal(sent.filter(c => c.method === 'editMessageText').length, 1);
  const long = await edit('z'.repeat(120));
  assert.equal(long.ok, false);
  assert.match(long.error, /too long/);
});

// ─── mode-dependent caps, enforced before the network ─────────────────────

test('a rich-planned edit may run to the rich cap — a long checklist is not "too long"', async () => {
  const { strategy, edited } = stubStrategy();
  const { own, edit } = build({ richEdit: strategy, maxChunkLen: 4000 });
  await own();
  const body = `${CHECKED}\n${'- [ ] step\n'.repeat(1000)}`;   // ~12k chars
  assert.ok(body.length > 4000, 'past the plain cap by construction');
  const res = await edit(body);
  assert.equal(res.ok, true, 'the rich ceiling governs a rich edit');
  assert.equal(edited.length, 1);
});

test('an over-cap edit answers {ok:false} BEFORE any network call', async () => {
  // The failure this pins: pre-fix the oversized body reached Telegram as the
  // plain fallback of a failed rich attempt, and the agent got the raw
  // "message is too long" with nothing to act on — after the bubble had
  // already been rewritten.
  const { strategy, edited } = stubStrategy({ mode: 'plain', maxLen: 4000 });
  const { own, edit, sent } = build({ richEdit: strategy, maxChunkLen: 4000 });
  await own();
  const before = sent.length;
  const res = await edit('z'.repeat(10_000));
  assert.equal(res.ok, false);
  assert.match(res.error, /too long/);
  assert.match(res.error, /10000/);
  assert.match(res.error, /4000/, 'names the cap that actually applied');
  assert.equal(edited.length, 0, 'no rich attempt');
  assert.equal(sent.length, before, 'no editMessageText, no request at all');
});

test('a rich chat past the RICH cap is refused against the RICH ceiling, still before the network', async () => {
  // Reporting 4,000 here would lie about a chat that renders 32k checklists.
  const { strategy, edited } = stubStrategy({ mode: 'plain', maxLen: RICH_MAX_LEN });
  const { own, edit, sent } = build({ richEdit: strategy, maxChunkLen: 4000 });
  await own();
  const before = sent.length;
  const res = await edit('z'.repeat(RICH_MAX_LEN + 10));
  assert.equal(res.ok, false);
  assert.match(res.error, new RegExp(String(RICH_MAX_LEN)));
  assert.equal(edited.length, 0);
  assert.equal(sent.length, before);
});

test('a planner that throws costs the styling, never the edit', async () => {
  const strategy = { plan: () => { throw new Error('planner broke'); }, edit: async () => ({ wentRich: true }) };
  const { own, edit, sent } = build({ richEdit: strategy });
  await own();
  const res = await edit(CHECKED);
  assert.equal(res.ok, true, 'degrades to the path that has always worked');
  assert.equal(sent.filter(c => c.method === 'editMessageText').length, 1);
});

test('an edit whose body strips to nothing is refused with something actionable', async () => {
  const strategy = {
    plan: (args) => ({ mode: 'plain', text: '', maxLen: 4000, planned: args }),
    edit: async () => ({ wentRich: true }),
  };
  const { own, edit, sent } = build({ richEdit: strategy });
  await own();
  const before = sent.length;
  const res = await edit('![](/tmp/a.png)');
  assert.equal(res.ok, false);
  assert.match(res.error, /media|empty/i);
  assert.equal(sent.length, before, 'tg()\'s empty-text guard is never reached');
});

test('a whitespace-only edit is refused as empty, not as a media problem', async () => {
  const { strategy } = stubStrategy();
  const { own, edit, sent } = build({ richEdit: strategy });
  await own();
  const before = sent.length;
  const res = await edit('   \n  ');
  assert.equal(res.ok, false);
  assert.match(res.error, /empty after sanitize/);
  assert.equal(sent.length, before);
});

test('a rich-enabled chat delivers the PLANNED body on the plain path too — no local paths', async () => {
  // The plan strips media for a rich-enabled chat; the plain branch must send
  // that body, not the raw text it was handed.
  const strategy = {
    plan: ({ text }) => ({ mode: 'plain', text: text.replace(/!\[[^\]]*\]\([^)]*\)/g, 'shot'), maxLen: 4000 }),
    edit: async () => ({ wentRich: true }),
  };
  const { own, edit, sent } = build({ richEdit: strategy });
  await own();
  await edit('progress ![shot](/tmp/secret-path.png)');
  const params = sent.filter(c => c.method === 'editMessageText').at(-1).params;
  assert.equal(params.text, 'progress shot');
  assert.doesNotMatch(params.text, /secret-path/);
});

// ─── failures come back as tool results, not as crashes ───────────────────

test('a transient rich-edit error becomes {ok:false}, not a dispatcher crash', async () => {
  // rich-edit.js RETHROWS transients on purpose — the streamer's retry logic
  // wants them. The tool has no retry logic; it has an agent waiting on an ack.
  const { strategy } = stubStrategy({ edit: async () => { throw new Error('TG 502: bad gateway'); } });
  const { own, edit } = build({ richEdit: strategy });
  await own();
  const res = await edit(CHECKED);
  assert.equal(res.ok, false);
  assert.match(res.error, /bad gateway/);
});

test('a rich-edit failure is redacted before the agent sees it', async () => {
  // Network error shapes embed the request URL, which carries the bot token.
  const { strategy } = stubStrategy({
    edit: async () => { throw new Error('request to https://api.telegram.org/bot123:SECRET/editMessageText failed'); },
  });
  const { own, edit } = build({
    richEdit: strategy,
    redactError: (s) => String(s).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>'),
  });
  await own();
  const res = await edit(CHECKED);
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.error, /SECRET/);
});

// ─── ownership is unchanged ───────────────────────────────────────────────

test('an unowned bubble is still denied — and nothing is rendered or sent for it', async () => {
  const { strategy, edited } = stubStrategy();
  const { dispatcher, sent } = build({ richEdit: strategy });
  const res = await dispatcher({
    sessionKey: 's', chatId: '1', threadId: null, toolName: 'edit_message',
    messageId: 999_999, text: CHECKED,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /not created by this session/);
  assert.equal(edited.length, 0);
  assert.equal(sent.filter(c => c.method === 'editMessageText').length, 0);
});

test('a RICH reply bubble is remembered, so editing it rich just works', async () => {
  // The reply's rich strategy returns its bubble through the same
  // deliverResult shape the chunked path uses; ownership is recorded from it.
  const { strategy, edited } = stubStrategy();
  const { dispatcher } = build({
    richEdit: strategy,
    makeDeliverText: () => async () => ({ handled: true, sent: [{ message_id: 777 }], failed: [], results: [] }),
  });
  const reply = await dispatcher({
    sessionKey: 's', chatId: '1', threadId: null, toolName: 'reply', text: CHECKLIST,
  });
  assert.equal(reply.message_id, 777, 'the rich bubble id is the edit handle');
  const res = await dispatcher({
    sessionKey: 's', chatId: '1', threadId: null, toolName: 'edit_message',
    messageId: 777, text: CHECKED,
  });
  assert.equal(res.ok, true);
  assert.equal(edited[0].messageId, 777, 'same bubble, edited rich');
});

// ─── transcript truth ─────────────────────────────────────────────────────

test('a successful rich edit brings the stored row up to the delivered body', async () => {
  const { strategy } = stubStrategy();
  const { own, edit, persisted } = build({ richEdit: strategy });
  await own();
  await edit(CHECKED);
  assert.deepEqual(persisted, [{ chatId: '1', msgId: 500, text: CHECKED }]);
});

test('a successful plain edit persists too — the transcript must not diverge either way', async () => {
  const { strategy } = stubStrategy({ mode: 'plain', maxLen: 4000 });
  const { own, edit, persisted } = build({ richEdit: strategy });
  await own();
  await edit('halfway there');
  assert.deepEqual(persisted, [{ chatId: '1', msgId: 500, text: 'halfway there' }]);
});

test('a FAILED edit persists nothing — the row keeps what the bubble still says', async () => {
  const { strategy } = stubStrategy({ edit: async () => { throw new Error('TG 400: message to edit not found'); } });
  const { own, edit, persisted } = build({ richEdit: strategy });
  await own();
  await edit(CHECKED);
  assert.deepEqual(persisted, []);
});

test('persisting the transcript can never cost a delivered edit', async () => {
  const { strategy } = stubStrategy();
  const { own, edit } = build({
    richEdit: strategy,
    persistEditedText: () => { throw new Error('db is locked'); },
  });
  await own();
  const res = await edit(CHECKED);
  assert.equal(res.ok, true, 'the edit landed; the row is the lesser loss');
});

// ─── the canonical flow, through the real strategy + the real rich editor ──

test('reply a checklist, edit_message it with [x]: same bubble, rich, checked', async () => {
  const calls = [];
  const tg = async (_bot, method, params) => { calls.push({ method, params }); return { message_id: params.message_id }; };
  const richEditMessageText = createRichEditor({
    tg,
    botName: 'test',
    logEvent: () => {},
    redactBotToken: (s) => s,
    isRichCapabilityError: () => false,
    isRichContentError: () => false,
  });
  const strategy = createRichEditStrategy({
    editRich: (args) => richEditMessageText({ bot: fakeBot, ...args, phase: 'final' }),
    isRichTextEnabled: () => true,
    logger: quietLogger,
  });
  const { dispatcher, persisted } = build({
    richEdit: strategy,
    makeDeliverText: () => async () => ({ handled: true, sent: [{ message_id: 777 }], failed: [], results: [] }),
  });

  const reply = await dispatcher({
    sessionKey: 's', chatId: '1', threadId: null, toolName: 'reply', text: CHECKLIST,
  });
  const res = await dispatcher({
    sessionKey: 's', chatId: '1', threadId: null, toolName: 'edit_message',
    messageId: reply.message_id, text: CHECKED,
  });

  assert.equal(res.ok, true);
  assert.equal(res.message_id, 777, 'the checklist bubble, not a new one');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'editMessageText');
  assert.equal(calls[0].params.message_id, 777);
  assert.ok(calls[0].params.rich_message, 're-rendered rich, not flattened to text');
  assert.equal(calls[0].params.text, undefined);
  const rendered = JSON.stringify(calls[0].params.rich_message);
  assert.match(rendered, /"is_checked":true/, 'the ticked item is checked in the blocks');
  assert.match(rendered, /fetch/);
  assert.deepEqual(persisted, [{ chatId: '1', msgId: 777, text: CHECKED }]);
});
