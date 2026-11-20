#!/usr/bin/env node
'use strict';
const { call, readSecret, socketPathFor } = require('../../../lib/ipc/client');

// Each command maps to one IPC op. `directory` and `open` read only; their
// JSON argument is optional.
const OPS = { send: 'mailbox_send', reply: 'mailbox_reply', directory: 'mailbox_directory', open: 'mailbox_open' };
const NEEDS_JSON = new Set(['send', 'reply']);

async function main() {
  const [botName, token, command, json] = process.argv.slice(2);
  if (!botName || !token || !Object.hasOwn(OPS, command) || (NEEDS_JSON.has(command) && !json)) {
    throw new Error('Usage: msg.js bot token send <JSON> | reply <JSON> | directory | open');
  }
  const input = json === undefined ? {} : JSON.parse(json);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('One JSON object argument required');
  // `op`, `id` and `secret` belong to the IPC envelope, so they are dropped
  // from the agent's JSON: they could otherwise reroute the call or replace
  // the request id. The ask being answered travels as inReplyTo, and the
  // token from the command line always wins over anything in the JSON.
  const { op, id, secret, ...fields } = input;
  const payload = command === 'reply' ? { ...fields, inReplyTo: id, token } : { ...fields, token };
  const result = await call({ path: socketPathFor(botName), secret: readSecret(botName), op: OPS[command], payload });
  if (!result.ok) throw new Error(result.error || 'Mailbox operation failed');
  console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
