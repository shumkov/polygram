#!/usr/bin/env node

// Session launcher for the snapshot-on control leg of the system-prompt
// snapshot gate. Orchestra's CliProcess passes `--system-prompt-snapshot off`
// whenever the selected binary advertises the flag, so the control leg cannot
// ask for Claude's default recording through CliProcess options. This
// launcher rewrites exactly that one pair to `on`, records the rewrite next to
// the wrapper provenance, and execs the provenance wrapper so the Claude
// process keeps its attested identity and pid.

import fs from 'node:fs';
import path from 'node:path';

const [executablePath, ...args] = process.argv.slice(2);
const wrapperPath = process.env.CLAUDE_CODE_PROCESS_WRAPPER;
const artifactDir = process.env.CLAUDE_CODE_GATE_ARTIFACT_DIR;

function fail(message) {
  process.stderr.write(`system-prompt-snapshot-launcher: ${message}\n`);
  process.exit(70);
}

if (!wrapperPath || !path.isAbsolute(wrapperPath)) {
  fail('CLAUDE_CODE_PROCESS_WRAPPER must be absolute');
}
if (!artifactDir || !path.isAbsolute(artifactDir)) {
  fail('CLAUDE_CODE_GATE_ARTIFACT_DIR must be absolute');
}
if (!executablePath || !path.isAbsolute(executablePath)) {
  fail('first argument must be an absolute executable path');
}
if (typeof process.execve !== 'function') {
  fail('process.execve is required to keep the wrapped pid');
}

const flagIndices = args.flatMap(
  (arg, index) => (arg === '--system-prompt-snapshot' ? [index] : []),
);
if (flagIndices.length !== 1 || args[flagIndices[0] + 1] !== 'off') {
  fail('expected exactly one --system-prompt-snapshot off pair');
}
const rewrittenArgs = [...args];
rewrittenArgs[flagIndices[0] + 1] = 'on';

const recordsPath = path.join(artifactDir, 'snapshot-launcher.ndjson');
try {
  fs.appendFileSync(
    recordsPath,
    `${JSON.stringify({ pid: process.pid, snapshot: 'on' })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.chmodSync(recordsPath, 0o600);
} catch (error) {
  fail(`could not record the rewrite: ${error.message}`);
}

process.execve(
  wrapperPath,
  [wrapperPath, executablePath, ...rewrittenArgs],
  process.env,
);
