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
 * an isolated topic, only that topic); only the operator's private chat with
 * the bot may name another chat. A chat or thread given here is checked by the
 * daemon against what the session may read, never trusted on its own.
 *
 * Default output: JSON (one row per message). Pass --format pretty for
 * human-readable lines.
 */

const { call, readSecret, socketPathFor } = require('../../../lib/ipc/client');
const { formatPretty } = require('../../../lib/history');

const USAGE = 'Usage: query.js <bot> <token> <recent|around|search|by-user|msg|stats> [args]; use the history command from your current turn';
const FLAGS = new Set(['chat', 'thread', 'limit', 'since', 'include-outbound', 'msg-id', 'before', 'after', 'user', 'days', 'format']);
// A read is a quick query; a hung daemon should not hold the agent for the
// client's default five minutes.
const CALL_TIMEOUT_MS = 30_000;

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
// unless they name the session's own chat and topic. Only numeric ids are
// read that way: any other extra word is most likely an unquoted part of a
// search term or a display name, and is refused with that hint.
function ids(sub, rest) {
  for (const arg of rest) {
    if (!/^-?\d+$/.test(arg)) throw new Error(`${sub}: unexpected argument ${JSON.stringify(arg)}; quote a multi-word term or name`);
  }
  if (rest.length > 2) throw new Error(`${sub}: too many arguments. ${USAGE}`);
  return rest;
}

function buildRequest(sub, positional, flags) {
  const common = { chatId: value(flags.chat), threadId: value(flags.thread), limit: value(flags.limit) };
  switch (sub) {
    case 'recent': {
      const [chatId, threadId] = ids(sub, positional);
      return { ...common, chatId: chatId ?? common.chatId, threadId: threadId ?? common.threadId, since: value(flags.since),
        includeOutbound: flags['include-outbound'] !== false && flags['include-outbound'] !== 'false' };
    }
    case 'around':
      if (positional.length) throw new Error(`around: unexpected argument ${JSON.stringify(positional[0])}; use --msg-id N`);
      return { chatId: common.chatId, msgId: value(flags['msg-id']), before: value(flags.before), after: value(flags.after) };
    case 'search': {
      const [chatId, threadId] = ids(sub, positional.slice(1));
      return { ...common, query: positional[0], chatId: chatId ?? common.chatId, threadId: threadId ?? common.threadId, user: value(flags.user), days: value(flags.days) };
    }
    case 'by-user': {
      const [chatId, threadId] = ids(sub, positional.slice(1));
      return { ...common, user: positional[0], chatId: chatId ?? common.chatId, threadId: threadId ?? common.threadId, days: value(flags.days) };
    }
    case 'msg': {
      const [chatId, extra] = ids(sub, positional.slice(1));
      if (extra !== undefined) throw new Error(`msg: too many arguments. ${USAGE}`);
      return { msgId: positional[0], chatId: chatId ?? common.chatId };
    }
    case 'stats': {
      const [chatId, threadId] = ids(sub, positional);
      return { chatId: chatId ?? common.chatId, threadId: threadId ?? common.threadId, days: value(flags.days) };
    }
    default:
      return null;
  }
}

async function main() {
  const [botName, token, sub, ...rest] = process.argv.slice(2);
  if (!botName || !token || !sub || botName.startsWith('-') || token.startsWith('-')) throw new Error(USAGE);
  const { positional, flags } = parseArgs(rest);
  for (const key of Object.keys(flags)) if (!FLAGS.has(key)) throw new Error(`unknown flag --${key}. ${USAGE}`);
  const request = buildRequest(sub, positional, flags);
  if (!request) throw new Error(`unknown subcommand: ${sub}. ${USAGE}`);
  const payload = { sub, token };
  for (const [key, v] of Object.entries(request)) if (v !== undefined) payload[key] = v;
  const result = await call({ path: socketPathFor(botName), secret: readSecret(botName), op: 'history_query', payload, callTimeoutMs: CALL_TIMEOUT_MS });
  if (!result.ok) throw new Error(result.error || 'History query failed');
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (flags.format === 'pretty' && sub !== 'stats') process.stdout.write(formatPretty(rows) + '\n');
  else process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

main().catch((error) => { process.stderr.write(`history: ${error.message}\n`); process.exitCode = 1; });
