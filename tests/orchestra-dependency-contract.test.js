'use strict';

/**
 * Contract checks against the REAL installed @shumkov/orchestra dependency
 * (not a mock) — one per orchestra-side feature polygram.js depends on but
 * can't verify statically at require-time.
 *
 * checkClaudeAuthHealth: polygram.js destructures it from claudeBin at
 * module load and calls it unconditionally on the handleMessage hot path
 * (every non-slash-command, non-replay message). If the installed package
 * doesn't actually export it, that destructure silently becomes `undefined`,
 * and the first call throws "checkClaudeAuthHealth is not a function" on
 * every message — the dispatcher only logs it and never replies, recreating
 * the exact silent wedge this feature exists to fix.
 *
 * This must go green before this branch is deployed — see
 * docs/claude-auth-detection-spec.md, "Rollout (ORCHESTRA FIRST)".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Per-component numeric comparison — deliberately NOT a string/lexicographic
// compare, which would incorrectly rank e.g. "0.10.0" below "0.4.0" (the
// digit '1' sorts before '4'). No semver dependency needed for a single
// floor check; this package's version history has no pre-release tags.
// Extracted (rather than inlined in the test below) so the edge case that
// actually distinguishes this from a buggy lexicographic compare can be
// exercised with synthetic input — the real installed version alone can't
// exercise a double-digit segment.
function versionGte(actual, min) {
  return actual[0] > min[0]
    || (actual[0] === min[0] && (actual[1] > min[1]
      || (actual[1] === min[1] && actual[2] >= min[2])));
}

test('versionGte: numeric comparison, not lexicographic (double-digit segments)', () => {
  assert.equal(versionGte([0, 10, 0], [0, 4, 0]), true, '0.10.0 must be >= 0.4.0 numerically — a string compare would get this wrong');
  assert.equal(versionGte([0, 3, 9], [0, 4, 0]), false);
  assert.equal(versionGte([0, 4, 0], [0, 4, 0]), true, 'equal to the floor counts as meeting it');
  assert.equal(versionGte([1, 0, 0], [0, 4, 0]), true);
});

test('checkClaudeAuthHealth is exported by the installed @shumkov/orchestra', () => {
  const { claudeBin } = require('@shumkov/orchestra');
  assert.equal(
    typeof claudeBin.checkClaudeAuthHealth,
    'function',
    'installed @shumkov/orchestra is missing claudeBin.checkClaudeAuthHealth — '
      + 'bump the @shumkov/orchestra dependency to a release that exports it '
      + 'before deploying (polygram.js calls it unconditionally on every message)',
  );
});

test('@shumkov/orchestra is exact and matches the lockfile and installed package', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const installed = require('@shumkov/orchestra/package.json');
  const spec = manifest.dependencies['@shumkov/orchestra'];

  assert.match(
    spec,
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
    'package.json must use a bare exact orchestra semver; ranges, tags, and protocols are unvalidated',
  );
  assert.equal(
    lock.packages[''].dependencies['@shumkov/orchestra'],
    spec,
    'the lockfile root dependency must preserve the exact orchestra pin',
  );
  assert.equal(
    lock.packages['node_modules/@shumkov/orchestra'].version,
    spec,
    'the lockfile package entry must match the exact orchestra pin',
  );
  assert.equal(
    installed.version,
    spec,
    'the installed orchestra package must match the validated exact version',
  );
});

/**
 * AUTH_DISABLED (docs/AUTH_DISABLED_HANDLING_SPEC.md): unlike
 * checkClaudeAuthHealth, there's no exported function to `typeof`-check —
 * orchestra's own spec (docs/AUTH_DISABLED_DETECTION_SPEC.md in the
 * @shumkov/orchestra package) is explicit that it deliberately does NOT
 * export a classify() helper for this; it's purely internal CliProcess
 * behavior (reject every pending turn with err.code = 'AUTH_DISABLED').
 * The only statically-checkable contract is "the installed version is new
 * enough to have shipped the fix" — this repo's classify.js/dispatcher.js
 * AUTH_DISABLED handling is dead code against an older orchestra that never
 * produces that err.code (silently falls back to the old 10-minute
 * TURN_TIMEOUT wedge instead of failing loudly).
 */
test('installed @shumkov/orchestra is new enough to ship AUTH_DISABLED detection (>= 0.4.0)', () => {
  const MIN_VERSION = [0, 4, 0];
  const { version } = require('@shumkov/orchestra/package.json');
  const actual = version.split('.').map(Number);
  assert.ok(
    versionGte(actual, MIN_VERSION),
    `installed @shumkov/orchestra@${version} predates the AUTH_DISABLED fix `
      + '(shipped in 0.4.0, docs/AUTH_DISABLED_DETECTION_SPEC.md upstream) — a '
      + 'disabled-account turn will silently take the old 10-minute TURN_TIMEOUT '
      + 'path instead of the immediate AUTH_DISABLED rejection this repo\'s '
      + 'classify.js/dispatcher.js handling depends on. Bump the dependency '
      + 'before deploying. See docs/AUTH_DISABLED_HANDLING_SPEC.md.',
  );
});
