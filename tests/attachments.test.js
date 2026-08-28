/**
 * Tests for lib/attachments.js
 * Run: node --test tests/attachments.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { filterAttachments } = require('../lib/attachments');

describe('filterAttachments', () => {
  test('empty / nullish input returns empty accepted/rejected', () => {
    assert.deepEqual(filterAttachments([]), { accepted: [], rejected: [], totalBytes: 0 });
    assert.deepEqual(filterAttachments(null), { accepted: [], rejected: [], totalBytes: 0 });
    assert.deepEqual(filterAttachments(undefined), { accepted: [], rejected: [], totalBytes: 0 });
  });

  test('accepts allowed MIME types', () => {
    const atts = [
      { name: 'p.jpg', mime_type: 'image/jpeg', size: 100 },
      { name: 'v.mp4', mime_type: 'video/mp4', size: 200 },
      { name: 'a.pdf', mime_type: 'application/pdf', size: 300 },
      { name: 'n.txt', mime_type: 'text/plain', size: 10 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 4);
    assert.equal(rejected.length, 0);
  });

  test('rejects disallowed MIME types', () => {
    const atts = [
      { name: 'x.bin', mime_type: 'application/x-msdownload', size: 100 },
      { name: 'y.exe', mime_type: '', size: 100 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 2);
    assert.match(rejected[0].reason, /mime not allowed/);
    assert.match(rejected[1].reason, /unknown/);
  });

  test('no count cap — only size caps gate acceptance', () => {
    // Removed the artificial MAX_COUNT=5 cap. With per-file (10 MB)
    // and total-size (20 MB) caps already in place, count was a
    // redundant guard that surprised users sending Telegram albums
    // (up to 10 photos per message).
    const atts = Array.from({ length: 12 }, (_, i) => ({
      name: `p${i}.jpg`, mime_type: 'image/jpeg', size: 10,
    }));
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 12);
    assert.equal(rejected.length, 0);
  });

  test('enforces total size cap across multiple files', () => {
    // Caps raised to Telegram cloud reality: 20MB per-file, 50MB total.
    // 3×18MB = 54MB > 50MB total → the third is rejected (first two = 36MB fit).
    const atts = [
      { name: 'a', mime_type: 'image/jpeg', size: 18 * 1024 * 1024 },
      { name: 'b', mime_type: 'image/jpeg', size: 18 * 1024 * 1024 },
      { name: 'c', mime_type: 'image/jpeg', size: 18 * 1024 * 1024 },
    ];
    const { accepted, rejected, totalBytes } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /total size cap/);
    assert.equal(totalBytes, 36 * 1024 * 1024);
  });

  test('rejects single file that exceeds per-file cap (20MB cloud limit)', () => {
    const atts = [
      { name: 'huge.mp4', mime_type: 'video/mp4', size: 50 * 1024 * 1024 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 0);
    assert.match(rejected[0].reason, /per-file cap/);
  });

  test('per-file cap is configurable via opts', () => {
    const atts = [
      { name: 'ok', mime_type: 'image/jpeg', size: 500 },
      { name: 'big', mime_type: 'image/jpeg', size: 2000 },
    ];
    const { accepted, rejected } = filterAttachments(atts, { maxFileBytes: 1000 });
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].name, 'ok');
    assert.match(rejected[0].reason, /per-file cap/);
  });

  test('file with missing/zero size is not rejected by per-file cap (live cap applies at download)', () => {
    // Unknown sizes pass the per-file gate (since reported is what's
    // checked there). The cumulative cap budgets them at worst-case
    // (= per-file cap) — so 2 unknowns under the default 20MB total
    // still fit. The streaming download enforces the per-file cap live.
    const atts = [
      { name: 'unsized.jpg', mime_type: 'image/jpeg' }, // no size field
      { name: 'zero.jpg', mime_type: 'image/jpeg', size: 0 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 0);
  });

  test('customizable total-size cap via opts', () => {
    const atts = [
      { name: 'a', mime_type: 'image/jpeg', size: 100 },
      { name: 'b', mime_type: 'image/jpeg', size: 100 },
    ];
    const { accepted, rejected } = filterAttachments(atts, { maxTotalBytes: 150 });
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /total size cap/);
  });

  test('single blob near but under per-file cap fits', () => {
    const atts = [{ name: 'v.mp4', mime_type: 'video/mp4', size: 9 * 1024 * 1024 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('openxml document (docx/xlsx) is allowed', () => {
    const atts = [
      { name: 'a.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10 },
      { name: 'b.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 10 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 0);
  });

  test('order: rejection reasons track which limit was hit', () => {
    const atts = [
      { name: 'ok', mime_type: 'image/jpeg', size: 100 },
      { name: 'huge', mime_type: 'image/jpeg', size: 30 * 1024 * 1024 },
      { name: 'bad', mime_type: 'application/x-weird', size: 100 },
    ];
    const { rejected } = filterAttachments(atts);
    assert.match(rejected[0].reason, /per-file cap/);
    assert.match(rejected[1].reason, /mime not allowed/);
  });

  test('unknown sizes count toward the cumulative budget at worst-case (per-file cap)', () => {
    // 0.6.14: Telegram occasionally reports file_size=0 / omits size.
    // Pre-fix, sizeForBudget was the reported value, so N unsized
    // attachments contributed 0 to totalBytes and could blow the cap
    // entirely once downloaded. Now sizeForBudget = maxFileBytes for
    // unknowns, so the cap holds even in the worst case.
    const atts = Array.from({ length: 5 }, (_, i) => ({
      name: `u${i}.jpg`, mime_type: 'image/jpeg',
    }));
    const { accepted, rejected } = filterAttachments(atts);
    // Default caps: maxFileBytes=10MB, maxTotalBytes=20MB →
    // 2 unknowns fit (2×10MB=20MB), 3rd onward rejected by total cap.
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 3);
    for (const r of rejected) assert.match(r.reason, /total size cap/);
  });
});

// rc.68: widen MIME allowlist to cover archives, the markup formats Claude
// already reads natively, and a filename-extension fallback for the
// octet-stream / missing-MIME case (Telegram ships unknown-extension
// documents with no usable MIME). Per-file (10MB) and total (20MB) caps
// remain the real safety net; the MIME list always was a "what's worth
// running through the agent" filter, not a security control.
//
// Trigger: Ivan tried to share a WhatsApp chat export (.zip) for analysis
// and got "mime not allowed (application/zip)" rejected.
describe('filterAttachments — rc.68 widened MIME allowlist', () => {
  test('zip is accepted (application/zip)', () => {
    const atts = [{ name: 'chat-export.zip', mime_type: 'application/zip', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('zip is accepted under the alt MIME some Telegram clients send', () => {
    const atts = [{ name: 'chat-export.zip', mime_type: 'application/x-zip-compressed', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('tar.gz is accepted under octet-stream (Telegram compound-extension archives)', () => {
    // Trigger: Ivan tried to share wa-fix-2026-08-28.tar.gz and got
    // "mime not allowed (application/octet-stream)" rejected — Telegram
    // reports .tar.gz/.tgz as generic octet-stream (no compound-extension
    // sniffing), and extensionOf() only sees the last dot segment ('gz'),
    // so the zip-only extension fallback didn't cover it.
    const atts = [{ name: 'wa-fix-2026-08-28.tar.gz', mime_type: 'application/octet-stream', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('tgz and tar accepted under octet-stream', () => {
    const atts = [
      { name: 'archive.tgz', mime_type: 'application/octet-stream', size: 100 },
      { name: 'archive.tar', mime_type: 'application/octet-stream', size: 100 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 0);
  });

  test('gzip accepted under explicit MIME (application/gzip and application/x-gzip)', () => {
    const atts = [
      { name: 'a.gz', mime_type: 'application/gzip', size: 100 },
      { name: 'b.gz', mime_type: 'application/x-gzip', size: 100 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 0);
  });

  test('markdown accepted (was silently slipping through as text/plain)', () => {
    const atts = [{ name: 'notes.md', mime_type: 'text/markdown', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('html accepted', () => {
    const atts = [{ name: 'page.html', mime_type: 'text/html', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
  });

  test('yaml accepted (text/yaml AND application/yaml)', () => {
    const atts = [
      { name: 'a.yml', mime_type: 'text/yaml', size: 100 },
      { name: 'b.yaml', mime_type: 'application/yaml', size: 100 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 0);
  });

  test('xml accepted (application/xml AND text/xml)', () => {
    const atts = [
      { name: 'a.xml', mime_type: 'application/xml', size: 100 },
      { name: 'b.xml', mime_type: 'text/xml', size: 100 },
    ];
    const { accepted } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
  });

  test('extension fallback: octet-stream + .zip is accepted', () => {
    // Telegram's MIME detection often degrades to octet-stream for
    // documents the client doesn't sniff. Trust the extension when it's
    // on the well-known list — same set the explicit MIMEs cover.
    const atts = [{ name: 'chat-export.zip', mime_type: 'application/octet-stream', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('extension fallback: empty MIME + .csv is accepted', () => {
    const atts = [{ name: 'data.csv', mime_type: '', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('extension fallback: missing MIME + .md is accepted', () => {
    const atts = [{ name: 'README.md', size: 100 }]; // no mime_type field
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('extension fallback: octet-stream + UNKNOWN extension still rejected', () => {
    // Generic octet-stream without a recognised extension stays blocked
    // — the fallback is "trust extension when MIME is missing", not
    // "octet-stream is universally allowed".
    const atts = [{ name: 'mystery.bin', mime_type: 'application/octet-stream', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /mime not allowed/);
  });

  test('extension fallback: empty MIME + no extension still rejected', () => {
    const atts = [{ name: 'noextension', mime_type: '', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 1);
  });

  test('extension fallback: explicit .exe MIME stays rejected (no extension override)', () => {
    // Defense-in-depth: if a malicious client sets mime_type to
    // application/x-msdownload (executable) AND names the file .zip,
    // the explicit-MIME path should reject — extension fallback only
    // kicks in when MIME is unhelpful (empty / octet-stream).
    const atts = [{ name: 'malware.zip', mime_type: 'application/x-msdownload', size: 100 }];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /mime not allowed/);
  });

  test('iWork stays blocked (no agent path to read .pages/.numbers/.keynote)', () => {
    const atts = [
      { name: 'doc.pages', mime_type: 'application/vnd.apple.pages', size: 100 },
      { name: 'data.numbers', mime_type: 'application/vnd.apple.numbers', size: 100 },
      { name: 'deck.keynote', mime_type: 'application/vnd.apple.keynote', size: 100 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 3);
  });

  test('rtf and legacy .ppt stay blocked (Claude cannot read directly)', () => {
    const atts = [
      { name: 'doc.rtf', mime_type: 'application/rtf', size: 100 },
      { name: 'deck.ppt', mime_type: 'application/vnd.ms-powerpoint', size: 100 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 2);
  });

  test('size caps still apply to newly-allowed types', () => {
    const atts = [
      { name: 'huge.zip', mime_type: 'application/zip', size: 50 * 1024 * 1024 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 0);
    assert.match(rejected[0].reason, /per-file cap/);
  });

  test('extension match is case-insensitive', () => {
    // Some clients uppercase the extension (.ZIP, .CSV). The fallback
    // shouldn't care about case.
    const atts = [
      { name: 'EXPORT.ZIP', mime_type: 'application/octet-stream', size: 100 },
      { name: 'DATA.CSV', mime_type: '', size: 100 },
    ];
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 0);
  });
});
