import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  access, lstat, open, realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { subscriptionOnlyEnv } from './adapters.mjs';

const require = createRequire(import.meta.url);
const { CLAUDE_CLI_PINNED_VERSION } = require('@shumkov/orchestra/lib/claude-bin');
const defaultExecFile = promisify(execFile);

export const EXPECTED_CLAUDE_VERSION = `${CLAUDE_CLI_PINNED_VERSION} (Claude Code)`;

async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function runtimeError(cause) {
  return Object.assign(new Error('ROUTER_CLAUDE_RUNTIME_MISMATCH'), {
    code: 'ROUTER_CLAUDE_RUNTIME_MISMATCH',
    cause,
  });
}

async function readRuntimeIdentity(canonicalPath) {
  const handle = await open(canonicalPath, 'r');
  try {
    const [pathInfo, handleInfo] = await Promise.all([
      lstat(canonicalPath),
      handle.stat(),
    ]);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || !handleInfo.isFile()
        || pathInfo.dev !== handleInfo.dev || pathInfo.ino !== handleInfo.ino
        || pathInfo.size !== handleInfo.size || pathInfo.mode !== handleInfo.mode
        || pathInfo.ctimeMs !== handleInfo.ctimeMs || pathInfo.mtimeMs !== handleInfo.mtimeMs) {
      throw new Error('Claude runtime path identity changed while opening');
    }
    return {
      dev: handleInfo.dev,
      ino: handleInfo.ino,
      size: handleInfo.size,
      mode: handleInfo.mode,
      ctimeMs: handleInfo.ctimeMs,
      mtimeMs: handleInfo.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

function validExpectedRuntime(expected) {
  return expected
    && typeof expected.canonicalPath === 'string'
    && path.isAbsolute(expected.canonicalPath)
    && expected.version === EXPECTED_CLAUDE_VERSION
    && /^[a-f0-9]{64}$/.test(expected.sha256)
    && ['dev', 'ino', 'size', 'mode'].every((field) => Number.isInteger(expected[field]))
    && ['ctimeMs', 'mtimeMs'].every((field) => Number.isFinite(expected[field]) && expected[field] >= 0);
}

export async function attestClaudeRuntime(binary, {
  execFileCommand = defaultExecFile,
  hashFile = sha256File,
} = {}) {
  try {
    if (typeof binary !== 'string' || !path.isAbsolute(binary)) {
      throw new TypeError('Claude binary must be absolute');
    }
    const canonicalPath = await realpath(binary);
    await access(canonicalPath, fsConstants.X_OK);
    const identity = await readRuntimeIdentity(canonicalPath);
    const { stdout } = await execFileCommand(canonicalPath, ['--version'], {
      env: subscriptionOnlyEnv(),
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16_384,
    });
    const version = stdout.trim();
    if (version !== EXPECTED_CLAUDE_VERSION) throw new Error('unexpected Claude version');
    return {
      canonicalPath,
      sha256: await hashFile(canonicalPath),
      version,
      ...identity,
    };
  } catch (cause) {
    throw runtimeError(cause);
  }
}

export async function assertClaudeRuntimeIdentityUnchanged(expected) {
  try {
    if (!validExpectedRuntime(expected)) {
      throw new TypeError('invalid attested Claude runtime');
    }
    const canonicalPath = await realpath(expected.canonicalPath);
    await access(canonicalPath, fsConstants.X_OK);
    const identity = await readRuntimeIdentity(canonicalPath);
    if (canonicalPath !== expected.canonicalPath
        || ['dev', 'ino', 'size', 'mode', 'ctimeMs', 'mtimeMs']
          .some((field) => identity[field] !== expected[field])) {
      throw new Error('Claude runtime changed after attestation');
    }
    return expected;
  } catch (cause) {
    if (cause?.code === 'ROUTER_CLAUDE_RUNTIME_MISMATCH') throw cause;
    throw runtimeError(cause);
  }
}

export async function assertClaudeRuntimeUnchanged(expected, {
  hashFile = sha256File,
} = {}) {
  try {
    await assertClaudeRuntimeIdentityUnchanged(expected);
    if (await hashFile(expected.canonicalPath) !== expected.sha256) {
      throw new Error('Claude runtime changed after attestation');
    }
    return expected;
  } catch (cause) {
    if (cause?.code === 'ROUTER_CLAUDE_RUNTIME_MISMATCH') throw cause;
    throw runtimeError(cause);
  }
}
