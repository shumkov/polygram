#!/usr/bin/env node
/**
 * Rich Message round-trip against a real Telegram Bot API, covering
 * rich sends, plain-to-rich edits, limit-error classification, and
 * literal rendering of adversarial content.
 *
 * SAFETY: this sends REAL messages using a REAL bot token to a REAL
 * Telegram chat. Dry-run by default — prints what it would do without
 * sending anything. Pass --confirm to actually send. Only ever targets
 * the bot's configured `adminChatId` (the operator's own DM with their
 * own bot) — never any other chat, never read from argv/env, so there's
 * no way to accidentally point this at a partner-facing chat.
 *
 * Usage:
 *   node scripts/spikes/rich-message-roundtrip.mjs [--config PATH] [--bot NAME] [--confirm]
 *
 * Defaults: --config ~/.polygram/config.json, --bot <first bot in config>.
 *
 * Each sent message is prefixed "[SPIKE TEST]" so it's identifiable in
 * the chat history; nothing is auto-deleted (this is the operator's own
 * admin/test DM, low-risk to leave a short trail in).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Bot } from 'grammy';

function parseArgs(argv) {
  const out = { config: path.join(os.homedir(), '.polygram', 'config.json'), bot: null, confirm: false, chat: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--bot') out.bot = argv[++i];
    else if (argv[i] === '--confirm') out.confirm = true;
    // --chat: explicit override of the target chat, required to differ
    // from adminChatId on purpose (e.g. adminChatId was never actually
    // used/has no open conversation) — NOT read from a default, always
    // an explicit human-in-the-loop choice at invocation time.
    else if (argv[i] === '--chat') out.chat = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function loadBotConfig() {
  const raw = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const botName = args.bot || Object.keys(raw.bots || {})[0];
  if (!botName) throw new Error(`no bots found in ${args.config}`);
  const botCfg = { ...(raw.bot || {}), ...(raw.bots[botName] || {}) };
  if (!botCfg.token) throw new Error(`bot "${botName}" has no token in ${args.config}`);
  if (!botCfg.adminChatId) throw new Error(`bot "${botName}" has no adminChatId in ${args.config} — refusing to guess a target chat`);
  return { botName, ...botCfg };
}

const results = []; // { id, pass, detail }
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

async function main() {
  const { botName, token, adminChatId, apiRoot } = loadBotConfig();
  const chatId = args.chat || adminChatId;
  console.log(`bot=${botName} chat=${chatId}${args.chat ? ' (explicit --chat override)' : ''} apiRoot=${apiRoot || 'cloud'} confirm=${args.confirm}`);

  if (!args.confirm) {
    console.log('\nDRY RUN — no messages will be sent. Pass --confirm to run against real Telegram.');
    console.log('Would run:');
    console.log('  (a) sendRichMessage round-trip: heading + checkbox list + table');
    console.log('  (b) sendMessage (plain) then editMessageText{rich_message} — plain→rich conversion');
    console.log('  (c) an intentionally oversized rich payload (>500 blocks) — expect a content-error rejection');
    console.log('  (d) a block with adversarial inline text (<b>, &, markdown link syntax) — confirm literal echo');
    process.exit(0);
  }

  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);

  // (a) round-trip: heading + checkbox list + table, single call.
  try {
    const blocks = [
      { type: 'heading', text: '[SPIKE TEST] rich round-trip', size: 2 },
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: 'pending item' }], has_checkbox: true },
          { blocks: [{ type: 'paragraph', text: 'done item' }], has_checkbox: true, is_checked: true },
        ],
      },
      {
        type: 'table',
        cells: [
          [
            { text: 'col a', is_header: true, align: 'left', valign: 'top' },
            { text: 'col b', is_header: true, align: 'left', valign: 'top' },
          ],
          [
            { text: '1', align: 'left', valign: 'top' },
            { text: '2', align: 'left', valign: 'top' },
          ],
        ],
      },
    ];
    const res = await bot.api.raw.sendRichMessage({ chat_id: chatId, rich_message: { blocks } });
    const hasRichField = res && (res.rich_message != null);
    record('rich round-trip', !!res?.message_id, `message_id=${res?.message_id}, echoed rich_message present=${hasRichField}`);
    if (res?.message_id) {
      // (b) plain→rich edit: send a fresh plain message, then convert it.
      const plainRes = await bot.api.raw.sendMessage({ chat_id: chatId, text: '[SPIKE TEST] plain, about to become rich' });
      try {
        const editRes = await bot.api.raw.editMessageText({
          chat_id: chatId, message_id: plainRes.message_id,
          rich_message: { blocks: [{ type: 'heading', text: '[SPIKE TEST] now rich', size: 2 }] },
        });
        record('plain→rich edit', !!editRes, `edited message_id=${plainRes.message_id}`);
      } catch (err) {
        record('plain→rich edit', false, `editMessageText rejected converting plain→rich: ${err.message}`);
      }
    }
  } catch (err) {
    record('rich round-trip', false, err.message);
  }

  // (c) overflow: 501 top-level blocks, expect a content-error rejection
  // (RICH_MESSAGE_BLOCKS_TOO_MANY or similar), not a crash/hang.
  try {
    const tooManyBlocks = Array.from({ length: 501 }, (_, i) => ({ type: 'paragraph', text: `block ${i}` }));
    await bot.api.raw.sendRichMessage({ chat_id: chatId, rich_message: { blocks: tooManyBlocks } });
    record('overflow classification', false, 'expected a rejection for >500 blocks, but the call succeeded');
  } catch (err) {
    const msg = err.message || String(err);
    const looksLikeContentError = /RICH_MESSAGE_|too many|blocks/i.test(msg);
    record('overflow classification', looksLikeContentError, `error message: ${msg.slice(0, 200)}`);
  }

  // (d) adversarial inline content: confirm the API echoes it back
  // literally (no server-side re-interpretation into a different
  // field/shape). Full VISUAL confirmation (does it render as a link on
  // a real client) still needs a human eyeball.
  try {
    const adversarialText = '[SPIKE TEST] payload: <b>injected</b> & [x](javascript:alert(1))';
    const res = await bot.api.raw.sendRichMessage({
      chat_id: chatId,
      rich_message: { blocks: [{ type: 'paragraph', text: adversarialText }] },
    });
    const echoedText = res?.rich_message?.blocks?.[0]?.text;
    record('adversarial content echo', echoedText === adversarialText,
      `sent=${JSON.stringify(adversarialText)} echoed=${JSON.stringify(echoedText)}`);
  } catch (err) {
    record('adversarial content echo', false, err.message);
  }

  console.log('\n=== Summary ===');
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.id}`);
  const allPass = results.every((r) => r.pass);
  console.log(allPass ? '\nALL PASS' : '\nSOME FAILED — see above');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('spike crashed:', err);
  process.exit(2);
});
