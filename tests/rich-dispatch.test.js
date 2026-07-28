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
 * absolute local path into the chat. Media that resolves becomes a block;
 * media that does not degrades to its caption, on both the rich and the
 * plain branch. This is a deliberate divergence from "flag-off behavior is
 * byte-identical": flag-off chats keep raw markdown, flag-on chats get the
 * leak closed.
 *
 * Media renders only when the caller injects a wiring for the call (the
 * tests below that pass one use the REAL resolver and preflight over a real
 * temp workspace — the trust boundary is the point). Without one, the
 * text-only behavior above still holds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');
const { RICH_MAX_LEN, stripMediaMarkdown } = require('../lib/telegram/rich');
const {
  createRichMediaResolver,
  createMediaDeliveryContext,
  createMediaPreflight,
} = require('../lib/telegram/rich-media');

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

// ─── Media blocks ──────────────────────────────────────────────────────────
//
// With a media wiring injected, rendering runs on the RAW text and image
// syntax becomes a real photo/video/animation block. Without one the strategy
// keeps the text-only behavior above: media collapses to its caption.

const tempDirs = new Set();
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mediaWorkspace(name = 'chart.png') {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'polygram-rich-dispatch-'));
  tempDirs.add(dir);
  const file = nodePath.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(64, 7));
  return { dir, file };
}

// The real resolver and the real preflight, over a real temp workspace: the
// trust boundary is the point of this path, and a fake one would prove
// nothing about it.
function buildWithMedia(overrides = {}) {
  const wiringArgs = [];
  const built = build({
    makeMediaWiring: (args) => {
      wiringArgs.push(args);
      return {
        resolveMedia: createRichMediaResolver({
          allowedRoots: args.allowedRoots,
          allowUrlMedia: false,
        }),
        mediaContext: createMediaDeliveryContext({
          allowedRoots: args.allowedRoots,
          tg: async () => ({}),
          bot: {},
          chatId: args.chatId,
        }),
      };
    },
    ...overrides,
  });
  return { ...built, wiringArgs };
}

const deliverIn = (factory, text, allowedRoots, extra = {}) => factory({
  sessionKey: 'sess-A',
  sessionCwd: allowedRoots[0],
  chatId: '12345',
  threadId: null,
  allowedRoots,
})({ text, chatId: '12345', threadId: null, replyToMessageId: null, meta: {}, ...extra });

test('an inline photo inside the allowed roots becomes a photo block', async () => {
  const { dir, file } = mediaWorkspace();
  const { factory, sendCalls } = buildWithMedia();

  const out = await deliverIn(factory, `## Results\n\n![the chart](${file})`, [dir]);

  assert.equal(out.handled, true);
  const blocks = sendCalls[0]?.blocks ?? [];
  const photo = blocks.find((b) => b.type === 'photo');
  assert.ok(photo, `expected a photo block, got ${JSON.stringify(blocks)}`);
  assert.equal(photo.photo.media.source, fs.realpathSync(file),
    'the uploaded source is the resolved realpath');
  assert.equal(photo.caption.text, 'the chart');
});

test('the send receives the preflight for this call, not a bare block tree', async () => {
  // Without it, materialization takes the unchecked branch: cached ids and
  // local sources used blindly, which is the exact TOCTOU the preflight closes.
  const { dir, file } = mediaWorkspace();
  const { factory, sendCalls } = buildWithMedia();

  await deliverIn(factory, `## Results\n\n![the chart](${file})`, [dir]);

  assert.equal(typeof sendCalls[0].mediaContext?.preflightMedia, 'function');
});

test('media outside the call\'s roots degrades to a caption, never a path', async () => {
  // Same rejection reply(files:) would give the same path — that parity is
  // the point, and it is enforced by both sides receiving one roots array.
  const { dir } = mediaWorkspace();
  const outside = mediaWorkspace('secret.png');
  const { factory, sendCalls } = buildWithMedia();

  const out = await deliverIn(factory, `## Results\n\n![a shot](${outside.file})`, [dir]);

  assert.equal(out.handled, true, 'the heading still carries the reply');
  const payload = JSON.stringify(sendCalls[0].blocks);
  assert.ok(!payload.includes(outside.dir), `path leaked into blocks: ${payload}`);
  assert.ok(payload.includes('a shot (media unavailable)'),
    `expected an honest placeholder, got ${payload}`);
});

test('a reply whose only media is unresolvable demotes to plain', async () => {
  // A rich bubble whose entire point was stripped out of it is worse than a
  // plain one. With no other trigger, the reply goes to the chunked path.
  const { dir } = mediaWorkspace();
  const outside = mediaWorkspace('secret.png');
  const { factory, sendCalls } = buildWithMedia();

  const out = await deliverIn(factory, `![a shot](${outside.file})`, [dir]);

  assert.equal(out.handled, false);
  assert.equal(sendCalls.length, 0);
  assert.equal(out.text, 'a shot', 'the caption is what the chunked path delivers');
});

test('without a media wiring, image syntax still cannot reach the renderer', async () => {
  // Nothing could upload, so a photo block would be a placeholder bubble at
  // best — and could be the only reason the reply went rich at all.
  const { dir, file } = mediaWorkspace();
  const { factory, sendCalls } = build();

  const out = await deliverIn(factory, `## Results\n\n![the chart](${file})`, [dir]);

  assert.equal(out.handled, true);
  const payload = JSON.stringify(sendCalls[0].blocks);
  assert.ok(!payload.includes(dir), 'no path may reach the block tree');
  assert.ok(!payload.includes('photo'), 'and no media block either');
});

test('no roots for this call means no media wiring is even built', async () => {
  const { file } = mediaWorkspace();
  const { factory, wiringArgs, sendCalls } = buildWithMedia();

  const out = await deliverIn(factory, `## Results\n\n![the chart](${file})`, []);

  assert.deepEqual(wiringArgs, [], 'an empty roots array is not a boundary — it is a missing one');
  assert.equal(out.handled, true, 'the reply still goes rich on its heading');
  assert.ok(!JSON.stringify(sendCalls[0].blocks).includes('photo'));
});

// ─── The media-source-changed ladder ───────────────────────────────────────

test('a file swapped mid-flight costs the media, not the structure', async () => {
  // Three steps: rich with media → rich with honest placeholders → plain.
  // Losing a whole table because one screenshot was rewritten is the worse
  // trade, so the structure gets one more attempt.
  const { dir, file } = mediaWorkspace();
  const calls = [];
  const outcomes = [
    { wentRich: false, fallback: 'media-source-changed' },
    { wentRich: true, result: { message_id: 4242 } },
  ];
  const { factory } = buildWithMedia({
    sendRich: async (args) => { calls.push(args); return outcomes.shift(); },
  });

  const out = await deliverIn(factory, `## Results\n\n![the chart](${file})\n\nDone.`, [dir]);

  assert.equal(out.handled, true);
  assert.deepEqual(out.sent, [{ message_id: 4242 }]);
  assert.equal(calls.length, 2, 'exactly one retry — not a loop');
  assert.ok(JSON.stringify(calls[0].blocks).includes('photo'),
    'the first attempt carried the real media');
  const retried = JSON.stringify(calls[1].blocks);
  assert.ok(!retried.includes('photo'), 'the retry carries no media');
  assert.ok(retried.includes('the chart (media unavailable)'),
    `the retry says so honestly: ${retried}`);
  assert.ok(retried.includes('Results'), 'and keeps the structure it was sent for');
});

test('an uncaptioned item that vanished renders the bare placeholder', async () => {
  const { dir, file } = mediaWorkspace();
  const calls = [];
  const outcomes = [
    { wentRich: false, fallback: 'media-source-changed' },
    { wentRich: true, result: { message_id: 1 } },
  ];
  const { factory } = buildWithMedia({
    sendRich: async (args) => { calls.push(args); return outcomes.shift(); },
  });

  await deliverIn(factory, `## Results\n\n![](${file})`, [dir]);

  assert.ok(JSON.stringify(calls[1].blocks).includes('(media unavailable)'));
});

test('a media-only reply collapses the ladder to two steps', async () => {
  // Re-rendering with everything rejected leaves no rich trigger at all, so
  // the demotion rule takes it to plain without a second send.
  const { dir, file } = mediaWorkspace();
  const calls = [];
  const { factory } = buildWithMedia({
    sendRich: async (args) => {
      calls.push(args);
      return { wentRich: false, fallback: 'media-source-changed' };
    },
  });

  const out = await deliverIn(factory, `![the chart](${file})`, [dir]);

  assert.equal(calls.length, 1, 'no second send: there is nothing rich left to send');
  assert.equal(out.handled, false);
  assert.equal(out.text, 'the chart', 'the chunked path delivers the caption');
});

test('a retry that also fails still delivers the reply', async () => {
  const { dir, file } = mediaWorkspace();
  const calls = [];
  const { factory } = buildWithMedia({
    sendRich: async (args) => {
      calls.push(args);
      return calls.length === 1
        ? { wentRich: false, fallback: 'media-source-changed' }
        : { wentRich: false, fallback: 'content-error' };
    },
  });

  const out = await deliverIn(factory, `## Results\n\n![the chart](${file})`, [dir]);

  assert.equal(calls.length, 2);
  assert.equal(out.handled, false, 'the pipeline still has to deliver this');
  assert.ok(!out.text.includes(dir), 'and never with the path in it');
});

test('other failure classes do not trigger the media retry', async () => {
  // Re-rendering helps only when the media is the problem. Retrying a
  // capability failure would be a second doomed call on every reply.
  const { dir, file } = mediaWorkspace();
  for (const fallback of ['capability', 'content-error', 'error', undefined]) {
    const calls = [];
    const { factory } = buildWithMedia({
      sendRich: async (args) => { calls.push(args); return { wentRich: false, fallback }; },
    });
    const out = await deliverIn(factory, `## Results\n\n![the chart](${file})`, [dir]);
    assert.equal(calls.length, 1, `fallback=${fallback} should not be retried`);
    assert.equal(out.handled, false);
  }
});

test('a media wiring that throws costs media, never the reply', async () => {
  const { dir, file } = mediaWorkspace();
  const { factory, sendCalls } = build({
    makeMediaWiring: () => { throw new Error('roots exploded'); },
  });

  const out = await deliverIn(factory, `## Results\n\n![the chart](${file})`, [dir]);

  assert.equal(out.handled, true, 'the reply still goes out, just without its media');
  assert.ok(!JSON.stringify(sendCalls[0].blocks).includes(dir));
});

test('styled text cannot smuggle a path past the media guard', async () => {
  // The guard walks block text looking for surviving image markdown. Styled
  // text is an ARRAY of strings and nodes, so a string-only check skips it
  // entirely — and the mundane case (a spaced screenshot path in a sentence
  // that also contains bold) ships the absolute path.
  const { dir } = mediaWorkspace();
  const { factory, sendCalls } = buildWithMedia({
    toRichBlocks: (text, opts) => require('../lib/telegram/rich')
      .toTelegramRichBlocks(text, { ...opts, inlineStyling: true }),
  });

  const out = await deliverIn(
    factory,
    '## Results\n\nThe **build** shot: ![shot](/Users/ivan/Desktop/a b.png)',
    [dir],
  );

  const wire = JSON.stringify(sendCalls[0]?.blocks ?? out.text ?? '');
  assert.ok(!wire.includes('/Users/ivan'), `absolute path reached the chat: ${wire}`);
});

test('a wiring missing its preflight is refused outright', async () => {
  // Half a wiring is the dangerous shape: the resolver would hand local
  // sources and cached ids to the send, and materialization would take the
  // unchecked branch — the exact TOCTOU the preflight exists to close.
  const { dir, file } = mediaWorkspace();
  const { factory, sendCalls } = build({
    makeMediaWiring: ({ allowedRoots }) => ({
      resolveMedia: createRichMediaResolver({ allowedRoots, allowUrlMedia: false }),
      mediaContext: null,
    }),
  });

  const out = await deliverIn(factory, `## Results\n\n![the chart](${file})`, [dir]);

  assert.equal(out.handled, true, 'the reply still goes out — text-only');
  const payload = JSON.stringify(sendCalls[0].blocks);
  assert.ok(!payload.includes('photo'), 'no media may be sent without a preflight');
  assert.ok(!payload.includes(dir));
});

// ─── No branch renders a local path (the raw-render hazards) ───────────────
//
// Rendering on RAW text is what makes media possible, and it is also what
// re-opens the leak the stripped-body render closed by construction. Two
// distinct mechanisms, both reachable from ordinary agent output.

test('image syntax the parser rejects never reaches the chat as text', async () => {
  // The rich gate's image regex is looser than the CommonMark parser. A
  // destination with a space (macOS names every screenshot that way), one
  // with parentheses, and an unterminated fragment are all "an image" to the
  // gate and none of them to the parser — so each yields no descriptor,
  // dodges the media-only demotion, and would survive as literal text with
  // the absolute path in it.
  //
  // The spaced case uses a REAL file inside the allowed roots: it is the
  // ordinary case (the spec's own demo is a workspace screenshot), and it
  // proves the leak is a rendering gap rather than merely unresolvable media.
  const real = mediaWorkspace('Screenshot 2026-07-29 at 10.00.00.png');
  const cases = {
    'spaces (real file, in roots)': `Here you go:\n\n![the shot](${real.file})`,
    parens: 'Here you go:\n\n![shot](/Users/ivan/Desktop/shot (1).png)',
    'unterminated fragment': `${TABLE}\n\n![shot](/Users/ivan/Desktop/id_rsa`,
    'wrapper around an unparseable path':
      `## Results\n\n<tg-collage>\n\n![a](/Users/ivan/Desktop/a b.png)\n\n</tg-collage>`,
  };

  for (const [label, text] of Object.entries(cases)) {
    const { factory, sendCalls } = buildWithMedia();
    const out = await deliverIn(factory, text, [real.dir]);
    const wire = JSON.stringify(sendCalls[0]?.blocks ?? out.text ?? '');
    assert.ok(!wire.includes('/Users/ivan') && !wire.includes(real.dir),
      `${label}: path reached the chat as ${wire}`);
  }
});

test('an uncaptioned image cannot smuggle its path through inline flattening', async () => {
  // Inline tokens are flattened to plain text for headings, table cells and
  // emphasis. An uncaptioned image there has no alt to flatten to, and
  // falling back to its destination would print the path — the reply tool
  // renders whatever an injected agent writes.
  const { dir } = mediaWorkspace();
  const secret = '/Users/ivan/.ssh/id_rsa';
  const cases = {
    heading: `# ![](${secret})`,
    emphasis: `## Results\n\nsee **![](${secret})** here`,
    table: `| a | b |\n| --- | --- |\n| ![](${secret}) | x |`,
    linked: `## Results\n\n[![](${secret})](https://example.com)`,
  };

  for (const [label, text] of Object.entries(cases)) {
    const { factory, sendCalls } = buildWithMedia();
    const out = await deliverIn(factory, text, [dir]);
    const wire = JSON.stringify(sendCalls[0]?.blocks ?? out.text ?? '');
    assert.ok(!wire.includes('id_rsa'), `${label}: path reached the chat as ${wire}`);
  }
});

test('a reply whose RAW text is over the cap is refused before the filesystem is touched', async () => {
  // The stripped body is blind to the cost of media: image markdown collapses
  // to a caption, so a megabyte of `![](…)` lines measures a few characters
  // while charging a realpath+stat per descriptor on the daemon's busiest
  // path. Only the raw measurement can see it.
  const { dir, file } = mediaWorkspace();
  let resolverCalls = 0;
  const { factory, sendCalls } = build({
    makeMediaWiring: ({ allowedRoots }) => ({
      resolveMedia: (descriptors) => {
        resolverCalls += 1;
        return createRichMediaResolver({ allowedRoots, allowUrlMedia: false })(descriptors);
      },
      mediaContext: createMediaPreflight({ allowedRoots }),
    }),
  });
  const flood = `![](${file})\n`.repeat(2000);
  const text = `## Results\n\n${flood}`;

  assert.ok(stripMediaMarkdown(text).length < RICH_MAX_LEN,
    'fixture must pass the stripped-body gate — otherwise it proves nothing');
  assert.ok(text.length > RICH_MAX_LEN, 'and be over the cap as authored');

  const out = await deliverIn(factory, text, [dir]);

  assert.equal(out.handled, false, 'the reply goes out plain');
  assert.equal(resolverCalls, 0, 'and no descriptor was ever resolved');
  assert.equal(sendCalls.length, 0);
});
