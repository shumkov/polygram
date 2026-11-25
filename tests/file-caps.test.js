'use strict';

// Tests for resolveFileCaps — backend-derived file-size caps with
// per-chat/topic override, clamped to Telegram's hard ceilings.
// (2026-06 file-send: caps must follow apiRoot, NOT be a fixed 20/50.)

const { test } = require('node:test');
const assert = require('node:assert');
const {
  resolveFileCaps,
  CLOUD_MAX_IN_BYTES, CLOUD_MAX_OUT_BYTES, LOCAL_MAX_BYTES,
} = require('../lib/attachments');

const MB = 1024 * 1024;

test('cloud default: 20MB in / 50MB out', () => {
  const c = resolveFileCaps({ localApi: false });
  assert.equal(c.inBytes, CLOUD_MAX_IN_BYTES);
  assert.equal(c.outBytes, CLOUD_MAX_OUT_BYTES);
  assert.equal(c.inBytes, 20 * MB);
  assert.equal(c.outBytes, 50 * MB);
  assert.equal(c.localApi, false);
});

test('local server default: 2GB both ways (not an intermediate tier)', () => {
  const c = resolveFileCaps({ localApi: true });
  assert.equal(c.inBytes, LOCAL_MAX_BYTES);
  assert.equal(c.outBytes, LOCAL_MAX_BYTES);
  assert.equal(c.inBytes, 2000 * MB);
});

test('per-chat override lowers caps on cloud', () => {
  const c = resolveFileCaps({ localApi: false, override: 5 * MB });
  assert.equal(c.inBytes, 5 * MB);
  assert.equal(c.outBytes, 5 * MB);
});

test('override CANNOT exceed the cloud hard ceiling (Telegram rejects beyond)', () => {
  // Someone sets maxFileBytes: 500MB on cloud — clamp to Telegram's real
  // limits (20 in / 50 out), don't pretend it works.
  const c = resolveFileCaps({ localApi: false, override: 500 * MB });
  assert.equal(c.inBytes, CLOUD_MAX_IN_BYTES, 'inbound clamped to 20MB on cloud');
  assert.equal(c.outBytes, CLOUD_MAX_OUT_BYTES, 'outbound clamped to 50MB on cloud');
});

test('override raises caps under the local server, clamped to 2GB', () => {
  const c100 = resolveFileCaps({ localApi: true, override: 100 * MB });
  assert.equal(c100.inBytes, 100 * MB, 'local server honors a 100MB override');
  assert.equal(c100.outBytes, 100 * MB);

  const cHuge = resolveFileCaps({ localApi: true, override: 5000 * MB });
  assert.equal(cHuge.inBytes, LOCAL_MAX_BYTES, 'clamped to the 2GB local ceiling');
});

test('non-numeric / zero / negative override falls back to the backend default', () => {
  for (const bad of [null, undefined, 0, -1, 'big', NaN]) {
    const c = resolveFileCaps({ localApi: false, override: bad });
    assert.equal(c.inBytes, CLOUD_MAX_IN_BYTES, `override=${bad} → default`);
  }
});

test('no args → cloud defaults (safe default)', () => {
  const c = resolveFileCaps();
  assert.equal(c.inBytes, CLOUD_MAX_IN_BYTES);
  assert.equal(c.localApi, false);
});

// ─── dispatcher enforces the outbound cap before upload ──────────────
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChannelsToolDispatcher } = require('../lib/process/channels-tool-dispatcher');

function makeDispatcher(sent) {
  return createChannelsToolDispatcher({
    bot: {},
    send: async (_b, method, params) => { sent.push({ method, params }); return { ok: true }; },
    chunkText: (t) => [t],
    deliverReplies: async () => ({ sent: [{ message_id: 1 }], failed: [], results: [] }),
    parseResponse: (t) => ({ text: t, sticker: null, stickers: [], reaction: null, reactions: [] }),
    sanitizeAssistantReply: (t) => ({ text: t, replaced: false }),
    logger: { warn() {}, error() {}, log() {}, debug() {} },
  });
}

test('dispatcher rejects a file over maxOutboundFileBytes BEFORE upload (clear error)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const big = path.join(dir, 'big.flac');
  fs.writeFileSync(big, Buffer.alloc(3 * MB)); // 3MB file, 1MB cap
  const sent = [];
  try {
    const res = await makeDispatcher(sent)({
      sessionKey: 's', chatId: '1', threadId: null, sessionCwd: dir,
      toolName: 'reply', text: 'here', files: [big],
      maxOutboundFileBytes: 1 * MB,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /too large/i);
    assert.equal(sent.filter(c => c.method === 'sendDocument').length, 0, 'no upload attempted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatcher sends a file UNDER the cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ok-'));
  const ok = path.join(dir, 'ok.flac');
  fs.writeFileSync(ok, Buffer.alloc(1 * MB));
  const sent = [];
  try {
    const res = await makeDispatcher(sent)({
      sessionKey: 's', chatId: '1', threadId: null, sessionCwd: dir,
      toolName: 'reply', text: 'here', files: [ok],
      maxOutboundFileBytes: 50 * MB,
    });
    assert.equal(res.ok, true);
    assert.equal(sent.filter(c => c.method === 'sendDocument').length, 1, 'upload attempted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('photographer album: 7 originals of ~19MB under a 100MB local-API cap all pass', () => {
  // Production symptom: a photographer sent a 7-photo album of full-size
  // JPEGs (18–20.5 MB each, ~135 MB in total) to a chat with
  // maxFileBytes=100MB on a local Bot API server. Every file was within the
  // per-file cap, yet the last photos were skipped with "exceeds total size
  // cap (104857600 bytes)": the per-message budget equalled ONE file's cap.
  // A Telegram album holds at most 10 items, so the budget must fit a full
  // album of files that each pass the per-file cap.
  const { filterAttachments, inboundFilterOpts } = require('../lib/attachments');
  const caps = resolveFileCaps({ localApi: true, override: 100 * MB });
  const sizesMb = [19.1, 19.3, 18.1, 19.3, 19.2, 20.5, 19.4];
  const album = sizesMb.map((mb, i) => ({
    name: `1Q2A${5000 + i}.jpg`, mime_type: 'image/jpeg', size: Math.round(mb * MB),
  }));
  const { accepted, rejected } = filterAttachments(album, inboundFilterOpts(caps));
  assert.deepEqual(rejected.map((r) => `${r.att.name}: ${r.reason}`), []);
  assert.equal(accepted.length, album.length);
});

test('album budget: 10 files at the per-file cap, never above the 2GB local ceiling', () => {
  // Cloud: 10 × 20MB. A 100MB local override: 10 × 100MB. A local server
  // with no override already allows a 2GB file; multiplying that would let one
  // album write 20GB to the local server's disk, so it stays at 2GB.
  assert.equal(resolveFileCaps({ localApi: false }).totalInBytes, 200 * MB);
  assert.equal(resolveFileCaps({ localApi: true, override: 100 * MB }).totalInBytes, 1000 * MB);
  assert.equal(resolveFileCaps({ localApi: true }).totalInBytes, LOCAL_MAX_BYTES);
});
