'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LogTail } = require('../lib/tmux/log-tail');

function tmpfile() {
  return path.join(os.tmpdir(), `tail-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
}

// fs.watch tests need an isolated directory — macOS kqueue hits EMFILE
// when many watchers attach to the same shared tmpdir.
function tmpdirIsolated() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tail-iso-'));
}

async function settle(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('LogTail', () => {

  test('requires path', () => {
    assert.throws(() => new LogTail({}), /path required/);
  });

  test('useWatch:true uses fs.watch (not polling) and picks up appends near-instantly', async () => {
    const dir = tmpdirIsolated();
    const p = path.join(dir, 'session.log');
    fs.writeFileSync(p, '');
    // intervalMs deliberately huge so any line we receive within ~120ms
    // must have come via fs.watch, not the safety-net poll (1s).
    const tail = new LogTail({
      path: p, intervalMs: 60_000, useWatch: true,
      // Suppress the runtime-fallback log when EMFILE on macOS test env.
      logger: { log: () => {}, warn: () => {} },
    });
    const lines = [];
    tail.on('line', (l) => lines.push(l));
    tail.start();
    assert.equal(tail._mode, 'watch', 'should be in watch mode');
    await settle(20);
    // Skip the timing assertion if the system kqueue ran out of slots
    // (EMFILE on macOS when many tests run in parallel) — the runtime
    // error path already kicks us to polling and that's covered by the
    // 'falls back to polling' test below. Production with 10 chats is
    // well below the kqueue limit.
    if (tail._mode !== 'watch') {
      tail.close();
      fs.rmSync(dir, { recursive: true, force: true });
      return; // env-limited; not a code defect
    }
    fs.appendFileSync(p, 'watch-fast\n');
    await settle(150);   // far less than intervalMs OR safety-net — only fs.watch delivers
    tail.close();
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(lines, ['watch-fast']);
  });

  test('useWatch:false forces polling', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    tail.start();
    assert.equal(tail._mode, 'poll', 'should be in poll mode');
    const lines = [];
    tail.on('line', (l) => lines.push(l));
    fs.appendFileSync(p, 'polled\n');
    await settle(30);
    tail.close();
    fs.unlinkSync(p);
    assert.deepEqual(lines, ['polled']);
  });

  // Helper: build a façade over `fs` whose `watch` throws. `fs.promises`
  // is a getter on the real `fs` module so we can't Object.assign over
  // it — instead define exactly the props LogTail uses.
  function brokenWatchFs() {
    return {
      watch: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
      mkdirSync: fs.mkdirSync,
      statSync: fs.statSync,
      promises: fs.promises,
    };
  }

  test('useWatch:auto falls back to polling when fs.watch throws (sandbox simulation)', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    let fellBack = false;
    const tail = new LogTail({
      path: p, intervalMs: 5, useWatch: 'auto', fs: brokenWatchFs(),
      logger: { log: (m) => { if (/falling back/.test(m)) fellBack = true; }, warn: () => {} },
    });
    tail.start();
    assert.equal(tail._mode, 'poll', 'should fall back to polling');
    assert.equal(fellBack, true, 'should log the fallback');
    tail.close();
    fs.unlinkSync(p);
  });

  test('useWatch:true throws when fs.watch unavailable (no silent fallback)', () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    const tail = new LogTail({
      path: p, useWatch: true, fs: brokenWatchFs(),
      logger: { log: () => {}, warn: () => {} },
    });
    assert.throws(() => tail.start(), /useWatch:true requested but fs.watch failed/);
    fs.unlinkSync(p);
  });

  test('SECURITY: drops a line that grows past 16MB without a newline + emits line-too-long', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    const lines = [];
    let oversize = null;
    tail.on('line', (l) => lines.push(l));
    tail.on('line-too-long', (ev) => { oversize = ev; });
    tail.start();
    await settle(20);
    // Append > 16MB of non-newline content. Use repeated chunks
    // for speed; ensure no \n until the end.
    const chunk = 'A'.repeat(1024 * 1024);   // 1 MB
    for (let i = 0; i < 18; i++) {           // 18 MB total
      fs.appendFileSync(p, chunk);
    }
    fs.appendFileSync(p, '\nrecovered\n');
    await settle(150);
    tail.close();
    fs.unlinkSync(p);
    assert.ok(oversize, 'line-too-long must fire when buf exceeds cap');
    assert.ok(oversize.bytes >= 16 * 1024 * 1024);
    // After the drop, normal tailing should resume — the "recovered"
    // line that came after a newline lands.
    assert.ok(lines.some((l) => l.includes('recovered')),
      `expected to recover after overflow; got ${JSON.stringify(lines)}`);
  });

  test('skipExisting:true ignores pre-existing content, emits only new lines', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, 'old1\nold2\nold3\n');
    const tail = new LogTail({ path: p, intervalMs: 5, skipExisting: true, useWatch: false });
    const lines = [];
    tail.on('line', (l) => lines.push(l));
    tail.start();
    await settle(30);
    fs.appendFileSync(p, 'new1\nnew2\n');
    await settle(30);
    tail.close();
    fs.unlinkSync(p);
    assert.deepEqual(lines, ['new1', 'new2'], 'should only see lines added after start()');
  });

  test('emits lines that already exist when start() runs', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, 'line1\nline2\nline3\n');
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    const lines = [];
    tail.on('line', (l) => lines.push(l));
    tail.start();
    await settle(30);
    tail.close();
    fs.unlinkSync(p);
    assert.deepEqual(lines, ['line1', 'line2', 'line3']);
  });

  test('emits lines appended after start()', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    const lines = [];
    tail.on('line', (l) => lines.push(l));
    tail.start();
    await settle(20);
    fs.appendFileSync(p, 'first\nsecond\n');
    await settle(30);
    fs.appendFileSync(p, 'third\n');
    await settle(30);
    tail.close();
    fs.unlinkSync(p);
    assert.deepEqual(lines, ['first', 'second', 'third']);
  });

  test('handles partial lines split across reads', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    const lines = [];
    tail.on('line', (l) => lines.push(l));
    tail.start();
    await settle(20);
    fs.appendFileSync(p, 'hello ');
    await settle(20);
    fs.appendFileSync(p, 'world\n');
    await settle(30);
    tail.close();
    fs.unlinkSync(p);
    assert.deepEqual(lines, ['hello world']);
  });

  test('tolerates ENOENT until file is created', async () => {
    const p = tmpfile();
    // do NOT create yet
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    const lines = [];
    let err = null;
    tail.on('line', (l) => lines.push(l));
    tail.on('error', (e) => { err = e; });
    tail.start();
    await settle(20);
    fs.writeFileSync(p, 'late-arrival\n');
    await settle(30);
    tail.close();
    fs.unlinkSync(p);
    assert.equal(err, null, `expected no error, got: ${err?.message}`);
    assert.deepEqual(lines, ['late-arrival']);
  });

  test('detects truncation and resets offset', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, 'aaaa\nbbbb\ncccc\ndddd\n'); // 20 bytes
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    const lines = [];
    const truncs = [];
    tail.on('line', (l) => lines.push(l));
    tail.on('truncated', (ev) => truncs.push(ev));
    tail.start();
    await settle(30);
    fs.writeFileSync(p, 'r\n'); // 2 bytes — clearly smaller
    await settle(40);
    tail.close();
    fs.unlinkSync(p);
    assert.deepEqual(lines, ['aaaa', 'bbbb', 'cccc', 'dddd', 'r']);
    assert.equal(truncs.length, 1);
  });

  test('close() is idempotent and flushes trailing partial line', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    const lines = [];
    tail.on('line', (l) => lines.push(l));
    tail.start();
    await settle(20);
    fs.appendFileSync(p, 'no-newline-at-end'); // no trailing \n
    await settle(30);
    tail.close();
    tail.close(); // second call no-op
    fs.unlinkSync(p);
    assert.ok(lines.includes('no-newline-at-end'), `expected flush on close, got ${JSON.stringify(lines)}`);
  });

  test('emits close event exactly once', async () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    const tail = new LogTail({ path: p, intervalMs: 5, useWatch: false });
    let closes = 0;
    tail.on('close', () => closes++);
    tail.start();
    tail.close();
    tail.close();
    await settle(20);
    fs.unlinkSync(p);
    assert.equal(closes, 1);
  });

  test('start() after close() throws (no zombie tailing)', () => {
    const p = tmpfile();
    fs.writeFileSync(p, '');
    const tail = new LogTail({ path: p });
    tail.close();
    assert.throws(() => tail.start(), /closed/);
    fs.unlinkSync(p);
  });
});
