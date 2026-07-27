import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashSensitiveString } from './claude-executable.mjs';
import {
  resolveDarwinProcessExecutable,
  resolveProcessExecutable,
} from './process-executable-evidence.mjs';

export { resolveProcessExecutable };

function parseProcessSnapshot(output) {
  const records = [];
  const seen = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error('process snapshot contained a malformed row');
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (
      !Number.isInteger(pid)
      || pid <= 0
      || !Number.isInteger(ppid)
      || ppid < 0
      || seen.has(pid)
    ) {
      throw new Error('process snapshot contained invalid process identities');
    }
    seen.add(pid);
    records.push({ pid, ppid, executable: match[3] });
  }
  return records;
}

function processSubtree(snapshot, rootPid, resolveExecutable) {
  const byPid = new Map(snapshot.map((record) => [record.pid, record]));
  if (!byPid.has(rootPid)) {
    throw new Error(`process snapshot did not contain tmux pane pid ${rootPid}`);
  }
  const children = new Map();
  for (const record of snapshot) {
    if (!children.has(record.ppid)) children.set(record.ppid, []);
    children.get(record.ppid).push(record.pid);
  }

  const pending = [rootPid];
  const seen = new Set();
  const records = [];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const record = byPid.get(pid);
    const executable = resolveExecutable(record, pid === rootPid);
    if (executable !== null) {
      records.push({
        pid,
        ppid: record.ppid,
        executable,
        executablePathHash: hashSensitiveString(executable),
      });
    }
    pending.push(...(children.get(pid) || []));
  }
  return records;
}

export function validateCapturedProcessTree(records) {
  for (const record of records) {
    if (
      typeof record.executable !== 'string'
      || record.executable.trim() === ''
    ) {
      throw new Error(`discovered pid ${record.pid} must have executable evidence`);
    }
    if (
      typeof record.executablePathHash !== 'string'
      || record.executablePathHash.trim() === ''
    ) {
      throw new Error(`discovered pid ${record.pid} must have an executable hash`);
    }
  }
  return records;
}

export function captureTmuxProcessTree({
  tmuxSession,
  selection,
  label,
  spawn = spawnSync,
  platform = process.platform,
  readlink = fs.readlinkSync,
  realpath = fs.realpathSync,
  procRoot = '/proc',
}) {
  if (!/^[A-Za-z0-9._-]+$/.test(label || '')) {
    throw new TypeError('process-tree label must be a safe basename');
  }
  const pane = spawn(
    'tmux',
    ['display-message', '-p', '-t', tmuxSession, '#{pane_pid}'],
    { encoding: 'utf8' },
  );
  assert.equal(pane.status, 0, 'tmux pane pid must be inspectable');
  const rootPid = Number(String(pane.stdout).trim());
  assert.ok(Number.isInteger(rootPid) && rootPid > 0, 'tmux pane pid must be valid');

  const snapshot = spawn(
    'ps',
    ['-axo', 'pid=,ppid=,comm='],
    { encoding: 'utf8' },
  );
  assert.equal(snapshot.status, 0, 'process snapshot must be inspectable');
  const records = processSubtree(
    parseProcessSnapshot(snapshot.stdout),
    rootPid,
    (record, isRoot) => {
      if (
        platform === 'darwin'
        && !path.isAbsolute(record.executable)
        && !isRoot
        && record.executable !== path.basename(
          selection.executablePath || '',
        )
      ) {
        return null;
      }
      return resolveProcessExecutable({
        pid: record.pid,
        command: record.executable,
        platform,
        readlink,
        realpath,
        procRoot,
        resolveDarwinPid: (pid) => resolveDarwinProcessExecutable(pid, {
          spawn,
        }),
      });
    },
  );
  validateCapturedProcessTree(records);

  const privateDir = path.join(selection.artifactDir, 'raw-private');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const privatePath = path.join(privateDir, `process-tree-${label}.json`);
  fs.writeFileSync(privatePath, `${JSON.stringify(records, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(privatePath, 0o600);
  const indexPath = path.join(privateDir, 'process-tree-index.ndjson');
  fs.appendFileSync(
    indexPath,
    `${JSON.stringify({ file: path.basename(privatePath) })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.chmodSync(indexPath, 0o600);
  return records;
}

export function mergeProcessTrees(...trees) {
  const byPid = new Map();
  for (const tree of trees) {
    for (const record of tree || []) byPid.set(record.pid, record);
  }
  return [...byPid.values()].sort((left, right) => left.pid - right.pid);
}

export function selectedBinaryProcesses(selection, processTree) {
  return processTree
    .filter((record) => (
      record.executablePathHash
      === selection.sanitizedAttestation.executablePathHash
    ))
    .map((record) => ({ pid: record.pid, ppid: record.ppid }));
}

export function selectedBinaryPids(selection, processTree) {
  return selectedBinaryProcesses(selection, processTree)
    .map((record) => record.pid);
}
