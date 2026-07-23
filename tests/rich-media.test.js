/**
 * Media blocks (photos / collages / slideshows) for rich messages —
 * renderer descriptor pipeline (lib/telegram/rich.js), the media
 * resolver trust boundary (lib/telegram/rich-media.js), the
 * envelope→InputFile materialization in rich-edit.js, and the
 * fallback-text sanitizer. See docs/0.18.0-rich-messages-plan.md §16.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  needsRichRendering,
  toTelegramRichBlocks,
  stripMediaMarkdown,
  countMediaBlocks,
} = require('../lib/telegram/rich');
const {
  createRichMediaResolver,
  PHOTO_UPLOAD_CEILING,
  MAX_MEDIA_PER_MESSAGE,
} = require('../lib/telegram/rich-media');
const { createRichEditor, materializeMediaBlocks } = require('../lib/telegram/rich-edit');

// Accept-everything resolver: local-looking srcs become {source} envelopes,
// URLs pass through — mirrors the real resolver's output shapes without fs.
const acceptAll = (ds) => ds.map((d) => (
  /^https?:\/\//i.test(d.src) ? { media: d.src } : { media: { source: d.src } }
));

// ─── Gate ────────────────────────────────────────────────────────────

describe('needsRichRendering — media triggers', () => {
  test('markdown image syntax triggers rich', () => {
    assert.equal(needsRichRendering('here ![shot](/tmp/a.png)'), true);
  });

  test('tg-collage / tg-slideshow wrappers trigger rich', () => {
    assert.equal(needsRichRendering('<tg-collage>…</tg-collage>'), true);
    assert.equal(needsRichRendering('<tg-slideshow>…</tg-slideshow>'), true);
  });

  test('image syntax inside a code fence does not trigger', () => {
    assert.equal(needsRichRendering('```\n![shot](/tmp/a.png)\n```'), false);
    assert.equal(needsRichRendering('```\n<tg-collage>\n```'), false);
  });

  test('ReDoS guard: pathological image-like input terminates quickly', () => {
    const evil = '![' + 'a'.repeat(100000) + '](' + 'b'.repeat(100000);
    const start = Date.now();
    needsRichRendering(evil);
    assert.ok(Date.now() - start < 500, 'gate slow on adversarial image syntax');
  });

  test('ReDoS guard: unclosed wrapper over a large body terminates quickly', () => {
    const evil = '<tg-collage>\n' + '![a](/x.png)\n'.repeat(20000);
    const start = Date.now();
    toTelegramRichBlocks(evil, { partial: true });
    assert.ok(Date.now() - start < 2000, 'renderer slow on unclosed wrapper');
  });
});

// ─── Renderer: descriptor → block mapping ────────────────────────────

describe('toTelegramRichBlocks — media', () => {
  test('image-only paragraph becomes a photo block with alt as caption', () => {
    const r = toTelegramRichBlocks('intro\n\n![the fix](/tmp/a.png)', { resolveMedia: acceptAll });
    assert.deepEqual(r.blocks, [
      { type: 'paragraph', text: 'intro' },
      { type: 'photo', photo: { type: 'photo', media: { source: '/tmp/a.png' } }, caption: { text: 'the fix' } },
    ]);
  });

  test('text+image paragraph splits into paragraph and photo siblings in order', () => {
    const r = toTelegramRichBlocks('Here it is:\n![after](/tmp/b.png)\nand done.', { resolveMedia: acceptAll });
    assert.deepEqual(r.blocks.map((b) => b.type), ['paragraph', 'photo', 'paragraph']);
  });

  test('image without alt gets no caption field', () => {
    const r = toTelegramRichBlocks('x\n\n![](/tmp/a.png)', { resolveMedia: acceptAll });
    const photo = r.blocks.find((b) => b.type === 'photo');
    assert.equal(photo.caption, undefined);
  });

  test('https URL image passes the URL through as the media value', () => {
    const r = toTelegramRichBlocks('![logo](https://example.com/l.png)\n\n# h', { resolveMedia: acceptAll });
    const photo = r.blocks.find((b) => b.type === 'photo');
    assert.equal(photo.photo.media, 'https://example.com/l.png');
  });

  test('wrapper in a single html token (no blank lines) becomes a collage', () => {
    const md = 'pics:\n<tg-collage>\n![a](/tmp/a.png)\n![b](/tmp/b.png)\n</tg-collage>';
    const r = toTelegramRichBlocks(md, { resolveMedia: acceptAll });
    const collage = r.blocks.find((b) => b.type === 'collage');
    assert.equal(collage.blocks.length, 2);
    assert.equal(collage.blocks[0].caption.text, 'a');
  });

  test('wrapper split across tokens by blank lines becomes a collage (details-style span scan)', () => {
    const md = '<tg-collage>\n\n![a](/tmp/a.png)\n\n![b](/tmp/b.png)\n\n</tg-collage>';
    const r = toTelegramRichBlocks(md, { resolveMedia: acceptAll });
    assert.equal(r.blocks[0].type, 'collage');
    assert.equal(r.blocks[0].blocks.length, 2);
  });

  test('inline one-line slideshow wrapper groups its images', () => {
    const md = 'x <tg-slideshow>![a](/tmp/a.png)![b](/tmp/b.png)</tg-slideshow> y';
    const r = toTelegramRichBlocks(md, { resolveMedia: acceptAll });
    const show = r.blocks.find((b) => b.type === 'slideshow');
    assert.equal(show.blocks.length, 2);
  });

  test('a one-survivor group collapses to a bare photo block', () => {
    const md = '<tg-collage>\n![a](/tmp/a.png)\n![b](/tmp/bad.png)\n</tg-collage>\n\n# h';
    const resolve = (ds) => ds.map((d) => (d.src.includes('bad') ? { rejected: 'path' } : { media: { source: d.src } }));
    const r = toTelegramRichBlocks(md, { resolveMedia: resolve });
    assert.ok(r.blocks.some((b) => b.type === 'photo'));
    assert.ok(!r.blocks.some((b) => b.type === 'collage'));
    assert.ok(r.blocks.some((b) => b.type === 'paragraph' && /1 image unavailable/.test(b.text)));
  });

  test('image nested in a list item becomes a photo block inside the item', () => {
    const r = toTelegramRichBlocks('- step one ![shot](/tmp/a.png)', { resolveMedia: acceptAll });
    const item = r.blocks[0].items[0];
    assert.deepEqual(item.blocks.map((b) => b.type), ['paragraph', 'photo']);
  });

  test('image nested in a blockquote becomes a photo block inside the quote', () => {
    const r = toTelegramRichBlocks('> look: ![shot](/tmp/a.png)', { resolveMedia: acceptAll });
    assert.equal(r.blocks[0].type, 'blockquote');
    const photo = r.blocks[0].blocks.find((b) => b.type === 'photo');
    assert.equal(photo.photo.media.source, '/tmp/a.png');
    assert.equal(photo.caption.text, 'shot');
  });

  test('an unclosed media wrapper is held back in partial mode and never runs the resolver', () => {
    const md = '# h\n\n<tg-collage>\n![a](/tmp/a.png)\n![b](/tmp/b.png)';
    const r = toTelegramRichBlocks(md, {
      partial: true,
      resolveMedia: () => { throw new Error('resolver must not run in partial'); },
    });
    assert.ok(!r.blocks.some((b) => b.type === 'collage' || b.type === 'photo'),
      'incomplete wrapper must not emit media mid-stream');
    assert.deepEqual(r.blocks.map((b) => b.type), ['heading']);
  });

  test('an unclosed wrapper whose images sit in the open token still yields them in final mode', () => {
    // marked bundles "<tg-collage>\n![a]…" (no close, no blank lines)
    // into ONE html token — the images are inside its raw, not sibling
    // tokens, and must not be silently dropped.
    const md = '# h\n\n<tg-collage>\n![a](/tmp/a.png)\n![b](/tmp/b.png)';
    const r = toTelegramRichBlocks(md, { resolveMedia: acceptAll });
    const collage = r.blocks.find((b) => b.type === 'collage');
    assert.ok(collage, 'images inside an unclosed wrapper token must survive');
    assert.equal(collage.blocks.length, 2);
  });

  test('rejected media degrades to a caption-only paragraph — never a basename', () => {
    const resolve = (ds) => ds.map(() => ({ rejected: 'path' }));
    const r = toTelegramRichBlocks('# h\n\n![my caption](/etc/passwd)', { resolveMedia: resolve });
    const para = r.blocks.find((b) => b.type === 'paragraph');
    assert.equal(para.text, 'my caption (image unavailable)');
    assert.ok(!JSON.stringify(r.blocks).includes('passwd'));
  });

  test('rejected media without a caption uses a generic label', () => {
    const resolve = () => [{ rejected: 'path' }];
    const r = toTelegramRichBlocks('# h\n\n![](/etc/passwd)', { resolveMedia: resolve });
    const para = r.blocks.filter((b) => b.type === 'paragraph').pop();
    assert.equal(para.text, '(image unavailable)');
    assert.ok(!JSON.stringify(r.blocks).includes('passwd'));
  });

  test('emitted blocks never contain a raw descriptor and always survive JSON.stringify', () => {
    const md = '# h\n\n![a](/tmp/a.png)\n\n<tg-collage>\n![b](/tmp/b.png)\n![c](/tmp/c.png)\n</tg-collage>';
    for (const opts of [{ resolveMedia: acceptAll }, { partial: true }, {}]) {
      const r = toTelegramRichBlocks(md, opts);
      const json = JSON.stringify(r.blocks);
      assert.ok(!json.includes('_media'), `raw descriptor leaked with opts ${JSON.stringify(opts)}`);
    }
  });

  test('partial mode renders placeholders and never invokes the resolver', () => {
    let called = false;
    const r = toTelegramRichBlocks('# h\n\n![shot](/tmp/a.png)\n\ntail text', {
      partial: true,
      resolveMedia: () => { called = true; return []; },
    });
    assert.equal(called, false);
    assert.ok(r.blocks.some((b) => b.type === 'paragraph' && b.text === '🖼 shot'));
  });

  test('partial-mode group placeholder is a single paragraph', () => {
    const md = '# h\n\n<tg-collage>\n![a](/tmp/a.png)\n![b](/tmp/b.png)\n</tg-collage>\n\ntail';
    const r = toTelegramRichBlocks(md, { partial: true });
    assert.ok(r.blocks.some((b) => b.type === 'paragraph' && /🖼 collage \(2 images\)/.test(b.text)));
  });

  test('media-only content with nothing resolved demotes to usedRich:false', () => {
    const resolve = () => [{ rejected: 'path' }];
    const r = toTelegramRichBlocks('some prose ![x](/tmp/bad.png)', { resolveMedia: resolve });
    assert.equal(r.usedRich, false);
    assert.deepEqual(r.blocks, []);
  });

  test('no demotion when a non-media construct is present', () => {
    const resolve = () => [{ rejected: 'path' }];
    const r = toTelegramRichBlocks('# heading\n\n![x](/tmp/bad.png)', { resolveMedia: resolve });
    assert.equal(r.usedRich, true);
  });

  test('usedRich:true never comes with empty blocks — an unsendable rich payload demotes to plain', () => {
    // A lone wrapper open tag is a gate trigger that renders to nothing.
    const r = toTelegramRichBlocks('<tg-collage>', { resolveMedia: acceptAll });
    assert.equal(r.usedRich, false);
    assert.deepEqual(r.blocks, []);
  });

  test('a throwing resolver degrades to placeholders, not a crash', () => {
    const r = toTelegramRichBlocks('# h\n\n![shot](/tmp/a.png)', {
      resolveMedia: () => { throw new Error('boom'); },
    });
    assert.equal(r.usedRich, true);
    assert.ok(r.blocks.some((b) => b.type === 'paragraph' && b.text === '🖼 shot'));
  });
});

describe('countMediaBlocks', () => {
  test('counts photos, wrapper children, and nested containers', () => {
    const md = '![a](/tmp/a.png)\n\n<tg-collage>\n![b](/tmp/b.png)\n![c](/tmp/c.png)\n</tg-collage>\n\n- item ![d](/tmp/d.png)';
    const r = toTelegramRichBlocks(md, { resolveMedia: acceptAll });
    assert.equal(countMediaBlocks(r.blocks), 4);
  });
});

// ─── stripMediaMarkdown ──────────────────────────────────────────────

describe('stripMediaMarkdown', () => {
  test('image syntax degrades to its caption text', () => {
    assert.equal(stripMediaMarkdown('see ![the fix](/abs/p.png) here'), 'see the fix here');
  });

  test('captionless image with a title falls back to the title', () => {
    assert.equal(stripMediaMarkdown('![](/abs/p.png "titled")'), 'titled');
  });

  test('wrapper tags disappear', () => {
    assert.equal(
      stripMediaMarkdown('<tg-collage>\n![a](/x.png)\n</tg-collage>'),
      '\na\n',
    );
  });

  test('fenced code is untouched', () => {
    const md = '```\n![keep](/in/fence.png)\n```';
    assert.equal(stripMediaMarkdown(md), md);
  });

  test('absolute paths never survive outside fences', () => {
    const out = stripMediaMarkdown('a ![cap](/Users/me/secret/shot.png) b');
    assert.ok(!out.includes('/Users/me'));
  });

  test('media-free text passes through by identity', () => {
    const md = 'plain **text** with `code`';
    assert.equal(stripMediaMarkdown(md), md);
  });

  test('a dangling unterminated trailing image fragment is cut — no partial path leaks', () => {
    assert.equal(stripMediaMarkdown('Here it is ![shot](/Users/me/secret/pa'), 'Here it is ');
    assert.equal(stripMediaMarkdown('typing ![alt'), 'typing ');
    assert.equal(stripMediaMarkdown('typing ![alt]('), 'typing ');
  });

  test('a mid-text unterminated fragment on an earlier line is cut too (images never span lines)', () => {
    const out = stripMediaMarkdown('broken ![x](/etc/passwd\nnext line');
    assert.ok(!out.includes('/etc/passwd'));
    assert.ok(out.includes('next line'));
  });

  test('fragment scrubbing leaves fenced content alone', () => {
    const md = '```\n![x](/keep/me\n```';
    assert.equal(stripMediaMarkdown(md), md);
  });
});

// ─── Resolver trust boundary ─────────────────────────────────────────

describe('createRichMediaResolver', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-media-test-'));
  const okPng = path.join(tmp, 'ok.png');
  fs.writeFileSync(okPng, Buffer.alloc(64, 1));
  const outsidePng = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rich-media-outside-')), 'out.png');
  fs.writeFileSync(outsidePng, Buffer.alloc(64, 1));

  const make = (over = {}) => createRichMediaResolver({ allowedRoots: [tmp], ...over });

  test('a file under an allowed root resolves to a {source} envelope with the realpath', () => {
    const [r] = make()([{ src: okPng, caption: '' }]);
    assert.deepEqual(r, { media: { source: fs.realpathSync(okPng) } });
  });

  test('a symlink pointing outside the roots is rejected', () => {
    const link = path.join(tmp, 'link.png');
    fs.symlinkSync(outsidePng, link);
    const [r] = make()([{ src: link, caption: '' }]);
    assert.equal(r.rejected, 'path');
  });

  test('a symlink inside the root resolves to the target realpath, never the alias path', () => {
    const target = path.join(tmp, 'real-target.png');
    fs.writeFileSync(target, Buffer.alloc(32, 2));
    const link = path.join(tmp, 'alias.png');
    fs.symlinkSync(target, link);
    const [r] = make()([{ src: link, caption: '' }]);
    assert.ok(r.media, 'a symlink to a file inside the root is accepted');
    assert.equal(r.media.source, fs.realpathSync(target), 'envelope carries the target realpath');
    assert.notEqual(r.media.source, link, 'the alias path itself must not be what gets uploaded');
  });

  test('a path outside the allowed roots is rejected', () => {
    const [r] = make()([{ src: outsidePng, caption: '' }]);
    assert.equal(r.rejected, 'path');
  });

  test('relative paths and non-http schemes are rejected', () => {
    const results = make()([
      { src: 'relative.png', caption: '' },
      { src: 'data:image/png;base64,AAAA', caption: '' },
      { src: 'file:///etc/passwd', caption: '' },
      { src: 'tg://resolve?domain=x', caption: '' },
      { src: 'attach://smuggled', caption: '' },
    ]);
    for (const r of results) assert.equal(r.rejected, 'not-absolute');
  });

  test('https URLs pass through when allowed', () => {
    const [r] = make()([{ src: 'https://example.com/x.png', caption: '' }]);
    assert.deepEqual(r, { media: 'https://example.com/x.png' });
  });

  test('URL media is rejected when allowUrlMedia is false (self-hosted Bot API server)', () => {
    const [r] = make({ allowUrlMedia: false })([{ src: 'https://example.com/x.png', caption: '' }]);
    assert.equal(r.rejected, 'url-local-api');
  });

  test('non-photo extensions are rejected (gif is an animation, not a photo)', () => {
    const gif = path.join(tmp, 'a.gif');
    fs.writeFileSync(gif, Buffer.alloc(8));
    const [r] = make()([{ src: gif, caption: '' }]);
    assert.equal(r.rejected, 'extension');
  });

  test('per-file size cap rejects oversized files', () => {
    const [r] = make({ maxPhotoBytes: 16 })([{ src: okPng, caption: '' }]);
    assert.equal(r.rejected, 'too-large');
  });

  test('default per-file cap is the photo ceiling, not 0, when no override exists', () => {
    // Pins the Math.min(cap, null) === 0 footgun the resolver's callers
    // avoid with `?? PHOTO_UPLOAD_CEILING`.
    assert.equal(Math.min(PHOTO_UPLOAD_CEILING, null ?? PHOTO_UPLOAD_CEILING), PHOTO_UPLOAD_CEILING);
    const [r] = make()([{ src: okPng, caption: '' }]);
    assert.ok(r.media);
  });

  test('total budget rejects the file that would exceed it', () => {
    const resolver = make({ maxTotalMediaBytes: 100 });
    const results = resolver([{ src: okPng, caption: '' }, { src: okPng, caption: '' }]);
    assert.ok(results[0].media);
    assert.equal(results[1].rejected, 'total-budget');
  });

  test('the 50-media cap applies across the flattened descriptor list', () => {
    const descriptors = Array.from({ length: MAX_MEDIA_PER_MESSAGE + 2 }, () => ({ src: 'https://e.com/x.png', caption: '' }));
    const results = make()(descriptors);
    assert.equal(results.filter((r) => r.media).length, MAX_MEDIA_PER_MESSAGE);
    assert.equal(results[MAX_MEDIA_PER_MESSAGE].rejected, 'media-cap');
  });

  test('rejection events carry reason classes only — never the src', () => {
    const events = [];
    const resolver = make({ logEvent: (kind, detail) => events.push({ kind, detail }) });
    resolver([{ src: 'https://user:hunter2@internal.host/x.png', caption: '' }, { src: outsidePng, caption: '' }]);
    // First src is an accepted URL; second is rejected.
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'rich-media-rejected');
    const json = JSON.stringify(events[0].detail);
    assert.ok(!json.includes('hunter2'));
    assert.ok(!json.includes(outsidePng));
    assert.deepEqual(events[0].detail.reasons, ['path']);
  });

  test('a broken logEvent never breaks resolution', () => {
    const resolver = make({ logEvent: () => { throw new Error('nope'); } });
    const [r] = resolver([{ src: outsidePng, caption: '' }]);
    assert.equal(r.rejected, 'path');
  });
});

// ─── rich-edit materialization + sanitized fallback ──────────────────

describe('rich-edit media handling', () => {
  const photoEnvelope = (source, caption) => ({
    type: 'photo',
    photo: { type: 'photo', media: { source } },
    ...(caption ? { caption: { text: caption } } : {}),
  });

  test('materializeMediaBlocks swaps envelopes for makeInputFile results on a clone', () => {
    const blocks = [
      { type: 'paragraph', text: 'x' },
      photoEnvelope('/tmp/a.png'),
      { type: 'collage', blocks: [photoEnvelope('/tmp/b.png'), photoEnvelope('/tmp/c.png')] },
      { type: 'list', items: [{ blocks: [photoEnvelope('/tmp/d.png')] }] },
    ];
    const made = [];
    const out = materializeMediaBlocks(blocks, (src) => { made.push(src); return `FILE:${src}`; });
    assert.deepEqual(made, ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png', '/tmp/d.png']);
    assert.equal(out[1].photo.media, 'FILE:/tmp/a.png');
    assert.equal(out[2].blocks[0].photo.media, 'FILE:/tmp/b.png');
    assert.equal(out[3].items[0].blocks[0].photo.media, 'FILE:/tmp/d.png');
    // Caller's blocks stay JSON-safe envelopes.
    assert.deepEqual(blocks[1].photo.media, { source: '/tmp/a.png' });
  });

  test('URL media strings are left untouched by materialization', () => {
    const blocks = [{ type: 'photo', photo: { type: 'photo', media: 'https://e.com/x.png' } }];
    const out = materializeMediaBlocks(blocks, () => { throw new Error('must not be called'); });
    assert.equal(out[0].photo.media, 'https://e.com/x.png');
  });

  test('the editor sends materialized blocks and logs media_count', async () => {
    const calls = [];
    const events = [];
    const editor = createRichEditor({
      tg: async (bot, method, params) => { calls.push({ method, params }); return { message_id: 1 }; },
      botName: 'test',
      logEvent: (kind, detail) => events.push({ kind, detail }),
      redactBotToken: (s) => s,
      isRichCapabilityError: () => false,
      isRichContentError: () => false,
      makeInputFile: (src) => `FILE:${src}`,
    });
    const blocks = [photoEnvelope('/tmp/a.png', 'cap')];
    const res = await editor({ bot: {}, chatId: '1', messageId: 5, blocks, sourceText: '![cap](/tmp/a.png)' });
    assert.equal(res.wentRich, true);
    assert.equal(calls[0].params.rich_message.blocks[0].photo.media, 'FILE:/tmp/a.png');
    const sent = events.find((e) => e.kind === 'rich-message-sent');
    assert.equal(sent.detail.media_count, 1);
  });

  test('content-error fallback sends sanitized text — no local path reaches the chat', async () => {
    const calls = [];
    const editor = createRichEditor({
      tg: async (bot, method, params) => {
        calls.push({ method, params });
        if (params.rich_message) { const err = new Error('RICH_MESSAGE_MEDIA_INVALID'); throw err; }
        return { message_id: 1 };
      },
      botName: 'test',
      logEvent: () => {},
      redactBotToken: (s) => s,
      isRichCapabilityError: () => false,
      isRichContentError: () => true,
      makeInputFile: (src) => `FILE:${src}`,
      sanitizeFallbackText: stripMediaMarkdown,
    });
    const res = await editor({
      bot: {}, chatId: '1', messageId: 5,
      blocks: [photoEnvelope('/tmp/secret-shot.png', 'the fix')],
      sourceText: 'done: ![the fix](/tmp/secret-shot.png)',
    });
    assert.equal(res.wentRich, false);
    const fallback = calls.find((c) => c.params.text);
    assert.equal(fallback.params.text, 'done: the fix');
    assert.ok(!fallback.params.text.includes('/tmp/secret-shot.png'));
  });

  test('a latched editor sends sanitized plain text and never uploads', async () => {
    const calls = [];
    const editor = createRichEditor({
      tg: async (bot, method, params) => { calls.push(params); return { message_id: 1 }; },
      botName: 'test',
      logEvent: () => {},
      redactBotToken: (s) => s,
      isRichCapabilityError: () => false,
      isRichContentError: () => false,
      getRichKnownUnsupported: () => true,
      makeInputFile: () => { throw new Error('must not upload when latched'); },
      sanitizeFallbackText: stripMediaMarkdown,
    });
    const res = await editor({
      bot: {}, chatId: '1', messageId: 5,
      blocks: [photoEnvelope('/tmp/a.png')],
      sourceText: 'see ![cap](/tmp/a.png)',
    });
    assert.equal(res.wentRich, false);
    assert.equal(calls[0].text, 'see cap');
  });
});

// The G6 live spike against the VPS's Bot API 10.1 server surfaced an
// unclassified error shape: a blocks-unaware server (blocks arrived in
// 10.2) ignores the blocks field entirely and rejects with
// "rich message must be non-empty". api.js refuses empty blocks before
// any call, so this response to a non-empty payload can only mean the
// server cannot see typed blocks — a capability condition that must
// latch, not a transient to retry forever.
describe('capability classification — blocks-unaware server (Bot API 10.1)', () => {
  const { isRichCapabilityError, isRichContentError } = require('../lib/telegram/rich');

  test('the real 10.1-server rejection latches as a capability error', () => {
    const err = new Error("Call to 'sendRichMessage' failed! (400: Bad Request: rich message must be non-empty)");
    err.error_code = 400;
    assert.equal(isRichCapabilityError(err), true);
    assert.equal(isRichContentError(err), false);
  });

  test('the real pre-10.1-server 404 latches as a capability error (shumorobot spike shape)', () => {
    const err = new Error("Call to 'sendRichMessage' failed! (404: Not Found: method not found)");
    err.error_code = 404;
    assert.equal(isRichCapabilityError(err), true);
    assert.equal(isRichContentError(err), false);
  });
});
