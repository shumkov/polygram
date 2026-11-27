'use strict';

/**
 * Inline images in a reply are never dropped without the agent being told.
 *
 * The reply tool used to answer {ok:true} whatever happened to the images in
 * its text: an image construct the parser could not read (a bare path with
 * spaces) vanished with no event at all, and a rejected path degraded to a
 * "(media unavailable)" line the agent never saw. The agent then reported
 * images it had not sent, three times in a row.
 *
 * The contract pinned here:
 *   - a reply whose inline media cannot ALL be sent is refused before
 *     anything goes out (ok:false, nothing delivered), and the error names
 *     each item and its reason in plain words, so the agent can fix the
 *     reply and send it whole;
 *   - media lost AFTER the text went out is reported the same way, with the
 *     delivered message_id, so the agent does not resend the text;
 *   - an unparsed image construct is a rejection in `rich-media-rejected`,
 *     and that event tells a missing file from one outside the roots.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createChannelsToolDispatcher,
  DEFAULT_ATTACHMENT_BASE,
} = require('../lib/process/channels-tool-dispatcher');
const { createRichDeliveryFactory } = require('../lib/telegram/rich-dispatch');
const { createRichSender } = require('../lib/telegram/rich-send');
const { makeReplyMediaWiring } = require('../lib/telegram/rich-media');
const { composeDeliverTextFactories } = require('../lib/telegram/deliver-strategy');
const {
  isRichCapabilityError, isRichCapabilityErrorExplicit, isRichContentError,
  stripMediaMarkdown, inventoryImageSyntax,
} = require('../lib/telegram/rich');
const { buildPolygramDisplayHint } = require('../lib/telegram/display-hint');

const fakeBot = {};
const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };
const passthroughParse = (text) => ({
  text, sticker: null, stickerLabel: null, stickers: [], reaction: null, reactions: [],
});
const passthroughSanitize = (text) => ({ text, replaced: false });

const cleanup = new Set();
test.after(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-media-loud-'));
  cleanup.add(dir);
  return dir;
}

function writeImage(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(64, 1));
  return file;
}

// polygram's reply-tool wiring, end to end: the real resolver, sender and
// rich strategy, with Telegram and the chunked path captured.
function build({ latched = false, richMaxLen } = {}) {
  const tgCalls = [];
  const events = [];
  const deliverCalls = [];
  const send = async (_bot, method, params) => {
    tgCalls.push({ method, params });
    return { message_id: 700 + tgCalls.length, date: 1 };
  };
  const sendRich = createRichSender({
    tg: send,
    botName: 'testbot',
    logEvent: () => {},
    redactBotToken: (s) => s,
    isRichCapabilityError,
    isRichCapabilityErrorExplicit,
    isRichContentError,
    getRichKnownUnsupported: () => latched,
    setRichKnownUnsupported: () => {},
    makeInputFile: (source) => ({ upload: source }),
    logger: quietLogger,
  });
  const richFactory = createRichDeliveryFactory({
    bot: fakeBot,
    sendRich,
    isRichTextEnabled: () => true,
    getRichKnownUnsupported: () => latched,
    logger: quietLogger,
    ...(richMaxLen ? { richMaxLen } : {}),
    makeMediaWiring: makeReplyMediaWiring({
      logEvent: (kind, detail) => events.push({ kind, detail }),
    }),
  });
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send,
    chunkText: (text) => [text],
    deliverReplies: async ({ chunks }) => {
      deliverCalls.push([...chunks]);
      return { sent: chunks.map((_, i) => ({ message_id: 900 + i })), failed: [], results: [] };
    },
    parseResponse: passthroughParse,
    sanitizeAssistantReply: passthroughSanitize,
    logger: quietLogger,
    projectFallbackText: (text) => {
      const stripped = stripMediaMarkdown(text);
      return stripped.trim() ? stripped : '(media unavailable)';
    },
    makeDeliverText: composeDeliverTextFactories([richFactory]),
  });
  const rejectedEvents = () => events.filter((e) => e.kind === 'rich-media-rejected');
  const sentAnything = () => tgCalls.length > 0 || deliverCalls.length > 0;
  return { dispatcher, tgCalls, deliverCalls, rejectedEvents, sentAnything };
}

const reply = (h, text, { sessionKey = 'sess-loud', sessionCwd, files = null } = {}) => h.dispatcher({
  sessionKey, chatId: '-1004462674958', threadId: '1306',
  toolName: 'reply', text, files, sessionCwd,
});

// ─── The incident, step by step ────────────────────────────────────────────

test('05:58 — a bare path with spaces is refused and named, not silently dropped', async () => {
  // The file exists and is inside the workspace: the ONLY problem is that a
  // destination with spaces is not an image to a CommonMark parser. The old
  // code sent the text, logged media_count 0, emitted no rejection, and
  // answered ok:true.
  const cwd = workspace();
  const file = writeImage(cwd, 'PREVIEW 1 until sunday.jpg');
  const h = build();

  const res = await reply(h, `Story previews:\n\n![1 UNTIL SUNDAY](${file})`, { sessionCwd: cwd });

  assert.equal(res.ok, false, `the agent must not be told this went out: ${JSON.stringify(res)}`);
  assert.ok(res.error.includes(file), `the error names the item: ${res.error}`);
  assert.ok(res.error.includes('unparsed image (spaces in the path? wrap it in <…>; not an image? put it in `code`)'), res.error);
  assert.equal(h.sentAnything(), false, 'nothing reached Telegram, so a corrected resend is not a duplicate');

  const [event] = h.rejectedEvents();
  assert.ok(event, 'an unparsed construct is a rejection, logged like any other');
  assert.deepEqual(event.detail.reasons, ['unparsed']);
  assert.equal(event.detail.rejected_count, 1);
  assert.ok(!JSON.stringify(event.detail).includes(cwd), 'the event still never carries the path');
});

test('the CommonMark angle-bracket form sends the same file as a photo', async () => {
  // What the refusal tells the agent to do must actually work.
  const cwd = workspace();
  const file = writeImage(cwd, 'PREVIEW 1 until sunday.jpg');
  const h = build();

  const res = await reply(h, `Story previews:\n\n![1 UNTIL SUNDAY](<${file}>)`, { sessionCwd: cwd });

  assert.equal(res.ok, true, JSON.stringify(res));
  const rich = h.tgCalls.find((c) => c.method === 'sendRichMessage');
  const photo = rich?.params.rich_message.blocks.find((b) => b.type === 'photo');
  assert.ok(photo, `expected a photo block: ${JSON.stringify(rich?.params)}`);
  assert.deepEqual(photo.photo.media, { upload: fs.realpathSync(file) });
  assert.equal(h.rejectedEvents().length, 0);
});

test('06:05 — a staged file that is gone is refused as "file not found", with the cleanup named', async () => {
  // The attachments folder is emptied when a turn ends, so a path that was
  // sent through files: in an earlier turn no longer exists. The old code
  // logged reasons ["path","path"], which cannot tell this from a
  // security refusal, and still answered ok:true.
  const sessionKey = `sess-loud-${process.pid}-${Date.now()}`;
  const staging = path.join(DEFAULT_ATTACHMENT_BASE, sessionKey);
  fs.mkdirSync(staging, { recursive: true });
  cleanup.add(staging);
  const gone1 = path.join(staging, 'preview-1-until-sunday.jpg');
  const gone2 = path.join(staging, 'preview-2-until-sunday.jpg');
  const h = build();

  const res = await reply(h, `Previews:\n\n![1](${gone1})\n\n![2](${gone2})`, { sessionKey });

  assert.equal(res.ok, false, JSON.stringify(res));
  for (const gone of [gone1, gone2]) assert.ok(res.error.includes(gone), res.error);
  assert.match(res.error, /file not found/);
  assert.match(res.error, /attachments folder are removed when a turn ends; copy the file there again/);
  assert.equal(h.sentAnything(), false);
  assert.deepEqual(h.rejectedEvents()[0].detail.reasons, ['not-found', 'not-found']);
});

test('a path outside the roots is refused as "outside allowed roots", told apart from a missing file', async () => {
  const cwd = workspace();
  const elsewhere = writeImage(workspace(), 'secret.png');
  const h = build();

  const res = await reply(h, `## Look\n\n![x](${elsewhere})`, { sessionCwd: cwd });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes(`${elsewhere} (outside allowed roots)`), res.error);
  assert.equal(h.sentAnything(), false, 'the refused path never reached Telegram in any form');
  assert.deepEqual(h.rejectedEvents()[0].detail.reasons, ['outside-roots']);
});

test('one bad image refuses the whole reply, and every problem is listed at once', async () => {
  // Sending the good half would leave the agent choosing between a duplicate
  // text and a missing picture. Refusing first costs one retry and the user
  // gets the reply whole.
  const cwd = workspace();
  const good = writeImage(cwd, 'good.png');
  const spaced = writeImage(cwd, 'with space.png');
  const wrongType = writeImage(cwd, 'notes.txt');
  const h = build();

  const res = await reply(h, [
    '## Batch',
    `![ok](${good})`,
    '',
    `![spaced](${spaced})`,
    '',
    `![txt](${wrongType})`,
  ].join('\n'), { sessionCwd: cwd });

  assert.equal(res.ok, false);
  assert.ok(!res.error.includes(`${good} (`), `the good image is not reported as failed: ${res.error}`);
  assert.ok(res.error.includes(`${spaced} (unparsed image`), res.error);
  assert.ok(res.error.includes(`${wrongType} (extension`), res.error);
  assert.match(res.error, /2 images could not be sent/);
  assert.match(res.error, /nothing was delivered/i);
  assert.equal(h.sentAnything(), false);
  const reasons = h.rejectedEvents().flatMap((e) => e.detail.reasons).sort();
  assert.deepEqual(reasons, ['extension', 'unparsed']);
});

test('an image the parser flattens into a link is reported, not reduced to its alt text', async () => {
  const cwd = workspace();
  const file = writeImage(cwd, 'badge.png');
  const h = build();

  const res = await reply(h, `## Status\n\n[![badge](${file})](https://example.com)`, { sessionCwd: cwd });

  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.error.includes(`${file} (image inside a link`), res.error);
  assert.equal(h.sentAnything(), false);
});

test('images a chat cannot send at all are reported after the text goes out', async () => {
  // The agent cannot fix this in the reply — the server refuses rich
  // messages — so refusing would only delay the text. It goes out, and the
  // agent is told the image did not, to send it with files: instead.
  const cwd = workspace();
  const file = writeImage(cwd, 'chart.png');
  const h = build({ latched: true });

  const res = await reply(h, `Here:\n\n![chart](${file})`, { sessionCwd: cwd });

  assert.equal(res.ok, false);
  assert.deepEqual(h.deliverCalls, [['Here:\n\nchart']], 'the text went out, plain');
  assert.match(res.error, /text was delivered \(message_id 900; do not send it again\)/);
  assert.ok(res.error.includes(`${file} (inline images are unavailable in this chat right now; send the file with files:)`), res.error);
});

test('a reply too long to carry its images is refused with a reason', async () => {
  const cwd = workspace();
  const file = writeImage(cwd, 'chart.png');
  const h = build({ richMaxLen: 200 });

  const res = await reply(h, `${'word '.repeat(60)}\n\n![chart](${file})`, { sessionCwd: cwd });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes(`${file} (the reply is too long to carry inline images`), res.error);
  assert.equal(h.sentAnything(), false);
});

// ─── What must keep working ────────────────────────────────────────────────

test('image syntax inside code is text, not a rejection', async () => {
  // Explaining the syntax is legitimate content. A refusal here would make
  // it impossible to say.
  const cwd = workspace();
  const h = build();

  const res = await reply(h, [
    '## How to embed',
    'Write `![alt](/path with spaces.png)` inline, or:',
    '```',
    '![alt](/another path.png)',
    '```',
  ].join('\n'), { sessionCwd: cwd });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(h.rejectedEvents().length, 0);
});

test('a reply without image syntax is untouched by all of this', async () => {
  const h = build();
  const res = await reply(h, '## Done\n\n- [x] one\n- [ ] two', { sessionCwd: workspace() });
  assert.equal(res.ok, true);
  assert.equal(h.rejectedEvents().length, 0);
});

test('plain prose with "![" in it is delivered, not refused', async () => {
  const cwd = workspace();
  for (const text of [
    'Replaced vec![] with Vec::new() in src/lib.rs',
    'Fixed: if (![1,2].includes(n)) in src/check.js',
    'Wow![1] neat — notes are in /tmp/notes',
  ]) {
    const h = build();
    const res = await reply(h, text, { sessionCwd: cwd });
    assert.equal(res.ok, true, `${text}: ${JSON.stringify(res)}`);
    assert.equal(h.rejectedEvents().length, 0, text);
  }
});

test('a spaced path inside a collage is refused with a reason that does not loop', async () => {
  const cwd = workspace();
  const spaced = writeImage(cwd, 'a b.png');
  const plain = writeImage(cwd, 'b.png');
  const h = build();

  const res = await reply(h, `## Pair\n\n<tg-collage>\n![a](<${spaced}>)\n![b](${plain})\n</tg-collage>`, { sessionCwd: cwd });

  assert.equal(res.ok, false);
  assert.ok(res.error.includes("paths inside a collage/slideshow can't contain spaces; rename the file"), res.error);
  assert.doesNotMatch(res.error, /wrap it in/);
  assert.equal(h.sentAnything(), false);
});

test('a renamed collage path keeps working with its <…> still on', async () => {
  // The collage refusal says "rename the file". An agent that renames it and
  // leaves the angle brackets must not be refused again, for a third reason.
  const cwd = workspace();
  const a = writeImage(cwd, 'a.png');
  const b = writeImage(cwd, 'b.png');
  const h = build();

  const res = await reply(h, `## Pair\n\n<tg-collage>\n![a](<${a}>)\n![b](${b})\n</tg-collage>`, { sessionCwd: cwd });

  assert.equal(res.ok, true, JSON.stringify(res));
  const rich = h.tgCalls.find((c) => c.method === 'sendRichMessage');
  const uploads = JSON.stringify(rich?.params.rich_message.blocks);
  assert.ok(uploads.includes(fs.realpathSync(a)) && uploads.includes(fs.realpathSync(b)), uploads);
});

test('an unsupported-format image is refused as extension, its path never sent as text', async () => {
  const cwd = workspace();
  const file = writeImage(cwd, 'IMG 1.heic');
  const h = build();

  const res = await reply(h, `Photo: ![shot](${file}) here`, { sessionCwd: cwd });

  assert.equal(res.ok, false, JSON.stringify(res));
  assert.ok(res.error.includes(`${file} (extension`), res.error);
  assert.equal(h.sentAnything(), false);
});

// ─── Loss after the text went out ──────────────────────────────────────────

test('media lost after the text was delivered is reported with the delivered message_id', async () => {
  // A strategy that sent the text but not its images (a file changed under
  // the send, a rich message that fell back to plain): the agent must learn
  // both halves — the images are missing AND the text must not be resent.
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({ message_id: 1 }),
    chunkText: (text) => [text],
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: passthroughParse,
    sanitizeAssistantReply: passthroughSanitize,
    logger: quietLogger,
    makeDeliverText: () => async () => ({
      handled: true,
      sent: [{ message_id: 4242 }],
      failed: [],
      results: [],
      mediaRejected: [{ src: '/w/chart.png', caption: 'chart', reason: 'source-changed' }],
    }),
  });

  const res = await dispatcher({
    sessionKey: 'sess-loud', chatId: '1', threadId: null, toolName: 'reply',
    text: '![chart](/w/chart.png)', files: null,
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /text was delivered \(message_id 4242; do not send it again\)/);
  assert.ok(res.error.includes('/w/chart.png (the file changed while sending)'), res.error);
  assert.equal(res.message_id, 4242);
});

test('a streamed reply\'s lost image is reported with advice that works', async () => {
  const dispatcher = createChannelsToolDispatcher({
    bot: fakeBot,
    send: async () => ({ message_id: 1 }),
    chunkText: (text) => [text],
    deliverReplies: async () => ({ sent: [], failed: [], results: [] }),
    parseResponse: passthroughParse,
    sanitizeAssistantReply: passthroughSanitize,
    logger: quietLogger,
    makeDeliverText: () => async () => ({
      handled: true, sent: [77], failed: [], results: [],
      mediaRejected: [{ src: '/w/chart.png', caption: 'chart', reason: 'streamed' }],
    }),
  });
  const res = await dispatcher({
    sessionKey: 'sess-loud', chatId: '1', threadId: null, toolName: 'reply',
    text: '![chart](/w/chart.png)', files: null,
  });
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('/w/chart.png (a streamed reply cannot carry images; send the image alone with files:)'), res.error);
});

// ─── Pieces ────────────────────────────────────────────────────────────────

test('inventoryImageSyntax separates what will render from what marked leaves as text', () => {
  const inv = inventoryImageSyntax([
    '![ok](/w/ok.png)',
    '',
    '![spaced](/w/a b.png)',
    '',
    '![angle](</w/c d.png>)',
    '',
    '- item ![listed](/w/e f.jpg)',
    '',
    'a gap ![a] (/w/g.png) here',
    '',
    'unterminated ![u](/w/u.png',
    '',
    '`![code](/w/h i.png)`',
    '',
    '```',
    '![fenced](/w/j k.png)',
    '```',
  ].join('\n'));
  assert.deepEqual(inv.images.map((i) => i.src), ['/w/ok.png', '/w/c d.png']);
  assert.deepEqual(inv.unparsed.map((i) => i.caption), ['spaced', 'listed', 'a', 'u']);
  assert.equal(inv.unparsed[0].src, '/w/a b.png');
  assert.equal(inv.unparsed[3].src, '![u](/w/u.png', 'an unterminated construct is quoted as written');
});

test('prose that merely contains "![" is not image syntax', () => {
  // Each line also carries a path, so a filter that only asks "is there a
  // separator in the tail?" would wrongly call every one an image.
  const cases = [
    'Replaced vec![] with Vec::new() in src/lib.rs',
    'if (![1,2].includes(n)) return /x/;',
    'Wow![1] neat, see /tmp/notes',
  ];
  for (const text of cases) {
    assert.deepEqual(inventoryImageSyntax(text), { images: [], unparsed: [] }, text);
  }
});

test('a destination that starts like a path but names no media file is prose', () => {
  // A path-like start alone made these "attempted images" and refused them.
  for (const text of [
    'Toggle ![x] (/settings/page) to enable',
    'Готово![1] (/tmp/report.md) лежит там',
    'See![note](./docs/read me.md) first',
  ]) {
    assert.deepEqual(inventoryImageSyntax(text), { images: [], unparsed: [] }, text);
  }
  // The incident's shapes name a media file and stay refused.
  assert.equal(inventoryImageSyntax('![1 UNTIL SUNDAY](/home/x/PREVIEW 1 until sunday.jpg)').unparsed.length, 1);
  assert.equal(inventoryImageSyntax('unterminated ![u](/w/u.png').unparsed.length, 1);
});

test('an image construct naming an unsupported media format is reported as "extension"', () => {
  // `.heic` is an image, just not one Telegram takes. Treating it as prose
  // would send its local path as text and drop the picture without a word.
  const inv = inventoryImageSyntax('Photo: ![shot](/Users/ivan/Pictures/IMG 1.heic) here');
  assert.deepEqual(inv.unparsed, [{ src: '/Users/ivan/Pictures/IMG 1.heic', caption: 'shot', reason: 'extension' }]);
});

test('a long unterminated construct is quoted, truncated, not its whole tail', () => {
  const tail = `![shot](/w/${'x'.repeat(200)}.png`;
  const [item] = inventoryImageSyntax(tail).unparsed;
  assert.equal(item.src, tail.slice(0, 60));
});

test('a reference-style image is reported as unparsed', () => {
  // The renderer only sees inline images reliably; a reference image either
  // renders or vanishes depending on what else the reply contains.
  const inv = inventoryImageSyntax('## Shot\n\n![a][r]\n\n[r]: /w/a.png');
  assert.deepEqual(inv.images, []);
  assert.deepEqual(inv.unparsed.map((i) => i.caption), ['a']);
});

test('a spaced path inside a collage gets its own reason, never "wrap it in <…>"', () => {
  // Angle brackets do not work inside a wrapper body, so advising them there
  // sends the agent round the same refusal forever.
  const inv = inventoryImageSyntax('<tg-collage>\n![a](</w/a b.png>)\n![b](/w/b.png)\n</tg-collage>');
  assert.deepEqual(inv.images.map((i) => i.src), ['/w/b.png']);
  assert.deepEqual(inv.unparsed.map((i) => i.reason), ['wrapper-spaces']);
});

test('the display hint teaches copying right before each send, names without spaces, and the loud failure', () => {
  const hint = buildPolygramDisplayHint(true, { inlineMedia: true });
  assert.match(hint, /right before each send/i);
  assert.match(hint, /without spaces/i);
  assert.match(hint, /<\/abs\/path with spaces\.png>/);
  assert.doesNotMatch(hint, /it will not error/i, 'a rejected image now errors, and the hint must say so');
  assert.doesNotMatch(hint, /dropped silently/i);
  assert.match(hint, /reply tool refuses/i, 'the refusal is the reply tool\'s, not every path\'s');
  assert.match(hint, /says the text was delivered, do not send the text again/i);
  assert.match(hint, /inside `<tg-collage>`.*cannot contain spaces/i);
});
