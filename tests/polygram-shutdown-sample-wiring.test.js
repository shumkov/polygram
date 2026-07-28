'use strict';

// The value of `in_flight_at_signal` is entirely positional: it must be read
// before the shutdown sequence changes anything, or it degenerates into a second
// copy of the post-drain `in_flight` — which reads 0 whether the daemon was busy
// or idle, because a lost bridge rejects every pending handler before the drain
// even begins. A behavioural test cannot pin that: the sample could be moved
// after the drain and every assertion about its VALUE would still pass.
//
// So this pins the ordering structurally, in the same style as the other
// polygram wiring tests.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'polygram.js'), 'utf8');

// Body of the SIGTERM/SIGINT/SIGHUP handler.
function shutdownBody() {
  const start = src.indexOf('const shutdown = async () => {');
  assert.notEqual(start, -1, 'shutdown handler not found — this test needs updating');
  const end = src.indexOf("process.on('SIGINT', shutdown)", start);
  assert.notEqual(end, -1, 'end of shutdown handler not found — this test needs updating');
  return src.slice(start, end);
}

describe('shutdown signal-time sampling', () => {
  test('samples in-flight work before anything in shutdown can change it', () => {
    const body = shutdownBody();
    // Anchor on the ASSIGNMENT, not on any call to countInFlight. `countInFlight`
    // is also called after the drain, and anchoring on its first occurrence lets
    // a stray early call satisfy this test while the real sample drifts past the
    // latch — a false green.
    const sample = body.indexOf('const inFlightAtSignal = countInFlight(inFlightHandlers)');
    assert.notEqual(sample, -1, 'signal-time in-flight sample is missing from shutdown');

    // Everything below either mutates state the sample measures, or awaits —
    // giving in-flight handlers a chance to settle or fail first.
    const mustComeAfter = {
      'the isShuttingDown latch': 'isShuttingDown = true',
      'refusing new inbound (bot._stop)': 'bot._stop()',
      'cancelling open questions': 'expireQuestion',
      'the drain loop': 'const drainStart',
    };
    for (const [label, marker] of Object.entries(mustComeAfter)) {
      const at = body.indexOf(marker);
      assert.notEqual(at, -1, `marker for ${label} not found — this test needs updating`);
      assert.ok(
        sample < at,
        `in-flight must be sampled BEFORE ${label}; found sample at ${sample}, ${label} at ${at}`,
      );
    }
  });

  test('reports the signal-time sample alongside the post-drain count', () => {
    const body = shutdownBody();
    // Both must reach the event: the pair is what shows how much work a restart
    // actually cost versus how much the drain managed to finish.
    assert.match(body, /logEvent\('shutdown-drain', \{[\s\S]*?in_flight: remaining,/);
    assert.match(body, /logEvent\('shutdown-drain', \{[\s\S]*?in_flight_at_signal: inFlightAtSignal,/);
  });

  test('the post-drain count is measured after the drain, not reused', () => {
    const body = shutdownBody();
    const drain = body.indexOf('const drainStart');
    const remaining = body.indexOf('const remaining = countInFlight(inFlightHandlers)');
    assert.notEqual(remaining, -1, 'post-drain in-flight count is missing');
    assert.ok(remaining > drain, 'post-drain count must be taken after the drain loop');
  });
});

describe('ipc handler wiring', () => {
  test('polygram serves the shared production handler set', () => {
    // Guards against the handlers drifting back inline, where the IPC tests
    // would silently stop covering what a running daemon actually answers.
    assert.match(src, /handlers: createIpcHandlers\(\{/);
    assert.match(src, /getInFlightHandlers: \(\) => inFlightHandlers/);
  });
});

describe('tmux preflight wiring', () => {
  // The fatal decision must happen before the daemon opens its DB or starts
  // polling Telegram — a bot that boots "successfully" into a host it cannot
  // serve is the failure this guards.
  test('an unusable required tmux server aborts boot before the DB is opened', () => {
    const verdict = src.indexOf('classifyOrphanSweep({');
    assert.notEqual(verdict, -1, 'boot preflight is missing');
    const exit = src.indexOf('process.exit(2)', verdict);
    assert.notEqual(exit, -1, 'preflight does not abort boot');

    const dbOpen = src.indexOf('db = dbClient.open(DB_PATH)');
    assert.notEqual(dbOpen, -1, 'DB open not found — this test needs updating');
    assert.ok(verdict < dbOpen, 'preflight must run before the DB is opened');
    assert.ok(exit < dbOpen, 'preflight must abort before the DB is opened');
  });

  test('the preflight is fed both the sweep result and a thrown sweep', () => {
    assert.match(src, /classifyOrphanSweep\(\{[\s\S]{0,200}?sweep: sweepResult,/);
    assert.match(src, /classifyOrphanSweep\(\{[\s\S]{0,200}?error: sweepError,/);
    assert.match(src, /classifyOrphanSweep\(\{[\s\S]{0,200}?requireExistingServer,/);
  });

  // Both runners must target the SAME tmux server. One left on the default
  // socket would spawn sessions the other cannot see or sweep.
  test('every tmux runner is given the configured socket', () => {
    const runnerCalls = [...src.matchAll(/createTmuxRunner\(\{([^}]*)\}\)/g)];
    assert.equal(runnerCalls.length, 2, 'orphan sweep and main runner must both be wired');
    for (const [, options] of runnerCalls) {
      assert.match(options, /\bsocketName: tmuxSocketName\b/);
      assert.match(options, /\brequireExistingServer\b/);
    }
  });

  test('the socket name is read from the environment, defaulting to the shared socket', () => {
    assert.match(src, /const tmuxSocketName = process\.env\.ORCHESTRA_TMUX_SOCKET \|\| null;/);
  });
});
