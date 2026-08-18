#!/usr/bin/env node
'use strict';

// Operator entry point for the protected Codex hook artifact tree. It is run
// by the account that owns the tree — never by the service account, which must
// not be able to write anything it executes. The closure it installs comes
// from the shipped build output; there is no way to hand it a body.

const {
  attestHookArtifactVersion,
  installHookArtifactVersion,
  listHookArtifactVersions,
  quarantineHookArtifactVersion,
} = require('../lib/codex/hook-artifacts');

const USAGE = [
  'usage: polygram-codex-hook-artifacts <command> [options]',
  '',
  '  install    --artifact-root <dir> --version <v> --runtime-root <dir>',
  '             --runtime-id <id> --runtime-sha256 <hex>',
  '             --operator-uid <uid> --service-uid <uid>',
  '  attest     --artifact-root <dir> --version <v> --runtime-root <dir>',
  '             --runtime-id <id> --runtime-sha256 <hex>',
  '             --operator-uid <uid> --service-uid <uid>',
  '  list       --artifact-root <dir>',
  '  quarantine --artifact-root <dir> --version <v> --runtime-root <dir>',
  '             --runtime-id <id> --runtime-sha256 <hex>',
  '             --operator-uid <uid> --service-uid <uid> --referenced <v1,v2>',
].join('\n');

const FLAGS = new Map([
  ['--artifact-root', 'artifactRoot'],
  ['--version', 'version'],
  ['--runtime-root', 'runtimeRoot'],
  ['--runtime-id', 'runtimeId'],
  ['--runtime-sha256', 'runtimeSha256'],
  ['--operator-uid', 'operatorUid'],
  ['--service-uid', 'serviceUid'],
  ['--referenced', 'referenced'],
]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['install', 'attest', 'list', 'quarantine'].includes(command)) {
    throw new Error(USAGE);
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const name = FLAGS.get(rest[index]);
    const value = rest[index + 1];
    if (!name || typeof value !== 'string') {
      throw new Error(`${USAGE}\n\nunknown or incomplete option ${rest[index]}`);
    }
    options[name] = value;
  }
  return options;
}

function uid(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be the numeric uid of that account`);
  }
  return parsed;
}

function accounts(options) {
  return {
    operatorUid: uid(options.operatorUid, '--operator-uid'),
    serviceUid: uid(options.serviceUid, '--service-uid'),
  };
}

function run(options) {
  switch (options.command) {
    case 'install':
      if (typeof options.runtimeSha256 !== 'string') {
        throw new Error(
          'pass --runtime-sha256 with the expected digest of the protected '
            + 'runtime binary',
        );
      }
      return installHookArtifactVersion({
        artifactRoot: options.artifactRoot,
        version: options.version,
        runtimeRoot: options.runtimeRoot,
        runtimeId: options.runtimeId,
        expectedRuntimeSha256: options.runtimeSha256,
        ...accounts(options),
      });
    case 'attest':
      return attestHookArtifactVersion({
        artifactRoot: options.artifactRoot,
        version: options.version,
        runtimeRoot: options.runtimeRoot,
        runtimeId: options.runtimeId,
        runtimeSha256: options.runtimeSha256,
        ...accounts(options),
      });
    case 'list':
      return listHookArtifactVersions({ artifactRoot: options.artifactRoot });
    case 'quarantine':
      if (typeof options.referenced !== 'string') {
        throw new Error(
          'pass --referenced with every version still referenced by a live '
            + "session, or --referenced '' when none is",
        );
      }
      return quarantineHookArtifactVersion({
        artifactRoot: options.artifactRoot,
        version: options.version,
        runtimeRoot: options.runtimeRoot,
        runtimeId: options.runtimeId,
        runtimeSha256: options.runtimeSha256,
        referencedVersions: options.referenced
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
        ...accounts(options),
      });
    default:
      throw new Error(USAGE);
  }
}

try {
  const result = run(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${error.code ? `${error.code}: ` : ''}${error.message}\n${
      error.action ? `${error.action}\n` : ''
    }`,
  );
  process.exitCode = 1;
}
