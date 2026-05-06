/**
 * Inbox on-disk helpers.
 *
 * `sweepInbox(dir, maxAgeMs)` deletes files under each chat subdir whose
 * mtime is older than `maxAgeMs`. Called on polygram boot so a long-running
 * polygram doesn't accumulate every file a user has ever sent.
 */

const fs = require('fs');
const path = require('path');

function sweepInbox(dir, maxAgeMs) {
  if (!fs.existsSync(dir)) return { swept: 0, bytes: 0 };
  const cutoff = Date.now() - maxAgeMs;
  let swept = 0;
  let bytes = 0;
  for (const chatDir of fs.readdirSync(dir)) {
    const full = path.join(dir, chatDir);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      const p = path.join(full, f);
      let s;
      try { s = fs.statSync(p); } catch { continue; }
      if (s.isFile() && s.mtimeMs < cutoff) {
        try { fs.unlinkSync(p); swept++; bytes += s.size; } catch {}
      }
    }
  }
  return { swept, bytes };
}

module.exports = { sweepInbox };
