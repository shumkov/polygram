'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const { isAttestationReceipt } = require('./hook-artifacts');

const MAX_ARTIFACTS = 8;
const MAX_ARGV = 16;
const MAX_TOKEN_LENGTH = 4096;

// Path tokens: no whitespace, no quoting, no shell metacharacter, no
// expansion. What survives this set cannot change meaning inside the command
// string Codex stores and executes.
const PATH_TOKEN_RE = /^[A-Za-z0-9._/@:+=-]+$/;

// A literal argument carries no separator at all, so nothing in the argument
// list is ambiguous between a word and a path.
const ARGV_LITERAL_RE = /^[A-Za-z0-9._@:+=-]+$/;
const CODEX_NAME_RE = /^codex([-.].*)?$/i;
const MOVING_ALIASES = new Set(['current', 'latest', 'stable']);

class CodexHookCommandError extends Error {
  constructor(message, code, action) {
    super(message);
    this.name = 'CodexHookCommandError';
    this.code = code;
    this.action = action;
  }
}

function invalid(message) {
  return new CodexHookCommandError(
    message,
    'CODEX_HOOK_COMMAND_INVALID',
    'Declare hook commands as typed descriptors over attested versioned '
      + 'paths and literal arguments.',
  );
}

function unattested(message) {
  return new CodexHookCommandError(
    message,
    'CODEX_HOOK_COMMAND_UNATTESTED',
    'Attest the protected artifact version before rendering a command from it.',
  );
}

function assertCommandPath(value, label) {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_TOKEN_LENGTH) {
    throw invalid(`The hook ${label} path must be a bounded string.`);
  }
  if (!PATH_TOKEN_RE.test(value)) {
    throw invalid(`The hook ${label} path carries an unsafe character.`);
  }
  if (!path.isAbsolute(value) || path.normalize(value) !== value
    || value.includes('//') || value.endsWith('/')) {
    throw invalid(
      `The hook ${label} path must be absolute and canonical; a PATH name or `
        + 'relative path is never resolved.',
    );
  }
  const segments = value.split('/').filter(Boolean);
  if (segments.some((segment) => MOVING_ALIASES.has(segment))) {
    throw invalid(
      `The hook ${label} path names a moving alias instead of a version.`,
    );
  }
  return value;
}

function assertNotCodex(value, label) {
  if (CODEX_NAME_RE.test(path.basename(value))) {
    throw invalid(
      `The hook ${label} names Codex; a hook never nests a Codex invocation.`,
    );
  }
  return value;
}

// Arguments are typed, so what a token means is declared rather than inferred
// from its spelling: a literal is a word with no separator in it, and a path
// argument is an executed input that the attestation must already cover.
function assertArgument(entry, attestedPaths) {
  if (!entry || typeof entry !== 'object') {
    throw invalid(
      'A hook argument must be a typed literal or attested-path entry.',
    );
  }
  if (entry.kind === 'literal') {
    const { value } = entry;
    if (typeof value !== 'string' || value.length === 0
      || value.length > MAX_TOKEN_LENGTH || !ARGV_LITERAL_RE.test(value)) {
      throw invalid(
        'A hook literal argument must be a bounded word without separators, '
          + 'whitespace, quoting, expansion, or shell metacharacters.',
      );
    }
    return assertNotCodex(value, 'argument');
  }
  if (entry.kind === 'attested-path') {
    const target = assertNotCodex(
      assertCommandPath(entry.path, 'argument'),
      'argument',
    );
    if (!attestedPaths.has(target)) {
      throw unattested('A hook argument names an unattested path.');
    }
    return target;
  }
  throw invalid(
    'A hook argument must declare kind "literal" or "attested-path".',
  );
}

// The rendering is a pure function of the descriptor, and `commandSha256` is
// the digest of that rendering — never of hand-written command text.
function renderHookCommand(descriptor, attestation) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw invalid('A hook command descriptor is required.');
  }
  // Only the object a full attestation returned may authorise a rendering; a
  // receipt-shaped literal proves nothing about what is on disk.
  if (!isAttestationReceipt(attestation)) {
    throw unattested(
      'A hook command needs a live receipt from a full artifact attestation.',
    );
  }
  const { runtime, artifacts, argv } = descriptor;
  if (!runtime || typeof runtime !== 'object'
    || runtime.kind !== 'protected-runtime') {
    throw invalid('The descriptor runtime must be a protected runtime.');
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0
    || artifacts.length > MAX_ARTIFACTS) {
    throw invalid('The descriptor must name one to eight protected artifacts.');
  }
  if (!Array.isArray(argv) || argv.length > MAX_ARGV) {
    throw invalid('The descriptor arguments must be a bounded literal list.');
  }

  const runtimePath = assertNotCodex(
    assertCommandPath(runtime.path, 'runtime'),
    'runtime',
  );
  if (runtimePath !== attestation.runtime.path
    || attestation.runtime.kind !== 'protected-runtime') {
    throw unattested('The descriptor runtime is not the attested runtime.');
  }

  const attested = new Map(
    attestation.artifacts.map((entry) => [entry.path, entry]),
  );
  const seen = new Set();
  const artifactPaths = artifacts.map((entry) => {
    if (!entry || typeof entry !== 'object'
      || entry.kind !== 'protected-artifact') {
      throw invalid('Each descriptor artifact must be a protected artifact.');
    }
    const artifactPath = assertCommandPath(entry.path, 'artifact');
    if (seen.has(artifactPath)) {
      throw invalid('A descriptor names the same artifact twice.');
    }
    seen.add(artifactPath);
    const match = attested.get(artifactPath);
    if (!match || match.kind !== 'protected-artifact') {
      throw unattested('A descriptor artifact is not in the attested closure.');
    }
    return artifactPath;
  });

  const attestedPaths = new Set([
    attestation.runtime.path,
    ...attestation.artifacts.map((entry) => entry.path),
  ]);
  const tokens = [
    runtimePath,
    ...artifactPaths,
    ...argv.map((entry) => assertArgument(entry, attestedPaths)),
  ];
  const command = tokens.map((token) => `'${token}'`).join(' ');
  return Object.freeze({
    command,
    sha256: createHash('sha256').update(command).digest('hex'),
  });
}

module.exports = {
  CodexHookCommandError,
  renderHookCommand,
};
