'use strict';

// Tests for the file-send staging dir + auto-purge (2026-06 file-send
// feature). The dispatcher allowlist already permitted
// <tmp>/polygram-attachments/<sessionKey>/ but nothing CREATED it — so
// claude's reply(files) attempts failed. CliProcess now creates it at
// spawn, exposes the realpath, and purges it on idle / removes on kill.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CliProcess } = require('../lib/process/cli-process');
const { DEFAULT_ATTACHMENT_BASE, validateAttachmentPath, buildAllowedRoots }
  = require('../lib/process/channels-tool-dispatcher');

function makeProc(sessionKey = 'stage:test') {
  return new CliProcess({
    botName: 'b', sessionKey, label: 't',
    tmuxRunner: { spawn: async () => {}, killSession: async () => {}, sendControl: async () => {}, captureWide: async () => '' },
    toolDispatcher: async () => ({ ok: true }),
    claudeBin: '/usr/bin/echo',
    logger: { error() {}, warn() {}, info() {}, debug() {}, log() {} },
    stopGraceMs: 60_000,
  });
}

// Drive just the staging-dir creation from start() without a real spawn.
function createStaging(proc, sessionKey) {
  // Mirror the start() snippet (kept in sync with cli-process.js).
  const dir = path.join(DEFAULT_ATTACHMENT_BASE, String(sessionKey));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  proc.attachmentStagingDir = fs.realpathSync(dir);
  return proc.attachmentStagingDir;
}

test('staging dir, once created, is INSIDE the dispatcher allowlist', () => {
  const sk = `stage-allow-${process.pid}-${Date.now()}`;
  const proc = makeProc(sk);
  const dir = createStaging(proc, sk);
  try {
    // A file in the staging dir must validate against the allowlist roots
    // that buildAllowedRoots produces for this session.
    const f = path.join(dir, 'track.flac');
    fs.writeFileSync(f, 'audio');
    const roots = buildAllowedRoots({ sessionKey: sk });
    const check = validateAttachmentPath(f, roots);
    assert.equal(check.ok, true, `staged file must be allowlisted; got: ${check.error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staging dir realpath matches the allowlist root realpath (no /tmp vs /private/tmp drift)', () => {
  const sk = `stage-realpath-${process.pid}-${Date.now()}`;
  const proc = makeProc(sk);
  const dir = createStaging(proc, sk);
  try {
    const allowRoot = fs.realpathSync(path.join(DEFAULT_ATTACHMENT_BASE, sk));
    assert.equal(dir, allowRoot, 'stored staging path must equal the realpath the validator resolves');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_purgeStagingDir empties contents but keeps the dir', () => {
  const sk = `stage-purge-${process.pid}-${Date.now()}`;
  const proc = makeProc(sk);
  const dir = createStaging(proc, sk);
  try {
    fs.writeFileSync(path.join(dir, 'a.flac'), 'x');
    fs.writeFileSync(path.join(dir, 'b.mp3'), 'y');
    assert.equal(fs.readdirSync(dir).length, 2);
    proc._purgeStagingDir();
    assert.equal(fs.existsSync(dir), true, 'dir itself preserved');
    assert.equal(fs.readdirSync(dir).length, 0, 'contents purged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_purgeStagingDir is a no-op when no staging dir (never throws)', () => {
  const proc = makeProc();
  proc.attachmentStagingDir = null;
  assert.doesNotThrow(() => proc._purgeStagingDir());
});

test('_finalizeTurn auto-purges staging when the last turn settles', () => {
  const sk = `stage-finalize-${process.pid}-${Date.now()}`;
  const proc = makeProc(sk);
  const dir = createStaging(proc, sk);
  try {
    fs.writeFileSync(path.join(dir, 'sent.flac'), 'data');
    // one pending turn that produced a reply
    proc.pendingTurns.set('T', {
      replies: ['done'], startedAt: Date.now(),
      resolve() {}, reject() {},
      quietTimer: null, hardTimer: null, absoluteTimer: null, _stopGraceTimer: null,
    });
    proc._finalizeTurn('T');
    assert.equal(fs.readdirSync(dir).length, 0, 'staging purged after last turn finalized');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
