#!/usr/bin/env node
'use strict';
const { call, readSecret, socketPathFor } = require('../../../lib/ipc/client');
async function main() {
  const [botName, token, command, json] = process.argv.slice(2);
  if (!botName || !token || !['send', 'reply'].includes(command) || !json) throw new Error('Usage: msg.js bot token send <JSON> | reply <JSON>');
  const input = JSON.parse(json);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('One JSON object argument required');
  // The IPC envelope reserves `id` for its own request id, so the ask being
  // answered travels as inReplyTo. The token from the command line always
  // wins over anything inside the JSON.
  const { id, ...rest } = input;
  const payload = command === 'reply' ? { ...rest, inReplyTo: id, token } : { ...input, token };
  const result = await call({ path: socketPathFor(botName), secret: readSecret(botName), op: command === 'send' ? 'mailbox_send' : 'mailbox_reply', payload });
  if (!result.ok) throw new Error(result.error || 'Mailbox operation failed');
  console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
