'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSystemdInvocationId,
  lifecycleDetail,
} = require('../lib/ops/systemd-invocation');

test('systemd lifecycle identity is exact and optional off systemd', () => {
  const invocationId = 'a'.repeat(32);
  const daemonIdentity = {
    daemon_instance_id: 'e565dbae-44cf-4fc0-b7df-91ee3305e588',
    pid: 4242,
  };
  assert.equal(parseSystemdInvocationId({}), null);
  assert.equal(
    parseSystemdInvocationId({ INVOCATION_ID: invocationId }),
    invocationId,
  );
  assert.throws(
    () => parseSystemdInvocationId({ INVOCATION_ID: 'not-an-invocation' }),
    /invalid systemd invocation identity/,
  );
  assert.deepEqual(
    lifecycleDetail({ clean: true }, invocationId),
    { clean: true, invocation_id: invocationId },
  );
  assert.deepEqual(lifecycleDetail({ clean: true }, null), { clean: true });
  assert.deepEqual(
    lifecycleDetail({ clean: true }, invocationId, daemonIdentity),
    {
      clean: true,
      daemon_instance_id: daemonIdentity.daemon_instance_id,
      pid: daemonIdentity.pid,
      invocation_id: invocationId,
    },
  );
  assert.deepEqual(
    lifecycleDetail({ clean: true }, null, daemonIdentity),
    {
      clean: true,
      daemon_instance_id: daemonIdentity.daemon_instance_id,
      pid: daemonIdentity.pid,
    },
  );
});
