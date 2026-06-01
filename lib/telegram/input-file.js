/**
 * input-file — coerce file-upload params into grammy InputFile instances.
 *
 * The bug (2026-05-31, shumorobot Music): callers passed a Telegraf-style
 * `{ source: '/abs/path' }` envelope as the file param (document/photo/…).
 * grammy 1.x does NOT recognize that shape — it's not an InputFile, so
 * grammy serializes it as a plain object and Telegram tries to read it as
 * a URL/file_id, failing with "invalid file HTTP URL: Wrong port number".
 * Result: file-send NEVER worked (channels reply(files) AND the IPC path
 * both produced this exact error). The existing dispatcher test used a fake
 * `send` and only asserted the METHOD, so it couldn't catch the bad shape.
 *
 * grammy uploads a local file only when the param is `new InputFile(path)`.
 * This helper normalizes, at the single send choke point (tg()), the
 * `{ source: <abs path> }` envelope → `new InputFile(path)`, leaving every
 * other shape untouched:
 *   - string file_id / https URL  → pass through (Telegram resolves)
 *   - existing InputFile instance → pass through (already correct)
 *   - Buffer / stream            → pass through (grammy handles)
 *
 * Only the explicit `{ source: string }` envelope is transformed — bare
 * path strings are intentionally NOT coerced (a Telegram file_id is also a
 * bare string; coercing would break sends-by-id).
 */

'use strict';

const { InputFile } = require('grammy');

// method → the params field that carries the file.
const FILE_FIELD_BY_METHOD = {
  sendPhoto: 'photo',
  sendDocument: 'document',
  sendAudio: 'audio',
  sendVideo: 'video',
  sendAnimation: 'animation',
  sendVoice: 'voice',
  sendVideoNote: 'video_note',
};

/**
 * Return a grammy-uploadable value for a single file param, or the original
 * value unchanged if it's not the `{ source }` envelope we coerce.
 */
function coerceFileValue(val) {
  if (val && typeof val === 'object' && !(val instanceof InputFile)
      && typeof val.source === 'string' && val.source.length > 0) {
    // { source: '/abs/path' } | { source: 'https://…', filename } → InputFile
    return new InputFile(val.source, val.filename);
  }
  return val;
}

/**
 * Mutate `params` in place so its file field (if any) is grammy-uploadable.
 * No-op for non-file methods and for params with no file field set.
 *
 * @param {string} method
 * @param {object} params
 * @returns {object} the same params object (for chaining)
 */
function coerceFileParams(method, params) {
  if (!params || typeof params !== 'object') return params;
  const field = FILE_FIELD_BY_METHOD[method];
  if (!field) return params;
  if (params[field] != null) {
    params[field] = coerceFileValue(params[field]);
  }
  return params;
}

module.exports = {
  coerceFileParams,
  coerceFileValue,
  FILE_FIELD_BY_METHOD,
};
