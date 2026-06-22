'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { resolvePinnedClaudeBin, verifyPinnedClaudeBin } = require('../lib/claude-bin');

const ORIGINAL_OVERRIDE = process.env.POLYGRAM_CLAUDE_BIN;

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.POLYGRAM_CLAUDE_BIN;
  else process.env.POLYGRAM_CLAUDE_BIN = ORIGINAL_OVERRIDE;
});

describe('claude-bin — resolvePinnedClaudeBin', () => {
  test('resolves to the standard claude-CLI versions path', () => {
    delete process.env.POLYGRAM_CLAUDE_BIN;
    assert.equal(
      resolvePinnedClaudeBin('2.1.142'),
      path.join(os.homedir(), '.local', 'share', 'claude', 'versions', '2.1.142'),
    );
  });

  test('the version string is part of the path (different versions → different paths)', () => {
    delete process.env.POLYGRAM_CLAUDE_BIN;
    assert.notEqual(
      resolvePinnedClaudeBin('2.1.142'),
      resolvePinnedClaudeBin('2.1.143'),
    );
  });

  test('POLYGRAM_CLAUDE_BIN env overrides the default path', () => {
    process.env.POLYGRAM_CLAUDE_BIN = '/custom/claude';
    assert.equal(resolvePinnedClaudeBin('2.1.142'), '/custom/claude');
  });
});

describe('claude-bin — verifyPinnedClaudeBin', () => {
  test('ok=true for an existing executable file', () => {
    // node itself is a reliable executable to point at.
    process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
    const r = verifyPinnedClaudeBin('2.1.142');
    assert.equal(r.ok, true);
    assert.equal(r.path, process.execPath);
    assert.equal(r.reason, undefined);
  });

  test('ok=false with an actionable reason for a missing binary', () => {
    process.env.POLYGRAM_CLAUDE_BIN = path.join(
      os.tmpdir(), `polygram-claude-bin-missing-${Date.now()}`,
    );
    const r = verifyPinnedClaudeBin('2.1.142');
    assert.equal(r.ok, false);
    assert.match(r.reason, /pinned claude CLI v2\.1\.142 not found/);
    assert.match(r.reason, /claude install 2\.1\.142/);
    assert.match(r.reason, /POLYGRAM_CLAUDE_BIN/);
  });

  test('ok=false for a non-executable file', () => {
    const tmp = path.join(os.tmpdir(), `polygram-claude-bin-noexec-${Date.now()}`);
    fs.writeFileSync(tmp, 'not a binary', { mode: 0o600 });
    try {
      process.env.POLYGRAM_CLAUDE_BIN = tmp;
      const r = verifyPinnedClaudeBin('2.1.142');
      assert.equal(r.ok, false);
      assert.match(r.reason, /not found or not executable/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

// 0.17: vendor the pinned binary so claude's auto-pruner can't delete it out
// from under the cli backend.
describe('claude-bin — ensureVendoredClaudeBin', () => {
  const { ensureVendoredClaudeBin } = require('../lib/claude-bin');
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const VER = '2.1.173';
  const SAVE = ['POLYGRAM_CLAUDE_BIN', 'POLYGRAM_CLAUDE_VENDOR_DIR', 'POLYGRAM_CLAUDE_VERSIONS_DIR', 'POLYGRAM_CLAUDE_INSTALL_BIN'];
  let saved; let root;

  const fakeExec = (p) => fs.writeFileSync(p, '#!/bin/sh\necho fake-claude', { mode: 0o755 });

  function setup() {
    saved = {}; for (const k of SAVE) { saved[k] = process.env[k]; delete process.env[k]; }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-vendor-'));
    const vendorD = path.join(root, 'vendor');
    const versionsD = path.join(root, 'versions');
    fs.mkdirSync(vendorD, { recursive: true });
    fs.mkdirSync(versionsD, { recursive: true });
    process.env.POLYGRAM_CLAUDE_VENDOR_DIR = vendorD;
    process.env.POLYGRAM_CLAUDE_VERSIONS_DIR = versionsD;
    return { vendorD, versionsD };
  }
  function teardown() {
    for (const k of SAVE) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }

  test('already-vendored → returns the vendored path without re-copying', () => {
    const { vendorD } = setup();
    try {
      fakeExec(path.join(vendorD, VER));
      const r = ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.equal(r.ok, true);
      assert.equal(r.vendored, true);
      assert.equal(r.path, path.join(vendorD, VER));
    } finally { teardown(); }
  });

  test('missing vendor + present system version → copies into the vendor dir (executable)', () => {
    const { vendorD, versionsD } = setup();
    try {
      fakeExec(path.join(versionsD, VER));
      const r = ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.equal(r.ok, true);
      assert.equal(r.path, path.join(vendorD, VER));
      assert.ok(fs.existsSync(path.join(vendorD, VER)), 'binary copied');
      fs.accessSync(path.join(vendorD, VER), fs.constants.X_OK); // executable
    } finally { teardown(); }
  });

  test('GC removes stale vendored versions, keeps the live one', () => {
    const { vendorD, versionsD } = setup();
    try {
      fakeExec(path.join(vendorD, '2.1.150'));   // stale old vendored version
      fakeExec(path.join(versionsD, VER));        // system has the live version
      ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.ok(!fs.existsSync(path.join(vendorD, '2.1.150')), 'stale vendored version GC-removed');
      assert.ok(fs.existsSync(path.join(vendorD, VER)), 'live version kept');
    } finally { teardown(); }
  });

  test('system absent + installer SUCCEEDS → installs into versions dir, then vendors', () => {
    const { vendorD, versionsD } = setup();
    try {
      // fake installer: `<bin> install <ver>` drops an executable into the
      // versions dir (the env is inherited by execFileSync).
      const inst = path.join(root, 'fake-installer');
      fs.writeFileSync(inst,
        '#!/bin/sh\nmkdir -p "$POLYGRAM_CLAUDE_VERSIONS_DIR"\n'
        + 'printf \'#!/bin/sh\\necho fake\\n\' > "$POLYGRAM_CLAUDE_VERSIONS_DIR/$2"\n'
        + 'chmod 755 "$POLYGRAM_CLAUDE_VERSIONS_DIR/$2"\n', { mode: 0o755 });
      process.env.POLYGRAM_CLAUDE_INSTALL_BIN = inst;
      const r = ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.equal(r.ok, true, r.reason);
      assert.ok(fs.existsSync(path.join(versionsD, VER)), 'installer wrote the system version');
      assert.ok(fs.existsSync(path.join(vendorD, VER)), 'then vendored from it');
      fs.accessSync(path.join(vendorD, VER), fs.constants.X_OK);
    } finally { teardown(); }
  });

  test('system absent + installer fails → ok=false with actionable reason, no throw', () => {
    setup();
    try {
      process.env.POLYGRAM_CLAUDE_INSTALL_BIN = path.join(root, 'no-such-claude');
      let r;
      assert.doesNotThrow(() => { r = ensureVendoredClaudeBin(VER, { logger: quiet }); });
      assert.equal(r.ok, false);
      assert.match(r.reason, /install/i);
    } finally { teardown(); }
  });

  test('POLYGRAM_CLAUDE_BIN override wins (executable) — skips vendoring', () => {
    setup();
    try {
      const ov = path.join(root, 'override-claude');
      fakeExec(ov);
      process.env.POLYGRAM_CLAUDE_BIN = ov;
      const r = ensureVendoredClaudeBin(VER, { logger: quiet });
      assert.equal(r.ok, true);
      assert.equal(r.path, ov);
      assert.equal(r.vendored, false);
    } finally { teardown(); }
  });
});
