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

  test('enforces max count', () => {
    const atts = Array.from({ length: 7 }, (_, i) => ({
      name: `p${i}.jpg`, mime_type: 'image/jpeg', size: 10,
    }));
    const { accepted, rejected } = filterAttachments(atts);
    assert.equal(accepted.length, 5);
    assert.equal(rejected.length, 2);
    assert.match(rejected[0].reason, /max count/);
  });

  test('enforces total size cap across multiple files', () => {
    const atts = [
      { name: 'a', mime_type: 'image/jpeg', size: 9 * 1024 * 1024 },
      { name: 'b', mime_type: 'image/jpeg', size: 9 * 1024 * 1024 },
      { name: 'c', mime_type: 'image/jpeg', size: 9 * 1024 * 1024 },
    ];
    const { accepted, rejected, totalBytes } = filterAttachments(atts);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /total size cap/);
    assert.equal(totalBytes, 18 * 1024 * 1024);
  });

  test('rejects single file that exceeds per-file cap', () => {
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

  test('customizable limits via opts', () => {
    const atts = [
      { name: 'a', mime_type: 'image/jpeg', size: 10 },
      { name: 'b', mime_type: 'image/jpeg', size: 10 },
    ];
    const { accepted, rejected } = filterAttachments(atts, { maxCount: 1 });
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
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
