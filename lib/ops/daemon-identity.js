'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

function createDaemonIdentity({
  mainPath,
  packageVersion,
  pid = process.pid,
  randomUUID = crypto.randomUUID,
  realpathSync = fs.realpathSync,
} = {}) {
  if (typeof mainPath !== 'string' || mainPath.length === 0) {
    throw new TypeError('daemon main path is required');
  }
  if (!PACKAGE_VERSION_RE.test(packageVersion || '')) {
    throw new TypeError('daemon package version is invalid');
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new TypeError('daemon PID is invalid');
  }

  const daemonInstanceId = randomUUID();
  if (!UUID_RE.test(daemonInstanceId)) {
    throw new TypeError('daemon instance identity is invalid');
  }
  const mainRealpath = realpathSync(mainPath);

  return Object.freeze({
    pid,
    daemon_instance_id: daemonInstanceId,
    package_version: packageVersion,
    main_realpath_sha256: crypto.createHash('sha256')
      .update(mainRealpath)
      .digest('hex'),
  });
}

module.exports = { createDaemonIdentity };
