#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  hashSensitiveString,
  sha256File,
} from './claude-executable.mjs';

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const wrapperPath = fileURLToPath(import.meta.url);
const [executablePath, ...args] = process.argv.slice(2);
const runId = process.env.CLAUDE_CODE_GATE_RUN_ID;
const artifactDir = process.env.CLAUDE_CODE_GATE_ARTIFACT_DIR;

function fail(message) {
  process.stderr.write(`claude-process-wrapper: ${message}\n`);
  process.exit(70);
}

if (!runId || !RUN_ID_RE.test(runId) || /^\.+$/.test(runId)) {
  fail('CLAUDE_CODE_GATE_RUN_ID is missing or invalid');
}
if (!artifactDir || !path.isAbsolute(artifactDir)) {
  fail('CLAUDE_CODE_GATE_ARTIFACT_DIR must be absolute');
}
if (!executablePath || !path.isAbsolute(executablePath)) {
  fail('first argument must be an absolute executable path');
}

try {
  fs.accessSync(executablePath, fs.constants.X_OK);
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactDir, 0o700);
} catch (error) {
  fail(error.message);
}

const versionProbeEnv = { ...process.env };
delete versionProbeEnv.CLAUDE_CODE_PROCESS_WRAPPER;
const versionResult = spawnSync(executablePath, ['--version'], {
  env: versionProbeEnv,
  encoding: 'utf8',
  timeout: 15_000,
  maxBuffer: 1024 * 1024,
});
const versionMatch = String(versionResult.stdout || '').trim().match(
  /^(\d+\.\d+\.\d+)\s+\(Claude Code\)$/,
);
if (versionResult.status !== 0 || !versionMatch) {
  fail('selected executable did not return a valid Claude Code version');
}

let executableSha256;
try {
  executableSha256 = await sha256File(executablePath);
} catch (error) {
  fail(`could not hash selected executable: ${error.message}`);
}

const record = {
  runId,
  pid: process.pid,
  ppid: process.ppid,
  version: versionMatch[1],
  executablePathHash: hashSensitiveString(fs.realpathSync(executablePath)),
  executableSha256,
  argvHash: hashSensitiveString(JSON.stringify(args)),
  argvCount: args.length,
  recordedAt: new Date().toISOString(),
};
const recordsPath = path.join(artifactDir, 'process-wrapper.ndjson');
try {
  fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(recordsPath, 0o600);
} catch (error) {
  fail(`could not write provenance: ${error.message}`);
}

const childEnv = {
  ...process.env,
  CLAUDE_CODE_PROCESS_WRAPPER: wrapperPath,
  CLAUDE_CODE_GATE_RUN_ID: runId,
  CLAUDE_CODE_GATE_ARTIFACT_DIR: artifactDir,
};

if (typeof process.execve === 'function') {
  process.execve(executablePath, [executablePath, ...args], childEnv);
}

const child = spawn(executablePath, args, { env: childEnv, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.on('error', (error) => fail(`spawn failed: ${error.message}`));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
