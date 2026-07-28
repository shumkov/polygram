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
  makeReplyMediaWiring,
  createMediaPreflight,
  createMediaDeliveryContext,
  createMediaFileIdCache,
  PHOTO_UPLOAD_CEILING,
  OTHER_MEDIA_UPLOAD_CEILING,
  MAX_TOTAL_MEDIA_BYTES,
  MAX_MEDIA_PER_MESSAGE,
} = require('../lib/telegram/rich-media');
const {
  MAX_FILES_PER_REPLY, validateAttachmentPath,
} = require('../lib/process/channels-tool-dispatcher');
const { materializeMediaBlocks } = require('../lib/telegram/rich-edit');
const { toTelegramRichBlocks } = require('../lib/telegram/rich');
const { createRichSender } = require('../lib/telegram/rich-send');

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
  test('the options carry what the caller did NOT have to state', () => {
    // Only assertions on values the caller did not pass in can fail here; the
    // reply tool's own choices are pinned behaviorally in makeReplyMediaWiring
    // below, because a value echoed straight back proves nothing.
    const opts = richMediaResolverOptions({ allowedRoots: ['/work'], chatId: '123' });

    assert.equal(opts.maxTotalMediaBytes, MAX_TOTAL_MEDIA_BYTES,
      'the per-reply byte budget is stated, not inherited by accident');
    assert.equal(MAX_FILES_PER_REPLY, 10,
      'the reply-tool ceiling both params share — if this moves, so does the parity claim');
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

  test('the whole tree aborts on the first mismatch, whichever item changed', () => {
    // Stated so the failure mode is a decision: one swapped file costs ALL
    // media in that reply, and the strategy re-renders every item as
    // unavailable rather than sending a partially-swapped tree.
    //
    // Asserted on the THROW, not on which handles were built. Materialization
    // walks in order, so whether an untouched sibling gets a handle first is
    // an artifact of position — and a handle is lazy and path-backed, nothing
    // is read until a request is serialized. The throw is what guarantees no
    // request is ever built; both orderings are covered so neither passes by
    // luck.
    for (const changed of ['a.png', 'b.png']) {
      const { dir, files } = workspace({ 'a.png': 8, 'b.png': 8 });
      const resolve = makeRichMediaResolver({ allowedRoots: [dir], chatId: '1' });
      const preflight = createMediaPreflight({ allowedRoots: [dir] });
      const [a, b] = resolve([
        { src: files['a.png'], caption: '' },
        { src: files['b.png'], caption: '' },
      ]);
      fs.writeFileSync(files[changed], Buffer.alloc(9, 3));

      assert.throws(() => materializeMediaBlocks(
        [
          { type: 'photo', photo: { type: 'photo', media: a.media } },
          { type: 'photo', photo: { type: 'photo', media: b.media } },
        ],
        (source) => ({ source }),
        preflight.preflightMedia,
      ), /source changed/i, `changed=${changed}`);
    }
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

// ─── The reply tool's envelope, tested by behavior ─────────────────────────
//
// These values ARE the reply tool's security and resource boundary. Expressed
// as an object literal at the wiring site they would be pinned by nothing —
// polygram.js is never executed by a test, only read as text — so deleting the
// fan-out ceiling there would widen it 5× with a green suite. Here each one
// can actually fail.

describe('makeReplyMediaWiring', () => {
  test('it hands back both halves, built from the call\'s roots', () => {
    const { dir, files } = workspace();
    const wiring = makeReplyMediaWiring({})({ allowedRoots: [dir], chatId: '1' });

    assert.equal(typeof wiring.resolveMedia, 'function');
    assert.equal(typeof wiring.mediaContext.preflightMedia, 'function',
      'a resolver without a preflight would upload unchecked');

    const [resolved] = wiring.resolveMedia([{ src: files['chart.png'], caption: '' }]);
    assert.equal(wiring.mediaContext.preflightMedia(resolved.media, 'photo').ok, true,
      'the two halves agree — same roots, same stat');
  });

  test('URL media is refused, whatever the server', () => {
    // files: cannot upload a URL at all, and a URL Telegram fetches
    // server-side is an exfiltration beacon for prompt-injected content.
    const { dir } = workspace();
    const { resolveMedia } = makeReplyMediaWiring({})({ allowedRoots: [dir], chatId: '1' });

    const [r] = resolveMedia([{ src: 'https://attacker.example/b.png?d=secret', caption: '' }]);

    assert.equal(r.rejected, 'url-local-api');
    assert.equal(r.media, undefined);
  });

  test('the fan-out ceiling is the one files: enforces', () => {
    const { dir, files } = workspace({ 'a.png': 8 });
    const { resolveMedia } = makeReplyMediaWiring({})({ allowedRoots: [dir], chatId: '1' });

    const results = resolveMedia(
      Array.from({ length: MAX_FILES_PER_REPLY + 2 }, () => ({ src: files['a.png'], caption: '' })),
    );

    assert.equal(results.filter((r) => r.media).length, MAX_FILES_PER_REPLY);
    assert.deepEqual(results.slice(MAX_FILES_PER_REPLY).map((r) => r.rejected),
      ['media-cap', 'media-cap']);
  });

  test('a path outside the call\'s roots is refused', () => {
    const inside = workspace();
    const outside = workspace({ 'secret.png': 8 });
    const { resolveMedia } = makeReplyMediaWiring({})({
      allowedRoots: [inside.dir], chatId: '1',
    });

    const [r] = resolveMedia([{ src: outside.files['secret.png'], caption: '' }]);

    assert.equal(r.rejected, 'path');
  });

  test('per-file caps follow the chat\'s override', () => {
    const { dir, files } = workspace({ 'big.png': 4096 });
    const config = { chats: { 1: { maxFileBytes: 1024 } } };
    const { resolveMedia } = makeReplyMediaWiring({ config })({
      allowedRoots: [dir], chatId: '1',
    });

    const [r] = resolveMedia([{ src: files['big.png'], caption: '' }]);

    assert.equal(r.rejected, 'too-large',
      'nothing downstream re-checks these bytes — api.js does not walk rich_message');
  });

  test('rejection telemetry names the verb, the chat, and reason classes only', () => {
    const inside = workspace();
    const outside = workspace({ 'secret.png': 8 });
    const seen = [];
    const { resolveMedia } = makeReplyMediaWiring({
      logEvent: (kind, detail) => seen.push({ kind, detail }),
      botName: 'testbot',
    })({ allowedRoots: [inside.dir], chatId: '12345', threadId: '77' });

    resolveMedia([{ src: outside.files['secret.png'], caption: '' }]);

    assert.equal(seen[0].kind, 'rich-media-rejected');
    assert.equal(seen[0].detail.transport, 'send', 'the soak groups by delivering verb');
    assert.equal(seen[0].detail.chat_id, '12345');
    assert.equal(seen[0].detail.thread_id, '77');
    assert.equal(seen[0].detail.bot, 'testbot');
    assert.deepEqual(seen[0].detail.reasons, ['path']);
    assert.ok(!JSON.stringify(seen[0]).includes(outside.dir),
      'a rejected path must not be echoed into telemetry');
  });

  test('the shared file_id cache is threaded through both halves', () => {
    const { dir, files } = workspace();
    const cache = createMediaFileIdCache();
    const wiring = makeReplyMediaWiring({ fileIdCache: cache })({
      allowedRoots: [dir], chatId: '1',
    });
    const [resolved] = wiring.resolveMedia([{ src: files['chart.png'], caption: '' }]);

    assert.equal(wiring.mediaContext.learnRichResult(
      [{ type: 'photo', photo: { type: 'photo', media: resolved.media } }],
      { rich_message: { blocks: [{ type: 'photo', photo: [{ file_id: 'learned', width: 9, height: 9 }] }] } },
    ), true);

    const [warm] = wiring.resolveMedia([{ src: files['chart.png'], caption: '' }]);
    assert.equal(warm.media.fileId, 'learned',
      'the send path fills the cache the streamer path also reads');
  });
});

describe('the media-count ceiling', () => {
  test('a caller asking for zero media gets zero, not the default', () => {
    // A ceiling option must never widen on the way through. Treating an
    // explicit 0 as "unset" would turn "no media here" into "up to 50".
    const { dir, files } = workspace({ 'a.png': 8 });
    const resolve = makeRichMediaResolver({
      allowedRoots: [dir], chatId: '1', maxMediaPerMessage: 0,
    });

    const results = resolve([1, 2, 3].map(() => ({ src: files['a.png'], caption: '' })));

    assert.deepEqual(results.map((r) => r.rejected), ['media-cap', 'media-cap', 'media-cap']);
  });

  test('a value above the module ceiling is clamped down to it', () => {
    const opts = richMediaResolverOptions({
      allowedRoots: [], chatId: '1', maxMediaPerMessage: 500,
    });
    const { dir, files } = workspace({ 'a.png': 8 });
    const resolve = makeRichMediaResolver({
      allowedRoots: [dir], chatId: '1', maxMediaPerMessage: 500,
    });

    assert.equal(opts.maxMediaPerMessage, 500, 'the option is passed through as given');
    const results = resolve(
      Array.from({ length: MAX_MEDIA_PER_MESSAGE + 1 }, () => ({ src: files['a.png'], caption: '' })),
    );
    assert.equal(results.filter((r) => r.media).length, MAX_MEDIA_PER_MESSAGE,
      'and clamped at enforcement — Telegram rejects the whole reply past 50');
  });
});

describe('the delivery context is built on the preflight', () => {
  test('it forwards the stat and the validator it was given', () => {
    // The extraction is only behavior-preserving if these arrive. A forward
    // that drops fileStat leaves the delivery context stat'ing differently
    // from the resolver that produced the fingerprints — every media send
    // then degrades to "(media unavailable)" with nothing in the logs. The
    // streamer suite passes either way, so it has to be pinned here.
    const { dir, files } = workspace();
    const seen = { stats: 0, validations: 0 };
    const context = createMediaDeliveryContext({
      allowedRoots: [dir],
      tg: async () => ({}),
      bot: {},
      chatId: 'chat',
      fileStat: (p) => { seen.stats += 1; return fs.statSync(p, { bigint: true }); },
      validatePath: (p, roots) => {
        seen.validations += 1;
        return validateAttachmentPath(p, roots);
      },
    });

    const [resolved] = makeRichMediaResolver({ allowedRoots: [dir], chatId: '1' })(
      [{ src: files['chart.png'], caption: '' }],
    );
    const checked = context.preflightMedia(resolved.media, 'photo');

    assert.equal(checked.ok, true);
    assert.equal(seen.stats, 1, 'the injected stat was the one used');
    assert.equal(seen.validations, 1, 'and so was the injected validator');
  });
});

describe('symlink swapped between resolve and send', () => {
  test('a link repointed outside the roots after resolution fails closed', () => {
    // The claim is that the resolved realpath is what gets uploaded, so
    // repointing the alias cannot smuggle a new target past a check that
    // already passed. Preflight re-requires that the path still resolves to
    // the same realpath, which is what makes that true.
    const inside = workspace({ 'real.png': 32 });
    const outside = workspace({ 'secret.png': 32 });
    const link = path.join(inside.dir, 'link.png');
    fs.symlinkSync(inside.files['real.png'], link);

    const resolve = makeRichMediaResolver({ allowedRoots: [inside.dir], chatId: '1' });
    const preflight = createMediaPreflight({ allowedRoots: [inside.dir] });
    const [resolved] = resolve([{ src: link, caption: '' }]);
    assert.equal(resolved.media.source, fs.realpathSync(inside.files['real.png']),
      'resolution records the target realpath, never the alias');

    // The agent owns its workspace, so it can repoint its own symlink.
    fs.unlinkSync(link);
    fs.symlinkSync(outside.files['secret.png'], link);

    assert.equal(preflight.preflightMedia(resolved.media, 'photo').ok, true,
      'the recorded realpath is unchanged and still in roots — it uploads that file');
    assert.throws(
      () => materializeMediaBlocks(
        [{ type: 'photo', photo: { type: 'photo', media: { ...resolved.media, source: link } } }],
        () => { throw new Error('nothing may be prepared for upload'); },
        preflight.preflightMedia,
      ),
      /source changed/i,
      'and an envelope naming the alias is refused: it no longer resolves to itself',
    );
  });
});

describe('nested media aborts as one tree', () => {
  test('one swapped child of a collage stops the whole group uploading', async () => {
    // The flat case is covered above; nesting is where a per-item abort would
    // be easiest to write by accident, and a group that uploaded its
    // unchanged half alongside a swapped one is the failure that matters —
    // the user would see a before/after where "after" is something else.
    const { dir, files } = workspace({ 'before.png': 32, 'after.png': 32 });
    const resolveMedia = makeRichMediaResolver({ allowedRoots: [dir], chatId: '1' });
    const preflight = createMediaPreflight({ allowedRoots: [dir] });

    const { blocks, usedRich } = toTelegramRichBlocks(
      `<tg-collage>\n\n![before](${files['before.png']})\n\n![after](${files['after.png']})\n\n</tg-collage>`,
      { resolveMedia },
    );
    assert.equal(usedRich, true);
    const collage = blocks.find((b) => b.type === 'collage');
    assert.ok(collage, `fixture must produce a group: ${JSON.stringify(blocks)}`);
    assert.equal(collage.blocks.length, 2);

    fs.writeFileSync(files['after.png'], Buffer.alloc(64, 9));

    // What matters is that no request is built: the throw escapes the whole
    // map, so the params object never exists and neither child is sent. Note
    // the unchanged sibling may already hold a lazy path-backed handle — that
    // reads nothing, and nothing ever serializes it.
    assert.throws(
      () => materializeMediaBlocks(blocks, (source) => ({ source }), preflight.preflightMedia),
      /source changed/i,
    );

    const tgCalls = [];
    const sendRich = createRichSender({
      tg: async (_bot, method, params) => { tgCalls.push({ method, params }); return { message_id: 1 }; },
      botName: 'testbot',
      isRichCapabilityError: () => false,
      isRichContentError: () => false,
      logger: { error: () => {}, warn: () => {} },
    });
    const out = await sendRich({
      bot: {}, chatId: '1', blocks, sourceText: 'x', mediaContext: preflight,
    });

    assert.deepEqual(out, { wentRich: false, fallback: 'media-source-changed' });
    assert.deepEqual(tgCalls, [], 'not one byte of the group reached Telegram');
  });
});
