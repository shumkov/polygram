#!/usr/bin/env node
/**
 * Quick IPC round-trip probe.
 * Usage: node scripts/ipc-smoke.js <bot-name>
 */

const { call, socketPathFor } = require('../lib/ipc/client');

(async () => {
  const bot = process.argv[2] || 'shumabit';
  const path = socketPathFor(bot);

  console.log('path:', path);
  console.log('ping:', JSON.stringify(await call({ path, op: 'ping' })));
  console.log('DONE');
})().catch((err) => {
  console.error('ERR:', err.message);
  process.exit(1);
});
