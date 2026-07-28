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

// Every bot on a host shares one DATA_DIR (it is process.cwd(), and the fleet
// starts each --bot from the same directory), so the filename MUST carry the bot
// name. A shared heartbeat lets a live bot's beat stand in for a dead one's —
// which defeats the file's only purpose — and puts both daemons on one temp path,
// where the rename that loses the race fails ENOENT every minute. botName is
// required rather than defaulted so a second caller can't silently reintroduce it.
function createHeartbeat({ dataDir, botName, authDisabledGate, intervalMs = 60_000, now = Date.now }) {
  if (!botName) throw new TypeError('createHeartbeat: botName required (the data dir is shared between bots)');
  // Bot names come from config/CLI and land in a path segment; keep them inert.
  const safeName = String(botName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(dataDir, `heartbeat-${safeName}.json`);
  // Unique per process so two daemons never contend for one temp path, even if
  // they are ever pointed at the same bot name.
  const tmp = `${file}.tmp.${process.pid}`;
  let timer = null;

  function snapshot() {
    const gate = authDisabledGate.snapshot();
    return { ts: now(), authDisabled: gate.count, authDisabledLastAt: gate.lastAt };
  }

  function beat() {
    const snap = snapshot();
    try {
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
