#!/usr/bin/env node
/**
 * Rich Message MEDIA blocks against a real Telegram Bot API — the G6
 * live checks for typed media blocks (docs/0.18.0-rich-messages-plan.md
 * §§16.7 and 17.11):
 *
 *   (a) editMessageText{rich_message} on an existing PLAIN message with
 *       a photo block whose media is a grammy InputFile — verifies the
 *       attach://-upload-via-edit path inferred from the API reference.
 *   (b) collage + slideshow with nested photo blocks (local InputFile
 *       and https URL mixed) with block-level captions.
 *   (c) a garbage media value — captures the REAL error string and
 *       confirms isRichContentError (not the capability classifier)
 *       matches it.
 *   (d) >10 photos in one collage — probes whether the classic 10-item
 *       album cap applies per-collage (undocumented; global cap is 50).
 *   (e) caption adversarial content — a block caption containing HTML,
 *       markdown-link syntax, and tg:// sequences must render LITERALLY
 *       on a real client (manual eyeball check; the G1(d) analog for
 *       the new caption surface).
 *   (f) only when apiRoot is configured: send a URL-media photo through
 *       the local Bot API server — then check the server host's egress
 *       (manually) to learn whether IT fetched the URL (SSRF surface →
 *       keep the cloud-only rule in rich-media.js) or Telegram's DCs
 *       did (rule can be lifted).
 *   (g-h) standalone local video and animation blocks, including the
 *       returned response shapes used for file_id learning.
 *   (i) mixed photo/video/animation collage and slideshow blocks.
 *   (j) second rich edits that reuse learned video/animation file_ids.
 *   (k) direct sendPhoto/sendVideo/sendAnimation sidecars.
 *
 * SAFETY: this sends REAL messages using a REAL bot token to a REAL
 * Telegram chat. Dry-run by default — prints what it would do without
 * sending anything. Pass --confirm to actually send. Only ever targets
 * the bot's configured `adminChatId` (the operator's own DM with their
 * own bot) unless --chat explicitly overrides it.
 *
 * Usage:
 *   node scripts/spikes/rich-media-blocks.mjs [--config PATH] [--bot NAME] [--confirm] [--chat ID] \
 *     [--video /absolute/fixture.mp4] [--animation /absolute/fixture.gif]
 *
 * Defaults: --config ~/.polygram/config.json, --bot <first bot in config>.
 * Test photos are generated locally. The video and animation gates
 * require operator-selected absolute fixture paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Bot, InputFile } = require('grammy');
const { isRichContentError, isRichCapabilityError } = require('../../lib/telegram/rich.js');
const { largestPhotoFileId } = require('../../lib/telegram/rich-media.js');

function parseArgs(argv) {
  const out = {
    config: path.join(os.homedir(), '.polygram', 'config.json'),
    bot: null,
    confirm: false,
    chat: null,
    video: null,
    animation: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--bot') out.bot = argv[++i];
    else if (argv[i] === '--confirm') out.confirm = true;
    else if (argv[i] === '--chat') out.chat = argv[++i];
    else if (argv[i] === '--video') out.video = argv[++i];
    else if (argv[i] === '--animation') out.animation = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function loadBotConfig() {
  const raw = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const botName = args.bot || Object.keys(raw.bots || {})[0];
  if (!botName) throw new Error(`no bots found in ${args.config}`);
  const botCfg = { ...(raw.bot || {}), ...(raw.bots[botName] || {}) };
  if (!botCfg.token) throw new Error(`bot "${botName}" has no token in ${args.config}`);
  if (!botCfg.adminChatId && !args.chat) throw new Error(`bot "${botName}" has no adminChatId in ${args.config} — refusing to guess a target chat`);
  return { botName, ...botCfg };
}

const results = []; // { id, pass, detail }
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// Minimal valid 1x1 PNG (red pixel) — enough for Telegram to accept a
// photo upload without shipping any real file from the operator's disk.
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080200000090775' +
  '3de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082',
  'hex',
);

function makeTestPng(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, PNG_1PX);
  return p;
}

const REMOTE_PHOTO_URL = 'https://telegram.org/img/t_logo.png';

function requireFixture(source, extension, label) {
  if (!source || !path.isAbsolute(source) || path.extname(source).toLowerCase() !== extension) {
    throw new Error(`--${label} must be an absolute ${extension} fixture path`);
  }
  const resolved = fs.realpathSync(source);
  if (!fs.statSync(resolved).isFile()) throw new Error(`--${label} must point to a file`);
  return resolved;
}

async function main() {
  const cfg = loadBotConfig();
  const chatId = args.chat || cfg.adminChatId;
  const prefix = '[SPIKE TEST] rich-media-blocks:';

  console.log(`bot=${cfg.botName} chat=${chatId} confirm=${args.confirm}`);
  if (!args.confirm) {
    console.log('DRY RUN — would run photo, standalone video/animation, mixed-wrapper, response-shape, learned-ID edit, and typed-sidecar checks. Pass --confirm with --video and --animation fixtures to send.');
    return;
  }

  const videoFixture = requireFixture(args.video, '.mp4', 'video');
  const animationFixture = requireFixture(args.animation, '.gif', 'animation');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rich-media-spike-'));
  const bot = new Bot(cfg.token, cfg.apiRoot ? { client: { apiRoot: cfg.apiRoot } } : undefined);

  const mediaBlock = (kind, media, captionText = null) => ({
    type: kind,
    [kind]: { type: kind, media },
    ...(captionText ? { caption: { text: captionText } } : {}),
  });
  const photoBlock = (media, captionText = null) => mediaBlock('photo', media, captionText);
  const returnedBlock = (result, kind) => (
    result?.rich_message?.blocks?.find((block) => block?.type === kind) || null
  );
  const returnedFileId = (result, kind) => {
    const block = returnedBlock(result, kind);
    if (kind === 'photo') {
      return largestPhotoFileId(block?.photo);
    }
    return block?.[kind]?.file_id || null;
  };
  let videoResult = null;
  let animationResult = null;

  // (a) plain send → rich edit introducing a photo upload
  try {
    const sent = await bot.api.raw.sendMessage({ chat_id: chatId, text: `${prefix} (a) plain message, about to become rich with a photo` });
    const local = makeTestPng(tmp, 'edit-upload.png');
    const edited = await bot.api.raw.editMessageText({
      chat_id: chatId,
      message_id: sent.message_id,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: `${prefix} (a) photo introduced via editMessageText upload` },
          photoBlock(new InputFile(local), 'uploaded via attach:// in an edit'),
        ],
      },
    });
    const fileId = returnedFileId(edited, 'photo');
    record('a-photo-via-edit', Boolean(fileId),
      fileId
        ? 'plain→rich edit accepted and returned PhotoSize[] with a reusable file_id'
        : 'edit succeeded but the returned rich photo shape had no reusable file_id');
  } catch (err) {
    record('a-photo-via-edit', false, `${err.message} (capability=${isRichCapabilityError(err)}, content=${isRichContentError(err)})`);
  }

  // (b) collage + slideshow, mixed local + URL, with captions
  try {
    const l1 = makeTestPng(tmp, 'collage-1.png');
    await bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: `${prefix} (b) collage + slideshow` },
          {
            type: 'collage',
            blocks: [photoBlock(new InputFile(l1), 'local'), photoBlock(REMOTE_PHOTO_URL, 'url')],
          },
          {
            type: 'slideshow',
            blocks: [photoBlock(REMOTE_PHOTO_URL, 'slide 1'), photoBlock(REMOTE_PHOTO_URL, 'slide 2')],
          },
        ],
      },
    });
    record('b-collage-slideshow', true, 'collage(local+url) + slideshow accepted');
  } catch (err) {
    record('b-collage-slideshow', false, `${err.message} (capability=${isRichCapabilityError(err)}, content=${isRichContentError(err)})`);
  }

  // (c) garbage media → capture real error shape, verify classification
  try {
    await bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: {
        blocks: [photoBlock('this-is-not-a-file-id-or-url')],
      },
    });
    record('c-bad-media-error', false, 'garbage media was ACCEPTED — unexpected');
  } catch (err) {
    const content = isRichContentError(err);
    const capability = isRichCapabilityError(err);
    record('c-bad-media-error', content && !capability,
      `error="${err.message}" → content=${content} capability=${capability} (want content-only)`);
  }

  // (d) >10 photos in one collage — probe undocumented per-collage cap
  try {
    const blocks = Array.from({ length: 12 }, (_, i) => photoBlock(REMOTE_PHOTO_URL, `p${i + 1}`));
    await bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: `${prefix} (d) 12-photo collage` },
          { type: 'collage', blocks },
        ],
      },
    });
    record('d-12-photo-collage', true, '12-photo collage accepted (no per-collage 10-cap)');
  } catch (err) {
    record('d-12-photo-collage', true, `12-photo collage REJECTED: "${err.message}" (content=${isRichContentError(err)}) — per-collage cap exists, note it in §16.1`);
  }

  // (e) caption adversarial content — literal rendering is a manual
  // eyeball check on the receiving client; the API-level pass is just
  // "accepted".
  try {
    await bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: `${prefix} (e) caption below must render its markup LITERALLY` },
          photoBlock(REMOTE_PHOTO_URL, '<b>bold?</b> & [link](https://evil.example) tg://resolve?domain=x'),
        ],
      },
    });
    record('e-caption-adversarial', true, 'accepted — now EYEBALL the client: caption must show tags/brackets literally, no bold, no tappable link');
  } catch (err) {
    record('e-caption-adversarial', false, `${err.message}`);
  }

  // (f) URL media through a local Bot API server (only meaningful with apiRoot)
  if (cfg.apiRoot) {
    try {
      await bot.api.raw.sendRichMessage({
        chat_id: chatId,
        rich_message: {
          blocks: [photoBlock(REMOTE_PHOTO_URL, `${prefix} (f) URL fetched via local server?`)],
        },
      });
      record('f-url-via-local-api', true, 'accepted — check the apiRoot host\'s egress logs to see WHO fetched the URL (local server = SSRF surface, keep cloud-only rule)');
    } catch (err) {
      record('f-url-via-local-api', true, `URL media rejected by local server: "${err.message}" — cloud-only rule stays`);
    }
  } else {
    console.log('[SKIP] f-url-via-local-api — no apiRoot configured');
  }

  // (g) standalone video upload and returned Video shape
  try {
    videoResult = await bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: `${prefix} (g) standalone video` },
          mediaBlock('video', new InputFile(videoFixture), 'video fixture'),
        ],
      },
    });
    const fileId = returnedFileId(videoResult, 'video');
    record('g-standalone-video', Boolean(fileId),
      fileId
        ? 'video accepted and returned Video.file_id'
        : 'video accepted but returned shape had no Video.file_id');
  } catch (err) {
    record('g-standalone-video', false, `${err.message}`);
  }

  // (h) standalone animation upload and returned Animation shape
  try {
    animationResult = await bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: `${prefix} (h) standalone animation` },
          mediaBlock('animation', new InputFile(animationFixture), 'animation fixture'),
        ],
      },
    });
    const fileId = returnedFileId(animationResult, 'animation');
    record('h-standalone-animation', Boolean(fileId),
      fileId
        ? 'animation accepted and returned Animation.file_id'
        : 'animation accepted but returned shape had no Animation.file_id');
  } catch (err) {
    record('h-standalone-animation', false, `${err.message}`);
  }

  // (i) mixed wrapper children preserve the request order
  try {
    const mixedPhoto = makeTestPng(tmp, 'mixed.png');
    await bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: {
        blocks: [
          { type: 'paragraph', text: `${prefix} (i) mixed wrappers` },
          {
            type: 'collage',
            blocks: [
              photoBlock(new InputFile(mixedPhoto), 'photo'),
              mediaBlock('video', new InputFile(videoFixture), 'video'),
              mediaBlock('animation', new InputFile(animationFixture), 'animation'),
            ],
          },
          {
            type: 'slideshow',
            blocks: [
              mediaBlock('animation', new InputFile(animationFixture), 'animation first'),
              photoBlock(REMOTE_PHOTO_URL, 'photo second'),
              mediaBlock('video', new InputFile(videoFixture), 'video third'),
            ],
          },
        ],
      },
    });
    record('i-mixed-wrappers', true, 'mixed collage and slideshow accepted in authored order');
  } catch (err) {
    record('i-mixed-wrappers', false, `${err.message}`);
  }

  // (j) edit twice using the reusable IDs learned from standalone results
  try {
    const videoId = returnedFileId(videoResult, 'video');
    const animationId = returnedFileId(animationResult, 'animation');
    if (!videoResult?.message_id || !animationResult?.message_id || !videoId || !animationId) {
      throw new Error('standalone response did not provide message IDs and reusable media IDs');
    }
    for (const [kind, result, fileId] of [
      ['video', videoResult, videoId],
      ['animation', animationResult, animationId],
    ]) {
      await bot.api.raw.editMessageText({
        chat_id: chatId,
        message_id: result.message_id,
        rich_message: {
          blocks: [
            { type: 'paragraph', text: `${prefix} (j) ${kind} learned-ID edit 1` },
            mediaBlock(kind, fileId, `${kind} ID reuse`),
          ],
        },
      });
      await bot.api.raw.editMessageText({
        chat_id: chatId,
        message_id: result.message_id,
        rich_message: {
          blocks: [
            { type: 'paragraph', text: `${prefix} (j) ${kind} learned-ID edit 2` },
            mediaBlock(kind, fileId, `${kind} ID reused again`),
          ],
        },
      });
    }
    record('j-learned-id-edits', true, 'second video and animation edits accepted reusable file_ids');
  } catch (err) {
    record('j-learned-id-edits', false, `${err.message}`);
  }

  // (k) the direct methods used by typed fallback rescue accept source uploads
  try {
    const sidecarPhoto = makeTestPng(tmp, 'sidecar.png');
    await bot.api.raw.sendPhoto({
      chat_id: chatId,
      photo: new InputFile(sidecarPhoto),
      caption: `${prefix} (k) photo sidecar`,
    });
    await bot.api.raw.sendVideo({
      chat_id: chatId,
      video: new InputFile(videoFixture),
      caption: `${prefix} (k) video sidecar`,
    });
    await bot.api.raw.sendAnimation({
      chat_id: chatId,
      animation: new InputFile(animationFixture),
      caption: `${prefix} (k) animation sidecar`,
    });
    record('k-typed-sidecars', true, 'sendPhoto/sendVideo/sendAnimation source uploads accepted');
  } catch (err) {
    record('k-typed-sidecars', false, `${err.message}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
