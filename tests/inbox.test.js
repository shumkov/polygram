/**
 * Tests for lib/inbox.js
 * Run: node --test tests/inbox.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { sweepInbox } = require('../lib/inbox');

let root;

function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-'));
  return root;
}

function teardown() {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

function touch(p, ageMs = 0) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  if (ageMs > 0) {
    const when = Date.now() - ageMs;
    fs.utimesSync(p, when / 1000, when / 1000);
  }
}

describe('sweepInbox', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('returns 0/0 when dir does not exist', () => {
    const r = sweepInbox(path.join(root, 'nope'), 86_400_000);
    assert.deepEqual(r, { swept: 0, bytes: 0 });
  });

  test('deletes only files older than cutoff', () => {
    touch(path.join(root, '-100', 'old.bin'), 10 * 86_400_000);
    touch(path.join(root, '-100', 'new.bin'), 1 * 86_400_000);
    const r = sweepInbox(root, 5 * 86_400_000);
    assert.equal(r.swept, 1);
    assert.equal(fs.existsSync(path.join(root, '-100', 'old.bin')), false);
    assert.equal(fs.existsSync(path.join(root, '-100', 'new.bin')), true);
  });

  test('sums bytes of deleted files', () => {
    const p = path.join(root, '-100', 'big.bin');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(1024, 0));
    const when = Date.now() - 10 * 86_400_000;
    fs.utimesSync(p, when / 1000, when / 1000);
    const r = sweepInbox(root, 5 * 86_400_000);
    assert.equal(r.swept, 1);
    assert.equal(r.bytes, 1024);
  });

  test('walks every chat subdir independently', () => {
    touch(path.join(root, '-100', 'a.bin'), 10 * 86_400_000);
    touch(path.join(root, '-200', 'b.bin'), 10 * 86_400_000);
    touch(path.join(root, '-300', 'c.bin'), 1 * 86_400_000);
    const r = sweepInbox(root, 5 * 86_400_000);
    assert.equal(r.swept, 2);
  });

  test('ignores non-directory entries at inbox root', () => {
    touch(path.join(root, 'stray.txt'), 10 * 86_400_000);
    touch(path.join(root, '-100', 'old.bin'), 10 * 86_400_000);
    const r = sweepInbox(root, 5 * 86_400_000);
    // stray.txt is skipped because it's not a directory
    assert.equal(r.swept, 1);
    assert.equal(fs.existsSync(path.join(root, 'stray.txt')), true);
  });

  test('empty chat dirs are fine (not removed, just no-op)', () => {
    fs.mkdirSync(path.join(root, '-100'), { recursive: true });
    const r = sweepInbox(root, 86_400_000);
    assert.equal(r.swept, 0);
    assert.equal(fs.existsSync(path.join(root, '-100')), true);
  });

  test('maxAgeMs=0 deletes everything', () => {
    touch(path.join(root, '-100', 'a.bin'), 1000);
    touch(path.join(root, '-100', 'b.bin'), 1000);
    const r = sweepInbox(root, 0);
    assert.equal(r.swept, 2);
  });
});
