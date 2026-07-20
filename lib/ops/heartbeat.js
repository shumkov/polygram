/**
 * Minimal file-based heartbeat for AUTH_DISABLED Netdata visibility
 * (docs/AUTH_DISABLED_HANDLING_SPEC.md, Layer 3.3).
 *
 * File-only equivalent of water's lib/ops/heartbeat.js pattern — no
 * /healthz endpoint, since this repo has no HTTP server to hang a route on.
 * Wiring heartbeat.json into an actual Netdata alert (netdata_watch_units /
 * a filecheck-or-cron-parses-JSON entry) is a VPS-side ops/ansible change
 * outside this repo's scope; this only builds the code-side signal.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createHeartbeat({ dataDir, authDisabledGate, intervalMs = 60_000, now = Date.now }) {
  const file = path.join(dataDir, 'heartbeat.json');
  let timer = null;

  function snapshot() {
    const gate = authDisabledGate.snapshot();
    return { ts: now(), authDisabled: gate.count, authDisabledLastAt: gate.lastAt };
  }

  function beat() {
    const snap = snapshot();
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snap));
      fs.renameSync(tmp, file); // atomic
    } catch (err) {
      // Best-effort (matches water's heartbeat.js) — must never throw into the
      // interval timer or affect a turn. Logged (water's version doesn't) because
      // this file's whole purpose is surfacing a silent failure; a heartbeat that
      // can go silently stale defeats that purpose the same way the bug it's
      // meant to catch does.
      console.error(`[auth] heartbeat write failed: ${err.message}`);
    }
    return snap;
  }

  function start() {
    beat();
    timer = setInterval(beat, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  return { start, stop, beat, snapshot, file };
}

module.exports = { createHeartbeat };
