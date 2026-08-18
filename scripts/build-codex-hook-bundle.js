#!/usr/bin/env node
'use strict';

// Builds the single self-contained Codex hook bundle from the checked-in
// sources. The build is a pure function of those sources, so `--check` is the
// drift gate: a bundle that no longer regenerates is never installed.

const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');

const {
  HOOK_BUNDLE_PATH,
  HOOK_BUNDLE_SOURCES,
  buildHookBundle,
} = require('../lib/codex/hook-bundle');

const USAGE = 'usage: build-codex-hook-bundle [--check] [--out <path>]';

function parseArgs(argv) {
  const options = { check: false, out: HOOK_BUNDLE_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--out') {
      index += 1;
      options.out = argv[index];
      if (typeof options.out !== 'string' || options.out.length === 0) {
        throw new Error(USAGE);
      }
    } else {
      throw new Error(`${USAGE}\nunknown argument ${argument}`);
    }
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const bundle = buildHookBundle();
  const sha256 = createHash('sha256').update(bundle).digest('hex');

  if (options.check) {
    let current = null;
    try {
      current = readFileSync(options.out, 'utf8');
    } catch {
      process.stderr.write(`missing bundle at ${options.out}\n`);
      return 1;
    }
    if (current !== bundle) {
      process.stderr.write(
        `bundle at ${options.out} is not what the sources build; `
          + 'rebuild it in the same change as the sources\n',
      );
      return 1;
    }
    process.stdout.write(`ok ${sha256}\n`);
    return 0;
  }

  writeFileSync(options.out, bundle, { mode: 0o644 });
  process.stdout.write(
    `${options.out}\nsources ${HOOK_BUNDLE_SOURCES.join(' ')}\nsha256 ${sha256}\n`,
  );
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
