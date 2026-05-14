#!/usr/bin/env node
/**
 * Snapshot the spike environment so the findings doc has a fixed
 * reference for what was tested. Run before any gate scripts.
 */

'use strict';

const { run, emit, appendFinding } = require('./runner');

async function snapshot(label, cmd, args) {
  try {
    const { stdout } = await run(cmd, args);
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

(async () => {
  const detail = {
    claude:     await snapshot('claude', 'claude', ['--version']),
    tmux:       await snapshot('tmux', 'tmux', ['-V']),
    sw_vers:    await snapshot('macOS', 'sw_vers', ['-productVersion']),
    node:       await snapshot('node', 'node', ['--version']),
    nvm_path:   await snapshot('nvm-claude', 'which', ['claude']),
  };
  emit({ gate: 'ENV', status: 'PASS', detail });
  appendFinding('ENV', 'snapshot', detail);
  process.exit(0);
})();
