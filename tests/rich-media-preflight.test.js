'use strict';

/**
 * The two halves of the media trust boundary that both rich paths share:
 * the resolver wiring (what a reply is ALLOWED to upload) and the preflight
 * (what is re-checked immediately before it uploads).
 *
 * They are tested together because their coupling is the dangerous part. The
 * preflight decides by comparing a fresh stat against the fingerprint the
 * resolver recorded, so any disagreement about how a file is stat'd rejects
 * every file — silently, with a "(media unavailable)" line and no error
 * anywhere. A test that builds one of them by hand would never see it.
 *
 * Run: node --test tests/rich-media-preflight.test.js
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  richMediaResolverOptions,
  makeRichMediaResolver,
  createMediaPreflight,
  createMediaFileIdCache,
  PHOTO_UPLOAD_CEILING,
  OTHER_MEDIA_UPLOAD_CEILING,
  MAX_TOTAL_MEDIA_BYTES,
  MAX_MEDIA_PER_MESSAGE,
} = require('../lib/telegram/rich-media');
const { MAX_FILES_PER_REPLY } = require('../lib/process/channels-tool-dispatcher');
const { materializeMediaBlocks } = require('../lib/telegram/rich-edit');

const tempDirs = new Set();
function workspace(files = { 'chart.png': 64 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-media-preflight-'));
  tempDirs.add(dir);
  const made = {};
  for (const [name, size] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(size, 1));
    made[name] = p;
  }
  return { dir, files: made };
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Resolver wiring ───────────────────────────────────────────────────────

describe('richMediaResolverOptions', () => {
  test('the reply-tool call site pins every gate that decides what may upload', () => {
    // Asserted by NAME, on the object the resolver is actually built from.
    // Each of these is a security or resource decision that would still
    // "work" if it silently reverted to the module default.
    const opts = richMediaResolverOptions({
      allowedRoots: ['/work'],
      chatId: '123',
      threadId: null,
      config: null,
      allowUrlMedia: false,
      maxMediaPerMessage: MAX_FILES_PER_REPLY,
    });

    assert.equal(opts.allowUrlMedia, false,
      'URL media is closed on this path unconditionally — files: cannot upload URLs either');
    assert.equal(opts.maxMediaPerMessage, 10,
      'the reply-tool fan-out ceiling is the one files: enforces');
    assert.equal(opts.maxMediaPerMessage, MAX_FILES_PER_REPLY);
    assert.equal(opts.maxTotalMediaBytes, MAX_TOTAL_MEDIA_BYTES,
      'the per-reply byte budget is stated, not inherited by accident');
    assert.deepEqual(opts.allowedRoots, ['/work']);
  });

  test('defaults are the NARROW side of every widenable option', () => {
    // "Nothing is defaulted" would be wrong — validatePath and fileStat are
    // deliberately defaulted, because their defaults are the secure ones.
    // What must never default open is anything that widens the boundary.
    const opts = richMediaResolverOptions({ allowedRoots: [], chatId: '1' });
    assert.equal(opts.allowUrlMedia, false);
    assert.equal(opts.validatePath, undefined,
      'path validation is not injectable at a call site');
    assert.equal(opts.fileStat, undefined,
      'stat is not injectable at a call site');
  });

  test('per-file caps come from the chat/topic override, clamped to the ceilings', () => {
    // api.js's outbound cap keys on FILE_FIELD_BY_METHOD, which has no
    // rich_message entry — nothing downstream re-checks these bytes.
    const config = {
      chats: {
        123: {
          maxFileBytes: 4 * 1024 * 1024,
          topics: { 77: { maxFileBytes: 2 * 1024 * 1024 } },
        },
        456: { maxFileBytes: 500 * 1024 * 1024 },
      },
    };

    const chat = richMediaResolverOptions({ allowedRoots: [], chatId: '123', config });
    assert.equal(chat.maxPhotoBytes, 4 * 1024 * 1024);
    assert.equal(chat.maxOtherMediaBytes, 4 * 1024 * 1024);

    const topic = richMediaResolverOptions({
      allowedRoots: [], chatId: '123', threadId: '77', config,
    });
    assert.equal(topic.maxPhotoBytes, 2 * 1024 * 1024,
      'the topic override wins — a dropped threadId would use the chat value');

    const huge = richMediaResolverOptions({ allowedRoots: [], chatId: '456', config });
    assert.equal(huge.maxPhotoBytes, PHOTO_UPLOAD_CEILING,
      'a generous override cannot lift the portable photo ceiling');
    assert.equal(huge.maxOtherMediaBytes, OTHER_MEDIA_UPLOAD_CEILING);

    const none = richMediaResolverOptions({ allowedRoots: [], chatId: '999', config });
    assert.equal(none.maxPhotoBytes, PHOTO_UPLOAD_CEILING,
      'no override → the ceiling, never 0');
    assert.equal(none.maxOtherMediaBytes, OTHER_MEDIA_UPLOAD_CEILING);
  });

  test('the delivering verb tags every event and cannot be shadowed by a detail', () => {
    // The soak counts rejections per transport. A resolver reason field named
    // `transport` must not be able to relabel which verb they came from.
    const seen = [];
    const opts = richMediaResolverOptions({
      allowedRoots: [],
      chatId: '123',
      threadId: '77',
      botName: 'testbot',
      transport: 'send',
      logEvent: (kind, detail) => seen.push({ kind, detail }),
    });

    opts.logEvent('rich-media-rejected', { rejected_count: 1, transport: 'spoofed' });

    assert.deepEqual(seen[0], {
      kind: 'rich-media-rejected',
      detail: {
        chat_id: '123', thread_id: '77', bot: 'testbot',
        rejected_count: 1, transport: 'send',
      },
    });
  });

  test('the fan-out ceiling is enforced, not merely recorded', () => {
    const { dir, files } = workspace({ 'a.png': 8 });
    const resolve = makeRichMediaResolver({
      allowedRoots: [dir], chatId: '1', maxMediaPerMessage: MAX_FILES_PER_REPLY,
    });

    const results = resolve(Array.from({ length: 12 }, () => ({ src: files['a.png'], caption: '' })));

    assert.equal(results.filter((r) => r.media).length, MAX_FILES_PER_REPLY);
    assert.deepEqual(results.slice(10).map((r) => r.rejected), ['media-cap', 'media-cap']);
    assert.ok(MAX_FILES_PER_REPLY < MAX_MEDIA_PER_MESSAGE,
      'the reply-tool path is narrower than the module ceiling — otherwise this proves nothing');
  });

  test('a URL is rejected on the reply-tool path even without a self-hosted server', () => {
    const resolve = makeRichMediaResolver({
      allowedRoots: ['/work'], chatId: '1', allowUrlMedia: false,
    });
    const [r] = resolve([{ src: 'https://example.com/beacon.png?leak=secret', caption: '' }]);
    assert.equal(r.rejected, 'url-local-api');
  });
});

// ─── The shared-stat invariant ─────────────────────────────────────────────

describe('createMediaPreflight', () => {
  test('a file resolved by the shared factory passes the shared preflight', () => {
    // The invariant that makes media work at all. Both sides take the
    // module's fileStat; the negative control below shows the assertion can
    // fail, so this is not a tautology.
    const { dir, files } = workspace();
    const resolve = makeRichMediaResolver({ allowedRoots: [dir], chatId: '1' });
    const preflight = createMediaPreflight({ allowedRoots: [dir] });

    const [resolved] = resolve([{ src: files['chart.png'], caption: '' }]);
    const checked = preflight.preflightMedia(resolved.media, resolved.kind);

    assert.equal(checked.ok, true);
    assert.deepEqual(checked.value, { source: fs.realpathSync(files['chart.png']) });
  });

  test('a non-bigint stat silently rejects every file — the trap this pins', () => {
    // fs.statSync without {bigint:true} yields float mtimes, so the
    // fingerprint can never equal the resolver's. Nothing errors: every media
    // send would just degrade to "(media unavailable)" forever.
    const { dir, files } = workspace();
    const resolve = makeRichMediaResolver({ allowedRoots: [dir], chatId: '1' });
    const wrong = createMediaPreflight({
      allowedRoots: [dir],
      fileStat: (p) => fs.statSync(p),
    });

    const [resolved] = resolve([{ src: files['chart.png'], caption: '' }]);

    assert.equal(wrong.preflightMedia(resolved.media, resolved.kind).ok, false,
      'a mismatched stat rejects — which is exactly why neither side may pick its own');
  });

  test('a cached file_id is still gated on THIS call\'s roots', () => {
    // The cache is process-wide and keyed by realpath. A session whose roots
    // no longer contain the file must not get its id back just because some
    // earlier reply uploaded it.
    const { dir, files } = workspace();
    const cache = createMediaFileIdCache();
    const resolve = makeRichMediaResolver({
      allowedRoots: [dir], chatId: '1', fileIdCache: cache,
    });
    const [resolved] = resolve([{ src: files['chart.png'], caption: '' }]);
    cache.set('photo', resolved.media.source, resolved.media.fingerprint, 'photo-id');

    const inRoots = createMediaPreflight({ allowedRoots: [dir], fileIdCache: cache });
    const outOfRoots = createMediaPreflight({
      allowedRoots: [path.join(dir, 'nope')], fileIdCache: cache,
    });
    const withId = { ...resolved.media, fileId: 'photo-id' };

    assert.equal(inRoots.preflightMedia(withId, 'photo').value, 'photo-id');
    assert.equal(outOfRoots.preflightMedia(withId, 'photo').ok, false,
      'roots are re-checked before a cached id is honored');
  });

  test('a source that changed since it was resolved aborts materialization', () => {
    const { dir, files } = workspace();
    const resolve = makeRichMediaResolver({ allowedRoots: [dir], chatId: '1' });
    const preflight = createMediaPreflight({ allowedRoots: [dir] });
    const [resolved] = resolve([{ src: files['chart.png'], caption: '' }]);

    fs.writeFileSync(files['chart.png'], Buffer.alloc(96, 2));

    assert.throws(
      () => materializeMediaBlocks(
        [{ type: 'photo', photo: { type: 'photo', media: resolved.media } }],
        () => { throw new Error('nothing may be prepared for upload'); },
        preflight.preflightMedia,
      ),
      /source changed/i,
    );
  });

  test('the whole tree aborts on the first mismatch, not just the changed item', () => {
    // Stated so the failure mode is a decision: one swapped file costs ALL
    // media in that reply, and the strategy re-renders every item as
    // unavailable rather than sending a partially-swapped tree.
    const { dir, files } = workspace({ 'a.png': 8, 'b.png': 8 });
    const resolve = makeRichMediaResolver({ allowedRoots: [dir], chatId: '1' });
    const preflight = createMediaPreflight({ allowedRoots: [dir] });
    const [a, b] = resolve([
      { src: files['a.png'], caption: '' },
      { src: files['b.png'], caption: '' },
    ]);
    fs.writeFileSync(files['a.png'], Buffer.alloc(9, 3));

    const prepared = [];
    assert.throws(() => materializeMediaBlocks(
      [
        { type: 'photo', photo: { type: 'photo', media: a.media } },
        { type: 'photo', photo: { type: 'photo', media: b.media } },
      ],
      (source) => { prepared.push(source); return { source }; },
      preflight.preflightMedia,
    ), /source changed/i);
    assert.deepEqual(prepared, [], 'the untouched file is not uploaded either');
  });

  test('eviction and learning act on the same cache the resolver reads', () => {
    const { dir, files } = workspace();
    const cache = createMediaFileIdCache();
    const resolve = makeRichMediaResolver({
      allowedRoots: [dir], chatId: '1', fileIdCache: cache,
    });
    const preflight = createMediaPreflight({ allowedRoots: [dir], fileIdCache: cache });
    const [resolved] = resolve([{ src: files['chart.png'], caption: '' }]);
    const blocks = [{ type: 'photo', photo: { type: 'photo', media: resolved.media } }];

    // A server that echoes the sent blocks back teaches the cache.
    assert.equal(preflight.learnRichResult(blocks, {
      rich_message: {
        blocks: [{ type: 'photo', photo: [{ file_id: 'learned', width: 20, height: 10 }] }],
      },
    }), true);
    const [warm] = resolve([{ src: files['chart.png'], caption: '' }]);
    assert.equal(warm.media.fileId, 'learned', 'the next reply reuses the id instead of re-uploading');

    // Telegram forgetting that id leaves a MATCHING fingerprint behind, so
    // without an explicit eviction every later reply would fail forever.
    assert.equal(preflight.evictCachedBlocks([
      { type: 'photo', photo: { type: 'photo', media: warm.media } },
    ]), 1);
    const [cold] = resolve([{ src: files['chart.png'], caption: '' }]);
    assert.equal(cold.media.fileId, undefined, 'the next reply re-uploads the bytes');
  });
});
