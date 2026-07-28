/**
 * Rich-message media resolver — turns agent-authored media srcs into
 * uploadable values for typed blocks, enforcing the same trust
 * boundary as reply(files).
 *
 * The renderer (rich.js) stays filesystem-free; every impure decision
 * lives here: src classification, path allowlisting, extension and
 * size gating, and the per-message media budget. Returned local-file
 * media are JSON-safe `{ source: '<realpath>', fingerprint: '…' }`
 * envelopes — the
 * grammy InputFile is materialized later, in rich-edit.js, because an
 * InputFile inside the block tree would break the streamer's
 * JSON.stringify payload dedup (InputFile.toJSON throws by design).
 *
 * src classification is a trichotomy decided by a literal prefix test,
 * never a URL parser (a colon in a local path must not read as a
 * scheme):
 *   1. http(s):// URL   → passed through; Telegram fetches it
 *                          server-side. Rejected when the bot runs
 *                          through a self-hosted Bot API server
 *                          (allowUrlMedia=false) — whether that server
 *                          fetches the URL from inside the operator's
 *                          network (an SSRF surface) is unverified.
 *   2. absolute path    → realpath + allowlist via the same
 *                          validateAttachmentPath used by reply(files);
 *                          the RESOLVED path is what gets uploaded, so
 *                          symlink games can't dodge the check.
 *   3. anything else    → rejected (data:, file:, tg:, attach:,
 *                          relative paths). A literal agent-authored
 *                          attach:// string must never reach grammy —
 *                          it would dangle against a multipart part
 *                          that doesn't exist.
 *
 * Rejections degrade to placeholder paragraphs upstream; the reply
 * always delivers. Events log reason classes only — never the raw src
 * (URLs can embed credentials, paths leak workspace structure).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  validateAttachmentPath,
  MAX_FILES_PER_REPLY,
} = require('../process/channels-tool-dispatcher');
const { resolveMaxFileOverride } = require('../attachments');
const { TELEGRAM_MAX_CAPTION_LENGTH } = require('./format');

// Portable multipart ceilings. Photos are capped tighter than video and
// animation by the Bot API.
const PHOTO_UPLOAD_CEILING = 10 * 1024 * 1024;
const OTHER_MEDIA_UPLOAD_CEILING = 50 * 1024 * 1024;

// Bound on the SINGLE multipart request that carries every local media
// item of a reply (uploads happen in one finalize edit). Matches
// attachments.js's MAX_TOTAL_BYTES posture.
const MAX_TOTAL_MEDIA_BYTES = 50 * 1024 * 1024;

// Rich messages allow ≤50 media attachments in total (Bot API "Rich
// Message Limits"), wrapper children included. Enforced here, on the
// flattened descriptor list, so Telegram never rejects the whole reply
// over attachment #51.
const MAX_MEDIA_PER_MESSAGE = 50;

// Source selection is extension-based, not a security control; the path
// allowlist is, and Telegram validates actual bytes server-side.
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const LOCAL_MEDIA_KIND_BY_EXTENSION = new Map([
  ...[...PHOTO_EXTENSIONS].map((extension) => [extension, 'photo']),
  ['.mp4', 'video'],
  ['.gif', 'animation'],
]);

const HTTP_URL_RE = /^https?:\/\//i;
const MAX_RESCUE_CAPTION_LENGTH = TELEGRAM_MAX_CAPTION_LENGTH;
const FILE_ID_CACHE_MAX_ENTRIES = 256;
const MEDIA_KINDS = new Set(['photo', 'video', 'animation']);
const RESCUE_METHODS = Object.freeze({
  photo: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  animation: { method: 'sendAnimation', field: 'animation' },
});

function classifyUrlMediaKind(src) {
  let extension = '';
  try {
    extension = path.posix.extname(new URL(src).pathname).toLowerCase();
  } catch {}
  return LOCAL_MEDIA_KIND_BY_EXTENSION.get(extension) || 'photo';
}

function classifyLocalMediaKind(source) {
  return LOCAL_MEDIA_KIND_BY_EXTENSION.get(path.extname(source).toLowerCase()) || null;
}

function statFingerprint(stat) {
  const value = (name, fallback) => {
    const v = stat?.[name] ?? stat?.[fallback];
    return v == null ? '' : String(v);
  };
  return [
    value('dev'),
    value('ino'),
    value('size'),
    value('mtimeNs', 'mtimeMs'),
    value('ctimeNs', 'ctimeMs'),
  ].join(':');
}

function statMediaFile(source) {
  return fs.statSync(source, { bigint: true });
}

function createMediaFileIdCache({ maxEntries = FILE_ID_CACHE_MAX_ENTRIES } = {}) {
  const entries = new Map();
  const limit = Number.isInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : FILE_ID_CACHE_MAX_ENTRIES;
  const keyFor = (kind, source) => `${kind}\0${source}`;

  function get(kind, source, fingerprint) {
    if (!MEDIA_KINDS.has(kind) || typeof source !== 'string' || typeof fingerprint !== 'string') {
      return null;
    }
    const key = keyFor(kind, source);
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.fileId;
  }

  function set(kind, source, fingerprint, fileId) {
    if (!MEDIA_KINDS.has(kind)
        || typeof source !== 'string'
        || typeof fingerprint !== 'string'
        || typeof fileId !== 'string'
        || !fileId) {
      return false;
    }
    const key = keyFor(kind, source);
    entries.delete(key);
    entries.set(key, { fingerprint, fileId });
    while (entries.size > limit) {
      entries.delete(entries.keys().next().value);
    }
    return true;
  }

  function remove(kind, source) {
    if (!MEDIA_KINDS.has(kind) || typeof source !== 'string') return false;
    return entries.delete(keyFor(kind, source));
  }

  return Object.freeze({
    get,
    set,
    delete: remove,
    get size() { return entries.size; },
  });
}

function visitNestedBlocks(blocks, visit) {
  for (const block of blocks || []) {
    visit(block);
    if (Array.isArray(block?.blocks)) visitNestedBlocks(block.blocks, visit);
    if (Array.isArray(block?.items)) {
      for (const item of block.items) {
        if (Array.isArray(item?.blocks)) visitNestedBlocks(item.blocks, visit);
      }
    }
  }
}

function collectOutgoingMedia(blocks) {
  const entries = [];
  visitNestedBlocks(blocks, (block) => {
    const kind = block?.type;
    if (!MEDIA_KINDS.has(kind)) return;
    const inputMedia = block[kind];
    if (!inputMedia || Array.isArray(inputMedia) || inputMedia.media == null) return;
    entries.push({ kind, media: inputMedia.media });
  });
  return entries;
}

function largestPhotoFileId(sizes) {
  if (!Array.isArray(sizes)) return null;
  let best = null;
  let bestArea = -1;
  for (const size of sizes) {
    if (typeof size?.file_id !== 'string' || !size.file_id) continue;
    const area = Math.max(0, Number(size.width) || 0) * Math.max(0, Number(size.height) || 0);
    if (area > bestArea) {
      best = size.file_id;
      bestArea = area;
    }
  }
  return best;
}

function returnedMediaFileId(kind, media) {
  if (kind === 'photo') return largestPhotoFileId(media);
  if (!MEDIA_KINDS.has(kind)) return null;
  return typeof media?.file_id === 'string' ? media.file_id : null;
}

function collectReturnedMedia(blocks) {
  const entries = [];
  visitNestedBlocks(blocks, (block) => {
    const kind = block?.type;
    if (!MEDIA_KINDS.has(kind)) return;
    entries.push({ kind, fileId: returnedMediaFileId(kind, block[kind]) });
  });
  return entries;
}

function collectMediaRescueEntries(blocks) {
  const entries = [];
  visitNestedBlocks(blocks, (block) => {
    const kind = block?.type;
    if (!MEDIA_KINDS.has(kind) || block[kind]?.media == null) return;
    entries.push({
      kind,
      media: block[kind].media,
      caption: typeof block.caption?.text === 'string' ? block.caption.text : '',
    });
  });
  return entries;
}

/**
 * @param {object} deps
 * @param {string[]} deps.allowedRoots — absolute roots media paths must
 *   resolve under (same builder as reply(files): buildAllowedRoots)
 * @param {number} [deps.maxPhotoBytes] — per-file cap, already clamped
 *   to PHOTO_UPLOAD_CEILING by the caller
 * @param {number} [deps.maxOtherMediaBytes] — video/animation per-file cap,
 *   already clamped to OTHER_MEDIA_UPLOAD_CEILING by the caller
 * @param {number} [deps.maxTotalMediaBytes] — per-reply budget
 * @param {number} [deps.maxMediaPerMessage] — per-reply attachment count,
 *   clamped to MAX_MEDIA_PER_MESSAGE. The reply-tool path passes the same
 *   ceiling reply(files) enforces, so one syntax can't fan out wider than
 *   the other.
 * @param {boolean} [deps.allowUrlMedia] — false when a self-hosted Bot
 *   API server is configured (see module doc)
 * @param {(kind: string, detail: object) => void} [deps.logEvent]
 * @param {(p: string, roots: string[]) => {ok: boolean, resolved?: string, error?: string}} [deps.validatePath]
 * @param {(p: string) => object} [deps.fileStat]
 * @param {(p: string) => number} [deps.fileSize]
 * @returns {(descriptors: Array<{src: string, caption: string}>) => Array<
 *   {kind: ('photo'|'video'|'animation'), media: (string|{
 *     source: string, fingerprint: string, fileId?: string
 *   })}|{rejected: string}
 * >}
 */
function createRichMediaResolver({
  allowedRoots = [],
  maxPhotoBytes = PHOTO_UPLOAD_CEILING,
  maxOtherMediaBytes = OTHER_MEDIA_UPLOAD_CEILING,
  maxTotalMediaBytes = MAX_TOTAL_MEDIA_BYTES,
  maxMediaPerMessage = MAX_MEDIA_PER_MESSAGE,
  allowUrlMedia = true,
  logEvent = null,
  validatePath = validateAttachmentPath,
  fileStat = statMediaFile,
  fileSize = null,
  fileIdCache = null,
} = {}) {
  // A caller asking for zero media means zero, not "use the default" — a
  // ceiling option must never widen on the way through. Only a value that is
  // not a count at all falls back.
  const mediaCap = Math.min(
    Number.isInteger(maxMediaPerMessage) && maxMediaPerMessage >= 0
      ? maxMediaPerMessage
      : MAX_MEDIA_PER_MESSAGE,
    MAX_MEDIA_PER_MESSAGE,
  );
  return function resolveMedia(descriptors) {
    const results = [];
    const reasons = [];
    let rejected = 0;
    let accepted = 0;
    let totalBytes = 0;

    const reject = (reason) => {
      rejected += 1;
      if (reasons.length < 10) reasons.push(reason);
      results.push({ rejected: reason });
    };

    for (const d of descriptors || []) {
      const src = typeof d?.src === 'string' ? d.src : '';
      if (!src) { reject('empty-src'); continue; }
      if (accepted >= mediaCap) { reject('media-cap'); continue; }

      if (HTTP_URL_RE.test(src)) {
        if (!allowUrlMedia) { reject('url-local-api'); continue; }
        accepted += 1;
        results.push({ kind: classifyUrlMediaKind(src), media: src });
        continue;
      }

      if (!path.isAbsolute(src)) {
        // Covers relative paths AND every non-http scheme (data:,
        // file:, tg:, attach:, …) — none of them start with "/".
        reject('not-absolute');
        continue;
      }

      const check = validatePath(src, allowedRoots);
      if (!check.ok) { reject('path'); continue; }

      const kind = classifyLocalMediaKind(check.resolved);
      if (!kind) {
        reject('extension');
        continue;
      }

      let stat;
      let bytes;
      try {
        stat = fileStat(check.resolved);
        bytes = fileSize ? fileSize(check.resolved) : Number(stat.size);
      }
      catch { reject('unreadable'); continue; }
      const maxBytes = kind === 'photo' ? maxPhotoBytes : maxOtherMediaBytes;
      if (bytes > maxBytes) { reject('too-large'); continue; }
      if (totalBytes + bytes > maxTotalMediaBytes) { reject('total-budget'); continue; }

      totalBytes += bytes;
      accepted += 1;
      const fingerprint = statFingerprint(stat);
      const fileId = fileIdCache?.get?.(kind, check.resolved, fingerprint) || null;
      results.push({
        kind,
        media: {
          source: check.resolved,
          fingerprint,
          ...(fileId ? { fileId } : {}),
        },
      });
    }

    if (rejected > 0 && typeof logEvent === 'function') {
      try {
        logEvent('rich-media-rejected', {
          rejected_count: rejected,
          accepted_count: accepted,
          reasons,
        });
      } catch { /* instrumentation must never break delivery */ }
    }

    return results;
  };
}

/**
 * Resolver options for one reply call, derived from exactly the inputs the
 * caller has. Separated from the factory below so the wiring can be asserted
 * as data — the value of every gate that decides what a prompt-injected reply
 * may upload, by name, rather than by whatever the resolver happened to
 * default to.
 *
 * No option that can WIDEN the trust boundary is defaulted permissively:
 * `allowUrlMedia` defaults OFF and `validatePath`/`fileStat` are deliberately
 * not injectable here — call sites get the module's secure implementations.
 *
 * @param {object} args
 * @param {string[]} args.allowedRoots — computed ONCE per reply by the caller
 *   and shared with its reply(files) validation, so the two can't diverge
 * @param {string|number} args.chatId
 * @param {string|number|null} [args.threadId]
 * @param {object|null} [args.config] — bot-filtered config, for the per-chat
 *   file-size override (never for roots: those follow the running session)
 * @param {object|null} [args.fileIdCache]
 * @param {Function|null} [args.logEvent]
 * @param {?string} [args.botName]
 * @param {?string} [args.transport] — event tag for the delivering verb
 * @param {boolean} [args.allowUrlMedia]
 * @param {number} [args.maxMediaPerMessage]
 */
function richMediaResolverOptions({
  allowedRoots = [],
  chatId = null,
  threadId = null,
  config = null,
  fileIdCache = null,
  logEvent = null,
  botName = null,
  transport = null,
  allowUrlMedia = false,
  maxMediaPerMessage = MAX_MEDIA_PER_MESSAGE,
} = {}) {
  // api.js's outbound size cap keys on FILE_FIELD_BY_METHOD, which has no
  // rich_message entry — nothing downstream re-checks these bytes, so these
  // caps are the only per-file limit on this payload.
  const override = resolveMaxFileOverride(config, chatId, threadId);
  return {
    allowedRoots,
    fileIdCache,
    maxPhotoBytes: Math.min(PHOTO_UPLOAD_CEILING, override ?? PHOTO_UPLOAD_CEILING),
    maxOtherMediaBytes: Math.min(OTHER_MEDIA_UPLOAD_CEILING, override ?? OTHER_MEDIA_UPLOAD_CEILING),
    maxTotalMediaBytes: MAX_TOTAL_MEDIA_BYTES,
    maxMediaPerMessage,
    allowUrlMedia,
    logEvent: typeof logEvent === 'function'
      // transport goes AFTER the spread: a resolver detail may not shadow the
      // field the soak groups by.
      ? (kind, detail) => logEvent(kind, {
        chat_id: chatId,
        thread_id: threadId,
        bot: botName,
        ...detail,
        ...(transport ? { transport } : {}),
      })
      : null,
  };
}

/**
 * The one place either rich path builds its media resolver. Duplicating this
 * wiring verbatim at two call sites is how the two trust boundaries drift
 * apart; see richMediaResolverOptions for what each option decides.
 */
function makeRichMediaResolver(args) {
  return createRichMediaResolver(richMediaResolverOptions(args));
}

/**
 * The reply tool's media boundary, whole: a resolver deciding what this call
 * may upload, and the preflight that re-checks each item immediately before
 * it does. Both from the same roots and the same stat, which is the property
 * that makes them agree.
 *
 * It lives here, rather than as an object literal at the wiring site, so it
 * can be tested by BEHAVIOR. The values below are the reply tool's security
 * and resource envelope; expressed at a call site they would be pinned by
 * nothing, since polygram.js is never executed by a test — deleting the
 * fan-out ceiling there would widen it 5× with a green suite.
 *
 * @param {object} deps
 * @param {object|null} [deps.config] — for the per-chat file-size override
 * @param {object|null} [deps.fileIdCache] — shared with the streamer path
 * @param {Function|null} [deps.logEvent]
 * @param {?string} [deps.botName]
 * @returns {(call: {allowedRoots: string[], chatId, threadId}) =>
 *   {resolveMedia: Function, mediaContext: object}}
 */
function makeReplyMediaWiring({
  config = null,
  fileIdCache = null,
  logEvent = null,
  botName = null,
} = {}) {
  return function replyMediaWiring({ allowedRoots, chatId, threadId = null } = {}) {
    return {
      resolveMedia: makeRichMediaResolver({
        allowedRoots,
        chatId,
        threadId,
        config,
        fileIdCache,
        // Unconditional, unlike the streamer path: `files:` cannot upload a
        // URL at all, and a URL Telegram fetches server-side is an
        // exfiltration beacon for prompt-injected content. The display hint
        // teaches local paths only, so nothing legitimate is lost.
        allowUrlMedia: false,
        // The same ceiling `files:` enforces: above it that param errors, and
        // silently accepting five times as many through image syntax would
        // make the narrower limit meaningless.
        maxMediaPerMessage: MAX_FILES_PER_REPLY,
        logEvent,
        botName,
        transport: 'send',
      }),
      mediaContext: createMediaPreflight({ allowedRoots, fileIdCache }),
    };
  };
}

/**
 * The non-network half of the delivery context: everything a send needs to
 * re-check local media immediately before upload and to keep the file_id
 * cache honest afterwards.
 *
 * Split out because the send path needs exactly this and nothing else — it
 * has no placeholder bubble to delete, no rescue ladder, and no partial-
 * delivery warning to flush. Its `fileStat`/`validatePath` MUST be the same
 * implementations the resolver used: a stat that isn't bigint produces
 * fingerprints that can never match the resolved ones, and every media send
 * would then degrade silently with nothing in the logs saying why.
 *
 * @returns {{preflightMedia: Function, rememberLocal: Function,
 *   learnRichResult: Function, evictCachedBlocks: Function}}
 */
function createMediaPreflight({
  allowedRoots = [],
  fileIdCache = null,
  validatePath = validateAttachmentPath,
  fileStat = statMediaFile,
  logger = console,
} = {}) {
  const roots = Object.freeze([...(allowedRoots || [])]);

  function evict(kind, media) {
    if (media && typeof media.source === 'string') {
      fileIdCache?.delete?.(kind, media.source);
    }
  }

  function preflight(media, kind = 'photo', { preferFileId = true } = {}) {
    if (!MEDIA_KINDS.has(kind)) return { ok: false };
    if (typeof media === 'string') return { ok: HTTP_URL_RE.test(media), value: media };
    if (!media || typeof media.source !== 'string' || typeof media.fingerprint !== 'string') {
      return { ok: false };
    }
    const check = validatePath(media.source, roots);
    if (!check.ok || check.resolved !== media.source) {
      evict(kind, media);
      return { ok: false };
    }
    let current;
    try { current = statFingerprint(fileStat(check.resolved)); }
    catch {
      evict(kind, media);
      return { ok: false };
    }
    if (current !== media.fingerprint) {
      evict(kind, media);
      return { ok: false };
    }
    let fileId = typeof media.fileId === 'string' && media.fileId ? media.fileId : null;
    if (fileId && fileIdCache) {
      const currentId = fileIdCache.get?.(kind, media.source, media.fingerprint) || null;
      if (currentId !== fileId) fileId = null;
    }
    return {
      ok: true,
      value: preferFileId && fileId ? fileId : { source: media.source },
    };
  }

  function rememberLocal(kind, media, fileId) {
    if (!fileIdCache || typeof fileId !== 'string' || !fileId) return false;
    const checked = preflight(media, kind, { preferFileId: false });
    if (!checked.ok || typeof media === 'string') return false;
    return fileIdCache.set?.(kind, media.source, media.fingerprint, fileId) === true;
  }

  function learnRichResult(blocks, result) {
    try {
      if (result?._notModified || !Array.isArray(result?.rich_message?.blocks)) return false;
      const outgoing = collectOutgoingMedia(blocks);
      const returned = collectReturnedMedia(result.rich_message.blocks);
      if (outgoing.length !== 1 || returned.length !== 1) return false;
      if (outgoing[0].kind !== returned[0].kind) return false;
      if (!outgoing[0].media || typeof outgoing[0].media !== 'object') return false;
      return rememberLocal(outgoing[0].kind, outgoing[0].media, returned[0].fileId);
    } catch (err) {
      logger.warn?.(`[rich-media] cache learning failed (${err?.name || 'Error'})`);
      return false;
    }
  }

  function evictCachedBlocks(blocks) {
    let evicted = 0;
    for (const entry of collectOutgoingMedia(blocks)) {
      if (entry.media
          && typeof entry.media === 'object'
          && typeof entry.media.fileId === 'string'
          && fileIdCache?.delete?.(entry.kind, entry.media.source)) {
        evicted += 1;
      }
    }
    return evicted;
  }

  return Object.freeze({
    preflightMedia: preflight,
    rememberLocal,
    learnRichResult,
    evictCachedBlocks,
  });
}

function createMediaDeliveryContext({
  allowedRoots = [],
  tg,
  bot,
  chatId,
  threadId = null,
  replyToMessageId = null,
  botName = null,
  logEvent = null,
  setDeliveryError = () => {},
  logger = console,
  validatePath = validateAttachmentPath,
  fileStat = statMediaFile,
  fileIdCache = null,
} = {}) {
  const {
    preflightMedia: preflight,
    rememberLocal,
    learnRichResult,
    evictCachedBlocks,
  } = createMediaPreflight({ allowedRoots, fileIdCache, validatePath, fileStat, logger });
  const failures = { text: 0, media: 0, deletion: 0 };
  let warningFlushed = false;

  function recordFailure(kind, count = 1) {
    if (Object.hasOwn(failures, kind)) failures[kind] += Math.max(0, Number(count) || 0);
  }

  function learnDirectResult(kind, media, result) {
    try {
      const fileId = returnedMediaFileId(kind, result?.[kind]);
      return rememberLocal(kind, media, fileId);
    } catch (err) {
      logger.warn?.(`[rich-media] cache learning failed (${err?.name || 'Error'})`);
      return false;
    }
  }

  async function deletePlaceholder(messageId, meta = {}) {
    try {
      await tg(bot, 'deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      }, { ...meta, source: 'bot-reply-rich-media-placeholder-delete', botName });
      return true;
    } catch (err) {
      recordFailure('deletion');
      logger.warn?.('[rich-media] placeholder delete failed');
      return false;
    }
  }

  async function rescueEntries(entries, {
    trigger,
    anchorFirst = false,
    meta = {},
  } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    let attempted = 0;
    let sent = 0;
    let failed = 0;
    let needsAnchor = anchorFirst && replyToMessageId != null;
    const kindCounts = { photo: 0, video: 0, animation: 0 };

    for (const entry of list) {
      const rescue = RESCUE_METHODS[entry?.kind];
      if (!rescue) continue;
      attempted += 1;
      kindCounts[entry.kind] += 1;
      const checked = preflight(entry.media, entry.kind, { preferFileId: false });
      if (!checked.ok) {
        failed += 1;
        recordFailure('media');
        continue;
      }
      const params = {
        chat_id: chatId,
        [rescue.field]: checked.value,
        ...(threadId != null && { message_thread_id: threadId }),
      };
      if (entry.caption && entry.caption.length <= MAX_RESCUE_CAPTION_LENGTH) {
        params.caption = entry.caption;
      }
      if (needsAnchor) {
        params.reply_parameters = {
          message_id: replyToMessageId,
          allow_sending_without_reply: true,
        };
      }
      try {
        const result = await tg(bot, rescue.method, params, {
          ...meta,
          source: 'bot-reply-rich-media-rescue',
          botName,
          plainText: true,
        });
        learnDirectResult(entry.kind, entry.media, result);
        sent += 1;
        needsAnchor = false;
      } catch (err) {
        failed += 1;
        recordFailure('media');
        logger.warn?.(`[rich-media] ${rescue.method} rescue failed`);
      }
    }

    if (attempted > 0 && typeof logEvent === 'function') {
      try {
        logEvent('rich-media-rescue', {
          trigger: trigger || 'unknown',
          attempted,
          sent,
          failed,
          photo_count: kindCounts.photo,
          video_count: kindCounts.video,
          animation_count: kindCounts.animation,
        });
      } catch { /* instrumentation must never break delivery */ }
    }
    return { attempted, sent, failed };
  }

  async function rescueBlocks(blocks, opts = {}) {
    return rescueEntries(collectMediaRescueEntries(blocks), opts);
  }

  function recordTextFailures(count) {
    recordFailure('text', count);
  }

  function recordDeletionFailures(count) {
    recordFailure('deletion', count);
  }

  function recordUnexpectedMediaFailure() {
    recordFailure('media');
  }

  async function flushPartialDeliveryWarning(meta = {}) {
    if (warningFlushed) return false;
    const total = failures.text + failures.media + failures.deletion;
    if (total === 0) return false;
    warningFlushed = true;
    try { setDeliveryError(); } catch {}
    if (typeof logEvent === 'function') {
      try {
        logEvent('rich-media-delivery-summary', {
          text_failed: failures.text,
          media_failed: failures.media,
          deletion_failed: failures.deletion,
        });
      } catch { /* instrumentation must never break delivery */ }
    }

    const parts = [];
    if (failures.text) parts.push(`${failures.text} message part${failures.text === 1 ? '' : 's'}`);
    if (failures.media) parts.push(`${failures.media} media item${failures.media === 1 ? '' : 's'}`);
    if (failures.deletion) parts.push('the media placeholder cleanup');
    const risks = [];
    if (failures.text || failures.media) risks.push('incomplete');
    if (failures.deletion) risks.push('duplicated');
    try {
      await tg(bot, 'sendMessage', {
        chat_id: chatId,
        text: `⚠️ ${parts.join(' and ')} failed. The reply may be ${risks.join(' or ')} — please retry.`,
        ...(threadId != null && { message_thread_id: threadId }),
      }, { ...meta, source: 'partial-delivery-warning', botName });
    } catch (err) {
      logger.warn?.('[rich-media] partial-delivery warning failed');
    }
    return true;
  }

  return Object.freeze({
    preflightMedia: preflight,
    learnRichResult,
    evictCachedBlocks,
    rescueEntries,
    rescueBlocks,
    deletePlaceholder,
    recordTextFailures,
    recordDeletionFailures,
    recordUnexpectedMediaFailure,
    flushPartialDeliveryWarning,
    get deliveryIncomplete() {
      return failures.text + failures.media + failures.deletion > 0;
    },
  });
}

module.exports = {
  createRichMediaResolver,
  richMediaResolverOptions,
  makeRichMediaResolver,
  makeReplyMediaWiring,
  createMediaPreflight,
  createMediaDeliveryContext,
  createMediaFileIdCache,
  collectMediaRescueEntries,
  largestPhotoFileId,
  PHOTO_UPLOAD_CEILING,
  OTHER_MEDIA_UPLOAD_CEILING,
  MAX_TOTAL_MEDIA_BYTES,
  MAX_MEDIA_PER_MESSAGE,
  PHOTO_EXTENSIONS,
  MAX_RESCUE_CAPTION_LENGTH,
};
