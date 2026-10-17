#!/usr/bin/env node
'use strict';
const { call, readSecret, socketPathFor } = require('../../../lib/ipc/client');
async function main() {
  const [botName, scope, command, json] = process.argv.slice(2);
  if (!botName || !scope || !['status', 'schedule', 'cancel'].includes(command)) throw new Error('Usage: check.js bot scope status | schedule <JSON> | cancel <JSON>');
  const input = command === 'status' ? {} : JSON.parse(json);
  if (command === 'cancel') input.dueAt = null;
  const result = await call({ path: socketPathFor(botName), secret: readSecret(botName), op: command === 'status' ? 'notification_status' : 'notification_wake', payload: { ...input, scope } });
  if (!result.ok) throw new Error(result.error || 'Notification operation failed');
  console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
