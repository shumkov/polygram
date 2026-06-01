/**
 * Attachment filter — caps total size + per-file size + MIME allowlist.
 * Rejected items return a human-readable reason that we surface to the
 * user and log to the events table.
 *
 * No count cap: per-file (10 MB) and total-size (20 MB) bound resource
 * usage already; an additional count limit just produces "skipped: max
 * count" surprises on Telegram albums (up to 10 photos in one send).
 *
 * rc.68 — widened scope:
 *   - archives (zip + alt zip MIME some Telegram clients send): containers
 *     the agent unpacks via Bash + unzip when downstream tools are gated
 *     in. Size caps remain the binding control.
 *   - markup the agent reads natively but was silently being denied unless
 *     the client happened to ship it as text/plain (markdown, html, yaml,
 *     xml). Closes the consistency gap.
 *   - extension-fallback path for missing/octet-stream MIME. Telegram's
 *     server-side detection degrades to octet-stream (or omits MIME) for
 *     extensions it doesn't sniff; the fallback trusts the filename when
 *     extension is on the same well-known list. Defense-in-depth: explicit
 *     denylisted MIME (e.g. application/x-msdownload) still wins over
 *     extension — the fallback only kicks in when MIME is unhelpful.
 */

// Inbound (user → bot) per-file cap. Telegram's cloud Bot API hard-caps
// bot file DOWNLOADS (getFile) at 20 MB, so 20 MB is the real ceiling on
// cloud — raised from 10 MB so users can send larger tracks/docs. With a
// self-hosted Bot API server (config.bot.apiRoot) the Telegram limit rises
// to 2 GB; resolveFileCaps() raises the default accordingly.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// ─── Backend-derived file-size caps (cloud vs local Bot API server) ──
//
// These are the HARD ceilings Telegram itself enforces — a per-chat
// override can lower them but never exceed them (Telegram rejects beyond
// regardless). NOT "adaptive": there is no intermediate tier. Cloud is a
// flat 20 in / 50 out; a local `telegram-bot-api --local` server is a flat
// 2 GB both ways.
const CLOUD_MAX_IN_BYTES  = 20 * 1024 * 1024;          // getFile download limit
const CLOUD_MAX_OUT_BYTES = 50 * 1024 * 1024;          // sendDocument upload limit
const LOCAL_MAX_BYTES     = 2000 * 1024 * 1024;        // --local server, both ways

/**
 * Resolve the effective per-file caps for a chat/topic.
 *
 * @param {object} opts
 * @param {boolean} opts.localApi   — true when config.bot.apiRoot is set
 *   (a local Bot API server is in use → 2 GB ceiling).
 * @param {...number} opts.override  — per-chat/topic maxFileBytes (bytes).
 *   Resolved by the caller from topic → chat → undefined; clamped to the
 *   backend ceiling.
 * @returns {{ inBytes:number, outBytes:number, ceiling:number, localApi:boolean }}
 */
function resolveFileCaps({ localApi = false, override = null } = {}) {
  const ceiling = localApi ? LOCAL_MAX_BYTES : null;
  const defIn  = localApi ? LOCAL_MAX_BYTES : CLOUD_MAX_IN_BYTES;
  const defOut = localApi ? LOCAL_MAX_BYTES : CLOUD_MAX_OUT_BYTES;
  // A numeric override sets BOTH directions to the same value, clamped to
  // the backend hard ceiling (cloud uses the per-direction default as the
  // clamp so an override can't push past Telegram's own limit).
  const ovr = (typeof override === 'number' && override > 0) ? override : null;
  const inBytes  = ovr ? (localApi ? Math.min(ovr, ceiling) : Math.min(ovr, CLOUD_MAX_IN_BYTES))  : defIn;
  const outBytes = ovr ? (localApi ? Math.min(ovr, ceiling) : Math.min(ovr, CLOUD_MAX_OUT_BYTES)) : defOut;
  return { inBytes, outBytes, ceiling: ceiling ?? CLOUD_MAX_OUT_BYTES, localApi };
}
const MIME_ALLOW = [
  /^image\//, /^audio\//, /^video\//,
  /^application\/pdf$/, /^text\/plain$/,
  /^application\/msword$/, /^application\/vnd\.openxmlformats-/,
  /^application\/vnd\.ms-excel$/, /^application\/json$/,
  /^text\/csv$/,
  // rc.68: archives + markup formats Claude reads natively.
  /^application\/zip$/, /^application\/x-zip-compressed$/,
  /^text\/markdown$/,
  /^text\/html$/,
  /^text\/yaml$/, /^application\/yaml$/, /^application\/x-yaml$/,
  /^application\/xml$/, /^text\/xml$/,
];

// rc.68: extensions trusted when MIME is missing or generic
// (application/octet-stream). Same set the explicit MIME list covers, so
// the fallback is "trust the filename when MIME is unhelpful" — not "any
// extension goes." A file named foo.exe with empty MIME stays rejected.
const EXTENSION_ALLOW = new Set([
  // archives
  'zip',
  // text / structured data
  'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'xml', 'html',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx',
]);
// MIME values that mean "I have no idea what this is" — fall back to
// extension match for these.
const FALLBACK_MIMES = new Set(['', 'application/octet-stream']);

function extensionOf(name) {
  if (!name) return '';
  const dot = String(name).lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function filterAttachments(attachments, opts = {}) {
  const maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const mimeAllow = opts.mimeAllow ?? MIME_ALLOW;
  const extensionAllow = opts.extensionAllow ?? EXTENSION_ALLOW;

  const accepted = [];
  const rejected = [];
  let totalBytes = 0;

  for (const a of attachments || []) {
    const mime = a.mime_type || '';
    const mimeOk = mimeAllow.some((re) => re.test(mime));
    // rc.68: extension fallback only when MIME is unhelpful (empty or
    // octet-stream). An explicit MIME — even one we don't allow — wins
    // over the extension; that keeps malware.zip with mime
    // application/x-msdownload from sneaking through via the .zip suffix.
    const fallbackOk = !mimeOk
      && FALLBACK_MIMES.has(mime)
      && extensionAllow.has(extensionOf(a.name));
    if (!mimeOk && !fallbackOk) {
      rejected.push({ att: a, reason: `mime not allowed (${mime || 'unknown'})` });
      continue;
    }
    const reported = a.size || 0;
    // Telegram sometimes reports file_size=0 or omits it. Pre-0.6.14
    // those bypassed the cumulative cap entirely (totalBytes + 0 always
    // ≤ maxTotalBytes), so unsized attachments could blow through the
    // 20 MB total cap. Treat unknown sizes as worst-case (= per-file
    // cap) for budgeting; the per-file cap is still enforced live by
    // the streaming download in polygram.js.
    const sizeForBudget = reported > 0 ? reported : maxFileBytes;
    if (reported > maxFileBytes) {
      rejected.push({ att: a, reason: `exceeds per-file cap (${maxFileBytes} bytes, got ${reported})` });
      continue;
    }
    if (totalBytes + sizeForBudget > maxTotalBytes) {
      rejected.push({ att: a, reason: `exceeds total size cap (${maxTotalBytes} bytes)` });
      continue;
    }
    totalBytes += sizeForBudget;
    accepted.push(a);
  }
  return { accepted, rejected, totalBytes };
}

module.exports = {
  filterAttachments,
  resolveFileCaps,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  CLOUD_MAX_IN_BYTES,
  CLOUD_MAX_OUT_BYTES,
  LOCAL_MAX_BYTES,
  MIME_ALLOW,
  EXTENSION_ALLOW,
  FALLBACK_MIMES,
};
