/**
 * Sanity-check: every JS file in the repo parses.
 *
 * polygram.js is a top-level script (calls main() at bottom), so it
 * can't be require()'d from a test without starting a bot. But running
 * `node --check <file>` parses without executing — perfect for catching
 * syntax breakage from mass refactors.
 *
 * 0.6.10 shipped to npm with a SyntaxError in polygram.js (the
 * logEvent perl substitution mangled three logConfigChange call
 * sites). This test would have caught that before publish.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

function checkSyntax(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, err: r.stderr || r.stdout };
  }
  return { ok: true };
}

describe('JS syntax', () => {
  test('polygram.js parses', () => {
    const r = checkSyntax(path.join(REPO_ROOT, 'polygram.js'));
    assert.equal(r.ok, true, r.err);
  });

  test('every lib/*.js parses', () => {
    const libDir = path.join(REPO_ROOT, 'lib');
    const files = fs.readdirSync(libDir).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0, 'lib/ should contain JS files');
    for (const f of files) {
      const r = checkSyntax(path.join(libDir, f));
      assert.equal(r.ok, true, `lib/${f}: ${r.err || ''}`);
    }
  });

  test('every scripts/*.js parses', () => {
    const dir = path.join(REPO_ROOT, 'scripts');
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const r = checkSyntax(path.join(dir, f));
      assert.equal(r.ok, true, `scripts/${f}: ${r.err || ''}`);
    }
  });

  test('every bin/*.js parses', () => {
    const dir = path.join(REPO_ROOT, 'bin');
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const r = checkSyntax(path.join(dir, f));
      assert.equal(r.ok, true, `bin/${f}: ${r.err || ''}`);
    }
  });
});
