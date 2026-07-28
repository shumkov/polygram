'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  createReadStream,
  lstatSync,
  realpathSync,
  statSync,
} = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const { resolveCodexTargetPin } = require('@shumkov/orchestra');

const CONTROLLED_PATH = '/usr/bin:/bin';
const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const VERSION_PROBE_MAX_BYTES = 4 * 1024;

class CodexBinaryError extends Error {
  constructor(message, code, action, options) {
    super(message, options);
    this.name = 'CodexBinaryError';
    this.code = code;
    this.action = action;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function binaryAction(version) {
  return (
    `Install ${version} as an immutable versioned executable and set `
    + 'POLYGRAM_CODEX_BIN to its canonical absolute path.'
  );
}

function fail(message, code, version, cause) {
  return new CodexBinaryError(
    message,
    code,
    binaryAction(version),
    cause ? { cause } : undefined,
  );
}

function fingerprint(binary, cliVersion) {
  const stat = statSync(binary, { bigint: true });
  if (!stat.isFile()) {
    throw fail(
      'Pinned Codex binary is not a regular file.',
      'CODEX_BINARY_MISMATCH',
      cliVersion,
    );
  }
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    nlink: Number(stat.nlink),
  };
}

function sameFingerprint(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function hashFile(binary) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(binary);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function validatePin({ target, cliVersion, binarySha256 }) {
  if (
    typeof target !== 'string'
    || target.length === 0
    || typeof cliVersion !== 'string'
    || cliVersion.length === 0
    || !SHA256_RE.test(binarySha256)
  ) {
    throw new TypeError(
      'Pinned Codex resolver requires an exact target, version, and lowercase SHA-256.',
    );
  }
}

function createPinnedCodexBinaryResolver({
  cliVersion,
  binarySha256,
  resolveTargetPin = resolveCodexTargetPin,
  execFileFn = promisify(execFile),
  platform = process.platform,
  arch = process.arch,
  getuid = process.getuid?.bind(process),
} = {}) {
  if ((cliVersion === undefined) !== (binarySha256 === undefined)) {
    throw new TypeError(
      'Pinned Codex resolver fixture version and SHA-256 must be supplied together.',
    );
  }
  if (typeof resolveTargetPin !== 'function' || typeof execFileFn !== 'function') {
    throw new TypeError(
      'Pinned Codex resolver requires target and process resolver functions.',
    );
  }

  return async function resolve({
    binaryPath,
    env = process.env,
  } = {}) {
    let reviewedPin;
    try {
      reviewedPin = resolveTargetPin(platform, arch);
    } catch (error) {
      if (error?.code === 'CODEX_UNSUPPORTED_PLATFORM') {
        throw new CodexBinaryError(
          'The native Codex beta does not support this host target.',
          'CODEX_BINARY_PLATFORM_UNSUPPORTED',
          'Use a reviewed macOS arm64 or Linux x64 host.',
          { cause: error },
        );
      }
      throw error;
    }
    const pin = {
      target: reviewedPin?.target,
      cliVersion: cliVersion ?? reviewedPin?.cliVersion,
      binarySha256: binarySha256 ?? reviewedPin?.binarySha256,
    };
    validatePin(pin);

    const configured = binaryPath ?? env?.POLYGRAM_CODEX_BIN;
    if (typeof configured !== 'string' || configured.length === 0) {
      throw new CodexBinaryError(
        'Pinned Codex binary is not configured.',
        'CODEX_BINARY_NOT_CONFIGURED',
        binaryAction(pin.cliVersion),
      );
    }
    if (!path.isAbsolute(configured)) {
      throw fail(
        'Pinned Codex binary must be an absolute path; PATH lookup is disabled.',
        'CODEX_BINARY_NOT_ABSOLUTE',
        pin.cliVersion,
      );
    }

    let canonical;
    try {
      canonical = realpathSync(configured);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw fail(
          'Pinned Codex binary is missing.',
          'CODEX_BINARY_MISSING',
          pin.cliVersion,
          error,
        );
      }
      throw fail(
        'Pinned Codex binary could not be resolved safely.',
        'CODEX_BINARY_MISMATCH',
        pin.cliVersion,
        error,
      );
    }
    if (canonical !== configured) {
      throw fail(
        'Pinned Codex binary path must be canonical and must not be a symlink.',
        'CODEX_BINARY_MISMATCH',
        pin.cliVersion,
      );
    }

    try {
      const allowedOwners = new Set([0]);
      if (typeof getuid === 'function') allowedOwners.add(getuid());
      const root = path.parse(canonical).root;
      let component = root;
      for (const part of canonical.slice(root.length).split('/').filter(Boolean)) {
        component = path.join(component, part);
        const stat = lstatSync(component);
        if (
          stat.isSymbolicLink()
          || !allowedOwners.has(stat.uid)
          || (stat.mode & 0o022) !== 0
        ) {
          throw fail(
            'Pinned Codex binary path ownership or mode is unsafe.',
            'CODEX_BINARY_MISMATCH',
            pin.cliVersion,
          );
        }
      }

      const before = fingerprint(canonical, pin.cliVersion);
      if (
        (before.mode & 0o022) !== 0
        || (before.mode & 0o111) === 0
        || !allowedOwners.has(before.uid)
        || before.nlink !== 1
      ) {
        throw fail(
          'Pinned Codex binary ownership or mode is unsafe.',
          'CODEX_BINARY_MISMATCH',
          pin.cliVersion,
        );
      }

      const actualSha256 = await hashFile(canonical);
      if (actualSha256 !== pin.binarySha256) {
        throw fail(
          'Pinned Codex binary checksum does not match the reviewed runtime.',
          'CODEX_BINARY_MISMATCH',
          pin.cliVersion,
        );
      }

      let stdout;
      try {
        ({ stdout } = await execFileFn(canonical, ['--version'], {
          encoding: 'utf8',
          timeout: VERSION_PROBE_TIMEOUT_MS,
          maxBuffer: VERSION_PROBE_MAX_BYTES,
          env: { PATH: CONTROLLED_PATH },
        }));
      } catch (error) {
        throw fail(
          'Pinned Codex binary version probe failed.',
          'CODEX_BINARY_MISMATCH',
          pin.cliVersion,
          error,
        );
      }
      if (typeof stdout !== 'string' || stdout.trim() !== pin.cliVersion) {
        throw fail(
          'Pinned Codex binary version does not match the reviewed runtime.',
          'CODEX_BINARY_MISMATCH',
          pin.cliVersion,
        );
      }

      if (
        realpathSync(canonical) !== canonical
        || !sameFingerprint(before, fingerprint(canonical, pin.cliVersion))
      ) {
        throw fail(
          'Pinned Codex binary changed during verification.',
          'CODEX_BINARY_MISMATCH',
          pin.cliVersion,
        );
      }

      return deepFreeze({
        path: canonical,
        target: pin.target,
        version: pin.cliVersion,
        sha256: actualSha256,
        fingerprint: before,
      });
    } catch (error) {
      if (error instanceof CodexBinaryError) throw error;
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw fail(
          'Pinned Codex binary disappeared during verification.',
          'CODEX_BINARY_MISSING',
          pin.cliVersion,
          error,
        );
      }
      throw fail(
        'Pinned Codex binary failed ownership and integrity verification.',
        'CODEX_BINARY_MISMATCH',
        pin.cliVersion,
        error,
      );
    }
  };
}

// Application code uses this fixed resolver. The factory exists so a pin
// upgrade can verify its candidate fixture before changing the production pin.
const resolvePinnedCodexBinary = createPinnedCodexBinaryResolver();

module.exports = {
  CodexBinaryError,
  createPinnedCodexBinaryResolver,
  resolvePinnedCodexBinary,
};
