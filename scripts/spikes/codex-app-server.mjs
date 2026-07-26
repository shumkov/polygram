#!/usr/bin/env node

import { constants, lstatSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    orchestraSpike: process.env.ORCHESTRA_CODEX_SPIKE
      ?? resolve(here, '../../../orchestra/scripts/spikes/codex-app-server-real.mjs'),
    binary: process.env.POLYGRAM_CODEX_BIN ?? '',
    launcher: process.env.ORCHESTRA_SESSION_LAUNCHER ?? '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--orchestra-spike') options.orchestraSpike = argv[++index] ?? '';
    else if (arg === '--binary') options.binary = argv[++index] ?? '';
    else if (arg === '--launcher') options.launcher = argv[++index] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function requireAbsoluteFile(path, label, executable = false) {
  if (!path || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if (executable) await access(path, constants.X_OK);
}

function childEnvironment() {
  return Object.fromEntries(
    ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await requireAbsoluteFile(options.binary, 'Codex binary', true);
  await requireAbsoluteFile(options.orchestraSpike, 'Orchestra U1a spike');
  if (options.launcher) {
    await requireAbsoluteFile(options.launcher, 'session launcher', true);
  }

  const args = [
    options.orchestraSpike,
    '--binary',
    options.binary,
    ...(options.launcher ? ['--launcher', options.launcher] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: childEnvironment(),
    stdio: 'inherit',
  });

  let settled = false;
  const forward = (signal) => {
    if (settled || child.pid === undefined) return;
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const outcome = await new Promise((resolveOutcome, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveOutcome({ code, signal }));
  });
  settled = true;
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);

  if (outcome.signal) {
    process.stderr.write(`Orchestra U1a spike ended by ${outcome.signal}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = outcome.code ?? 1;
  }
}

main().catch((error) => {
  process.stderr.write(`Polygram Codex U1a launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});
