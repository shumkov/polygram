#!/usr/bin/env node
/**
 * Live gate for rich replies on the reply-tool path.
 *
 * The earlier round-trip spike only ever sent a bare
 * `{chat_id, rich_message}`. Three things the dispatcher path depends on
 * were therefore never exercised against a real server, and each one has a
 * silent-failure mode that unit tests cannot reach:
 *
 *   A. Does sendRichMessage honor `message_thread_id`? A dropped thread id
 *      does not error — it delivers the reply to the group's General topic
 *      instead. On a forum-style chat that mis-delivers EVERY rich reply.
 *   B. Does it honor `reply_parameters`? Replies lose their anchor silently
 *      the same way.
 *   C. Does a photo block backed by a local file actually upload? The
 *      multipart `attach://` path on this verb is documented and plausible,
 *      never exercised.
 *   D. Does the response echo `rich_message.blocks`? Only if it does can the
 *      send path learn file_ids into the shared cache instead of merely
 *      consuming what the streamer put there.
 *
 * A and B decide whether the reply tool can send rich DIRECTLY or has to
 * fall back to the documented contingency (send plain, then convert with
 * `editMessageText{rich_message}` — known to work, but it reintroduces a
 * visible plain→rich flicker). C and D scope the media release that follows.
 *
 * SAFETY: sends REAL messages with a REAL token to a REAL chat. Dry-run by
 * default; `--confirm` actually sends. Targets the bot's own `adminChatId`
 * unless `--chat` is passed explicitly. Every message is prefixed
 * "[SPIKE TEST]".
 *
 * Usage:
 *   node scripts/spikes/rich-send-topic-gate.mjs \
 *     [--config PATH] [--bot NAME] [--chat ID] --topic THREAD_ID [--confirm]
 *
 * `--topic` is REQUIRED for checks A and B: a forum topic id cannot be
 * guessed, and running them against a non-forum chat proves nothing. Create
 * (or pick) a throwaway topic in a test supergroup and pass its thread id.
 * Without it the script still runs C and D and reports A/B as SKIPPED.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Bot, InputFile } from 'grammy';

// The daemon's sanitizers are CommonJS; reuse them rather than re-deriving
// the patterns here, where a subtly weaker one would go unnoticed.
const require = createRequire(import.meta.url);
const { redactBotToken, stripUrlCredentials } = require('../../lib/error/net.js');

function parseArgs(argv) {
  const out = {
    config: path.join(os.homedir(), '.polygram', 'config.json'),
    bot: null, chat: null, topic: null, confirm: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--bot') out.bot = argv[++i];
    else if (argv[i] === '--chat') out.chat = argv[++i];
    else if (argv[i] === '--topic') out.topic = argv[++i];
    else if (argv[i] === '--confirm') out.confirm = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// This script's whole output is meant to be pasted somewhere — that is what
// the JSON tail exists for. Network errors from a Bot API call routinely
// embed the request URL, which carries `bot<TOKEN>` and, for a self-hosted
// root, its basic-auth userinfo. Everything printed goes through here.
export function redact(value) {
  return redactBotToken(String(value ?? ''))
    .replace(/https?:\/\/[^/\s]*@/gi, (m) => stripUrlCredentials(m));
}

function loadBotConfig() {
  const raw = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const botName = args.bot || Object.keys(raw.bots || {})[0];
  if (!botName) throw new Error(`no bots found in ${args.config}`);
  // Per-bot config wins over the top-level block: at boot polygram replaces
  // `config.bot` with `config.bots[name]`, so a key that lives only at the
  // top level (apiRoot is the one that has bitten before) is not what the
  // running daemon uses.
  const botCfg = { ...(raw.bot || {}), ...(raw.bots[botName] || {}) };
  if (!botCfg.token) throw new Error(`bot "${botName}" has no token in ${args.config}`);
  if (!botCfg.adminChatId) {
    throw new Error(`bot "${botName}" has no adminChatId — refusing to guess a target chat`);
  }
  return { botName, ...botCfg };
}

const results = [];
function record(key, id, status, detail) {
  results.push({ key, id, status, detail: redact(detail) });
  const tag = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[status];
  console.log(`[${tag}] ${id} — ${results[results.length - 1].detail}`);
}

// Only these answer the question the gate exists to ask; C and D scope the
// media release that follows and must never decide this run's exit code.
const REQUIRED_KEYS = ['control', 'A', 'B'];

/**
 * Pure verdict logic, separated so it can be exercised without a network.
 * @param {Array<{key: string, status: 'pass'|'fail'|'skip'}>} rows
 */
export function classifyGateRun(rows) {
  const byKey = {};
  for (const r of rows || []) byKey[r.key] = r.status;

  const required = REQUIRED_KEYS.map((k) => ({ key: k, status: byKey[k] ?? 'skip' }));
  const unanswered = required.filter((r) => r.status !== 'pass').map((r) => r.key);

  let verdict;
  if (byKey.control === 'fail') {
    // A and B are measured against this topic, so nothing they report means
    // anything until a plain send reaches it.
    verdict = 'INCONCLUSIVE';
  } else if (byKey.A === 'skip' || byKey.B === 'skip' || byKey.A == null || byKey.B == null) {
    verdict = 'INCONCLUSIVE';
  } else if (byKey.A === 'pass' && byKey.B === 'pass') {
    verdict = 'DIRECT_SEND';
  } else {
    verdict = 'CONTINGENCY';
  }

  return {
    verdict,
    unanswered,
    // Informational probes are reported but never fail the run.
    informationalFailures: ['C', 'D'].filter((k) => byKey[k] === 'fail'),
    exitCode: unanswered.length > 0 ? 1 : 0,
  };
}

// A 1x1 transparent PNG, written to a temp file so the multipart check runs
// against a real path without depending on a fixture that may not exist on
// the host this is run from.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function writeProbeImage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-spike-'));
  const file = path.join(dir, 'probe.png');
  fs.writeFileSync(file, PNG_1X1);
  return file;
}

const heading = (text) => ({ type: 'heading', text, size: 2 });

async function main() {
  const { botName, token, adminChatId, apiRoot } = loadBotConfig();
  const chatId = args.chat || adminChatId;

  console.log(`bot=${botName} chat=${chatId}${args.chat ? ' (explicit --chat)' : ''} `
    + `topic=${args.topic ?? '(none)'} apiRoot=${redact(apiRoot) || 'cloud'} confirm=${args.confirm}`);

  if (!args.confirm) {
    console.log('\nDRY RUN — nothing will be sent. Pass --confirm to run for real.');
    console.log('Would run:');
    console.log('  control    — plain sendMessage into the topic (proves the topic id is valid)');
    console.log('  A: topic   — sendRichMessage with message_thread_id; verify the echoed thread id');
    console.log('  B: anchor  — sendRichMessage with reply_parameters; verify the echoed reply target');
    console.log('  C: media   — sendRichMessage with a photo block backed by a local file (multipart)');
    console.log('  D: echo    — does any response carry rich_message.blocks back?');
    if (!args.topic) console.log('\nNOTE: --topic not given; A and B would be SKIPPED.');
    process.exit(0);
  }

  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);
  const threadId = args.topic != null ? Number(args.topic) : null;
  let anyEchoedBlocks = null;

  // ANY response carrying blocks answers the question, so a later response
  // without them must not erase an earlier positive.
  const noteEcho = (res) => {
    if (res && res.rich_message !== undefined) {
      anyEchoedBlocks = (anyEchoedBlocks === true) || Array.isArray(res.rich_message?.blocks);
    }
  };

  // ── Control: is the topic id itself usable? ─────────────────────────────
  // Without this, a failure in A is ambiguous between "the verb drops the
  // thread id" and "that topic does not exist" — and those have opposite
  // consequences for the release.
  let anchorMessageId = null;
  if (threadId != null) {
    try {
      const res = await bot.api.raw.sendMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        text: '[SPIKE TEST] control — plain message, should land in the topic',
      });
      anchorMessageId = res?.message_id ?? null;
      const echoed = res?.message_thread_id ?? null;
      record('control', 'control: plain send honors the topic', Number(echoed) === threadId ? 'pass' : 'fail',
        `sent thread_id=${threadId}, echoed=${echoed}. If this failed, the topic id is wrong — fix it before trusting A/B.`);
    } catch (err) {
      record('control', 'control: plain send honors the topic', 'fail',
        `plain sendMessage rejected: ${err.message}. A/B results below are meaningless until this passes.`);
    }
  } else {
    record('control', 'control: plain send honors the topic', 'skip', 'no --topic given');
  }

  // ── A: does sendRichMessage honor message_thread_id? ────────────────────
  if (threadId != null) {
    try {
      const res = await bot.api.raw.sendRichMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        rich_message: { blocks: [heading('[SPIKE TEST] A — topic routing')] },
      });
      noteEcho(res);
      const echoed = res?.message_thread_id ?? null;
      const ok = Number(echoed) === threadId;
      record('A', 'A: sendRichMessage honors message_thread_id', ok ? 'pass' : 'fail',
        ok
          ? `landed in topic ${echoed} (message_id=${res?.message_id})`
          : `THREAD DROPPED — sent ${threadId}, echoed ${echoed}. Direct rich send would mis-deliver every reply in a forum chat; use the plain-send-then-rich-edit contingency.`);
    } catch (err) {
      record('A', 'A: sendRichMessage honors message_thread_id', 'fail',
        `rejected outright: ${err.message}`);
    }
  } else {
    record('A', 'A: sendRichMessage honors message_thread_id', 'skip', 'no --topic given');
  }

  // ── B: does it honor reply_parameters? ──────────────────────────────────
  if (threadId != null && anchorMessageId != null) {
    try {
      const res = await bot.api.raw.sendRichMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        reply_parameters: { message_id: anchorMessageId },
        rich_message: { blocks: [heading('[SPIKE TEST] B — reply anchor')] },
      });
      noteEcho(res);
      const anchored = res?.reply_to_message?.message_id ?? null;
      const ok = Number(anchored) === Number(anchorMessageId);
      record('B', 'B: sendRichMessage honors reply_parameters', ok ? 'pass' : 'fail',
        ok
          ? `anchored to ${anchored}`
          : `ANCHOR DROPPED — asked for ${anchorMessageId}, echoed ${anchored}. Rich replies would lose their reply-to link.`);
    } catch (err) {
      record('B', 'B: sendRichMessage honors reply_parameters', 'fail', `rejected: ${err.message}`);
    }
  } else {
    record('B', 'B: sendRichMessage honors reply_parameters', 'skip',
      threadId == null ? 'no --topic given' : 'control message never landed, so there is no anchor');
  }

  // ── C: does a local-file photo block upload over multipart? ─────────────
  let probe = null;
  try {
    probe = writeProbeImage();
    const params = {
      chat_id: chatId,
      rich_message: {
        blocks: [
          heading('[SPIKE TEST] C — local media upload'),
          {
            type: 'photo',
            photo: { type: 'photo', media: new InputFile(probe) },
            caption: { text: '1x1 probe' },
          },
        ],
      },
    };
    if (threadId != null) params.message_thread_id = threadId;
    const res = await bot.api.raw.sendRichMessage(params);
    noteEcho(res);
    record('C', 'C: photo block uploads from a local path', !!res?.message_id ? 'pass' : 'fail',
      `message_id=${res?.message_id}. Confirms grammy walks nested InputFiles inside rich_message and the server accepts the attach:// part.`);
  } catch (err) {
    record('C', 'C: photo block uploads from a local path', 'fail',
      `${err.message}. Media on this path needs a different construction (or is unsupported).`);
  } finally {
    if (probe) { try { fs.rmSync(path.dirname(probe), { recursive: true, force: true }); } catch {} }
  }

  // ── D: does the response echo blocks back? ──────────────────────────────
  // Decides whether the send path can LEARN file_ids into the shared cache
  // or only consume what the streamer path put there. Safe either way — it
  // only determines whether a caching optimization is reachable.
  if (anyEchoedBlocks === null) {
    record('D', 'D: response echoes rich_message.blocks', 'fail',
      'no response carried a rich_message field at all — file_id learning is not reachable on the send path');
  } else {
    record('D', 'D: response echoes rich_message.blocks', anyEchoedBlocks ? 'pass' : 'fail',
      anyEchoedBlocks
        ? 'blocks echoed — the send path can populate the shared file_id cache'
        : 'rich_message present but without a blocks array — file_id learning is not reachable');
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${{ pass: '✓', fail: '✗', skip: '−' }[r.status]} ${r.id}`);
  }

  const byKey = Object.fromEntries(results.map((r) => [r.key, r.status]));
  const { verdict, unanswered, informationalFailures, exitCode } = classifyGateRun(results);

  console.log('\n=== Verdict ===');
  if (verdict === 'INCONCLUSIVE') {
    console.log('INCONCLUSIVE — the direct-send decision cannot be made from this run.');
    console.log(`  unanswered: ${unanswered.join(', ')}`);
    if (byKey.control === 'fail') {
      console.log('  the control send never reached the topic, so A and B mean nothing yet.');
    } else {
      console.log('  rerun with --topic pointing at a real forum topic.');
    }
  } else if (verdict === 'DIRECT_SEND') {
    console.log('DIRECT SEND IS SAFE — sendRichMessage honors both the topic and the reply anchor.');
    console.log('Ship the reply-tool rich path as specified; the contingency stays unused.');
  } else {
    console.log('USE THE CONTINGENCY — send plain, then convert with editMessageText{rich_message}.');
    console.log(`  topic honored:  ${byKey.A === 'pass'}`);
    console.log(`  anchor honored: ${byKey.B === 'pass'}`);
    console.log('The plain→rich flicker returns, but delivery stays correct.');
  }

  // Informational: these scope the media release, and must not change the
  // verdict or the exit code of a run that answered A and B.
  console.log(`\nmedia upload works: ${byKey.C === 'pass'}`);
  console.log(`blocks echoed back: ${byKey.D === 'pass'}`);
  if (informationalFailures.length) {
    console.log(`(informational probes that failed: ${informationalFailures.join(', ')} — these do not block the decision)`);
  }

  // JSON tail so the outcome can be relayed without transcribing prose.
  console.log(`\n${JSON.stringify({
    gate: 'G-A1', bot: botName, chat: String(chatId), topic: args.topic ?? null,
    verdict, unanswered, informationalFailures, results,
  }, null, 2)}`);

  process.exit(exitCode);
}

// Only run when executed directly: the classifier above is imported by tests,
// and importing this file must not fire a live run.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('spike crashed:', redact(err?.stack || err));
    process.exit(2);
  });
}
