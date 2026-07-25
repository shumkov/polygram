import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashSensitiveString } from './claude-executable.mjs';

function commandForPid(pid) {
  try {
    return fs.realpathSync(`/proc/${pid}/exe`);
  } catch {}
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
    encoding: 'utf8',
  });
  return result.status === 0 ? String(result.stdout).trim() : '';
}

function childPids(pid) {
  const result = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`could not inspect child processes for pid ${pid}`);
  }
  return String(result.stdout || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

export function captureTmuxProcessTree({
  tmuxSession,
  selection,
  label,
}) {
  if (!/^[A-Za-z0-9._-]+$/.test(label || '')) {
    throw new TypeError('process-tree label must be a safe basename');
  }
  const pane = spawnSync(
    'tmux',
    ['display-message', '-p', '-t', tmuxSession, '#{pane_pid}'],
    { encoding: 'utf8' },
  );
  assert.equal(pane.status, 0, 'tmux pane pid must be inspectable');
  const rootPid = Number(String(pane.stdout).trim());
  assert.ok(Number.isInteger(rootPid) && rootPid > 0, 'tmux pane pid must be valid');

  const pending = [{ pid: rootPid, ppid: null }];
  const seen = new Set();
  const records = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (seen.has(current.pid)) continue;
    seen.add(current.pid);
    const executable = commandForPid(current.pid);
    records.push({
      pid: current.pid,
      ppid: current.ppid,
      executable,
      executablePathHash: executable ? hashSensitiveString(executable) : null,
    });
    for (const pid of childPids(current.pid)) {
      pending.push({ pid, ppid: current.pid });
    }
  }

  const privateDir = path.join(selection.artifactDir, 'raw-private');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const privatePath = path.join(privateDir, `process-tree-${label}.json`);
  fs.writeFileSync(privatePath, `${JSON.stringify(records, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(privatePath, 0o600);
  return records;
}

export function mergeProcessTrees(...trees) {
  const byPid = new Map();
  for (const tree of trees) {
    for (const record of tree || []) byPid.set(record.pid, record);
  }
  return [...byPid.values()].sort((left, right) => left.pid - right.pid);
}

export function selectedBinaryPids(selection, processTree) {
  return processTree
    .filter((record) => (
      record.executablePathHash
      === selection.sanitizedAttestation.executablePathHash
    ))
    .map((record) => record.pid);
}
