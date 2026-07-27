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

  assert.match(identity.stableHostId, /^host:[a-f0-9]{64}$/);
  assert.match(identity.bootSessionId, /^boot:[a-f0-9]{64}$/);
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
  assert.throws(
    () => resolveCodexHostIdentity({ platform: 'linux' }),
    (error) => (
      error instanceof CodexHostIdentityError
      && error.code === 'CODEX_HOST_PLATFORM_UNSUPPORTED'
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
