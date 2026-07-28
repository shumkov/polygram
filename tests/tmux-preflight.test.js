'use strict';

// The failure this guards: with ORCHESTRA_TMUX_REQUIRE_SERVER=1 the daemon must
// never create the tmux server itself, so a missing or unreachable server means
// every tmux-backed turn will fail. Booting on regardless produces the worst
// possible state — systemd reports the bot `active` while nothing it does works.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyOrphanSweep } = require('../lib/ops/tmux-preflight');

describe('classifyOrphanSweep', () => {
  test('a reachable host with orphans swept is fine', () => {
    const r = classifyOrphanSweep({
      sweep: { swept: ['polygram-shumabit-channels-aa'], errors: [], listFailed: false },
      requireExistingServer: true,
    });
    assert.equal(r.fatal, false);
  });

  test('a reachable host with nothing to sweep is fine', () => {
    const r = classifyOrphanSweep({
      sweep: { swept: [], errors: [], listFailed: false },
      requireExistingServer: true,
    });
    assert.equal(r.fatal, false);
  });

  test('an unreachable server is fatal when the server is required', () => {
    const r = classifyOrphanSweep({
      sweep: { swept: [], errors: [], listFailed: true, listError: 'no server running' },
      requireExistingServer: true,
    });
    assert.equal(r.fatal, true);
    assert.match(r.reason, /no server running/);
  });

  // Without the flag the daemon is allowed to create the server itself, so an
  // empty host is normal at first boot and must not block startup.
  test('an unreachable server is tolerated when the daemon may create one', () => {
    const r = classifyOrphanSweep({
      sweep: { swept: [], errors: [], listFailed: true, listError: 'no server running' },
      requireExistingServer: false,
    });
    assert.equal(r.fatal, false);
  });

  // An orchestra too old to report listFailed cannot distinguish "no sessions"
  // from "could not ask" — the exact fail-open this check exists to close. Boot
  // must not silently degrade to the old behaviour on a downgrade.
  test('an orchestra that cannot report reachability is fatal, not assumed healthy', () => {
    const r = classifyOrphanSweep({
      sweep: { swept: [], errors: [] },
      requireExistingServer: true,
    });
    assert.equal(r.fatal, true);
    assert.match(r.reason, /cannot report/i);
  });

  test('a missing sweep result is fatal when the server is required', () => {
    assert.equal(classifyOrphanSweep({ sweep: null, requireExistingServer: true }).fatal, true);
    assert.equal(classifyOrphanSweep({ sweep: null, requireExistingServer: false }).fatal, false);
  });

  // A sweep that threw is at least as bad as one that reported failure.
  test('a thrown sweep is fatal when the server is required', () => {
    const r = classifyOrphanSweep({
      error: new Error('spawn tmux ENOENT'),
      requireExistingServer: true,
    });
    assert.equal(r.fatal, true);
    assert.match(r.reason, /ENOENT/);
  });

  test('a thrown sweep stays non-fatal when the server is not required', () => {
    const r = classifyOrphanSweep({
      error: new Error('spawn tmux ENOENT'),
      requireExistingServer: false,
    });
    assert.equal(r.fatal, false);
  });
});
