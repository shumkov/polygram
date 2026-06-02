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
const { MAX_FILE_BYTES, resolveFileCaps } = require('../attachments');

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
      // Inbound per-file cap is BACKEND-derived: 20 MB on cloud Telegram
      // (Telegram's own getFile ceiling), 2 GB with the local Bot API server.
      // rc.15: previously hardcoded to MAX_FILE_BYTES (20 MB), which rejected
      // large lossless tracks even when the local server could handle them.
      const cap = resolveFileCaps({ localApi: !!config.bot?.apiRoot }).inBytes;

      const fileInfo = await bot.api.getFile(att.file_id);
      if (!fileInfo?.file_path) throw new Error('no file_path from getFile');

      const safeName = sanitizeFilename(att.name);
      // Embed file_unique_id so two attachments with the same msg_id+name
      // (album, resend) can't silently overwrite each other.
      const uniq = att.file_unique_id ? `-${att.file_unique_id}` : '';
      const localName = `${msg.message_id}${uniq}-${safeName}`;
      const localPath = path.join(chatDir, localName);

      let size;

      if (path.isAbsolute(fileInfo.file_path)) {
        // ── Local Bot API server ────────────────────────────────────────
        // rc.15: in `--local` mode getFile returns a LOCAL ABSOLUTE PATH —
        // the server has already downloaded the file to its own disk. The
        // previous code built a cloud URL (https://api.telegram.org/file/...)
        // and HTTP-fetched it, which is nonsensical for a local path and
        // failed every inbound file once apiRoot was set. Instead, link the
        // file into the inbox directly (no HTTP, no buffering a 2 GB file
        // through RAM). A hardlink is instant and shares the inode, so it
        // survives the server pruning its own copy; fall back to a byte copy
        // across filesystems.
        const srcStat = fs.statSync(fileInfo.file_path);
        if (srcStat.size > cap) {
          throw new Error(`file ${srcStat.size} exceeds per-file cap ${cap}`);
        }
        if (fs.existsSync(localPath)) {
          logger.log?.(`[attach] ${chatId} ← ${att.kind} ${safeName} (already on disk, reusing)`);
        } else {
          try {
            fs.linkSync(fileInfo.file_path, localPath);
          } catch (e) {
            if (e.code === 'EEXIST') {
              logger.log?.(`[attach] ${chatId} ← ${att.kind} ${safeName} (race: already on disk)`);
            } else if (e.code === 'EXDEV') {
              fs.copyFileSync(fileInfo.file_path, localPath);   // cross-device fallback
            } else {
              throw e;
            }
          }
        }
        size = srcStat.size;
        logger.log?.(`[attach] ${chatId} ← ${att.kind} ${safeName} (${size} bytes, local-api) → ${localPath}`);
      } else {
        // ── Cloud Telegram ──────────────────────────────────────────────
        // getFile returns a RELATIVE path; download it over HTTPS with the
        // three-layer size guard (header → streaming accumulator → final).
        const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cl = parseInt(res.headers.get('content-length') || '0', 10);
        if (cl > cap) {
          throw new Error(`content-length ${cl} exceeds per-file cap ${cap}`);
        }
        let total = 0;
        const chunks = [];
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > cap) {
              try { await reader.cancel(); } catch {}
              throw new Error(`stream ${total}+ bytes exceeds per-file cap ${cap}`);
            }
            chunks.push(value);
          }
        } else {
          // Fallback for runtimes without WHATWG streams (shouldn't fire
          // on Node 22+).
          const ab = await res.arrayBuffer();
          if (ab.byteLength > cap) {
            throw new Error(`body ${ab.byteLength} bytes exceeds per-file cap ${cap}`);
          }
          chunks.push(new Uint8Array(ab));
          total = ab.byteLength;
        }
        const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
        if (buf.length > cap) {
          throw new Error(`body ${buf.length} bytes exceeds per-file cap ${cap}`);
        }
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
        size = buf.length;
        logger.log?.(`[attach] ${chatId} ← ${att.kind} ${safeName} (${size} bytes) → ${localPath}`);
      }

      dbWrite(() => db.markAttachmentDownloaded(att.id, {
        local_path: localPath, size_bytes: att.size_bytes || size,
      }), `markAttachmentDownloaded ${att.id}`);
      return { ...att, path: localPath, size: att.size_bytes || size, error: null };
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
