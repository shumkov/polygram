'use strict';

/**
 * The reply-tool delivery strategy: decides rich vs plain for one reply.
 *
 * Two invariants carry most of the weight here.
 *
 * Delivery is never lost. Every way rich can fail (gate, over-length,
 * nothing to render, any error class from the send) must come back as a
 * decline so the pipeline's chunked path still delivers.
 *
 * Fallback hygiene — in a rich-enabled chat, NO outcome may render an
 * absolute local path into the chat. Media blocks are out of scope for this
 * release, so image markdown degrades to its caption on both the rich and
 * the plain branch. This is a deliberate divergence from "flag-off behavior
 * is byte-identical": flag-off chats keep raw markdown, flag-on chats get
 * the leak closed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');
const { RICH_MAX_LEN } = require('../lib/telegram/rich');

const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |';

function build(overrides = {}) {
  const sendCalls = [];
  const gateArgs = [];
  const factory = createRichDeliveryFactory({
    bot: {},
    sendRich: async (args) => {
      sendCalls.push(args);
      return { wentRich: true, result: { message_id: 909 } };
    },
    isRichTextEnabled: (c, t) => { gateArgs.push([c, t]); return true; },
    getRichKnownUnsupported: () => false,
    ...overrides,
  });
  return { factory, sendCalls, gateArgs };
}

const deliver = (factory, text, extra = {}) => factory({
  sessionKey: 'sess-A', sessionCwd: '/tmp/ws', chatId: '12345', threadId: null,
})({ text, chatId: '12345', threadId: null, replyToMessageId: null, meta: {}, ...extra });

// ─── The rich path ─────────────────────────────────────────────────────────

test('structured content is sent as rich blocks in one message', async () => {
  const { factory, sendCalls } = build();

  const out = await deliver(factory, TABLE);

  assert.equal(out.handled, true);
  assert.deepEqual(out.sent, [{ message_id: 909 }],
    'the pipeline records the bubble so the agent can edit it');
  assert.equal(sendCalls.length, 1);
  assert.ok(sendCalls[0].blocks.length > 0);
  assert.ok(sendCalls[0].blocks.some(b => b.type === 'table'), 'the table survived as a block');
});

test('a reply targeting an inbound message carries the reply anchor', async () => {
  // Shape parity with the chunked path matters here: a long turn gives the
  // user time to delete the message being answered, and without
  // allow_sending_without_reply Telegram rejects the whole send.
  const { factory, sendCalls } = build();
  await deliver(factory, TABLE, { replyToMessageId: 55 });
  assert.deepEqual(sendCalls[0].replyParams, {
    message_id: 55,
    allow_sending_without_reply: true,
  });
});

test('topic replies carry the thread id through to the send', async () => {
  const { factory, sendCalls, gateArgs } = build();
  await factory({ sessionKey: 's', sessionCwd: null, chatId: '12345', threadId: '77' })({
    text: TABLE, chatId: '12345', threadId: '77', replyToMessageId: null, meta: {},
  });
  assert.equal(sendCalls[0].threadId, '77');
  // richText resolves per topic, so swapped or dropped arguments would let a
  // topic that opted out receive rich — invisible unless the call is pinned.
  assert.deepEqual(gateArgs, [['12345', '77']]);
});

// ─── Declining to go rich ──────────────────────────────────────────────────

test('plain prose is left to the chunked path', async () => {
  const { factory, sendCalls } = build();
  const out = await deliver(factory, 'Just a normal conversational answer.');
  assert.equal(out.handled, false);
  assert.equal(sendCalls.length, 0, 'no rich attempt for content with no structure');
});

test('rich-disabled chats are untouched, raw markdown included', async () => {
  // A chat that never opted in must behave exactly as it does without this
  // feature —
  // including rendering image markdown as-is, because that is today's
  // behavior and changing it here would be an unrequested surprise.
  const { factory, sendCalls } = build({ isRichTextEnabled: () => false });

  const out = await deliver(factory, `${TABLE}\n\n![shot](/Users/me/secret/shot.png)`);

  assert.equal(out.handled, false);
  assert.equal(out.text, undefined, 'no text rewrite — the pipeline delivers what the agent wrote');
  assert.equal(sendCalls.length, 0);
});

test('a latched capability skips the attempt but keeps the hygiene rewrite', async () => {
  // The fixture must be content that WOULD go rich, or the decline proves
  // only that prose is prose and the latch could be deleted unnoticed.
  const { factory, sendCalls } = build({ getRichKnownUnsupported: () => true });

  const out = await deliver(factory, `${TABLE}\n\n![shot](/Users/me/secret/shot.png)`);

  assert.equal(out.handled, false, 'the latch is the only thing that can decline this');
  assert.equal(sendCalls.length, 0, 'the latch is checked before rendering, not after');
  assert.ok(!out.text.includes('/Users/me'), 'the flag is still on, so the path must not render');
});

test('over-length is measured on the fallback body, not the raw text', async () => {
  // A reply can be over the cap as authored but under it once media markdown
  // collapses to captions. Measuring the raw text would downgrade it for no
  // reason — and a fixture without media cannot tell the two apart.
  const { factory, sendCalls } = build();
  const longPath = `/Users/me/${'d'.repeat(400)}/shot.png`;
  const media = `![c](${longPath})\n`.repeat(40);
  const body = 'x'.repeat(RICH_MAX_LEN - 200);
  const raw = `${TABLE}\n\n${body}\n\n${media}`;

  assert.ok(raw.length > RICH_MAX_LEN, 'fixture must be over the cap as authored');
  const out = await deliver(factory, raw);

  assert.equal(out.handled, true, 'the stripped body fits, so rich is still attempted');
  assert.equal(sendCalls.length, 1);
});

test('a reply over the cap even after stripping goes plain', async () => {
  const { factory, sendCalls } = build();
  const out = await deliver(factory, `${TABLE}\n\n${'x'.repeat(RICH_MAX_LEN)}`);
  assert.equal(out.handled, false);
  assert.equal(sendCalls.length, 0);
});

test('the cap boundary is inclusive — exactly at the limit still goes rich', async () => {
  const { factory, sendCalls } = build();
  const pad = RICH_MAX_LEN - TABLE.length - 2;
  const atLimit = `${TABLE}\n\n${'x'.repeat(pad)}`;
  assert.equal(atLimit.length, RICH_MAX_LEN, 'fixture sits exactly on the boundary');

  const out = await deliver(factory, atLimit);

  assert.equal(out.handled, true, 'a reply exactly at the cap is still sendable');
  assert.equal(sendCalls.length, 1);
});

// ─── Every failure class still delivers ────────────────────────────────────

test('a declined send falls through to plain delivery', async () => {
  const { factory } = build({ sendRich: async () => ({ wentRich: false }) });
  const out = await deliver(factory, TABLE);
  assert.equal(out.handled, false, 'the pipeline must still deliver this reply');
});

test('a throwing send falls through instead of losing the reply', async () => {
  // sendRich is contracted never to throw, but the strategy must not depend
  // on that: a lost reply is a far worse failure than a flat one.
  const { factory } = build({ sendRich: async () => { throw new Error('boom'); } });
  const out = await deliver(factory, TABLE);
  assert.equal(out.handled, false);
});

test('a throwing renderer falls through instead of losing the reply', async () => {
  const { factory } = build({
    toRichBlocks: () => { throw new Error('lexer exploded'); },
  });
  const out = await deliver(factory, TABLE);
  assert.equal(out.handled, false);
});

// ─── Media hygiene (no media blocks in this release) ───────────────────────

test('image markdown renders as its caption, never as a path', async () => {
  const { factory, sendCalls } = build();

  const out = await deliver(factory, `## Results\n\n![the chart](/Users/me/secret/chart.png)`);

  assert.equal(out.handled, true);
  const payload = JSON.stringify(sendCalls[0].blocks);
  assert.ok(!payload.includes('/Users/me'), `absolute path leaked into blocks: ${payload}`);
  assert.ok(payload.includes('the chart'), 'the caption survives as text');
});

test('image markdown cannot by itself trigger a rich send', async () => {
  // Media is not renderable on this path yet. If an image were allowed to be
  // the only reason a reply went rich, the user would get a rich bubble whose
  // entire point had been stripped out of it.
  const { factory, sendCalls } = build();

  const out = await deliver(factory, '![just a shot](/Users/me/secret/shot.png)');

  assert.equal(out.handled, false);
  assert.equal(sendCalls.length, 0);
});

test('every plain outcome in a rich chat strips media markdown', async () => {
  // Nothing else on the dispatcher path strips image syntax, so without
  // this a rich-flagged chat renders raw absolute paths into the chat.
  // Whichever branch declines, the path must not survive.
  //
  // Each case needs a fixture that actually REACHES its branch. Prose-only
  // text returns at the no-structure gate, so reusing it everywhere would
  // exercise one branch four times under four labels.
  const media = '![a shot](/Users/me/secret/shot.png)';
  const prose = `Look:\n\n${media}\n\nThat is all.`;
  const structured = `${TABLE}\n\n${media}`;

  let rendererCalls = 0;
  let sendCalls = 0;

  const cases = [
    { label: 'no structure', text: prose, build: () => build() },
    {
      label: 'send declined',
      text: structured,
      build: () => build({
        sendRich: async () => { sendCalls += 1; return { wentRich: false }; },
      }),
      after: () => assert.equal(sendCalls, 1, 'the send branch was actually reached'),
    },
    {
      label: 'capability latched',
      text: structured,
      build: () => build({ getRichKnownUnsupported: () => true }),
    },
    {
      label: 'renderer threw',
      text: structured,
      build: () => build({
        toRichBlocks: () => { rendererCalls += 1; throw new Error('lexer exploded'); },
      }),
      after: () => assert.equal(rendererCalls, 1, 'the throwing renderer was actually reached'),
    },
  ];

  for (const { label, text, build: mk, after } of cases) {
    const { factory } = mk();
    const out = await deliver(factory, text);
    assert.equal(out.handled, false, `${label}: expected a decline`);
    assert.ok(typeof out.text === 'string', `${label}: expected rewritten fallback text`);
    assert.ok(!out.text.includes('/Users/me'), `${label}: path leaked as "${out.text}"`);
    assert.ok(out.text.includes('a shot'), `${label}: caption should survive`);
    after?.();
  }
});

test('every declining branch strips media, including the ones that decline late', async () => {
  // The earlier hygiene sweep covered the branches that decline BEFORE the
  // send. These decline after rendering, and each returns its own fallback
  // body — a branch that forgets to project its text leaks the raw path with
  // the rest of the suite green.
  const media = '![a shot](/Users/me/secret/shot.png)';
  const oversize = 'y'.repeat(RICH_MAX_LEN + 1);

  const cases = [
    {
      label: 'over-length after stripping',
      text: `${TABLE}\n\n${oversize}\n\n${media}`,
      build: () => build(),
    },
    {
      label: 'send declined',
      text: `${TABLE}\n\n${media}`,
      build: () => build({ sendRich: async () => ({ wentRich: false }) }),
    },
    {
      label: 'send threw',
      text: `${TABLE}\n\n${media}`,
      build: () => build({ sendRich: async () => { throw new Error('boom'); } }),
    },
  ];

  for (const { label, text, build: mk } of cases) {
    const { factory } = mk();
    const out = await deliver(factory, text);
    assert.equal(out.handled, false, `${label}: expected a decline`);
    assert.equal(typeof out.text, 'string', `${label}: must supply a projected body`);
    assert.ok(!out.text.includes('/Users/me'), `${label}: path leaked as "${out.text.slice(0, 120)}"`);
    assert.ok(out.text.includes('a shot'), `${label}: caption should survive`);
  }
});

test('a send that reports success without a message id yields no bubble to edit', async () => {
  const { factory } = build({
    sendRich: async () => ({ wentRich: true, result: {} }),
  });

  const out = await deliver(factory, TABLE);

  assert.equal(out.handled, true, 'the message did land — it just cannot be addressed');
  assert.deepEqual(out.sent, [], 'no id means no ownership claim and no edit target');
});

test('a path containing spaces is stripped like any other', async () => {
  // macOS names screenshots "Screenshot 2026-07-28 at 10.11.32.png", so a
  // space in the path is the common case rather than an adversarial one.
  // The gate that decides "this looks like media" and the stripper that
  // removes it have to agree about what an image is, or media slips past
  // the stripper and ships as literal text.
  const { factory, sendCalls } = build();
  const spaced = '## Results\n\n![the chart](/Users/me/secret/Screenshot 2026-07-28 at 10.11.32.png)';

  const out = await deliver(factory, spaced);

  const payload = JSON.stringify(sendCalls[0]?.blocks ?? out.text);
  assert.ok(!payload.includes('/Users/me'), `absolute path leaked: ${payload}`);
  assert.ok(payload.includes('the chart'), 'the caption still survives');
});

test('a spaced-path image alone cannot trigger a rich send', async () => {
  const { factory, sendCalls } = build();
  const out = await deliver(factory, '![just a shot](/Users/me/secret dir/shot.png)');
  assert.equal(out.handled, false);
  assert.equal(sendCalls.length, 0);
  assert.ok(!String(out.text).includes('/Users/me'));
});

test('the rich payload is rendered from the stripped text, not the raw text', async () => {
  const { factory, sendCalls } = build();
  await deliver(factory, `${TABLE}\n\n![cap](/Users/me/secret/shot.png)`);
  const payload = JSON.stringify(sendCalls[0].blocks);
  assert.ok(!payload.includes('secret'), 'no media path may reach the block tree');
});
