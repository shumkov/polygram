'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CodexHostIdentityError,
  resolveCodexHostIdentity,
} = require('../lib/codex/host-identity');

test('derives redacted stable macOS host and boot-session identities', () => {
  const calls = [];
  const identity = resolveCodexHostIdentity({
    platform: 'darwin',
    execFileSync(file, args) {
      calls.push([file, args]);
      if (file === '/usr/sbin/ioreg') {
        return Buffer.from(
          '    |   "IOPlatformUUID" = "01234567-89AB-CDEF-0123-456789ABCDEF"\n',
        );
      }
      if (file === '/usr/sbin/sysctl') {
        return '{ sec = 1780000000, usec = 42 } Sun May 31 00:00:00 2026\n';
      }
      throw new Error(`unexpected executable ${file}`);
    },
  });

  assert.equal(
    identity.stableHostId,
    'host:dda4442821794ae69a907e13696600e96a9174cbda56ce219901431858328bc6',
  );
  assert.equal(
    identity.bootSessionId,
    'boot:81629cacb5d6654afafea27d0497fefa7c03bc7bba7ae08d966179b037ae42e5',
  );
  assert.doesNotMatch(
    JSON.stringify(identity),
    /01234567|1780000000|IOPlatformUUID/,
  );
  assert.deepEqual(calls, [
    ['/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']],
    ['/usr/sbin/sysctl', ['-n', 'kern.boottime']],
  ]);
  assert.ok(Object.isFrozen(identity));
});

test('derives the frozen Linux byte-ABI identity from fixed kernel sources', () => {
  const calls = [];
  const identity = resolveCodexHostIdentity({
    platform: 'linux',
    readFileSync(file, encoding) {
      calls.push([file, encoding]);
      if (file === '/etc/machine-id') {
        return '0123456789abcdef0123456789abcdef\n';
      }
      if (file === '/proc/sys/kernel/random/boot_id') {
        return '11111111-2222-4333-8444-555555555555\n';
      }
      throw new Error(`unexpected identity source ${file}`);
    },
  });

  assert.equal(
    identity.stableHostId,
    'host:b31d5ae71acd368ab2297814cf7c483ade00dfa4be7ab8d3faf2e67e57418734',
  );
  assert.equal(
    identity.bootSessionId,
    'boot:f8f5ef453e1c98731241349e6f816e044a7389ac5427d29de593d884a6316d09',
  );
  assert.deepEqual(calls, [
    ['/etc/machine-id', 'utf8'],
    ['/proc/sys/kernel/random/boot_id', 'utf8'],
  ]);
  assert.doesNotMatch(
    JSON.stringify(identity),
    /0123456789abcdef|11111111-2222/,
  );
  assert.ok(Object.isFrozen(identity));
});

test('Linux stable identity changes only with the machine ID', () => {
  const makeIdentity = (machineId, bootId) => resolveCodexHostIdentity({
    platform: 'linux',
    readFileSync(file) {
      return file === '/etc/machine-id' ? machineId : bootId;
    },
  });
  const before = makeIdentity(
    '0123456789abcdef0123456789abcdef',
    '11111111-2222-4333-8444-555555555555',
  );
  const rebooted = makeIdentity(
    '0123456789abcdef0123456789abcdef',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  );
  const relocated = makeIdentity(
    'fedcba9876543210fedcba9876543210',
    '11111111-2222-4333-8444-555555555555',
  );

  assert.equal(before.stableHostId, rebooted.stableHostId);
  assert.notEqual(before.bootSessionId, rebooted.bootSessionId);
  assert.notEqual(before.stableHostId, relocated.stableHostId);
  assert.notEqual(before.bootSessionId, relocated.bootSessionId);
});

test('same macOS host is stable while a new kernel boot changes only boot ID', () => {
  const makeIdentity = (bootSeconds) => resolveCodexHostIdentity({
    platform: 'darwin',
    execFileSync(file) {
      return file === '/usr/sbin/ioreg'
        ? '"IOPlatformUUID" = "01234567-89AB-CDEF-0123-456789ABCDEF"'
        : `{ sec = ${bootSeconds}, usec = 0 }`;
    },
  });

  const before = makeIdentity(1780000000);
  const after = makeIdentity(1780000001);
  assert.equal(before.stableHostId, after.stableHostId);
  assert.notEqual(before.bootSessionId, after.bootSessionId);
});

test('fails closed on malformed, missing, or unsupported identity sources', () => {
  assert.throws(
    () => resolveCodexHostIdentity({
      platform: 'darwin',
      execFileSync() { return 'malformed'; },
    }),
    (error) => (
      error instanceof CodexHostIdentityError
      && error.code === 'CODEX_HOST_IDENTITY_UNAVAILABLE'
    ),
  );
  const invalidLinuxSources = [{
    machine: '',
    boot: '11111111-2222-4333-8444-555555555555',
  }, {
    machine: 'uninitialized\n',
    boot: '11111111-2222-4333-8444-555555555555',
  }, {
    machine: '00000000000000000000000000000000',
    boot: '11111111-2222-4333-8444-555555555555',
  }, {
    machine: '0123456789ABCDEF0123456789ABCDEF',
    boot: '11111111-2222-4333-8444-555555555555',
  }, {
    machine: '0123456789abcdef0123456789abcdef\n\n',
    boot: '11111111-2222-4333-8444-555555555555',
  }, {
    machine: '0123456789abcdef0123456789abcdef',
    boot: '00000000-0000-0000-0000-000000000000',
  }, {
    machine: '0123456789abcdef0123456789abcdef',
    boot: '11111111-2222-3333-4444-555555555555',
  }, {
    machine: '0123456789abcdef0123456789abcdef',
    boot: '11111111-2222-4333-8444-555555555555\r\n',
  }];
  for (const { machine, boot } of invalidLinuxSources) {
    assert.throws(
      () => resolveCodexHostIdentity({
        platform: 'linux',
        readFileSync(file) {
          return file === '/etc/machine-id' ? machine : boot;
        },
      }),
      (error) => (
        error instanceof CodexHostIdentityError
        && error.code === 'CODEX_HOST_IDENTITY_UNAVAILABLE'
        && (!machine || !error.message.includes(machine))
        && (!boot || !error.message.includes(boot))
      ),
    );
  }
  assert.throws(
    () => resolveCodexHostIdentity({
      platform: 'linux',
      readFileSync() {
        const error = new Error('source missing');
        error.code = 'ENOENT';
        throw error;
      },
    }),
    (error) => (
      error instanceof CodexHostIdentityError
      && error.code === 'CODEX_HOST_IDENTITY_UNAVAILABLE'
    ),
  );
  assert.throws(
    () => resolveCodexHostIdentity({ platform: 'win32' }),
    (error) => (
      error instanceof CodexHostIdentityError
      && error.code === 'CODEX_HOST_PLATFORM_UNSUPPORTED'
    ),
  );
});
