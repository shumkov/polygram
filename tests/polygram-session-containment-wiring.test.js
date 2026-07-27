'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

describe('polygram session containment wiring', () => {
  test('passes the configured launcher path explicitly to the process factory', () => {
    assert.match(
      src,
      /const sessionLauncher = process\.env\.ORCHESTRA_SESSION_LAUNCHER;/,
    );
    assert.match(
      src,
      /const orchestraProcessFactory = createProcessFactory\(\{[\s\S]*?\n\s+sessionLauncher,/,
    );
  });

  test('requires exactly "1" and passes the flag to both tmux runner constructions', () => {
    assert.match(
      src,
      /const requireExistingServer = process\.env\.ORCHESTRA_TMUX_REQUIRE_SERVER === '1';/,
    );
    const runnerCalls = [...src.matchAll(/createTmuxRunner\(\{([^}]*)\}\)/g)];
    assert.equal(runnerCalls.length, 2, 'orphan sweep and main runner must both be wired');
    for (const [, options] of runnerCalls) {
      assert.match(options, /\brequireExistingServer\b/);
    }
  });

  test('reports only whether containment is configured, never the launcher path', () => {
    const log = src.match(/console\.log\(`\[polygram\] session containment[^`]*`\);/)?.[0];
    assert.ok(log, 'boot must report containment configuration');
    assert.match(log, /\$\{sessionLauncher \? 'yes' : 'no'\}/);
    assert.doesNotMatch(log, /\$\{sessionLauncher\}/);
    assert.doesNotMatch(log, /ORCHESTRA_SESSION_LAUNCHER/);
  });
});
