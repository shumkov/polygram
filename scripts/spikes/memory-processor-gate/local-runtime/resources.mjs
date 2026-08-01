import fs from 'node:fs';
import path from 'node:path';

import { LLAMA_RUNTIME } from '../adapters/llama.mjs';

export class LocalRuntimeResourceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalRuntimeResourceError';
    this.code = code;
  }
}

function fail(code) {
  throw new LocalRuntimeResourceError(code);
}

function parseInteger(value, code) {
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) fail(code);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) fail(code);
  return parsed;
}

function parseKeyValue(text, code) {
  const result = {};
  for (const line of String(text).trim().split('\n')) {
    if (line.length === 0) continue;
    const match = /^(\S+)\s+(\d+)$/.exec(line);
    if (!match) fail(code);
    result[match[1]] = parseInteger(match[2], code);
  }
  return result;
}

export function parseCgroupV2Snapshot({ memoryPeak, swapCurrent, memoryEvents, cpuStat }) {
  const events = parseKeyValue(memoryEvents, 'LOCAL_RUNTIME_MEMORY_EVENTS_INVALID');
  const cpu = parseKeyValue(cpuStat, 'LOCAL_RUNTIME_CPU_STAT_INVALID');
  const snapshot = {
    memoryPeakBytes: parseInteger(memoryPeak, 'LOCAL_RUNTIME_MEMORY_PEAK_INVALID'),
    swapCurrentBytes: parseInteger(swapCurrent, 'LOCAL_RUNTIME_SWAP_CURRENT_INVALID'),
    oomCount: events.oom,
    oomKillCount: events.oom_kill,
    cpuUsageUsec: cpu.usage_usec,
    cpuThrottledUsec: cpu.throttled_usec ?? 0,
  };
  if (Object.values(snapshot).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail('LOCAL_RUNTIME_RESOURCE_COUNTER_MISSING');
  }
  return Object.freeze(snapshot);
}

export function createCgroupV2Sampler(cgroupDirectory, {
  readFile = fs.promises.readFile,
} = {}) {
  if (typeof cgroupDirectory !== 'string' || !path.isAbsolute(cgroupDirectory)) {
    fail('LOCAL_RUNTIME_CGROUP_PATH_INVALID');
  }
  return async function sampleCgroupV2() {
    const [memoryPeak, swapCurrent, memoryEvents, cpuStat] = await Promise.all([
      readFile(path.join(cgroupDirectory, 'memory.peak'), 'utf8'),
      readFile(path.join(cgroupDirectory, 'memory.swap.current'), 'utf8'),
      readFile(path.join(cgroupDirectory, 'memory.events'), 'utf8'),
      readFile(path.join(cgroupDirectory, 'cpu.stat'), 'utf8'),
    ]);
    return parseCgroupV2Snapshot({ memoryPeak, swapCurrent, memoryEvents, cpuStat });
  };
}

function assertSnapshot(snapshot) {
  const keys = [
    'memoryPeakBytes',
    'swapCurrentBytes',
    'oomCount',
    'oomKillCount',
    'cpuUsageUsec',
    'cpuThrottledUsec',
  ];
  if (!snapshot || keys.some((key) => !Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0)) {
    fail('LOCAL_RUNTIME_RESOURCE_SNAPSHOT_INVALID');
  }
}

export function summarizeResourceWindow(before, after, runtime = LLAMA_RUNTIME) {
  assertSnapshot(before);
  assertSnapshot(after);
  const monotonicKeys = ['oomCount', 'oomKillCount', 'cpuUsageUsec', 'cpuThrottledUsec'];
  if (monotonicKeys.some((key) => after[key] < before[key])) {
    fail('LOCAL_RUNTIME_RESOURCE_COUNTER_RESET');
  }
  const evidence = {
    memoryPeakBytes: after.memoryPeakBytes,
    swapCurrentBytes: after.swapCurrentBytes,
    oomDelta: after.oomCount - before.oomCount,
    oomKillDelta: after.oomKillCount - before.oomKillCount,
    cpuUsageUsec: after.cpuUsageUsec - before.cpuUsageUsec,
    cpuThrottledUsec: after.cpuThrottledUsec - before.cpuThrottledUsec,
  };
  return Object.freeze({
    ...evidence,
    passed: evidence.memoryPeakBytes <= runtime.memoryLimitBytes
      && evidence.swapCurrentBytes === runtime.swapBytes
      && evidence.oomDelta === 0
      && evidence.oomKillDelta === 0,
  });
}
