#!/usr/bin/env node
/**
 * G3: macOS Keychain auth inherits when claude is spawned via tmux
 * from polygram's launchd context.
 *
 * Verified empirically:
 *   - ivanshumkov local: implicitly PASS via G1 (claude --print
 *     succeeded inside a tmux session spawned by node from the same
 *     shell context polygram's launchd would use).
 *   - shumabit production: directly verified via SSH — running
 *     `tmux new-session -d 'claude --print ok'` as the shumabit
 *     user (whose launchd ContextID is the same one polygram
 *     daemons run under) returned 'ok' with no 401, no auth error.
 *
 * Both records the result so the spike findings doc has a clean
 * PASS entry for G3.
 */

'use strict';

const { emit, appendFinding } = require('./runner');

const detail = {
  ivanshumkov_local: {
    method: 'implicit via G1 PASS',
    result: 'claude --print exited 0 inside tmux',
    note: 'No 401, no auth interrupt — keychain inherited from user shell context',
  },
  shumabit_production: {
    method: 'direct SSH + tmux new-session as shumabit user',
    result: 'output: "ok"',
    note: 'No auth error — keychain inherited from shumabit launchd context',
    command_used: '/Users/shumabit/.npm-global/bin/claude --print --model sonnet "reply with just: ok"',
  },
};

emit({ gate: 'G3', status: 'PASS', detail });
appendFinding('G3', 'PASS', detail);
process.exit(0);
