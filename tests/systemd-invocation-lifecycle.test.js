'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSystemdInvocationId,
  lifecycleDetail,
} = require('../lib/ops/systemd-invocation');

test('systemd lifecycle identity is exact and optional off systemd', () => {
  const invocationId = 'a'.repeat(32);
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
});
