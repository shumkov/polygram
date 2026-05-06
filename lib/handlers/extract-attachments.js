/**
 * Extract attachment metadata from a Telegram message.
 *
 * Returns the canonical row shape that the rest of polygram's
 * pipeline (recordInbound → filterAttachments → downloadAttachments
 * → buildAttachmentTags) consumes. Pure function: no DB, no fs,
 * no network.
 *
 * Media-group bundling: when polygram pre-merges several
 * siblings sharing a `media_group_id` into a single message, the
 * merged attachment list lives at `msg._mergedAttachments`; we
 * return it verbatim. Otherwise the per-field extractors run.
 *
 * Auto-generated names use `shortFileTag(file_unique_id)` —
 * file_unique_id is stable per file across sessions, so a 6-char
 * prefix gives stable names that survive media-group reassignment.
 * Falls back to msg.message_id when file_unique_id is missing.
 */

'use strict';

/**
 * 8-char filesystem-safe handle from a Telegram file_unique_id.
 * Falls back to fallback (typically msg.message_id) when no
 * unique id is available.
 */
function shortFileTag(fileUniqueId, fallback) {
  if (fileUniqueId) {
    return String(fileUniqueId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8)
      || String(fallback);
  }
  return String(fallback);
}

function extractAttachments(msg) {
  // Media-group bundling: pre-merged list takes precedence.
  if (Array.isArray(msg._mergedAttachments)) return msg._mergedAttachments;

  const items = [];
  if (msg.document) {
    const d = msg.document;
    items.push({
      file_id: d.file_id,
      file_unique_id: d.file_unique_id,
      name: d.file_name || `document-${shortFileTag(d.file_unique_id, msg.message_id)}`,
      mime_type: d.mime_type || 'application/octet-stream',
      size: d.file_size || 0,
      kind: 'document',
    });
  }
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    items.push({
      file_id: largest.file_id,
      file_unique_id: largest.file_unique_id,
      name: `photo-${shortFileTag(largest.file_unique_id, msg.message_id)}.jpg`,
      mime_type: 'image/jpeg',
      size: largest.file_size || 0,
      kind: 'photo',
    });
  }
  if (msg.voice) {
    items.push({
      file_id: msg.voice.file_id,
      file_unique_id: msg.voice.file_unique_id,
      name: `voice-${shortFileTag(msg.voice.file_unique_id, msg.message_id)}.ogg`,
      mime_type: msg.voice.mime_type || 'audio/ogg',
      size: msg.voice.file_size || 0,
      kind: 'voice',
    });
  }
  if (msg.audio) {
    const a = msg.audio;
    items.push({
      file_id: a.file_id,
      file_unique_id: a.file_unique_id,
      name: a.file_name || `audio-${shortFileTag(a.file_unique_id, msg.message_id)}.mp3`,
      mime_type: a.mime_type || 'audio/mpeg',
      size: a.file_size || 0,
      kind: 'audio',
    });
  }
  if (msg.video) {
    const v = msg.video;
    items.push({
      file_id: v.file_id,
      file_unique_id: v.file_unique_id,
      name: v.file_name || `video-${shortFileTag(v.file_unique_id, msg.message_id)}.mp4`,
      mime_type: v.mime_type || 'video/mp4',
      size: v.file_size || 0,
      kind: 'video',
    });
  }
  return items;
}

module.exports = { extractAttachments, shortFileTag };
