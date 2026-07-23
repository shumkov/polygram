/**
 * Media blocks (photos, videos, animations, collages, and slideshows)
 * for rich messages —
 * renderer descriptor pipeline (lib/telegram/rich.js), the media
 * resolver trust boundary (lib/telegram/rich-media.js), the
 * envelope→InputFile materialization in rich-edit.js, and the
 * fallback-text sanitizer. See docs/0.18.0-rich-messages-plan.md §16.
 */

'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDirs = new Set();
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const {
  needsRichRendering,
  toTelegramRichBlocks,
  stripMediaMarkdown,
  countMediaBlocks,
} = require('../lib/telegram/rich');
const {
  createRichMediaResolver,
  createMediaDeliveryContext,
  createMediaFileIdCache,
  collectMediaRescueEntries,
  PHOTO_UPLOAD_CEILING,
  MAX_MEDIA_PER_MESSAGE,
  MAX_RESCUE_CAPTION_LENGTH,
} = require('../lib/telegram/rich-media');
const { createRichEditor, materializeMediaBlocks } = require('../lib/telegram/rich-edit');

// Accept-everything resolver: local-looking srcs become {source} envelopes,
// URLs pass through — mirrors the real resolver's output shapes without fs.
const acceptAll = (ds) => ds.map((d) => (
  /^https?:\/\//i.test(d.src)
    ? { kind: 'photo', media: d.src }
    : { kind: 'photo', media: { source: d.src } }
));

const acceptTyped = (ds) => ds.map((d) => {
  let extension = path.extname(d.src).toLowerCase();
  if (/^https?:\/\//i.test(d.src)) extension = path.posix.extname(new URL(d.src).pathname).toLowerCase();
  const kind = extension === '.mp4' ? 'video' : extension === '.gif' ? 'animation' : 'photo';
  return {
    kind,
    media: /^https?:\/\//i.test(d.src) ? d.src : { source: d.src },
  };
});

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

  test('unchanged image syntax emits typed photo, video, and animation blocks', () => {
    const r = toTelegramRichBlocks([
      '![still](/tmp/a.JPEG)',
      '',
      '![demo](/tmp/b.MP4)',
      '',
      '![motion](/tmp/c.GIF)',
    ].join('\n'), { resolveMedia: acceptTyped });

    assert.deepEqual(r.blocks.map((b) => b.type), ['photo', 'video', 'animation']);
    assert.deepEqual(r.blocks[0], {
      type: 'photo',
      photo: { type: 'photo', media: { source: '/tmp/a.JPEG' } },
      caption: { text: 'still' },
    });
    assert.deepEqual(r.blocks[1], {
      type: 'video',
      video: { type: 'video', media: { source: '/tmp/b.MP4' } },
      caption: { text: 'demo' },
    });
    assert.deepEqual(r.blocks[2], {
      type: 'animation',
      animation: { type: 'animation', media: { source: '/tmp/c.GIF' } },
      caption: { text: 'motion' },
    });
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

  test('a one-survivor group collapses to the surviving typed media block', () => {
    const md = '<tg-collage>\n![a](/tmp/a.png)\n![b](/tmp/bad.png)\n</tg-collage>\n\n# h';
    const resolve = (ds) => ds.map((d) => (
      d.src.includes('bad')
        ? { rejected: 'path' }
        : { kind: 'video', media: { source: d.src } }
    ));
    const r = toTelegramRichBlocks(md, { resolveMedia: resolve });
    assert.ok(r.blocks.some((b) => b.type === 'video'));
    assert.ok(!r.blocks.some((b) => b.type === 'collage'));
    assert.ok(r.blocks.some((b) => b.type === 'paragraph' && /1 media item unavailable/.test(b.text)));
  });

  test('collage and slideshow preserve mixed media order', () => {
    const md = [
      '<tg-collage>',
      '![p](/tmp/a.png)',
      '![v](/tmp/b.mp4)',
      '![a](/tmp/c.gif)',
      '</tg-collage>',
      '',
      '<tg-slideshow>![a](/tmp/d.gif)![p](/tmp/e.webp)</tg-slideshow>',
    ].join('\n');
    const r = toTelegramRichBlocks(md, { resolveMedia: acceptTyped });

    assert.deepEqual(r.blocks[0].blocks.map((b) => b.type), ['photo', 'video', 'animation']);
    assert.deepEqual(r.blocks[1].blocks.map((b) => b.type), ['animation', 'photo']);
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
    assert.equal(para.text, 'my caption (media unavailable)');
    assert.ok(!JSON.stringify(r.blocks).includes('passwd'));
  });

  test('rejected media without a caption uses a generic label', () => {
    const resolve = () => [{ rejected: 'path' }];
    const r = toTelegramRichBlocks('# h\n\n![](/etc/passwd)', { resolveMedia: resolve });
    const para = r.blocks.filter((b) => b.type === 'paragraph').pop();
    assert.equal(para.text, '(media unavailable)');
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
    assert.ok(r.blocks.some((b) => b.type === 'paragraph' && b.text === '📎 shot'));
  });

  test('partial-mode group placeholder is a single paragraph', () => {
    const md = '# h\n\n<tg-collage>\n![a](/tmp/a.png)\n![b](/tmp/b.png)\n</tg-collage>\n\ntail';
    const r = toTelegramRichBlocks(md, { partial: true });
    assert.ok(r.blocks.some((b) => b.type === 'paragraph' && /📎 collage \(2 media items\)/.test(b.text)));
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
    assert.ok(r.blocks.some((b) => b.type === 'paragraph' && b.text === '📎 shot'));
  });
});

describe('countMediaBlocks', () => {
  test('counts all typed media, wrapper children, and nested containers', () => {
    const md = '![a](/tmp/a.png)\n\n<tg-collage>\n![b](/tmp/b.png)\n![c](/tmp/c.png)\n</tg-collage>\n\n- item ![d](/tmp/d.png)';
    const r = toTelegramRichBlocks(md, { resolveMedia: acceptAll });
    assert.equal(countMediaBlocks(r.blocks), 4);
    assert.equal(countMediaBlocks([
      { type: 'video', video: { type: 'video', media: 'v' } },
      {
        type: 'details',
        blocks: [{
          type: 'slideshow',
          blocks: [
            { type: 'animation', animation: { type: 'animation', media: 'a' } },
            { type: 'photo', photo: { type: 'photo', media: 'p' } },
          ],
        }],
      },
    ]), 3);
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

  test('captionless media-only fallback projects to no text, preserving sidecar anchoring', () => {
    assert.equal(
      stripMediaMarkdown('![](/abs/first.png)\n\n![](/abs/second.gif)'),
      '',
    );
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
  const tmp = makeTempDir('rich-media-test-');
  const okPng = path.join(tmp, 'ok.png');
  fs.writeFileSync(okPng, Buffer.alloc(64, 1));
  const okJpegUpper = path.join(tmp, 'still.JPEG');
  const okMp4Upper = path.join(tmp, 'demo.MP4');
  const okGifUpper = path.join(tmp, 'motion.GIF');
  fs.writeFileSync(okJpegUpper, Buffer.alloc(32, 2));
  fs.writeFileSync(okMp4Upper, Buffer.alloc(32, 3));
  fs.writeFileSync(okGifUpper, Buffer.alloc(32, 4));
  const outsidePng = path.join(makeTempDir('rich-media-outside-'), 'out.png');
  fs.writeFileSync(outsidePng, Buffer.alloc(64, 1));

  const make = (over = {}) => createRichMediaResolver({ allowedRoots: [tmp], ...over });

  test('a file under an allowed root resolves to a JSON-safe fingerprinted envelope', () => {
    const [r] = make()([{ src: okPng, caption: '' }]);
    assert.equal(r.kind, 'photo');
    assert.equal(r.media.source, fs.realpathSync(okPng));
    assert.equal(typeof r.media.fingerprint, 'string');
    assert.ok(r.media.fingerprint.length > 0);
    assert.doesNotThrow(() => JSON.stringify(r));
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
    assert.deepEqual(r, { kind: 'photo', media: 'https://example.com/x.png' });
  });

  test('URL pathname classifies gif and mp4 after query/fragment, otherwise photo', () => {
    const sources = [
      'https://example.com/motion.GIF?download=1#frame',
      'https://example.com/demo.mp4#play',
      'https://example.com/render?id=file.gif',
      'https://assets.gif.example/no-extension',
      'https://example.com/image.unknown?kind=.mp4',
    ];
    const results = make()(sources.map((src) => ({ src, caption: '' })));
    assert.deepEqual(results.map((r) => r.kind), [
      'animation',
      'video',
      'photo',
      'photo',
      'photo',
    ]);
    assert.deepEqual(results.map((r) => r.media), sources);
  });

  test('URL media of every kind is rejected under a self-hosted Bot API server', () => {
    const results = make({ allowUrlMedia: false })([
      { src: 'https://example.com/x.png', caption: '' },
      { src: 'https://example.com/x.mp4', caption: '' },
      { src: 'https://example.com/x.gif', caption: '' },
    ]);
    assert.deepEqual(results.map((r) => r.rejected), [
      'url-local-api',
      'url-local-api',
      'url-local-api',
    ]);
  });

  test('local extensions classify case-insensitively and unsupported types are rejected', () => {
    const mov = path.join(tmp, 'unsupported.mov');
    fs.writeFileSync(mov, Buffer.alloc(8));
    const results = make()([
      { src: okJpegUpper, caption: '' },
      { src: okMp4Upper, caption: '' },
      { src: okGifUpper, caption: '' },
      { src: mov, caption: '' },
    ]);
    assert.deepEqual(results.slice(0, 3).map((r) => r.kind), ['photo', 'video', 'animation']);
    assert.equal(results[3].rejected, 'extension');
  });

  test('per-file size cap rejects oversized files', () => {
    const [r] = make({ maxPhotoBytes: 16 })([{ src: okPng, caption: '' }]);
    assert.equal(r.rejected, 'too-large');
  });

  test('per-kind ceilings use 10 MiB for photos and 50 MiB for video/animation', () => {
    const sizes = new Map([
      [fs.realpathSync(okJpegUpper), 11],
      [fs.realpathSync(okMp4Upper), 50],
      [fs.realpathSync(okGifUpper), 51],
    ]);
    const results = make({
      maxPhotoBytes: 10,
      maxOtherMediaBytes: 50,
      fileSize: (source) => sizes.get(source),
    })([
      { src: okJpegUpper, caption: '' },
      { src: okMp4Upper, caption: '' },
      { src: okGifUpper, caption: '' },
    ]);
    assert.equal(results[0].rejected, 'too-large');
    assert.equal(results[1].kind, 'video');
    assert.equal(results[2].rejected, 'too-large');
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

  test('the shared byte budget spans mixed media kinds', () => {
    const sizes = new Map([
      [fs.realpathSync(okPng), 20],
      [fs.realpathSync(okMp4Upper), 30],
      [fs.realpathSync(okGifUpper), 1],
    ]);
    const results = make({
      maxPhotoBytes: 100,
      maxOtherMediaBytes: 100,
      maxTotalMediaBytes: 50,
      fileSize: (source) => sizes.get(source),
    })([
      { src: okPng, caption: '' },
      { src: okMp4Upper, caption: '' },
      { src: okGifUpper, caption: '' },
    ]);
    assert.deepEqual(results.slice(0, 2).map((r) => r.kind), ['photo', 'video']);
    assert.equal(results[2].rejected, 'total-budget');
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

  test('a shared cache hit crosses resolver instances only after ordinary validation', () => {
    const cache = createMediaFileIdCache();
    const [first] = make({ fileIdCache: cache })([{ src: okPng, caption: '' }]);
    cache.set('photo', first.media.source, first.media.fingerprint, 'cached-photo');

    let validations = 0;
    let stats = 0;
    const [second] = make({
      fileIdCache: cache,
      validatePath: (source, roots) => {
        validations += 1;
        return require('../lib/process/channels-tool-dispatcher').validateAttachmentPath(source, roots);
      },
      fileStat: (source) => {
        stats += 1;
        return fs.statSync(source, { bigint: true });
      },
    })([{ src: okPng, caption: '' }]);

    assert.equal(second.media.fileId, 'cached-photo');
    assert.equal(second.media.source, fs.realpathSync(okPng));
    assert.equal(validations, 1, 'allowlist validation still runs on a cache hit');
    assert.equal(stats, 1, 'stat/fingerprint validation still runs on a cache hit');
  });

  test('fingerprint, deletion, kind, and LRU boundaries cannot serve stale IDs', () => {
    const cache = createMediaFileIdCache();
    cache.set('photo', '/tmp/a.png', 'fp-a', 'photo-a');
    assert.equal(cache.get('video', '/tmp/a.png', 'fp-a'), null,
      'the same path under another kind is a miss');
    assert.equal(cache.get('photo', '/tmp/a.png', 'changed'), null,
      'a fingerprint mismatch evicts the stale entry');
    assert.equal(cache.get('photo', '/tmp/a.png', 'fp-a'), null);

    for (let i = 0; i < 257; i += 1) {
      cache.set('photo', `/tmp/${i}.png`, `fp-${i}`, `id-${i}`);
    }
    assert.equal(cache.size, 256);
    assert.equal(cache.get('photo', '/tmp/0.png', 'fp-0'), null, 'the oldest entry is evicted');
    assert.equal(cache.get('photo', '/tmp/256.png', 'fp-256'), 'id-256');

    const deleted = path.join(tmp, 'deleted-after-cache.png');
    fs.writeFileSync(deleted, Buffer.alloc(8, 4));
    const firstResolver = make({ fileIdCache: cache });
    const [resolved] = firstResolver([{ src: deleted, caption: '' }]);
    cache.set('photo', resolved.media.source, resolved.media.fingerprint, 'deleted-id');
    fs.unlinkSync(deleted);
    const [afterDelete] = firstResolver([{ src: deleted, caption: '' }]);
    assert.equal(afterDelete.rejected, 'path');
  });
});

describe('bounded media file_id cache integration', () => {
  test('materialization prefers a validated cached ID and mutation evicts it', () => {
    const tmp = makeTempDir('rich-media-cache-preflight-');
    const source = path.join(tmp, 'cached.png');
    fs.writeFileSync(source, Buffer.alloc(8, 1));
    const cache = createMediaFileIdCache();
    const resolver = createRichMediaResolver({ allowedRoots: [tmp], fileIdCache: cache });
    const [cold] = resolver([{ src: source, caption: '' }]);
    cache.set('photo', cold.media.source, cold.media.fingerprint, 'photo-id');
    const [hit] = resolver([{ src: source, caption: '' }]);
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: cache,
      tg: async () => ({ message_id: 1 }),
      bot: {},
      chatId: 'chat',
    });

    const materialized = materializeMediaBlocks([
      { type: 'photo', photo: { type: 'photo', media: hit.media } },
    ], () => { throw new Error('cached ID must avoid upload materialization'); }, context.preflightMedia);
    assert.equal(materialized[0].photo.media, 'photo-id');

    fs.writeFileSync(source, Buffer.alloc(9, 2));
    assert.equal(context.preflightMedia(hit.media, 'photo').ok, false);
    assert.equal(cache.get('photo', hit.media.source, hit.media.fingerprint), null);
  });

  test('a direct photo rescue learns the largest returned PhotoSize after re-stat', async () => {
    const tmp = makeTempDir('rich-media-cache-rescue-');
    const source = path.join(tmp, 'rescue.png');
    fs.writeFileSync(source, Buffer.alloc(8, 1));
    const cache = createMediaFileIdCache();
    const [resolved] = createRichMediaResolver({
      allowedRoots: [tmp],
      fileIdCache: cache,
    })([{ src: source, caption: '' }]);
    const calls = [];
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: cache,
      tg: async (_bot, method, params) => {
        calls.push({ method, params });
        return {
          message_id: 1,
          photo: [
            { file_id: 'small', width: 10, height: 10 },
            { file_id: 'largest', width: 40, height: 30 },
            { file_id: 'wide', width: 100, height: 5 },
          ],
        };
      },
      bot: {},
      chatId: 'chat',
    });

    await context.rescueEntries([{ kind: 'photo', media: resolved.media, caption: '' }]);

    assert.deepEqual(calls[0].params.photo, { source: resolved.media.source },
      'rescue uses the validated source rather than a cached ID');
    assert.equal(
      cache.get('photo', resolved.media.source, resolved.media.fingerprint),
      'largest',
    );
  });

  test('rich response learning is single-media-only and fail-closed', () => {
    const tmp = makeTempDir('rich-media-cache-rich-');
    const source = path.join(tmp, 'rich.png');
    fs.writeFileSync(source, Buffer.alloc(8, 1));
    const cache = createMediaFileIdCache();
    const [resolved] = createRichMediaResolver({ allowedRoots: [tmp] })([
      { src: source, caption: '' },
    ]);
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: cache,
      tg: async () => ({ message_id: 1 }),
      bot: {},
      chatId: 'chat',
    });
    const local = { type: 'photo', photo: { type: 'photo', media: resolved.media } };
    const remote = (fileId = 'learned') => ({
      rich_message: {
        blocks: [{
          type: 'photo',
          photo: fileId == null
            ? [{}]
            : [
              { file_id: 'small', width: 1, height: 1 },
              { file_id: fileId, width: 5, height: 5 },
            ],
        }],
      },
    });

    assert.equal(context.learnRichResult([local], remote()), true);
    assert.equal(cache.get('photo', resolved.media.source, resolved.media.fingerprint), 'learned');

    const skipped = [
      { blocks: [local, local], result: remote('multi-return') },
      { blocks: [local], result: { _notModified: true, ...remote('not-modified') } },
      { blocks: [local], result: { message_id: 1 } },
      { blocks: [local], result: remote(null) },
      {
        blocks: [local],
        result: {
          rich_message: {
            blocks: [{ type: 'video', video: { file_id: 'wrong-kind' } }],
          },
        },
      },
      {
        blocks: [
          local,
          { type: 'photo', photo: { type: 'photo', media: 'https://example.com/remote.png' } },
        ],
        result: remote('url-must-count'),
      },
    ];
    for (const [index, candidate] of skipped.entries()) {
      cache.delete('photo', resolved.media.source);
      assert.equal(
        context.learnRichResult(candidate.blocks, candidate.result),
        false,
        `skip case ${index} must not learn`,
      );
      assert.equal(cache.get('photo', resolved.media.source, resolved.media.fingerprint), null);
    }
  });

  test('video and animation rich responses teach only their matching cache kinds', () => {
    const tmp = makeTempDir('rich-media-cache-typed-');
    const video = path.join(tmp, 'demo.mp4');
    const animation = path.join(tmp, 'motion.gif');
    fs.writeFileSync(video, Buffer.alloc(8, 1));
    fs.writeFileSync(animation, Buffer.alloc(8, 2));
    const cache = createMediaFileIdCache();
    const resolver = createRichMediaResolver({ allowedRoots: [tmp], fileIdCache: cache });
    const [videoResolved, animationResolved] = resolver([
      { src: video, caption: '' },
      { src: animation, caption: '' },
    ]);
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: cache,
      tg: async () => ({ message_id: 1 }),
      bot: {},
      chatId: 'chat',
    });

    for (const [kind, resolved, fileId] of [
      ['video', videoResolved, 'video-id'],
      ['animation', animationResolved, 'animation-id'],
    ]) {
      assert.equal(context.learnRichResult(
        [{ type: kind, [kind]: { type: kind, media: resolved.media } }],
        { rich_message: { blocks: [{ type: kind, [kind]: { file_id: fileId } }] } },
      ), true);
    }

    const [videoHit, animationHit] = resolver([
      { src: video, caption: '' },
      { src: animation, caption: '' },
    ]);
    assert.equal(videoHit.media.fileId, 'video-id');
    assert.equal(animationHit.media.fileId, 'animation-id');
    assert.equal(cache.get('photo', videoHit.media.source, videoHit.media.fingerprint), null);
  });

  test('unexpected response media shapes never turn successful delivery into a cache failure', async () => {
    const tmp = makeTempDir('rich-media-cache-shape-');
    const source = path.join(tmp, 'shape.png');
    fs.writeFileSync(source, Buffer.alloc(8, 1));
    const cache = createMediaFileIdCache();
    const [resolved] = createRichMediaResolver({
      allowedRoots: [tmp],
      fileIdCache: cache,
    })([{ src: source, caption: '' }]);
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: cache,
      tg: async () => ({
        message_id: 1,
        photo: { file_id: 'not-an-array' },
      }),
      bot: {},
      chatId: 'chat',
    });

    const rescue = await context.rescueEntries([
      { kind: 'photo', media: resolved.media, caption: '' },
    ]);
    assert.deepEqual(rescue, { attempted: 1, sent: 1, failed: 0 },
      'the media already landed; malformed cache metadata must stay non-fatal');

    assert.equal(context.learnRichResult([
      { type: 'photo', photo: { type: 'photo', media: resolved.media } },
    ], {
      rich_message: {
        blocks: [{ type: 'photo', photo: { file_id: 'not-an-array' } }],
      },
    }), false);
  });

  test('cache adapter exceptions stay non-fatal but emit source-free diagnostics', async () => {
    const tmp = makeTempDir('rich-media-cache-error-');
    const source = path.join(tmp, 'cache-error.png');
    fs.writeFileSync(source, Buffer.alloc(8, 1));
    const [resolved] = createRichMediaResolver({ allowedRoots: [tmp] })([
      { src: source, caption: '' },
    ]);
    const warnings = [];
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: {
        get: () => null,
        set: () => { throw new TypeError('private adapter detail'); },
        delete: () => false,
      },
      tg: async () => ({
        message_id: 1,
        photo: [{ file_id: 'learned', width: 1, height: 1 }],
      }),
      bot: {},
      chatId: 'chat',
      logger: { warn: (message) => warnings.push(message) },
    });

    const rescue = await context.rescueEntries([
      { kind: 'photo', media: resolved.media, caption: '' },
    ]);

    assert.deepEqual(rescue, { attempted: 1, sent: 1, failed: 0 });
    assert.deepEqual(warnings, ['[rich-media] cache learning failed (TypeError)']);
    assert.ok(!warnings[0].includes(tmp), 'diagnostic must not contain the media source');
  });
});

describe('typed media rescue delivery context', () => {
  test('collects nested photos in display order and sends valid rescues sequentially', async () => {
    const tmp = makeTempDir('rich-media-rescue-');
    const first = path.join(tmp, 'first.png');
    const second = path.join(tmp, 'second.png');
    fs.writeFileSync(first, Buffer.alloc(8, 1));
    fs.writeFileSync(second, Buffer.alloc(8, 2));
    const resolver = createRichMediaResolver({ allowedRoots: [tmp] });
    const [firstResolved, secondResolved] = resolver([
      { src: first, caption: '' },
      { src: second, caption: '' },
    ]);
    const longCaption = 'x'.repeat(MAX_RESCUE_CAPTION_LENGTH + 1);
    const blocks = [
      { type: 'photo', photo: { media: firstResolved.media }, caption: { text: 'short caption' } },
      {
        type: 'list',
        items: [{
          blocks: [{ type: 'photo', photo: { media: secondResolved.media }, caption: { text: longCaption } }],
        }],
      },
    ];
    const entries = collectMediaRescueEntries(blocks);
    const calls = [];
    const events = [];
    let errorStates = 0;
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      tg: async (_bot, method, params) => {
        calls.push({ method, params });
        return { message_id: calls.length };
      },
      bot: {},
      chatId: 'chat',
      threadId: 'topic',
      replyToMessageId: 77,
      logEvent: (kind, detail) => events.push({ kind, detail }),
      setDeliveryError: () => { errorStates += 1; },
    });

    const result = await context.rescueEntries([
      { kind: 'photo', media: { ...firstResolved.media, fingerprint: 'stale' }, caption: 'rejected' },
      ...entries,
    ], { trigger: 'overflow', anchorFirst: true });
    context.recordTextFailures(2);
    context.recordDeletionFailures(1);
    await context.flushPartialDeliveryWarning();
    await context.flushPartialDeliveryWarning();

    assert.deepEqual(result, { attempted: 3, sent: 2, failed: 1 });
    const photos = calls.filter((call) => call.method === 'sendPhoto');
    assert.equal(photos.length, 2);
    assert.equal(photos[0].params.photo.source, fs.realpathSync(first));
    assert.equal(photos[0].params.caption, 'short caption');
    assert.deepEqual(photos[0].params.reply_parameters, {
      message_id: 77,
      allow_sending_without_reply: true,
    });
    assert.equal(photos[0].params.message_thread_id, 'topic');
    assert.equal(photos[1].params.photo.source, fs.realpathSync(second));
    assert.equal(photos[1].params.caption, undefined, 'overlong captions are omitted');
    assert.equal(photos[1].params.reply_parameters, undefined);
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 1,
      'aggregate delivery warning is emitted at most once');
    assert.match(
      calls.find((call) => call.method === 'sendMessage').params.text,
      /duplicated/i,
      'a failed placeholder deletion must disclose possible duplicate content',
    );
    assert.equal(errorStates, 1);
    assert.equal(context.deliveryIncomplete, true);
    const summary = events.find((event) => event.kind === 'rich-media-delivery-summary');
    assert.deepEqual(summary.detail, { text_failed: 2, media_failed: 1, deletion_failed: 1 });
    assert.ok(!JSON.stringify(events).includes(tmp), 'telemetry never contains local media paths');
  });

  test('sends photo, video, and animation rescues sequentially with source uploads', async () => {
    const tmp = makeTempDir('rich-media-rescue-typed-');
    const sources = {
      video: path.join(tmp, 'first.mp4'),
      animation: path.join(tmp, 'second.gif'),
      photo: path.join(tmp, 'third.png'),
    };
    for (const [index, source] of Object.values(sources).entries()) {
      fs.writeFileSync(source, Buffer.alloc(8, index + 1));
    }
    const cache = createMediaFileIdCache();
    const resolver = createRichMediaResolver({ allowedRoots: [tmp], fileIdCache: cache });
    const resolved = resolver([
      { src: sources.video, caption: '' },
      { src: sources.animation, caption: '' },
      { src: sources.photo, caption: '' },
    ]);
    const blocks = [
      {
        type: 'collage',
        blocks: [
          { type: 'video', video: { type: 'video', media: resolved[0].media }, caption: { text: 'video' } },
          { type: 'animation', animation: { type: 'animation', media: resolved[1].media }, caption: { text: 'animation' } },
        ],
      },
      { type: 'photo', photo: { type: 'photo', media: resolved[2].media }, caption: { text: 'photo' } },
    ];
    const entries = collectMediaRescueEntries(blocks);
    const calls = [];
    const events = [];
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: cache,
      tg: async (_bot, method, params) => {
        calls.push({ method, params });
        if (method === 'sendVideo') throw new Error('video failed');
        if (method === 'sendAnimation') {
          return { message_id: 2, animation: { file_id: 'animation-id' } };
        }
        return {
          message_id: 3,
          photo: [{ file_id: 'photo-id', width: 10, height: 10 }],
        };
      },
      bot: {},
      chatId: 'chat',
      threadId: 'topic',
      replyToMessageId: 77,
      logEvent: (kind, detail) => events.push({ kind, detail }),
      logger: { warn: () => {} },
    });

    const result = await context.rescueEntries(entries, {
      trigger: 'overflow',
      anchorFirst: true,
    });

    assert.deepEqual(result, { attempted: 3, sent: 2, failed: 1 });
    assert.deepEqual(calls.map((call) => call.method), [
      'sendVideo',
      'sendAnimation',
      'sendPhoto',
    ]);
    assert.deepEqual(calls.map((call, index) => (
      call.params[['video', 'animation', 'photo'][index]]
    )), [
      { source: fs.realpathSync(sources.video) },
      { source: fs.realpathSync(sources.animation) },
      { source: fs.realpathSync(sources.photo) },
    ]);
    assert.equal(calls[0].params.reply_parameters?.message_id, 77);
    assert.equal(calls[1].params.reply_parameters?.message_id, 77,
      'the anchor remains until the first successful rescue');
    assert.equal(calls[2].params.reply_parameters, undefined);
    assert.deepEqual(calls.map((call) => call.params.caption), ['video', 'animation', 'photo']);
    const event = events.find((candidate) => candidate.kind === 'rich-media-rescue');
    assert.deepEqual(event.detail, {
      trigger: 'overflow',
      attempted: 3,
      sent: 2,
      failed: 1,
      photo_count: 1,
      video_count: 1,
      animation_count: 1,
    });
    assert.ok(!JSON.stringify(events).includes(tmp));
    assert.equal(
      cache.get('animation', resolved[1].media.source, resolved[1].media.fingerprint),
      'animation-id',
    );
    assert.equal(
      cache.get('photo', resolved[2].media.source, resolved[2].media.fingerprint),
      'photo-id',
    );
  });

  test('copies the root allowlist and rejects files admitted only by later caller mutation', async () => {
    const originalRoot = makeTempDir('rich-media-root-');
    const laterRoot = makeTempDir('rich-media-later-root-');
    const laterFile = path.join(laterRoot, 'later.png');
    fs.writeFileSync(laterFile, Buffer.alloc(8, 3));
    const [resolved] = createRichMediaResolver({ allowedRoots: [laterRoot] })([
      { src: laterFile, caption: '' },
    ]);
    const roots = [originalRoot];
    const calls = [];
    const context = createMediaDeliveryContext({
      allowedRoots: roots,
      tg: async (_bot, method) => { calls.push(method); },
      bot: {},
      chatId: 'chat',
    });
    roots.push(laterRoot);

    const result = await context.rescueEntries([
      { kind: 'photo', media: resolved.media, caption: '' },
    ], { trigger: 'edit-failed' });

    assert.deepEqual(result, { attempted: 1, sent: 0, failed: 1 });
    assert.deepEqual(calls, []);
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

  test('materializes video and animation envelopes with explicit preflight kinds', () => {
    const seen = [];
    const blocks = [{
      type: 'collage',
      blocks: [
        { type: 'video', video: { type: 'video', media: { source: '/tmp/a.mp4' } } },
        {
          type: 'details',
          blocks: [{
            type: 'animation',
            animation: { type: 'animation', media: { source: '/tmp/b.gif' } },
          }],
        },
      ],
    }];
    const out = materializeMediaBlocks(
      blocks,
      (source) => `FILE:${source}`,
      (media, kind) => {
        seen.push([kind, media.source]);
        return { ok: true, value: media };
      },
    );

    assert.deepEqual(seen, [
      ['video', '/tmp/a.mp4'],
      ['animation', '/tmp/b.gif'],
    ]);
    assert.equal(out[0].blocks[0].video.media, 'FILE:/tmp/a.mp4');
    assert.equal(out[0].blocks[1].blocks[0].animation.media, 'FILE:/tmp/b.gif');
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

  test('a successful single-media rich edit teaches a later resolver instance', async () => {
    const tmp = makeTempDir('rich-media-editor-cache-');
    const source = path.join(tmp, 'edit.png');
    fs.writeFileSync(source, Buffer.alloc(8, 1));
    const cache = createMediaFileIdCache();
    const firstResolver = createRichMediaResolver({ allowedRoots: [tmp], fileIdCache: cache });
    const [resolved] = firstResolver([{ src: source, caption: '' }]);
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: cache,
      tg: async () => ({ message_id: 1 }),
      bot: {},
      chatId: 'chat',
    });
    const editor = createRichEditor({
      tg: async () => ({
        message_id: 1,
        rich_message: {
          blocks: [{
            type: 'photo',
            photo: [{ file_id: 'from-rich-edit', width: 20, height: 10 }],
          }],
        },
      }),
      botName: 'test',
      logEvent: () => {},
      redactBotToken: (s) => s,
      isRichCapabilityError: () => false,
      isRichContentError: () => false,
      makeInputFile: (src) => `FILE:${src}`,
    });

    await editor({
      bot: {},
      chatId: 'chat',
      messageId: 5,
      blocks: [{ type: 'photo', photo: { type: 'photo', media: resolved.media } }],
      sourceText: `![](${source})`,
      mediaContext: context,
    });

    const [hit] = createRichMediaResolver({
      allowedRoots: [tmp],
      fileIdCache: cache,
    })([{ src: source, caption: '' }]);
    assert.equal(hit.media.fileId, 'from-rich-edit');
  });

  test('content fallback evicts a cached ID before source rescue refreshes it', async () => {
    const tmp = makeTempDir('rich-media-editor-refresh-');
    const source = path.join(tmp, 'refresh.png');
    fs.writeFileSync(source, Buffer.alloc(8, 1));
    const cache = createMediaFileIdCache();
    const coldResolver = createRichMediaResolver({ allowedRoots: [tmp], fileIdCache: cache });
    const [cold] = coldResolver([{ src: source, caption: '' }]);
    cache.set('photo', cold.media.source, cold.media.fingerprint, 'stale-id');
    const [hit] = coldResolver([{ src: source, caption: '' }]);
    const calls = [];
    const tg = async (_bot, method, params) => {
      calls.push({ method, params });
      if (method === 'editMessageText' && params.rich_message) {
        throw new Error('RICH_MESSAGE_MEDIA_INVALID');
      }
      if (method === 'sendPhoto') {
        assert.equal(
          cache.get('photo', hit.media.source, hit.media.fingerprint),
          null,
          'the stale ID is gone before rescue starts',
        );
        return {
          message_id: 2,
          photo: [{ file_id: 'refreshed-id', width: 10, height: 10 }],
        };
      }
      return { message_id: 1 };
    };
    const context = createMediaDeliveryContext({
      allowedRoots: [tmp],
      fileIdCache: cache,
      tg,
      bot: {},
      chatId: 'chat',
    });
    const editor = createRichEditor({
      tg,
      botName: 'test',
      logEvent: () => {},
      redactBotToken: (s) => s,
      isRichCapabilityError: () => false,
      isRichContentError: () => true,
      makeInputFile: () => { throw new Error('cached ID should be preferred'); },
      sanitizeFallbackText: stripMediaMarkdown,
    });

    await editor({
      bot: {},
      chatId: 'chat',
      messageId: 5,
      phase: 'final',
      mediaContext: context,
      blocks: [{
        type: 'photo',
        photo: { type: 'photo', media: hit.media },
        caption: { text: 'refresh' },
      }],
      sourceText: `done ![refresh](${source})`,
    });

    assert.equal(calls[0].params.rich_message.blocks[0].photo.media, 'stale-id');
    assert.deepEqual(
      calls.find((call) => call.method === 'sendPhoto').params.photo,
      { source: hit.media.source },
    );
    assert.equal(
      cache.get('photo', hit.media.source, hit.media.fingerprint),
      'refreshed-id',
    );
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
