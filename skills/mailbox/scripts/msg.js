#!/usr/bin/env node
'use strict';
const { call, readSecret, socketPathFor } = require('../../../lib/ipc/client');
async function main() {
  const [botName, token, command, json] = process.argv.slice(2);
  if (!botName || !token || !['send', 'reply'].includes(command) || !json) throw new Error('Usage: msg.js bot token send <JSON> | reply <JSON>');
  const input = JSON.parse(json);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('One JSON object argument required');
  // `op`, `id` and `secret` belong to the IPC envelope, so they are dropped
  // from the agent's JSON: they could otherwise reroute the call or replace
  // the request id. The ask being answered travels as inReplyTo, and the
  // token from the command line always wins over anything in the JSON.
  const { op, id, secret, ...fields } = input;
  const payload = command === 'reply' ? { ...fields, inReplyTo: id, token } : { ...fields, token };
  const result = await call({ path: socketPathFor(botName), secret: readSecret(botName), op: command === 'send' ? 'mailbox_send' : 'mailbox_reply', payload });
  if (!result.ok) throw new Error(result.error || 'Mailbox operation failed');
  console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
