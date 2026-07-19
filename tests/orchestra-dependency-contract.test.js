'use strict';

/**
 * Contract check against the REAL installed @shumkov/orchestra dependency
 * (not a mock). polygram.js destructures checkClaudeAuthHealth from
 * claudeBin at module load and calls it unconditionally on the handleMessage
 * hot path (every non-slash-command, non-replay message). If the installed
 * package doesn't actually export it, that destructure silently becomes
 * `undefined`, and the first call throws "checkClaudeAuthHealth is not a
 * function" on every message — the dispatcher only logs it and never
 * replies, recreating the exact silent wedge this feature exists to fix.
 *
 * This must go green before this branch is deployed — see
 * docs/claude-auth-detection-spec.md, "Rollout (ORCHESTRA FIRST)".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

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
