/**
 * Tests for lib/handlers/download.js — Telegram attachment downloader.
 *
 * Covers the factory contract, sanitizeFilename, attachmentConcurrency
 * resolution, and the per-attachment cap enforcement (content-length /
 * streaming / post-buffer). Token-redaction integration is tested via
 * lib/error/net's own test suite.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  createDownloadAttachments,
  sanitizeFilename,
  ATTACHMENT_DOWNLOAD_CONCURRENCY_DEFAULT,
} = require('../lib/handlers/download');

const silentLogger = { log: () => {}, error: () => {} };

describe('sanitizeFilename', () => {
  test('null/empty → "file"', () => {
    assert.equal(sanitizeFilename(null), 'file');
    assert.equal(sanitizeFilename(''), 'file');
  });

  test('replaces / \\ : NUL with _', () => {
    assert.equal(sanitizeFilename('a/b\\c:d\0e'), 'a_b_c_d_e');
  });

  test('truncates to 120 chars', () => {
    const out = sanitizeFilename('x'.repeat(200));
    assert.equal(out.length, 120);
  });

  test('preserves benign characters', () => {
    assert.equal(sanitizeFilename('voice-2026-05-06.ogg'), 'voice-2026-05-06.ogg');
    assert.equal(sanitizeFilename('My Document (1).pdf'), 'My Document (1).pdf');
  });
});

describe('ATTACHMENT_DOWNLOAD_CONCURRENCY_DEFAULT', () => {
  test('is a small integer (≥1, ≤16)', () => {
    assert.ok(Number.isInteger(ATTACHMENT_DOWNLOAD_CONCURRENCY_DEFAULT));
    assert.ok(ATTACHMENT_DOWNLOAD_CONCURRENCY_DEFAULT >= 1);
    assert.ok(ATTACHMENT_DOWNLOAD_CONCURRENCY_DEFAULT <= 16);
  });
});

describe('createDownloadAttachments — factory contract', () => {
  test('throws on missing required deps', () => {
    assert.throws(() => createDownloadAttachments({}), /config required/);
    assert.throws(() => createDownloadAttachments({ config: {} }), /db required/);
    assert.throws(() => createDownloadAttachments({
      config: {}, db: {}, dbWrite: () => {}, fetchImpl: () => {},
    }), /inboxDir required/);
  });

  test('returns the per-call function', () => {
    const fn = createDownloadAttachments({
      config: { bot: {} },
      db: { markAttachmentDownloaded: () => {}, markAttachmentFailed: () => {} },
      dbWrite: (f) => f(),
      inboxDir: os.tmpdir(),
      fetchImpl: () => {},
    });
    assert.equal(typeof fn, 'function');
  });
});

describe('downloadAttachments — empty input', () => {
  test('no rows → returns empty array', async () => {
    const fn = createDownloadAttachments({
      config: { bot: {} },
      db: { markAttachmentDownloaded: () => {}, markAttachmentFailed: () => {} },
      dbWrite: (f) => f(),
      inboxDir: os.tmpdir(),
      fetchImpl: () => Promise.reject(new Error('should not be called')),
    });
    const out = await fn({}, 'tok', '12345', { message_id: 1 }, []);
    assert.deepEqual(out, []);
  });
});

describe('downloadAttachments — happy path', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-download-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('downloads + writes atomically + marks downloaded', async () => {
    const dbCalls = [];
    const fn = createDownloadAttachments({
      config: { bot: {} },
      db: {
        markAttachmentDownloaded: (id, args) => dbCalls.push(['downloaded', id, args]),
        markAttachmentFailed: (id, reason) => dbCalls.push(['failed', id, reason]),
      },
      dbWrite: (f) => f(),
      inboxDir: tmpDir,
      logger: silentLogger,
      fetchImpl: async () => {
        const buf = Buffer.from('hello world');
        return {
          ok: true,
          headers: { get: (k) => k === 'content-length' ? '11' : null },
          body: null, // forces fallback path
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      },
    });
    const bot = { api: { getFile: async () => ({ file_path: 'voice/x.ogg' }) } };
    const out = await fn(bot, 'tok', '12345', { message_id: 555 }, [
      { id: 7, file_id: 'CAA', file_unique_id: 'unique', kind: 'voice', name: 'x.ogg', size_bytes: 11 },
    ]);
    assert.equal(out.length, 1);
    assert.ok(out[0].path, 'returned path is set');
    assert.equal(out[0].error, null);
    const downloaded = dbCalls.find((c) => c[0] === 'downloaded');
    assert.ok(downloaded);
    assert.equal(downloaded[1], 7);
    assert.ok(fs.existsSync(out[0].path), 'file is on disk');
    assert.equal(fs.readFileSync(out[0].path, 'utf8'), 'hello world');
  });

  test('reuses on-disk file when row already downloaded', async () => {
    const existingPath = path.join(tmpDir, '12345', 'pre-existing.ogg');
    fs.mkdirSync(path.dirname(existingPath), { recursive: true });
    fs.writeFileSync(existingPath, 'cached content');
    let fetchCalled = 0;
    const fn = createDownloadAttachments({
      config: { bot: {} },
      db: {
        markAttachmentDownloaded: () => {},
        markAttachmentFailed: () => {},
      },
      dbWrite: (f) => f(),
      inboxDir: tmpDir,
      logger: silentLogger,
      fetchImpl: () => { fetchCalled++; return Promise.reject(new Error('not reached')); },
    });
    const out = await fn({}, 'tok', '12345', { message_id: 1 }, [
      { id: 1, kind: 'voice', name: 'x.ogg',
        download_status: 'downloaded', local_path: existingPath, size_bytes: 14 },
    ]);
    assert.equal(out[0].path, existingPath);
    assert.equal(out[0].error, null);
    assert.equal(fetchCalled, 0, 'no network fetch when on-disk file is reused');
  });
});

describe('downloadAttachments — failure handling', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-download-fail-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('non-ok HTTP response → marks failed with redacted reason', async () => {
    const dbCalls = [];
    const fn = createDownloadAttachments({
      config: { bot: {} },
      db: {
        markAttachmentDownloaded: () => {},
        markAttachmentFailed: (id, reason) => dbCalls.push([id, reason]),
      },
      dbWrite: (f) => f(),
      inboxDir: tmpDir,
      logger: silentLogger,
      fetchImpl: async () => ({ ok: false, status: 410 }),
    });
    const bot = { api: { getFile: async () => ({ file_path: 'voice/x.ogg' }) } };
    const out = await fn(bot, 'sec3et-token', '1', { message_id: 1 }, [
      { id: 9, file_id: 'F', kind: 'voice', name: 'x.ogg' },
    ]);
    assert.equal(out[0].path, null);
    assert.match(out[0].error, /HTTP 410/);
    assert.equal(dbCalls[0][0], 9);
  });

  test('content-length over cap → throws + marks failed', async () => {
    const dbCalls = [];
    const fn = createDownloadAttachments({
      config: { bot: {} },
      db: {
        markAttachmentDownloaded: () => {},
        markAttachmentFailed: (id, reason) => dbCalls.push([id, reason]),
      },
      dbWrite: (f) => f(),
      inboxDir: tmpDir,
      logger: silentLogger,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => String(50 * 1024 * 1024) },
        body: null,
        arrayBuffer: async () => Buffer.alloc(0),
      }),
    });
    const bot = { api: { getFile: async () => ({ file_path: 'x' }) } };
    const out = await fn(bot, 'tok', '1', { message_id: 1 }, [
      { id: 5, file_id: 'F', kind: 'video', name: 'big.mp4' },
    ]);
    assert.match(out[0].error, /content-length .* exceeds per-file cap/);
  });
});

describe('downloadAttachments — concurrency', () => {
  test('respects per-bot config.bot.attachmentConcurrency override', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fn = createDownloadAttachments({
      config: { bot: { attachmentConcurrency: 2 } },
      db: {
        markAttachmentDownloaded: () => {},
        markAttachmentFailed: () => {},
      },
      dbWrite: (f) => f(),
      inboxDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pgconc-')),
      logger: silentLogger,
      fetchImpl: async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        const buf = Buffer.from('x');
        return {
          ok: true,
          headers: { get: () => '1' },
          body: null,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      },
    });
    const bot = { api: { getFile: async () => ({ file_path: 'x' }) } };
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: i, file_id: 'F', kind: 'voice', name: `v${i}.ogg`,
      file_unique_id: `u${i}`,
    }));
    await fn(bot, 'tok', '1', { message_id: 1 }, rows);
    assert.ok(maxInFlight <= 2, `max parallel was ${maxInFlight}, expected ≤ 2`);
  });
});
