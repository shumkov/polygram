/**
 * rc.58: validate the `document`/`photo`/etc file param on IPC sends
 * before relaying to Telegram, so agents get a clear error instead
 * of Telegram's cryptic "Wrong port number specified" rejection.
 *
 * Discovery: 2026-05-05 — agent generated an Artisan invoice .docx,
 * tried to deliver via polygram-ipc with `document: 'http://...'`
 * pointing at a localhost HTTP server it spun up. Telegram rejected
 * because (1) it can't reach the agent's Mac, (2) port format was
 * malformed. The rejection error read "Wrong port number specified"
 * which gave neither agent nor operator a useful clue.
 *
 * What's accepted:
 *   - { source: '/abs/path' } envelope — preferred for local files
 *   - public HTTPS URL — Telegram fetches it
 *   - Telegram file_id — short alphanumeric string, no scheme/slashes
 *
 * What's rejected at the IPC layer (clear error returned to caller):
 *   - localhost / 127.0.0.1 URLs (Telegram can't reach)
 *   - http:// URLs (Telegram requires https)
 *   - bare absolute paths (must wrap in { source: ... })
 *   - non-https schemes
 *
 * What's PASSED THROUGH (caller's responsibility):
 *   - { source: '/abs/path' } — grammy handles multipart upload
 *   - https URL string — Telegram validates reachability itself
 *   - file_id-shaped string — Telegram resolves
 *   - Buffer / Stream / other grammy InputFile shapes
 */

'use strict';

const FILE_PARAM_BY_METHOD = {
  sendDocument: 'document',
  sendPhoto: 'photo',
  sendAudio: 'audio',
  sendAnimation: 'animation',
  sendVideo: 'video',
  sendVoice: 'voice',
};

/**
 * @param {string} method - IPC method name (e.g. 'sendDocument')
 * @param {object} params - the params payload
 * @returns {string|null} human-readable error if the file param is
 *   malformed, null if the params look fine (or the method has no
 *   file param to check).
 */
function validateIpcFileParam(method, params = {}) {
  const fileParam = FILE_PARAM_BY_METHOD[method];
  if (!fileParam) return null;
  const val = params[fileParam];
  if (typeof val !== 'string') return null;       // envelope/Buffer/etc — pass through
  if (val.length === 0) return `polygram IPC: ${fileParam} is empty`;

  const looksUrl = /^(https?|ftp):\/\//i.test(val);
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(\b|[:/?#])/i.test(val);
  const isAbsPath = val.startsWith('/');

  if (isLocalhost) {
    return `polygram IPC: localhost URLs unreachable from Telegram (got: ${val.slice(0, 80)}). Use { source: '/abs/path' } for local files, or a publicly reachable HTTPS URL.`;
  }
  if (looksUrl && !/^https:\/\//i.test(val)) {
    return `polygram IPC: only HTTPS URLs supported for ${fileParam} (got: ${val.slice(0, 80)}). Use https://, { source: '/abs/path' } for local files, or a Telegram file_id.`;
  }
  if (isAbsPath && !looksUrl) {
    return `polygram IPC: bare file path not accepted (got: ${val.slice(0, 80)}). Wrap it: { ${fileParam}: { source: '${val}' } } so grammy uploads as multipart.`;
  }
  return null;
}

module.exports = {
  validateIpcFileParam,
  FILE_PARAM_BY_METHOD,
};
