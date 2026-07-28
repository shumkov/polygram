'use strict';

const { execFileSync: defaultExecFileSync } = require('node:child_process');
const { createHash, createHmac } = require('node:crypto');
const { readFileSync: defaultReadFileSync } = require('node:fs');

const MAC_HOST_RE = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/;
const MAC_BOOT_RE = /\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/;
const LINUX_MACHINE_ID_RE = /^[0-9a-f]{32}$/;
const LINUX_BOOT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function hmacDigest(key, ...parts) {
  const hmac = createHmac('sha256', key);
  for (const part of parts) hmac.update(part);
  return hmac.digest('hex');
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

function canonicalLinuxSource(value, pattern, maxBytes) {
  const raw = rendered(value);
  if (
    Buffer.byteLength(raw, 'utf8') > maxBytes
    || (raw.includes('\n') && !raw.endsWith('\n'))
  ) {
    throw new Error('Linux identity source is malformed');
  }
  const normalized = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!pattern.test(normalized)) {
    throw new Error('Linux identity source is malformed');
  }
  return normalized;
}

function readLinuxIdentity(readFileSync) {
  const machineId = canonicalLinuxSource(
    readFileSync('/etc/machine-id', 'utf8'),
    LINUX_MACHINE_ID_RE,
    33,
  );
  if (/^0{32}$/.test(machineId)) {
    throw new Error('Linux machine identity is uninitialized');
  }
  const bootId = canonicalLinuxSource(
    readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
    LINUX_BOOT_ID_RE,
    37,
  );
  return {
    machineBytes: Buffer.from(machineId, 'hex'),
    bootBytes: Buffer.from(bootId.replaceAll('-', ''), 'hex'),
  };
}

function resolveCodexHostIdentity({
  platform = process.platform,
  execFileSync = defaultExecFileSync,
  readFileSync = defaultReadFileSync,
} = {}) {
  if (!['darwin', 'linux'].includes(platform)) {
    throw identityError(
      `Codex native beta is unsupported on ${platform}`,
      'CODEX_HOST_PLATFORM_UNSUPPORTED',
    );
  }

  let source;
  try {
    source = platform === 'darwin'
      ? readDarwinIdentity(execFileSync)
      : readLinuxIdentity(readFileSync);
  } catch (cause) {
    throw identityError(
      'Codex stable host or kernel boot identity could not be verified',
      'CODEX_HOST_IDENTITY_UNAVAILABLE',
      cause,
    );
  }

  if (platform === 'linux') {
    return Object.freeze({
      stableHostId: `host:${hmacDigest(
        'polygram/codex/stable-host/linux/v1',
        source.machineBytes,
      )}`,
      bootSessionId: `boot:${hmacDigest(
        'polygram/codex/boot-session/linux/v1',
        source.machineBytes,
        source.bootBytes,
      )}`,
    });
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
