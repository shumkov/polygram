'use strict';

// A rich message (Bot API 10.1 `Message.rich_message`) carries its content
// only in a block tree: no `text`, no `caption`. Forwarding one to the bot
// used to be dropped by the intake gate, so the agent never saw it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createShouldHandle } = require('../lib/handlers/should-handle');
const { createGateInbound } = require('../lib/handlers/gate-inbound');
const { createRecordInbound } = require('../lib/handlers/record-inbound');
const { isAbortRequest } = require('../lib/abort-detector');
const { isRewindCommand } = require('../lib/rewind/rewind');
const { buildPrompt, buildReplyToBlock } = require('../lib/prompt');
const { freshDb, cleanupDb } = require('./helpers/db-fixture');
const { normalizeRichInbound, RICH_TEXT_HEADER } = require('../lib/telegram/rich-inbound');

const OPERATOR = { id: 111, is_bot: false, first_name: 'Ivan' };

// Shape of the update Telegram delivers when the operator forwards a bot's
// rich reply into a DM with Polygram.
function forwardedRichMessage() {
  return {
    message_id: 4242,
    date: 1792675478,
    chat: { id: 111, type: 'private', first_name: 'Ivan' },
    from: OPERATOR,
    forward_origin: {
      type: 'user',
      sender_user: { id: 999, is_bot: true, first_name: 'Shumorobot' },
      date: 1792675400,
    },
    rich_message: {
      blocks: [
        { type: 'heading', size: 2, text: 'Release checklist' },
        {
          type: 'paragraph',
          text: [
            'Deploy ',
            { type: 'bold', text: 'polygram 0.40.1' },
            ' per the ',
            { type: 'url', text: 'runbook', url: 'https://example.com/runbook' },
            '.',
          ],
        },
        {
          type: 'list',
          items: [
            { label: '•', has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: 'tag the release' }] },
            { label: '•', has_checkbox: true, blocks: [{ type: 'paragraph', text: 'restart the VPS bots' }] },
          ],
        },
        {
          type: 'table',
          cells: [
            [{ text: 'Bot', is_header: true, align: 'left', valign: 'top' }, { text: 'Host', is_header: true, align: 'left', valign: 'top' }],
            [{ text: 'shumabit', align: 'left', valign: 'top' }, { text: 'umi-vps', align: 'left', valign: 'top' }],
          ],
        },
      ],
    },
  };
}

function makeShouldHandle() {
  return createShouldHandle({
    getConfig: () => ({ chats: { 111: {} } }),
    getPairings: () => null,
    getBotName: () => 'shumabit',
  });
}

describe('forwarded rich message reaches the agent', () => {
  test('intake passes the gate and the prompt carries the rendered content', () => {
    const msg = normalizeRichInbound(forwardedRichMessage());
    assert.equal(makeShouldHandle()(msg, {}, 'shumabit_bot'), true,
      'a rich-only forward must not be blocked as an empty message');

    const prompt = buildPrompt({ msg });
    const body = prompt.match(/<untrusted-input>([\s\S]*?)<\/untrusted-input>/);
    assert.ok(body, 'the prompt must contain the user content');
    for (const needle of [
      'Release checklist',
      'Deploy polygram 0.40.1 per the [runbook](https://example.com/runbook).',
      '[x] tag the release',
      '[ ] restart the VPS bots',
      'shumabit | umi-vps',
    ]) {
      assert.ok(body[1].includes(needle), `prompt is missing ${JSON.stringify(needle)}:\n${body[1]}`);
    }
  });

  test("a reply to the bot's own rich reply quotes its content in <reply_to>", () => {
    // With richText on, the bot's replies are rich messages; replying to one
    // used to give the agent an empty <reply_to>.
    const original = forwardedRichMessage();
    delete original.forward_origin;
    original.from = { id: 999, is_bot: true, first_name: 'Shumabit', username: 'shumabit_bot' };
    const reply = normalizeRichInbound({
      message_id: 4243,
      date: 1792675500,
      chat: { id: 111, type: 'private' },
      from: OPERATOR,
      text: 'is this still right?',
      reply_to_message: original,
    });
    const block = buildReplyToBlock({ telegram: reply.reply_to_message });
    assert.match(block, /Release checklist/);
    assert.match(block, /restart the VPS bots/);
  });

  test('the stored row keeps the rendered text, so replay still passes the gate', () => {
    const { db, dbPath } = freshDb('rich-inbound');
    try {
      const recordInbound = createRecordInbound({
        db,
        dbWrite: (fn) => fn(),
        config: { chats: { 111: {} } },
        botName: 'shumabit',
        extractAttachments: () => [],
      });
      recordInbound(normalizeRichInbound(forwardedRichMessage()));
      const row = db.getMessage('111', 4242);
      assert.ok(row.text.includes('restart the VPS bots'), 'stored row must hold the rendered content');

      // Rebuilt the way boot replay and drop-redelivery rebuild a message.
      const replayed = {
        chat: { id: 111, type: 'private' }, message_id: 4242,
        from: { id: row.user_id, first_name: row.user }, text: row.text || '', date: 1,
      };
      assert.equal(makeShouldHandle()(replayed, {}, 'shumabit_bot'), true);
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  test('an edit event for a rich row re-renders the same text, so it is not seen as a change', () => {
    // A link preview loading fires edited_message with the same content; the
    // edit path compares the stored text with the new one and re-dispatches
    // the message as a fresh turn when they differ.
    const { db, dbPath } = freshDb('rich-inbound-edit');
    try {
      const recordInbound = createRecordInbound({
        db, dbWrite: (fn) => fn(), config: { chats: { 111: {} } }, botName: 'shumabit', extractAttachments: () => [],
      });
      recordInbound(normalizeRichInbound(forwardedRichMessage()));
      const before = db.getMessage('111', 4242).text;

      const edited = { ...forwardedRichMessage(), edit_date: 1792675999 };
      recordInbound(normalizeRichInbound(edited));
      assert.equal(edited.text, before);
      assert.equal(db.getMessage('111', 4242).text, before);
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  test('a message that already has text keeps it', () => {
    const msg = forwardedRichMessage();
    msg.text = 'typed by the user';
    assert.equal(normalizeRichInbound(msg).text, 'typed by the user');
  });

  test('a message with no content at all is still blocked', () => {
    const msg = normalizeRichInbound({
      message_id: 1, date: 1, chat: { id: 111, type: 'private' }, from: OPERATOR,
    });
    assert.equal(makeShouldHandle()(msg, {}, 'shumabit_bot'), false);
  });
});

describe('rendered rich content is never read as a command', () => {
  function makeGate() {
    const calls = { abort: [], dispatched: [] };
    const gate = createGateInbound({
      config: { chats: { 111: {} }, bot: { allowConfigCommands: true } },
      getBotUsername: () => 'shumabit_bot',
      getMentionRe: () => /@shumabit_bot\b/g,
      isAbortRequest,
      handleAbortIfRequested: async (msg) => { calls.abort.push(msg.message_id); return true; },
      isRewindCommand,
      getRewindHandler: () => ({ tryConsume: async () => ({ consumed: true }) }),
      shouldHandle: makeShouldHandle(),
      getSessionKey: (chatId) => chatId,
      dispatchHandleMessage: (sessionKey, chatId, msg) => calls.dispatched.push(msg),
      bot: {},
      botName: 'shumabit',
      logger: { error: () => {} },
    });
    return { gate, calls };
  }

  function richDm(blocks) {
    return {
      message_id: 7, date: 1, chat: { id: 111, type: 'private' }, from: OPERATOR,
      forward_origin: { type: 'hidden_user', sender_user_name: 'Someone', date: 1 },
      rich_message: { blocks },
    };
  }

  for (const [name, blocks] of [
    ['a collapsed details block hiding /new', [{ type: 'details', summary: '', blocks: [{ type: 'paragraph', text: '/new' }] }]],
    ['a message that reads "stop"', [{ type: 'paragraph', text: 'stop' }]],
    ['a message that reads "/model opus"', [{ type: 'paragraph', text: '/model opus' }]],
    ['a message that reads "/rewind"', [{ type: 'paragraph', text: '/rewind' }]],
  ]) {
    test(`${name} reaches the agent as content`, async () => {
      const msg = normalizeRichInbound(richDm(blocks));
      const { gate, calls } = makeGate();
      const res = await gate(msg, { tier: 'fresh' });
      assert.deepEqual(res, { action: 'dispatched' }, 'must take the regular path, not abort/admin/rewind');
      assert.equal(calls.abort.length, 0);
      assert.equal(calls.dispatched.length, 1);
      // handleMessage's slash dispatch runs after the gate and matches on a
      // leading "/" of the trimmed text.
      assert.ok(!calls.dispatched[0].text.trimStart().startsWith('/'));
    });
  }
});

describe('rich messages in a mention-gated group', () => {
  function groupGate() {
    const dispatched = [];
    const shouldHandle = createShouldHandle({
      getConfig: () => ({ chats: { '-100': { requireMention: true } } }),
      getPairings: () => null,
      getBotName: () => 'shumabit',
    });
    const gate = createGateInbound({
      config: { chats: { '-100': { requireMention: true } }, bot: {} },
      getBotUsername: () => 'shumabit_bot',
      getMentionRe: () => /@shumabit_bot\b/g,
      isAbortRequest,
      handleAbortIfRequested: async () => true,
      shouldHandle,
      getSessionKey: (chatId) => chatId,
      dispatchHandleMessage: (sessionKey, chatId, msg) => dispatched.push(msg),
      bot: {},
      botName: 'shumabit',
      logger: { error: () => {} },
    });
    return { gate, dispatched };
  }

  function groupForward(text) {
    return normalizeRichInbound({
      message_id: 8, date: 1, chat: { id: -100, type: 'supergroup' },
      from: { id: 222, is_bot: false, first_name: 'Teammate' },
      forward_origin: { type: 'user', sender_user: { id: 999, is_bot: true, first_name: 'Bot' }, date: 1 },
      rich_message: { blocks: [{ type: 'paragraph', text }] },
    });
  }

  test('an unaddressed forward is not answered (each answer is a paid turn)', async () => {
    const { gate, dispatched } = groupGate();
    const res = await gate(groupForward('weekly numbers'), { tier: 'fresh' });
    assert.deepEqual(res, { action: 'blocked', stage: 'shouldHandle' });
    assert.equal(dispatched.length, 0);
  });

  test('a forward that mentions the bot is answered', async () => {
    const { gate, dispatched } = groupGate();
    const res = await gate(groupForward('@shumabit_bot weekly numbers'), { tier: 'fresh' });
    assert.deepEqual(res, { action: 'dispatched' });
    assert.match(dispatched[0].text, /weekly numbers/);
  });
});

describe('a rich message answering an open free-text question', () => {
  test('the answer carries the rendered content, not an empty string', async () => {
    const answers = [];
    const gate = createGateInbound({
      config: { chats: { 111: {} }, bot: {} },
      getBotUsername: () => 'shumabit_bot',
      getMentionRe: () => /@shumabit_bot\b/g,
      isAbortRequest,
      handleAbortIfRequested: async () => true,
      getQuestionHandlers: () => ({
        isAwaitingOtherFrom: () => true,
        tryConsumeAsAnswer: async ({ text }) => { answers.push(text); return { consumed: true }; },
      }),
      shouldHandle: makeShouldHandle(),
      getSessionKey: (chatId) => chatId,
      dispatchHandleMessage: () => {},
      bot: {},
      botName: 'shumabit',
      logger: { error: () => {} },
    });
    const res = await gate(normalizeRichInbound(forwardedRichMessage()), { tier: 'fresh' });
    assert.deepEqual(res, { action: 'handled', stage: 'question-consume' });
    assert.match(answers[0], /Release checklist/);
  });
});

describe('rendered size and senders', () => {
  test('nesting cannot amplify a message past the cap', () => {
    const lines = 'a\n'.repeat(16_000);
    let block = { type: 'paragraph', text: lines };
    for (let i = 0; i < 15; i += 1) block = { type: 'blockquote', blocks: [block] };
    const msg = normalizeRichInbound({ message_id: 1, chat: { id: 111 }, from: OPERATOR, rich_message: { blocks: [block] } });
    // Telegram's own rich-message budget, plus the header and truncation lines.
    assert.ok(msg.text.length <= 32_768 + 64, `rendered ${msg.text.length} chars`);
    assert.ok(msg.text.endsWith('[rich message truncated]'), 'truncation must be visible to the agent');
  });

  test('truncation never splits an emoji in half', () => {
    // A lone surrogate is stored as U+FFFD, so the stored text would never
    // equal a fresh rendering and every edit event would look like a change.
    const text = `${'a'.repeat(32_767)}😀 tail`;
    const msg = normalizeRichInbound({
      message_id: 1, chat: { id: 111 }, from: OPERATOR,
      rich_message: { blocks: [{ type: 'paragraph', text }] },
    });
    assert.ok(msg.text.isWellFormed(), 'rendered text must not contain a lone surrogate');
    assert.ok(msg.text.endsWith('[rich message truncated]'));
  });

  test('a link with no label renders its URL once', () => {
    const url = `https://example.com/${'x'.repeat(2000)}`;
    const msg = normalizeRichInbound({
      message_id: 1, chat: { id: 111 }, from: OPERATOR,
      rich_message: { blocks: [{ type: 'paragraph', text: { type: 'url', text: '', url } }] },
    });
    assert.equal(msg.text, `${RICH_TEXT_HEADER}\n${url}`);
  });

  test('an anonymous group admin is a person, not a bot', () => {
    const msg = forwardedRichMessage();
    msg.chat = { id: -100, type: 'supergroup' };
    msg.from = { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' };
    msg.sender_chat = { id: -100, type: 'supergroup', title: 'UMI' };
    assert.match(normalizeRichInbound(msg).text, /Release checklist/);
  });

  test("another bot's rich message stays unrendered, but what it replies to still renders", () => {
    // Two AI bots in one group answering each other's rich replies would loop.
    const fromBot = forwardedRichMessage();
    delete fromBot.forward_origin;
    fromBot.from = { id: 555, is_bot: true, first_name: 'OtherBot' };
    fromBot.reply_to_message = { ...forwardedRichMessage(), message_id: 1 };
    normalizeRichInbound(fromBot);
    assert.equal(fromBot.text, undefined);
    assert.equal(makeShouldHandle()(fromBot, {}, 'shumabit_bot'), false);
    assert.ok(fromBot.reply_to_message.text.includes('Release checklist'));
  });
});

describe('polygram.js intake wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

  function handlerBody(event) {
    const start = source.indexOf(`bot.on('${event}', async (ctx) => {`);
    assert.notEqual(start, -1, `missing ${event} handler`);
    const end = source.indexOf('\n  });', start);
    return source.slice(start, end);
  }

  for (const [event, field, chatGuard] of [
    // Handler-level guards (4-space indent); the /pair onboarding block has
    // its own deeper-indented chatConfig check.
    ['message', 'ctx.message', '\n    if (!chatConfig) return;\n'],
    ['edited_message', 'ctx.editedMessage', '\n    if (!knownChat(chatId)) return;\n'],
  ]) {
    test(`${event} renders rich content right after the chat check, before the row is recorded`, () => {
      const body = handlerBody(event);
      const normalizeAt = body.indexOf(`normalizeRichInbound(${field});`);
      assert.notEqual(normalizeAt, -1, `${event} handler never normalizes rich content`);
      const guardAt = body.indexOf(chatGuard);
      assert.notEqual(guardAt, -1, `missing chat guard in ${event} handler`);
      assert.ok(guardAt < normalizeAt, 'unconfigured chats must not be rendered');
      // The edit path upserts the row's text, so an unrendered edit would
      // blank a rich row that was stored with its rendered text.
      const recordAt = body.indexOf(`recordInbound(${field})`, guardAt);
      assert.ok(normalizeAt < recordAt,
        'the stored row must hold the rendered text, or replay and history lose it');
    });
  }
});

describe('richMessageToText', () => {
  const { richMessageToText } = require('../lib/telegram/rich-inbound');
  const render = (...blocks) => richMessageToText({ blocks });

  test('headings keep their level so the agent sees the outline', () => {
    assert.equal(render({ type: 'heading', size: 3, text: 'Plan' }), '### Plan');
    assert.equal(render({ type: 'heading', size: 99, text: 'Tiny' }), '###### Tiny');
    assert.equal(render({ type: 'heading', text: 'No size' }), '# No size');
  });

  test('inline nodes render their visible text', () => {
    assert.equal(render({
      type: 'paragraph',
      text: [
        { type: 'italic', text: [{ type: 'bold', text: 'deep' }] },
        ' ',
        { type: 'custom_emoji', custom_emoji_id: '1', alternative_text: '🔥' },
        ' ',
        { type: 'mathematical_expression', expression: 'e=mc^2' },
        ' ',
        { type: 'mention', text: '@ivan', username: 'ivan' },
        { type: 'anchor', name: 'top' },
      ],
    }), 'deep 🔥 $e=mc^2$ @ivan');
  });

  test('a link keeps its target unless the label already is the URL', () => {
    assert.equal(render({ type: 'paragraph', text: { type: 'url', text: 'docs', url: 'https://a.b/c' } }), '[docs](https://a.b/c)');
    assert.equal(render({ type: 'paragraph', text: { type: 'url', text: 'https://a.b', url: 'https://a.b' } }), 'https://a.b');
  });

  test('nested lists indent and keep checkbox state', () => {
    assert.equal(render({
      type: 'list',
      items: [
        { label: '1.', blocks: [
          { type: 'paragraph', text: 'ship' },
          { type: 'list', items: [{ label: '•', has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: 'tag' }] }] },
        ] },
        { label: '2.', blocks: [{ type: 'paragraph', text: 'watch' }] },
      ],
    }), '1. ship\n  • [x] tag\n2. watch');
  });

  test('quotes carry their credit', () => {
    assert.equal(render({ type: 'blockquote', blocks: [{ type: 'paragraph', text: 'a' }, { type: 'paragraph', text: 'b' }], credit: 'Ivan' }),
      '> a\n>\n> b\n> — Ivan');
    assert.equal(render({ type: 'pullquote', text: 'said', credit: 'X' }), '> said\n> — X');
  });

  test('code, divider, math and table blocks', () => {
    assert.equal(render({ type: 'pre', language: 'sh', text: 'ls -la' }), '```sh\nls -la\n```');
    assert.equal(render({ type: 'pre', text: 'a ``` b' }), '````\na ``` b\n````',
      'code containing a fence must not close the outer fence early');
    assert.equal(render({ type: 'divider' }), '---');
    assert.equal(render({ type: 'mathematical_expression', expression: 'x^2' }), '$$x^2$$');
    assert.equal(render({
      type: 'table',
      caption: 'Fleet',
      cells: [[{ text: 'Bot', is_header: true }, { text: 'Host' }], [{}, { text: 'multi\nline' }]],
    }), 'Fleet\nBot | Host\n | multi line');
    assert.equal(render({
      type: 'table',
      cells: [[{ text: 'A' }, { text: 'B' }, { text: 'C' }], [{ text: 'wide', colspan: 2 }, { text: 'c' }]],
    }), 'A | B | C\nwide |  | c', 'a spanning cell must not shift later columns');
  });

  test('media inside the message becomes a placeholder that says the file is not attached', () => {
    assert.equal(render(
      { type: 'photo', photo: [{ file_id: 'p' }], caption: { text: 'the cat', credit: 'Ivan' } },
      { type: 'document', document: { file_id: 'd', file_name: 'report.pdf' } },
      { type: 'voice_note', voice_note: { file_id: 'v' } },
      { type: 'collage', blocks: [{ type: 'photo', photo: [] }, { type: 'video', video: { file_id: 'x' } }], caption: { text: 'trip' } },
    ), '[photo — not attached] the cat — Ivan\n\n[document: report.pdf — not attached]\n\n[voice — not attached]'
      + '\n\n[photo — not attached]\n\n[video — not attached]\ntrip');
  });

  test('details, map and buttons stay readable', () => {
    assert.equal(render({ type: 'details', summary: 'Logs', blocks: [{ type: 'paragraph', text: 'line' }] }), 'Logs\nline');
    assert.equal(render({ type: 'map', location: { latitude: 13.7, longitude: 100.5 }, zoom: 1, width: 1, height: 1 }), '[map: 13.7,100.5]');
    assert.equal(render({ type: 'buttons', buttons: [{ text: 'Open', url: 'https://a.b' }, { text: 'Close', callback_data: 'x' }] }),
      '[button: Open](https://a.b) [button: Close]');
  });

  test('a block type newer than the renderer keeps its readable content', () => {
    assert.equal(render({ type: 'callout', text: 'heads up' }), 'heads up');
    assert.equal(render({ type: 'sparkle' }), '[sparkle]');
  });

  test('legal nesting depth still renders', () => {
    // Telegram allows 16 levels of nested formatting; each one is a node
    // wrapping an array, so the renderer must not stop at 16 or 32.
    let inline = ['deep'];
    for (let i = 0; i < 16; i += 1) inline = [{ type: 'bold', text: inline }];
    let block = { type: 'paragraph', text: inline };
    for (let i = 0; i < 15; i += 1) block = { type: 'blockquote', blocks: [block] };
    assert.match(render(block), /deep$/);
  });

  test('every button in a long row keeps its label', () => {
    const buttons = Array.from({ length: 40 }, (_, i) => ({ text: `b${i}` }));
    assert.ok(render({ type: 'buttons', buttons }).endsWith('[button: b39]'));
  });

  test('an empty list item has no trailing space, and a code language cannot add lines', () => {
    assert.equal(render({ type: 'list', items: [{ label: '1.', blocks: [] }] }), '1.');
    assert.equal(render({ type: 'pre', language: 'js\n/new', text: 'x' }), '```js/new\nx\n```');
  });

  test('malformed input renders what it can and never throws', () => {
    assert.equal(richMessageToText(null), '');
    assert.equal(richMessageToText('text'), '');
    assert.equal(richMessageToText({ blocks: 'nope' }), '');
    assert.equal(render(null, 7, { type: 'paragraph', text: 42 }, { type: 'paragraph', text: 'ok' }), 'ok');

    let bomb = { type: 'paragraph', text: 'bottom' };
    for (let i = 0; i < 10_000; i += 1) bomb = { type: 'blockquote', blocks: [bomb] };
    assert.doesNotThrow(() => render(bomb));
    assert.ok(!render(bomb).includes('bottom'), 'rendering must stop at the depth cap');

    let inline = 'leaf';
    for (let i = 0; i < 10_000; i += 1) inline = { type: 'bold', text: [inline] };
    assert.doesNotThrow(() => render({ type: 'paragraph', text: inline }));
  });

  test('a render failure leaves the message untouched and is logged', () => {
    const { normalizeRichInbound } = require('../lib/telegram/rich-inbound');
    const errors = [];
    const msg = { message_id: 9, rich_message: {} };
    Object.defineProperty(msg.rich_message, 'blocks', { get() { throw new Error('boom'); } });
    normalizeRichInbound(msg, { logger: { error: (line) => errors.push(line) } });
    assert.equal(msg.text, undefined);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /rich message 9 could not be rendered: boom/);
  });
});
