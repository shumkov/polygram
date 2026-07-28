'use strict';

/**
 * E2E — REAL claude authoring media blocks (docs/0.18.0-rich-messages-plan.md §16).
 *
 * Every offline media test feeds the pipeline hand-written markdown. The one
 * thing none of them can prove is the AUTHORING side: given the real rich-mode
 * display hint, does real claude actually produce inline-image markdown the
 * pipeline can render — absolute paths inside its workspace, the wrapper tags,
 * parseable syntax? That's the same class of blind spot the hint/delivery
 * coupling bugs came from (openclaw #108264: the hint steered content the
 * delivery layer couldn't render).
 *
 * This spawns a REAL claude (channels bridge, same harness as
 * e2e-channels-real-claude.test.js), hands it the REAL rich-mode hint text,
 * asks for a before/after image reply, then runs claude's ACTUAL authored
 * reply through the REAL production chain:
 *
 *   needsRichRendering → toTelegramRichBlocks + createRichMediaResolver
 *   (allowlisted to the session cwd) → createStreamer partial/finalize ticks
 *   → createRichEditor → grammy InputFile materialization.
 *
 * Asserts: the authored images resolve to realpath'd {source} envelopes under
 * the cwd, streaming ticks never resolve media (placeholders only), the
 * finalize edit carries photo blocks, and rich-edit hands grammy genuine
 * path-backed InputFiles. Everything except the Telegram API itself, which is
 * G6's job (scripts/spikes/rich-media-blocks.mjs).
 *
 * GATED: only runs with E2E_REAL_CLAUDE=1 (spawns real claude, needs the
 * pinned binary + a working subscription/keychain; not for CI). Run with:
 *   E2E_REAL_CLAUDE=1 node --test --test-force-exit tests/e2e-rich-media-real-claude.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same resolution as polygram.js boot: orchestra's default vendor dir is
// ~/.local/share/orchestra, but the pruner-immune pinned binary lives in
// polygram's vendored dir — point orchestra there BEFORE loading claudeBin,
// or resolvePinnedClaudeBin returns claude's own auto-pruned version store
// and the spawn dies instantly (TMUX_SESSION_GONE in ~8ms).
if (!process.env.ORCHESTRA_CLAUDE_VENDOR_DIR) {
  process.env.ORCHESTRA_CLAUDE_VENDOR_DIR = path.join(os.homedir(), '.local', 'share', 'polygram', 'claude-bin');
}

const { CliProcess } = require('@shumkov/orchestra');
const { createTmuxRunner } = require('@shumkov/orchestra');
const { ensureVendoredClaudeBin, CLAUDE_CLI_PINNED_VERSION } = require('@shumkov/orchestra').claudeBin;
const { InputFile } = require('grammy');

function pinnedClaudeBin() {
  const r = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION, { logger: console });
  if (!r.ok) throw new Error(`pinned claude bin unavailable: ${r.reason}`);
  return r.path;
}

const { needsRichRendering, toTelegramRichBlocks, countMediaBlocks } = require('../lib/telegram/rich');
const { createRichMediaResolver } = require('../lib/telegram/rich-media');
const { createRichEditor } = require('../lib/telegram/rich-edit');
const { createStreamer } = require('../lib/telegram/streamer');
const { buildPolygramDisplayHint } = require('../lib/telegram/display-hint');

const RUN = process.env.E2E_REAL_CLAUDE === '1';

const noopStreamer = {
  onChunk: async () => {}, forceNewMessage: () => {},
  finalize: async () => ({ streamed: false }), flushDraft: async () => {}, discard: async () => {},
};
const noopReactor = { setState: () => {}, heartbeat: () => {}, clear: async () => {}, stop: () => {} };

// Depth-first photo-envelope collection (bare photo blocks + collage/slideshow
// children + containers) — what the assertions below inspect.
function collectPhotoMedia(blocks, out = []) {
  for (const b of blocks || []) {
    if (b.type === 'photo') out.push(b.photo.media);
    if (Array.isArray(b.blocks)) collectPhotoMedia(b.blocks, out);
    if (Array.isArray(b.items)) for (const it of b.items) collectPhotoMedia(it.blocks, out);
  }
  return out;
}

test('e2e: real claude authors inline media per the rich hint → full media pipeline yields uploadable photo blocks', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 240_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-media-'));
  const cwdReal = fs.realpathSync(cwd);
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];

  const proc = new CliProcess({
    sessionKey: 'e2e-media:1', chatId: '987654360', threadId: null, label: 'e2e-media',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: pinnedClaudeBin(),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true, message_id: 1 }; },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    // The REAL rich-mode hint — in the SDK path it arrives via the system
    // prompt (appendDisplayHint); the channels harness has no system-prompt
    // seam, so hand it over as explicit display rules in the message. What's
    // under test is whether the HINT TEXT steers correct authoring, not the
    // injection plumbing (build-options.test.js covers that).
    // inlineMedia: the media paragraphs are the rules this test asks claude to
    // follow, and both delivering paths now ship them.
    const hint = buildPolygramDisplayHint(true, { inlineMedia: true });

    // The plumbing is reliable; claude's discretion (e.g. describing the
    // images instead of embedding them) is the coin-flip — retry a fresh turn
    // like the edit_message E2E does, and fail only if no attempt authors
    // image markdown.
    let authored = '';
    for (let attempt = 1; attempt <= 3 && !/!\[[^\]\n]*\]\(/.test(authored); attempt++) {
      replies.length = 0;
      const result = await proc.send(
        'Here are your Telegram display rules for this chat:\n\n' + hint + '\n\n---\n\n'
        + 'Task (follow the Inline images + Grouping rules above): using the Bash tool, create two small '
        + 'PNG files named before.png and after.png in the current working directory '
        + '(`printf fake-image-bytes > before.png` is fine). Then send ONE reply via the reply tool: '
        + 'a one-sentence summary, then BOTH images inline as a before/after comparison, grouped with '
        + '<tg-collage> per your Grouping rule. Remember: absolute paths.',
        { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
      );
      authored = replies.join('\n\n') || result?.text || '';
    }

    // ── Authoring: real claude produced pipeline-consumable media markdown ──
    assert.match(authored, /!\[[^\]\n]*\]\(/,
      `claude must author inline image markdown per the hint. authored=${authored.slice(0, 400)}`);
    assert.equal(needsRichRendering(authored), true, 'the authored reply trips the rich gate');

    const files = ['before.png', 'after.png'].map((f) => path.join(cwdReal, f));
    for (const f of files) assert.ok(fs.existsSync(f), `claude created ${f}`);

    // ── The REAL production chain over claude's ACTUAL text ──
    const resolver = createRichMediaResolver({ allowedRoots: [cwd] });
    const toRichPayload = (text, opts) => toTelegramRichBlocks(text, { ...opts, resolveMedia: resolver });

    // Streamer with a fake clock (the streamer-rich test harness pattern):
    // a mid-stream tick then finalize, driven by claude's own reply text.
    const edits = [];
    let now = 0;
    const timers = [];
    const streamer = createStreamer({
      send: async () => ({ message_id: 500 }),
      edit: async (msgId, payload) => { edits.push(payload); },
      minChars: 1, throttleMs: 500, clock: () => now,
      schedule: (fn, delay) => { const t = { fn, fireAt: now + delay }; timers.push(t); return t; },
      cancel: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
      logger: { log: () => {}, error: () => {}, warn: () => {} },
      toRichPayload,
    });
    const advance = async (ms) => {
      now += ms;
      for (const t of timers.filter((x) => x.fireAt <= now)) {
        timers.splice(timers.indexOf(t), 1);
        await t.fn();
      }
    };

    await streamer.onChunk(authored.slice(0, Math.max(20, Math.floor(authored.length / 2))));
    await advance(600);
    await streamer.onChunk(authored);
    await advance(600);

    // Streaming ticks must NEVER resolve media — no {source} envelope (and
    // certainly no InputFile) before finalize.
    for (const e of edits) {
      const json = typeof e === 'string' ? e : JSON.stringify(e.blocks);
      assert.ok(!json.includes('"source"'),
        `no streaming tick may carry resolved media. edit=${json.slice(0, 300)}`);
    }

    const fin = await streamer.finalize(authored);
    assert.equal(fin.finalEditOk, true, `finalize edit must succeed: ${JSON.stringify(fin)}`);
    const finalEdit = edits[edits.length - 1];
    assert.ok(finalEdit && typeof finalEdit === 'object' && finalEdit.rich,
      `the finalize edit is rich. finalEdit=${JSON.stringify(finalEdit).slice(0, 300)}`);

    // Claude's images resolved to realpath'd envelopes under the session cwd.
    const media = collectPhotoMedia(finalEdit.blocks);
    assert.ok(media.length >= 2,
      `both authored images survive as photo blocks. blocks=${JSON.stringify(finalEdit.blocks).slice(0, 500)}`);
    for (const m of media) {
      assert.equal(typeof m.source, 'string', `local envelope shape: ${JSON.stringify(m)}`);
      assert.ok(m.source.startsWith(cwdReal + path.sep),
        `envelope carries a realpath inside the session cwd (allowlist + realpath held): ${m.source}`);
      assert.ok(fs.existsSync(m.source), `envelope points at the real file: ${m.source}`);
    }
    assert.equal(countMediaBlocks(finalEdit.blocks), media.length);
    assert.doesNotThrow(() => JSON.stringify(finalEdit.blocks), 'finalize blocks stay dedup-stringify-safe');

    // ── rich-edit hands grammy genuine path-backed InputFiles ──
    const tgCalls = [];
    const editor = createRichEditor({
      tg: async (_bot, method, params) => { tgCalls.push({ method, params }); return { message_id: 500 }; },
      botName: 'e2etest', logEvent: () => {}, redactBotToken: (s) => s,
      isRichCapabilityError: () => false, isRichContentError: () => false,
    });
    await editor({ bot: {}, chatId: '987654360', messageId: 500, blocks: finalEdit.blocks, sourceText: authored });
    const sentBlocks = tgCalls[0].params.rich_message.blocks;
    const sentMedia = collectPhotoMedia(sentBlocks);
    for (const m of sentMedia) {
      assert.ok(m instanceof InputFile, `rich-edit materialized a grammy InputFile: ${String(m)}`);
    }
    // The caller-held blocks stay envelopes (materialization cloned).
    for (const m of collectPhotoMedia(finalEdit.blocks)) {
      assert.ok(!(m instanceof InputFile), 'materialization must not mutate the streamer-held blocks');
    }
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
});

// The hint's degradation contract, live: an image OUTSIDE the allowlist must
// not kill the reply — the pipeline degrades it to a caption-only placeholder
// while in-root images still render. Uses real claude to author a reply
// referencing one in-root and one out-of-root file (the "typo'd/foreign path"
// failure §16.5 row 1 promises to survive).
test('e2e: real claude — an out-of-roots image degrades to a placeholder while the in-root image renders', {
  skip: RUN ? false : 'set E2E_REAL_CLAUDE=1 to run (spawns real claude)',
  timeout: 240_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-media2-'));
  const cwdReal = fs.realpathSync(cwd);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-e2e-media2-outside-'));
  const outsidePng = path.join(outside, 'foreign.png');
  fs.writeFileSync(outsidePng, Buffer.alloc(16, 3));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const replies = [];

  const proc = new CliProcess({
    sessionKey: 'e2e-media2:1', chatId: '987654361', threadId: null, label: 'e2e-media2',
    tmuxRunner: createTmuxRunner(), botName: 'e2etest',
    claudeBin: pinnedClaudeBin(),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true, message_id: 1 }; },
    logger: { warn: (...a) => console.error('[e2e:warn]', ...a), error: (...a) => console.error('[e2e:err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });

  try {
    await proc.start({ cwd, chatConfig, existingSessionId: null });

    let authored = '';
    for (let attempt = 1; attempt <= 3 && !(authored.includes(outsidePng) && /!\[[^\]\n]*\]\(/.test(authored)); attempt++) {
      replies.length = 0;
      const result = await proc.send(
        'Create a file named local.png in the current working directory (`printf x > local.png`). '
        + 'Then send ONE reply via the reply tool containing exactly two inline markdown images, in this order: '
        + `![local](<absolute path to local.png>) and ![foreign](${outsidePng}) — use those exact captions. `
        + 'One sentence of text first, then the two images.',
        { timeoutMs: 150_000, maxTurnMs: 170_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
      );
      authored = replies.join('\n\n') || result?.text || '';
    }

    assert.match(authored, /!\[local\]\(/, `claude authored the in-root image. authored=${authored.slice(0, 400)}`);
    assert.ok(authored.includes(outsidePng), `claude authored the out-of-root image path. authored=${authored.slice(0, 400)}`);

    const resolver = createRichMediaResolver({ allowedRoots: [cwd] });
    const r = toTelegramRichBlocks(authored, { resolveMedia: resolver });
    assert.equal(r.usedRich, true);

    const media = collectPhotoMedia(r.blocks);
    assert.equal(media.length, 1, `exactly the in-root image renders as a photo. blocks=${JSON.stringify(r.blocks).slice(0, 500)}`);
    assert.ok(media[0].source.startsWith(cwdReal + path.sep), `the surviving photo is the in-root one: ${media[0].source}`);

    const json = JSON.stringify(r.blocks);
    assert.ok(json.includes('foreign (media unavailable)'),
      `the rejected image degrades to its caption + unavailable marker. blocks=${json.slice(0, 500)}`);
    assert.ok(!json.includes(outsidePng) && !json.includes('foreign.png'),
      `the rejected path/basename never enters the rendered blocks. blocks=${json.slice(0, 500)}`);
  } finally {
    try { await proc.kill('e2e-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
  }
});
