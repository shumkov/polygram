'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCgroupV2Path,
  resolveMemoryEventsPath,
  parseOomKillCounter,
  createCgroupOomObserver,
} = require('../lib/ops/cgroup-oom-observer');

describe('cgroup OOM parsing', () => {
  test('extracts the unified cgroup membership and exact memory.events path', () => {
    const cgroupPath = parseCgroupV2Path('0::/system.slice/shumabit-sessions.service\n');
    assert.equal(cgroupPath, '/system.slice/shumabit-sessions.service');
    assert.equal(
      resolveMemoryEventsPath(cgroupPath),
      '/sys/fs/cgroup/system.slice/shumabit-sessions.service/memory.events',
    );
  });

  test('rejects traversal, empty components, deleted paths, and NUL', () => {
    for (const invalid of [
      '0::/system.slice/../escape\n',
      '0::/system.slice/./escape\n',
      '0::/system.slice//escape\n',
      '0::/system.slice/unit (deleted)\n',
      '0::/system.slice/unit\0escape\n',
    ]) {
      assert.throws(() => parseCgroupV2Path(invalid));
    }
    assert.throws(() => parseCgroupV2Path('0::/first\n0::/second\n'));
    assert.throws(() => resolveMemoryEventsPath('/../../etc', '/sys/fs/cgroup'));
  });

  test('returns null for cgroup v1 and parses oom_kill as BigInt', () => {
    assert.equal(parseCgroupV2Path('2:memory:/legacy\n'), null);
    assert.equal(parseOomKillCounter('low 0\nhigh 2\noom 4\noom_kill 9007199254740993\n'), 9_007_199_254_740_993n);
    assert.throws(() => parseOomKillCounter('oom_kill -1\n'));
    assert.throws(() => parseOomKillCounter('oom 1\n'));
    assert.throws(() => parseOomKillCounter('oom_kill 1\noom_kill 2\n'));
    assert.throws(() => parseOomKillCounter('oom_kill 1\noom_kill\n'));
  });
});

describe('createCgroupOomObserver', () => {
  test('captures once, samples the same cgroup, and detects a counter delta', () => {
    const reads = [];
    let counter = 4n;
    const observer = createCgroupOomObserver({
      platform: 'linux',
      readFileSync(file) {
        reads.push(file);
        if (file === '/proc/self/cgroup') return '0::/system.slice/polygram.service\n';
        return `low 0\noom_kill ${counter}\n`;
      },
    });

    assert.deepEqual(observer.startup, {
      status: 'unchanged',
      detected: false,
      delta: 0n,
    });
    counter = 6n;
    assert.deepEqual(observer.sample(), {
      status: 'detected',
      detected: true,
      delta: 2n,
    });
    assert.equal(reads.filter((file) => file === '/proc/self/cgroup').length, 1);
    assert.equal(reads.at(-1), '/sys/fs/cgroup/system.slice/polygram.service/memory.events');
  });

  test('unchanged counter remains non-detected', () => {
    const observer = createCgroupOomObserver({
      platform: 'linux',
      readFileSync(file) {
        if (file === '/proc/self/cgroup') return '0::/unit\n';
        return 'oom_kill 4\n';
      },
    });
    assert.deepEqual(observer.sample(), {
      status: 'unchanged',
      detected: false,
      delta: 0n,
    });
  });

  test('non-Linux and cgroup v1 are quietly unsupported', () => {
    const nonLinux = createCgroupOomObserver({
      platform: 'darwin',
      readFileSync() {
        throw new Error('must not read');
      },
    });
    assert.equal(nonLinux.startup.status, 'unsupported');
    assert.equal(nonLinux.sample().detected, false);

    const cgroupV1 = createCgroupOomObserver({
      platform: 'linux',
      readFileSync: () => '2:memory:/legacy\n',
    });
    assert.deepEqual(cgroupV1.startup, {
      status: 'unsupported',
      detected: false,
      delta: null,
      reason: 'cgroup-v2-unavailable',
    });
  });

  test('Linux read and counter failures degrade to sanitized unavailable results', () => {
    const startupFailure = createCgroupOomObserver({
      platform: 'linux',
      readFileSync() {
        throw new Error('/secret/path was denied');
      },
    });
    assert.deepEqual(startupFailure.startup, {
      status: 'unavailable',
      detected: false,
      delta: null,
      reason: 'membership-invalid',
    });

    for (const memoryEventsFailure of [
      () => { throw new Error('/secret/memory.events was denied'); },
      () => 'oom_kill not-a-number\n',
    ]) {
      const baselineFailure = createCgroupOomObserver({
        platform: 'linux',
        readFileSync(file) {
          if (file === '/proc/self/cgroup') return '0::/unit\n';
          return memoryEventsFailure();
        },
      });
      assert.deepEqual(baselineFailure.startup, {
        status: 'unavailable',
        detected: false,
        delta: null,
        reason: 'memory-events-unavailable',
      });
      assert.deepEqual(baselineFailure.sample(), baselineFailure.startup);
    }

    let failSample = false;
    const sampleFailure = createCgroupOomObserver({
      platform: 'linux',
      readFileSync(file) {
        if (file === '/proc/self/cgroup') return '0::/unit\n';
        if (failSample) return 'oom_kill not-a-number\n';
        return 'oom_kill 1\n';
      },
    });
    failSample = true;
    assert.deepEqual(sampleFailure.sample(), {
      status: 'unavailable',
      detected: false,
      delta: null,
      reason: 'memory-events-unavailable',
    });
  });

  test('counter reset is unavailable rather than evidence of no OOM', () => {
    let counter = 3;
    const observer = createCgroupOomObserver({
      platform: 'linux',
      readFileSync(file) {
        if (file === '/proc/self/cgroup') return '0::/unit\n';
        return `oom_kill ${counter}\n`;
      },
    });
    counter = 2;
    const sample = observer.sample();
    assert.equal(sample.status, 'unavailable');
    assert.equal(sample.reason, 'oom-kill-counter-decreased');
  });
});
