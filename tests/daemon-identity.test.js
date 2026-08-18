'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDaemonIdentity } = require('../lib/ops/daemon-identity');

test('daemon identity binds one boot UUID and PID to the real main path and package version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-daemon-identity-'));
  try {
    const release = path.join(root, 'release');
    fs.mkdirSync(release);
    const mainPath = path.join(release, 'polygram.js');
    fs.writeFileSync(mainPath, '// fixture\n');
    const current = path.join(root, 'current.js');
    fs.symlinkSync(mainPath, current);
    const daemonInstanceId = 'e565dbae-44cf-4fc0-b7df-91ee3305e588';

    const identity = createDaemonIdentity({
      mainPath: current,
      packageVersion: '0.38.1',
      pid: 4242,
      randomUUID: () => daemonInstanceId,
    });

    assert.deepEqual(identity, {
      pid: 4242,
      daemon_instance_id: daemonInstanceId,
      package_version: '0.38.1',
      main_realpath_sha256: crypto.createHash('sha256')
        .update(fs.realpathSync(mainPath))
        .digest('hex'),
    });
    assert.equal(Object.isFrozen(identity), true);
    assert.doesNotMatch(JSON.stringify(identity), new RegExp(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('each daemon identity generation uses one fresh valid UUID', () => {
  const mainPath = fs.realpathSync(path.join(__dirname, '..', 'polygram.js'));
  const generated = [
    'e565dbae-44cf-4fc0-b7df-91ee3305e588',
    '0b65ec58-0822-48c3-b5f5-bff9e9305875',
  ];
  let calls = 0;

  const first = createDaemonIdentity({
    mainPath,
    packageVersion: '0.38.1',
    pid: 4242,
    randomUUID: () => generated[calls++],
  });
  const second = createDaemonIdentity({
    mainPath,
    packageVersion: '0.38.1',
    pid: 4242,
    randomUUID: () => generated[calls++],
  });

  assert.equal(calls, 2);
  assert.equal(first.daemon_instance_id, generated[0]);
  assert.equal(second.daemon_instance_id, generated[1]);
  assert.notEqual(first.daemon_instance_id, second.daemon_instance_id);
});
