'use strict';

const { execFileSync: defaultExecFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const MAC_HOST_RE = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/;
const MAC_BOOT_RE = /\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/;

class CodexHostIdentityError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'CodexHostIdentityError';
    this.code = code;
  }
}

function identityError(message, code, cause) {
  return new CodexHostIdentityError(
    message,
    code,
    cause ? { cause } : undefined,
  );
}

function rendered(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function digest(domain, ...parts) {
  const hash = createHash('sha256');
  hash.update(domain);
  for (const part of parts) {
    hash.update('\0');
    hash.update(part);
  }
  return hash.digest('hex');
}

function readDarwinIdentity(execFileSync) {
  const hostOutput = rendered(execFileSync(
    '/usr/sbin/ioreg',
    ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024 },
  ));
  const hostMatch = MAC_HOST_RE.exec(hostOutput);
  if (!hostMatch) throw new Error('macOS platform UUID is unavailable');

  const bootOutput = rendered(execFileSync(
    '/usr/sbin/sysctl',
    ['-n', 'kern.boottime'],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 },
  ));
  const bootMatch = MAC_BOOT_RE.exec(bootOutput);
  if (!bootMatch) throw new Error('macOS kernel boot time is unavailable');

  return {
    stable: hostMatch[1].toLowerCase(),
    boot: `${bootMatch[1]}.${bootMatch[2]}`,
  };
}

function resolveCodexHostIdentity({
  platform = process.platform,
  execFileSync = defaultExecFileSync,
} = {}) {
  if (platform !== 'darwin') {
    throw identityError(
      `Codex native macOS beta is unsupported on ${platform}`,
      'CODEX_HOST_PLATFORM_UNSUPPORTED',
    );
  }

  let source;
  try {
    source = readDarwinIdentity(execFileSync);
  } catch (cause) {
    throw identityError(
      'Codex stable host or kernel boot identity could not be verified',
      'CODEX_HOST_IDENTITY_UNAVAILABLE',
      cause,
    );
  }

  const stableDigest = digest(
    'polygram/codex/stable-host/v1',
    platform,
    source.stable,
  );
  return Object.freeze({
    stableHostId: `host:${stableDigest}`,
    bootSessionId: `boot:${digest(
      'polygram/codex/boot-session/v1',
      platform,
      stableDigest,
      source.boot,
    )}`,
  });
}

module.exports = {
  CodexHostIdentityError,
  resolveCodexHostIdentity,
};
