import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function resolveDarwinProcessExecutable(
  pid,
  { spawn = spawnSync } = {},
) {
  const result = spawn(
    'lsof',
    ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`could not resolve macOS executable for process ${pid}`);
  }
  const lines = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  if (lines[0] !== `p${pid}`) {
    throw new Error(`could not resolve macOS executable for process ${pid}`);
  }
  const executable = lines.find((line) => line.startsWith('n/'))?.slice(1);
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error(`could not resolve macOS executable for process ${pid}`);
  }
  return executable;
}

export function resolveProcessExecutable({
  pid,
  command,
  platform = process.platform,
  readlink = fs.readlinkSync,
  realpath = fs.realpathSync,
  procRoot = '/proc',
  resolveDarwinPid = resolveDarwinProcessExecutable,
}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError('process pid must be a positive integer');
  }

  let executable;
  if (platform === 'darwin') {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error(`process ${pid} must report executable evidence`);
    }
    executable = path.isAbsolute(command)
      ? command
      : resolveDarwinPid(pid);
  } else if (platform === 'linux') {
    try {
      executable = readlink(path.join(procRoot, String(pid), 'exe'));
    } catch (error) {
      throw new Error(
        `could not resolve executable for process ${pid}: ${error.message}`,
      );
    }
  } else {
    throw new Error(`unsupported platform for process evidence: ${platform}`);
  }

  try {
    return realpath(executable);
  } catch (error) {
    throw new Error(
      `could not canonicalize executable for process ${pid}: ${error.message}`,
    );
  }
}
