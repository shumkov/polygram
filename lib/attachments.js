/**
 * Attachment filter — caps count + total size + MIME allowlist.
 * Rejected items return a human-readable reason that we surface to the
 * user and log to the events table.
 */

const MAX_COUNT = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MIME_ALLOW = [
  /^image\//, /^audio\//, /^video\//,
  /^application\/pdf$/, /^text\/plain$/,
  /^application\/msword$/, /^application\/vnd\.openxmlformats-/,
  /^application\/vnd\.ms-excel$/, /^application\/json$/,
  /^text\/csv$/,
];

function filterAttachments(attachments, opts = {}) {
  const maxCount = opts.maxCount ?? MAX_COUNT;
  const maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const mimeAllow = opts.mimeAllow ?? MIME_ALLOW;

  const accepted = [];
  const rejected = [];
  let totalBytes = 0;

  for (const a of attachments || []) {
    if (accepted.length >= maxCount) {
      rejected.push({ att: a, reason: `exceeds max count (${maxCount})` });
      continue;
    }
    const mime = a.mime_type || '';
    if (!mimeAllow.some((re) => re.test(mime))) {
      rejected.push({ att: a, reason: `mime not allowed (${mime || 'unknown'})` });
      continue;
    }
    const reported = a.size || 0;
    // Telegram sometimes reports file_size=0 or omits it. Pre-0.6.14
    // those bypassed the cumulative cap entirely (totalBytes + 0 always
    // ≤ maxTotalBytes), so 5 size-0 attachments could blow through the
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

module.exports = { filterAttachments, MAX_COUNT, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MIME_ALLOW };
