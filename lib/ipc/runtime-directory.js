'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIRECTORY_NAME = '.ipc';
const BOT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_BOT_NAME_BYTES = 64;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

function ipcDirectoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function currentUid() {
  if (typeof process.getuid !== 'function') {
    throw ipcDirectoryError(
      'IPC_DIR_UID_UNAVAILABLE',
      'IPC directory ownership cannot be verified on this platform',
    );
  }
  return process.getuid();
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === ''
    || (
      !relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative)
    )
  );
}

function existingRealpath(candidate) {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function temporaryRoots() {
  const roots = new Set([
    '/tmp',
    '/private/tmp',
    '/var/tmp',
    '/private/var/tmp',
    path.resolve(os.tmpdir()),
  ]);
  for (const root of [...roots]) {
    const canonical = existingRealpath(root);
    if (canonical) roots.add(canonical);
  }
  return [...roots];
}

function assertNonTemporary(candidate) {
  const paths = [candidate];
  const canonical = existingRealpath(candidate);
  if (canonical) paths.push(canonical);
  if (paths.some((item) => temporaryRoots().some((root) => isWithin(item, root)))) {
    throw ipcDirectoryError(
      'IPC_DIR_TEMPORARY',
      'IPC directory must not be located in a temporary directory',
    );
  }
}

function assertOwnedDirectory(candidate, { exactMode = null, label = 'IPC directory' } = {}) {
  let entry;
  try {
    entry = fs.lstatSync(candidate);
  } catch (cause) {
    throw ipcDirectoryError('IPC_DIR_UNAVAILABLE', `${label} is unavailable`);
  }
  if (entry.isSymbolicLink()) {
    throw ipcDirectoryError('IPC_DIR_SYMLINK', `${label} must not be a symlink`);
  }
  if (!entry.isDirectory()) {
    throw ipcDirectoryError('IPC_DIR_NOT_DIRECTORY', `${label} must be a directory`);
  }

  const canonical = existingRealpath(candidate);
  if (!canonical || canonical !== candidate) {
    throw ipcDirectoryError('IPC_DIR_NOT_CANONICAL', `${label} must be canonical and contain no symlinks`);
  }

  const stat = fs.statSync(candidate);
  if (stat.uid !== currentUid()) {
    throw ipcDirectoryError('IPC_DIR_WRONG_OWNER', `${label} must be owned by the current user`);
  }
  const mode = stat.mode & 0o777;
  if (exactMode !== null && mode !== exactMode) {
    throw ipcDirectoryError('IPC_DIR_WRONG_MODE', `${label} must have mode 0700`);
  }
  return stat;
}

function assertSafeCreationParent(candidate) {
  const parent = path.dirname(candidate);
  const stat = assertOwnedDirectory(parent, { label: 'IPC directory parent' });
  if ((stat.mode & 0o022) !== 0) {
    throw ipcDirectoryError(
      'IPC_DIR_UNSAFE_PARENT',
      'IPC directory parent must not be group- or world-writable',
    );
  }
}

/**
 * Resolve the one IPC runtime directory used by the daemon and its clients.
 *
 * The default stays under Polygram's DATA_DIR (`process.cwd()`), which is
 * already outside agent write access. An override is accepted only as an
 * absolute, canonical, non-temporary path.
 */
function runtimeDirectory({ cwd = process.cwd(), env = process.env } = {}) {
  const hasOverride = Object.prototype.hasOwnProperty.call(env, 'POLYGRAM_IPC_DIR');
  const configured = hasOverride
    ? env.POLYGRAM_IPC_DIR
    : path.join(cwd, DEFAULT_DIRECTORY_NAME);

  if (typeof configured !== 'string' || configured.length === 0) {
    throw ipcDirectoryError('IPC_DIR_INVALID', 'IPC directory must be a non-empty path');
  }
  if (!path.isAbsolute(configured)) {
    throw ipcDirectoryError('IPC_DIR_RELATIVE', 'IPC directory must be absolute');
  }

  const resolved = path.resolve(configured);
  if (resolved !== configured) {
    throw ipcDirectoryError('IPC_DIR_NOT_CANONICAL', 'IPC directory path must be canonical');
  }
  assertNonTemporary(resolved);
  assertSafeCreationParent(resolved);

  if (fs.existsSync(resolved)) {
    assertOwnedDirectory(resolved, { exactMode: 0o700 });
  }
  return resolved;
}

/**
 * Create the resolved runtime directory exactly once with owner-only access,
 * then revalidate it to catch pre-existing or raced unsafe filesystem state.
 */
function ensureRuntimeDirectory(options) {
  const directory = runtimeDirectory(options);
  if (!fs.existsSync(directory)) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw ipcDirectoryError('IPC_DIR_CREATE_FAILED', 'IPC directory could not be created');
      }
    }
  }
  assertOwnedDirectory(directory, { exactMode: 0o700 });
  return directory;
}

function validateBotName(botName) {
  if (
    typeof botName !== 'string'
    || Buffer.byteLength(botName, 'utf8') > MAX_BOT_NAME_BYTES
    || !BOT_NAME_PATTERN.test(botName)
  ) {
    throw ipcDirectoryError(
      'IPC_BOT_NAME_INVALID',
      'IPC bot name may contain only letters, numbers, underscores, and hyphens',
    );
  }
  return botName;
}

function socketPathFor(botName, options) {
  const safeBotName = validateBotName(botName);
  const socketPath = path.join(
    runtimeDirectory(options),
    `polygram-${safeBotName}.sock`,
  );
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw ipcDirectoryError(
      'IPC_SOCKET_PATH_TOO_LONG',
      'IPC socket path exceeds the portable Unix-domain socket limit',
    );
  }
  return socketPath;
}

function secretPathFor(botName, options) {
  const safeBotName = validateBotName(botName);
  return path.join(runtimeDirectory(options), `polygram-${safeBotName}.secret`);
}

module.exports = {
  runtimeDirectory,
  ensureRuntimeDirectory,
  socketPathFor,
  secretPathFor,
  validateBotName,
};
