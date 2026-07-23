/**
 * Rich-message media resolver — turns agent-authored image srcs into
 * uploadable media values for photo blocks, enforcing the same trust
 * boundary as reply(files).
 *
 * The renderer (rich.js) stays filesystem-free; every impure decision
 * lives here: src classification, path allowlisting, extension and
 * size gating, and the per-message media budget. Returned local-file
 * media are JSON-safe `{ source: '<realpath>' }` envelopes — the
 * grammy InputFile is materialized later, in rich-edit.js, because an
 * InputFile inside the block tree would break the streamer's
 * JSON.stringify payload dedup (InputFile.toJSON throws by design).
 *
 * src classification is a trichotomy decided by a literal prefix test,
 * never a URL parser (a colon in a local path must not read as a
 * scheme):
 *   1. http(s):// URL   → passed through; Telegram fetches it
 *                          server-side (its 5 MB URL-photo limit
 *                          applies). Rejected when the bot runs
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
const { validateAttachmentPath } = require('../process/channels-tool-dispatcher');

// Telegram's per-photo upload ceiling (multipart). Distinct from the
// document caps in attachments.js — photos are capped tighter than
// documents by the Bot API.
const PHOTO_UPLOAD_CEILING = 10 * 1024 * 1024;

// Bound on the SINGLE multipart request that carries every photo of a
// reply (media upload happens in one finalize edit). Matches
// attachments.js's MAX_TOTAL_BYTES posture.
const MAX_TOTAL_MEDIA_BYTES = 50 * 1024 * 1024;

// Rich messages allow ≤50 media attachments in total (Bot API "Rich
// Message Limits"), wrapper children included. Enforced here, on the
// flattened descriptor list, so Telegram never rejects the whole reply
// over attachment #51.
const MAX_MEDIA_PER_MESSAGE = 50;

// Photo-block source selection (NOT a security control — the path
// allowlist is; Telegram validates actual bytes server-side). .gif is
// deliberately absent: it maps to an animation block, which this
// module doesn't emit — unlike channels-tool-dispatcher's image list,
// which includes .gif because sendPhoto accepts it as a photo message.
const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const HTTP_URL_RE = /^https?:\/\//i;

/**
 * @param {object} deps
 * @param {string[]} deps.allowedRoots — absolute roots media paths must
 *   resolve under (same builder as reply(files): buildAllowedRoots)
 * @param {number} [deps.maxPhotoBytes] — per-file cap, already clamped
 *   to PHOTO_UPLOAD_CEILING by the caller
 * @param {number} [deps.maxTotalMediaBytes] — per-reply budget
 * @param {boolean} [deps.allowUrlMedia] — false when a self-hosted Bot
 *   API server is configured (see module doc)
 * @param {(kind: string, detail: object) => void} [deps.logEvent]
 * @param {(p: string, roots: string[]) => {ok: boolean, resolved?: string, error?: string}} [deps.validatePath]
 * @param {(p: string) => number} [deps.fileSize]
 * @returns {(descriptors: Array<{src: string, caption: string}>) => Array<{media?: (string|{source: string}), rejected?: string}>}
 */
function createRichMediaResolver({
  allowedRoots = [],
  maxPhotoBytes = PHOTO_UPLOAD_CEILING,
  maxTotalMediaBytes = MAX_TOTAL_MEDIA_BYTES,
  allowUrlMedia = true,
  logEvent = null,
  validatePath = validateAttachmentPath,
  fileSize = (p) => fs.statSync(p).size,
} = {}) {
  return function resolveMedia(descriptors) {
    const results = [];
    const reasons = [];
    let accepted = 0;
    let totalBytes = 0;

    const reject = (reason) => {
      reasons.push(reason);
      results.push({ rejected: reason });
    };

    for (const d of descriptors || []) {
      const src = typeof d?.src === 'string' ? d.src : '';
      if (!src) { reject('empty-src'); continue; }
      if (accepted >= MAX_MEDIA_PER_MESSAGE) { reject('media-cap'); continue; }

      if (HTTP_URL_RE.test(src)) {
        if (!allowUrlMedia) { reject('url-local-api'); continue; }
        accepted += 1;
        results.push({ media: src });
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

      if (!PHOTO_EXTENSIONS.has(path.extname(check.resolved).toLowerCase())) {
        reject('extension');
        continue;
      }

      let bytes;
      try { bytes = fileSize(check.resolved); }
      catch { reject('unreadable'); continue; }
      if (bytes > maxPhotoBytes) { reject('too-large'); continue; }
      if (totalBytes + bytes > maxTotalMediaBytes) { reject('total-budget'); continue; }

      totalBytes += bytes;
      accepted += 1;
      results.push({ media: { source: check.resolved } });
    }

    if (reasons.length && typeof logEvent === 'function') {
      try {
        logEvent('rich-media-rejected', {
          rejected_count: reasons.length,
          accepted_count: accepted,
          reasons: reasons.slice(0, 10),
        });
      } catch { /* instrumentation must never break delivery */ }
    }

    return results;
  };
}

module.exports = {
  createRichMediaResolver,
  PHOTO_UPLOAD_CEILING,
  MAX_TOTAL_MEDIA_BYTES,
  MAX_MEDIA_PER_MESSAGE,
  PHOTO_EXTENSIONS,
};
