#!/usr/bin/env node
'use strict';
/**
 * history skill CLI.
 *
 *   node query.js <bot> <token> <subcmd> [positional args] [--flag value]
 *
 * Subcommands: recent | around | search | by-user | msg | stats
 *
 * The script never opens a database. It sends the parsed request to the
 * daemon over the authenticated IPC socket, together with the scope token
 * from the command polygram put in the current turn. The daemon maps the
 * token to the calling session and reads only that session's chat (and, for
 * an isolated topic, only that topic). A chat or thread given here is checked
 * against that scope and refused when it differs; it can never widen it.
 *
 * Default output: JSON (one row per message). Pass --format pretty for
 * human-readable lines.
 */

const { call, readSecret, socketPathFor } = require('../../../lib/ipc/client');
const { formatPretty } = require('../../../lib/history');

const USAGE = 'Usage: query.js <bot> <token> <recent|around|search|by-user|msg|stats> [args]; use the history command from your current turn';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const value = (v) => (v === undefined || v === true ? undefined : v);

// Positional chat and thread arguments keep the old argument order, so a
// command written for the old skill still parses; the daemon refuses them
// unless they name the session's own chat and topic.
function buildRequest(sub, positional, flags) {
  const common = { chatId: value(flags.chat), threadId: value(flags.thread), limit: value(flags.limit) };
  switch (sub) {
    case 'recent':
      return { ...common, chatId: positional[0] ?? common.chatId, threadId: positional[1] ?? common.threadId, since: value(flags.since),
        includeOutbound: flags['include-outbound'] !== false && flags['include-outbound'] !== 'false' };
    case 'around':
      return { chatId: common.chatId, msgId: value(flags['msg-id']), before: value(flags.before), after: value(flags.after) };
    case 'search':
      return { ...common, query: positional[0], chatId: positional[1] ?? common.chatId, threadId: positional[2] ?? common.threadId, user: value(flags.user), days: value(flags.days) };
    case 'by-user':
      return { ...common, user: positional[0], chatId: positional[1] ?? common.chatId, threadId: positional[2] ?? common.threadId, days: value(flags.days) };
    case 'msg':
      return { msgId: positional[0], chatId: positional[1] ?? common.chatId };
    case 'stats':
      return { chatId: positional[0] ?? common.chatId, threadId: positional[1] ?? common.threadId, days: value(flags.days) };
    default:
      return null;
  }
}

async function main() {
  const [botName, token, sub, ...rest] = process.argv.slice(2);
  if (!botName || !token || !sub || botName.startsWith('-') || token.startsWith('-')) throw new Error(USAGE);
  const { positional, flags } = parseArgs(rest);
  const request = buildRequest(sub, positional, flags);
  if (!request) throw new Error(`unknown subcommand: ${sub}. ${USAGE}`);
  const payload = { sub, token };
  for (const [key, v] of Object.entries(request)) if (v !== undefined) payload[key] = v;
  const result = await call({ path: socketPathFor(botName), secret: readSecret(botName), op: 'history_query', payload });
  if (!result.ok) throw new Error(result.error || 'History query failed');
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (flags.format === 'pretty' && sub !== 'stats') process.stdout.write(formatPretty(rows) + '\n');
  else process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

main().catch((error) => { process.stderr.write(`history: ${error.message}\n`); process.exitCode = 1; });
