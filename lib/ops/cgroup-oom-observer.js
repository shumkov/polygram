'use strict';

const fs = require('fs');
const path = require('path');

const CGROUP_MEMBERSHIP_PATH = '/proc/self/cgroup';
const CGROUP_ROOT = '/sys/fs/cgroup';

function parseCgroupV2Path(contents) {
  if (typeof contents !== 'string') throw new TypeError('cgroup membership must be text');
  const matches = contents
    .split(/\r?\n/)
    .filter((line) => line.startsWith('0::'));
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('multiple cgroup v2 memberships');

  const cgroupPath = matches[0].slice(3);
  if (!cgroupPath.startsWith('/')) throw new Error('cgroup v2 path is not absolute');
  if (cgroupPath.includes('\0')) throw new Error('cgroup v2 path contains NUL');
  if (/\s+\(deleted\)$/.test(cgroupPath)) throw new Error('cgroup v2 path is deleted');

  const relative = cgroupPath.slice(1);
  if (relative !== '') {
    const components = relative.split('/');
    if (components.some((component) => component === '' || component === '.' || component === '..')) {
      throw new Error('cgroup v2 path contains an invalid component');
    }
  }
  return cgroupPath;
}

function resolveMemoryEventsPath(cgroupPath, cgroupRoot = CGROUP_ROOT) {
  if (typeof cgroupPath !== 'string' || !cgroupPath.startsWith('/')) {
    throw new Error('cgroup v2 path is invalid');
  }
  const root = path.resolve(cgroupRoot);
  const cgroupDir = path.resolve(root, cgroupPath.slice(1));
  const relative = path.relative(root, cgroupDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('cgroup v2 path escapes the cgroup root');
  }
  return path.join(cgroupDir, 'memory.events');
}

function parseOomKillCounter(contents) {
  if (typeof contents !== 'string') throw new TypeError('memory.events must be text');
  const values = [];
  for (const line of contents.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'oom_kill') continue;
    if (fields.length !== 2 || !/^\d+$/.test(fields[1])) {
      throw new Error('memory.events oom_kill counter is invalid');
    }
    values.push(fields[1]);
  }
  if (values.length !== 1) {
    throw new Error('memory.events oom_kill counter is missing or invalid');
  }
  return BigInt(values[0]);
}

function observation(status, {
  detected = false,
  delta = null,
  reason = null,
} = {}) {
  return Object.freeze({
    status,
    detected,
    delta,
    ...(reason ? { reason } : {}),
  });
}

function createCgroupOomObserver({
  platform = process.platform,
  readFileSync = fs.readFileSync,
  membershipPath = CGROUP_MEMBERSHIP_PATH,
  cgroupRoot = CGROUP_ROOT,
} = {}) {
  if (platform !== 'linux') {
    const startup = observation('unsupported', { reason: 'platform' });
    return { startup, sample: () => startup };
  }

  let cgroupPath;
  try {
    cgroupPath = parseCgroupV2Path(readFileSync(membershipPath, 'utf8'));
  } catch {
    const startup = observation('unavailable', { reason: 'membership-invalid' });
    return { startup, sample: () => startup };
  }
  if (cgroupPath == null) {
    const startup = observation('unsupported', { reason: 'cgroup-v2-unavailable' });
    return { startup, sample: () => startup };
  }

  let memoryEventsPath;
  try {
    memoryEventsPath = resolveMemoryEventsPath(cgroupPath, cgroupRoot);
  } catch {
    const startup = observation('unavailable', { reason: 'membership-invalid' });
    return { startup, sample: () => startup };
  }

  let baseline;
  try {
    baseline = parseOomKillCounter(readFileSync(memoryEventsPath, 'utf8'));
  } catch {
    const startup = observation('unavailable', { reason: 'memory-events-unavailable' });
    return { startup, sample: () => startup };
  }

  const startup = observation('unchanged', { delta: 0n });
  return {
    startup,
    sample() {
      let current;
      try {
        current = parseOomKillCounter(readFileSync(memoryEventsPath, 'utf8'));
      } catch {
        return observation('unavailable', { reason: 'memory-events-unavailable' });
      }
      if (current < baseline) {
        return observation('unavailable', { reason: 'oom-kill-counter-decreased' });
      }
      const delta = current - baseline;
      if (delta > 0n) return observation('detected', { detected: true, delta });
      return observation('unchanged', { delta });
    },
  };
}

module.exports = {
  parseCgroupV2Path,
  resolveMemoryEventsPath,
  parseOomKillCounter,
  createCgroupOomObserver,
};
