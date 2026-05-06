/**
 * Telegram attachment downloader with bounded concurrency.
 *
 * Per inbound message with attachments, this fans out parallel
 * fetches against Telegram's CDN, writes each to disk atomically
 * (temp file + rename), and updates the attachments DB row with
 * download_status / local_path / error. The per-file 10MB cap is
 * enforced THREE ways: content-length header (cheap), streaming
 * accumulator (DOS protection), final post-buffer check (defense
 * in depth).
 *
 * Reuse path: if a row already says downloaded AND the file is on
 * disk with non-zero size, the fetch is skipped (idempotent on
 * boot-replay).
 *
 * Token redaction: the fetch URL embeds bot${TOKEN}; some undici
 * error variants stringify the URL into err.message. We pipe every
 * persisted error through redactBotToken so the bot token never
 * lands in attachments.download_error or stderr.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { redactBotToken } = require('../error/net');
const { MAX_FILE_BYTES } = require('../attachments');

const ATTACHMENT_DOWNLOAD_CONCURRENCY_DEFAULT = 6;

function sanitizeFilename(name) {
  if (!name) return 'file';
  return name.replace(/[\/\\:\0]/g, '_').slice(0, 120);
}

function createDownloadAttachments({
  config,
  db,
  dbWrite,
  inboxDir,
  logger = console,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
} = {}) {
  if (!config) throw new TypeError('config required');
  if (!db) throw new TypeError('db required');
  if (typeof dbWrite !== 'function') throw new TypeError('dbWrite required');
  if (!inboxDir) throw new TypeError('inboxDir required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl required');

  function attachmentConcurrency() {
    const v = Number(config.bot?.attachmentConcurrency);
    return (Number.isInteger(v) && v > 0) ? v : ATTACHMENT_DOWNLOAD_CONCURRENCY_DEFAULT;
  }

  // Per-attachment download. Pure function over (att, deps) → result.
  // Pulled out of the loop so downloadAttachments can run several in
  // parallel.
  async function downloadOneAttachment(bot, token, chatId, msg, chatDir, att) {
    // Reuse path: row already says downloaded AND the file is on disk.
    if (att.download_status === 'downloaded' && att.local_path) {
      try {
        if (fs.statSync(att.local_path).size > 0) {
          return { ...att, path: att.local_path, size: att.size_bytes || 0, error: null };
        }
      } catch { /* fall through to refetch */ }
    }
    try {
      const fileInfo = await bot.api.getFile(att.file_id);
      if (!fileInfo?.file_path) throw new Error('no file_path from getFile');
      const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Three-layer size enforcement, in order of cheapness:
      //   1. Content-Length header — fail-fast before reading body.
      //   2. Streaming accumulator — abort the moment cumulative byte
      //      count crosses the cap. Defends against attackers omitting
      //      Content-Length: pre-cap the whole body could pin RSS.
      //   3. Final post-buffer check — defense in depth.
      const cl = parseInt(res.headers.get('content-length') || '0', 10);
      if (cl > MAX_FILE_BYTES) {
        throw new Error(`content-length ${cl} exceeds per-file cap ${MAX_FILE_BYTES}`);
      }
      let total = 0;
      const chunks = [];
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_FILE_BYTES) {
            try { await reader.cancel(); } catch {}
            throw new Error(`stream ${total}+ bytes exceeds per-file cap ${MAX_FILE_BYTES}`);
          }
          chunks.push(value);
        }
      } else {
        // Fallback for runtimes without WHATWG streams (shouldn't fire
        // on Node 22+).
        const ab = await res.arrayBuffer();
        if (ab.byteLength > MAX_FILE_BYTES) {
          throw new Error(`body ${ab.byteLength} bytes exceeds per-file cap ${MAX_FILE_BYTES}`);
        }
        chunks.push(new Uint8Array(ab));
        total = ab.byteLength;
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
      if (buf.length > MAX_FILE_BYTES) {
        throw new Error(`body ${buf.length} bytes exceeds per-file cap ${MAX_FILE_BYTES}`);
      }
      const safeName = sanitizeFilename(att.name);
      // Embed file_unique_id so two attachments with the same msg_id+name
      // (album, resend) can't silently overwrite each other.
      const uniq = att.file_unique_id ? `-${att.file_unique_id}` : '';
      const localName = `${msg.message_id}${uniq}-${safeName}`;
      const localPath = path.join(chatDir, localName);
      // Atomic write: temp file + rename. A crash mid-write leaves a
      // .tmp.* file (swept later) rather than a truncated canonical
      // file the EEXIST dedup branch would happily serve next time.
      if (fs.existsSync(localPath)) {
        logger.log?.(`[attach] ${chatId} ← ${att.kind} ${safeName} (already on disk, reusing)`);
      } else {
        const tmpPath = `${localPath}.tmp.${process.pid}.${Date.now()}`;
        try {
          fs.writeFileSync(tmpPath, buf, { flag: 'wx' });
          fs.renameSync(tmpPath, localPath);
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch {}
          if (e.code !== 'EEXIST') throw e;
          logger.log?.(`[attach] ${chatId} ← ${att.kind} ${safeName} (race: already on disk)`);
        }
      }
      logger.log?.(`[attach] ${chatId} ← ${att.kind} ${safeName} (${buf.length} bytes) → ${localPath}`);
      dbWrite(() => db.markAttachmentDownloaded(att.id, {
        local_path: localPath, size_bytes: att.size_bytes || buf.length,
      }), `markAttachmentDownloaded ${att.id}`);
      return { ...att, path: localPath, size: att.size_bytes || buf.length, error: null };
    } catch (err) {
      // Don't drop the attachment silently — push it through with the
      // failure noted. buildAttachmentTags renders this as
      // <attachment-failed reason="..." /> so claude tells the user
      // "I couldn't see your <kind>" instead of pretending it received
      // text only. Token redaction is mandatory: the fetch URL embeds
      // bot${TOKEN} and some undici variants stringify it into err.message.
      const raw = (err.message || 'unknown').slice(0, 200);
      const reason = redactBotToken(raw);
      logger.error?.(`[attach] download failed for ${att.name}: ${reason}`);
      dbWrite(() => db.markAttachmentFailed(att.id, reason),
        `markAttachmentFailed ${att.id}`);
      return { ...att, path: null, error: reason };
    }
  }

  // 0.6.7: parallel fetches with bounded concurrency. Inner work is
  // stateless per-attachment (writes keyed on file_unique_id so two
  // parallel downloads can't collide). Order of results is preserved
  // by writing into a fixed-size array at the original index —
  // important so the prompt sees attachments in album order.
  async function downloadAttachments(bot, token, chatId, msg, rows) {
    if (!rows.length) return [];
    const chatDir = path.join(inboxDir, String(chatId));
    fs.mkdirSync(chatDir, { recursive: true });

    const results = new Array(rows.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(attachmentConcurrency(), rows.length) },
      async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= rows.length) return;
          results[idx] = await downloadOneAttachment(bot, token, chatId, msg, chatDir, rows[idx]);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  return downloadAttachments;
}

module.exports = {
  createDownloadAttachments,
  sanitizeFilename,
  ATTACHMENT_DOWNLOAD_CONCURRENCY_DEFAULT,
};
