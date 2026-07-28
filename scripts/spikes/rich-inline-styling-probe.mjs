#!/usr/bin/env node
/**
 * Live probe for INLINE styling inside rich blocks.
 *
 * Today every block text field carries a flat string: rich.js's plainTextOf
 * collapses bold, italic, code spans and links to their text content, because
 * the nested representation was never verified against a server. Bot API 10.1+
 * documents typed RichText nodes (RichTextBold, RichTextItalic, RichTextCode,
 * RichTextUrl, RichTextPlain and friends) and types block text as
 * "String | RichText[] | typed nodes" — but the public reference truncates
 * before the field tables, so the exact JSON shape is guesswork. Guessing
 * wrong is not a compile error here; it is a silently mis-rendered reply.
 *
 * This probe asks the server, one shape at a time, and reads the ANSWER OFF
 * THE ECHO. That distinction is the whole point:
 *
 *   rejected   — the send errored. Cheap, loud, and the easiest to act on.
 *   flattened  — the send was ACCEPTED and the echo came back as a bare
 *                string. The structure was dropped in transit: agents would
 *                author bold that never renders and nothing would ever say
 *                so. This is the outcome that must not be mistaken for
 *                success, and acceptance alone cannot tell it apart.
 *   preserved  — accepted AND the echo still carries typed nodes. Only this
 *                is a green light, and the echoed form is the canonical one
 *                to emit (it is the schema, told to us by the server).
 *
 * Shapes probed, per the candidate ladder:
 *   (a) bare string                        — control; also the current behavior
 *   (b) array of strings                   — does the field accept a sequence?
 *   (c) array mixing strings + typed nodes — the shape we would emit
 *   (d) nested / alternate spellings       — tdlib-style `{text: {node}}` and
 *                                            capitalized type names, tried
 *                                            because (c) failing does not mean
 *                                            typed nodes are unsupported, only
 *                                            that this spelling is wrong
 *
 * Plus the fields we would actually wire: a heading, a list item, and a table
 * cell with styled text, and one nested case (bold containing code). A shape
 * that works in a paragraph and not in a table cell is a real and likely
 * outcome — the reference types them the same, but the renderers differ.
 *
 * SAFETY: sends REAL messages with a REAL token to a REAL chat. Dry-run by
 * default; `--confirm` actually sends. Targets the bot's own `adminChatId`
 * unless `--chat` is passed. Every message is prefixed "[SPIKE TEST]".
 * One send per probe, ~14 messages total on a full run.
 *
 * Usage:
 *   node scripts/spikes/rich-inline-styling-probe.mjs \
 *     [--config PATH] [--bot NAME] [--chat ID] [--topic THREAD_ID] [--confirm]
 *
 * `--topic` is optional here (unlike the topic gate): routing is already
 * settled. Pass it to keep the noise out of a chat's main timeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';

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

// ─── Pure analysis ─────────────────────────────────────────────────────────
//
// Everything below this line is decided without a network, so the part that
// says what a run MEANS can be tested. The live half only collects echoes.

const STYLE_MARKER = 'STYLEDWORD';   // what a styled node's text always is

/**
 * A compact, comparable description of a value's SHAPE — the thing the echo
 * is being read for. Depth-limited and text-free by construction: it names
 * structure, never content, so it can be printed and pasted without leaking
 * whatever the probe happened to send.
 */
export function describeShape(value, depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' || typeof value === 'boolean') return typeof value;
  if (depth >= 4) return '…';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array<>';
    // Collapse a homogeneous array to one member description; a mixed one is
    // exactly the interesting case, so keep every distinct member shape.
    const members = [...new Set(value.map((v) => describeShape(v, depth + 1)))];
    return `array<${members.join(' | ')}>`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const inner = keys.map((k) => (
      // The discriminator's VALUE is schema, not content — it is the one
      // string worth quoting, and it is ours (we sent it) or the server's.
      k === 'type' && typeof value[k] === 'string'
        ? `type:'${value[k]}'`
        : `${k}:${describeShape(value[k], depth + 1)}`
    ));
    return `{${inner.join(', ')}}`;
  }
  return typeof value;
}

/**
 * Did the styling survive the round trip?
 *
 * `sent` is what we put in the text field, `echoed` is what came back. A bare
 * string echo for a typed-node send is the silent-flatten case: accepted,
 * delivered, and stripped of the only thing we were asking for.
 *
 * @returns {'preserved'|'flattened'|'unknown'}
 */
export function classifyEcho(sent, echoed) {
  const sentStyled = containsTypedNode(sent);
  if (echoed === undefined) return 'unknown';       // nothing echoed at all
  if (!sentStyled) {
    // Control shapes: "preserved" means the field came back structurally
    // equivalent (a string stayed a string, an array stayed an array).
    if (typeof sent === 'string') return typeof echoed === 'string' ? 'preserved' : 'unknown';
    if (Array.isArray(sent)) return Array.isArray(echoed) ? 'preserved' : 'flattened';
    return 'unknown';
  }
  return containsTypedNode(echoed) ? 'preserved' : 'flattened';
}

function containsTypedNode(value) {
  if (Array.isArray(value)) return value.some(containsTypedNode);
  if (value && typeof value === 'object') {
    if (typeof value.type === 'string' && value.type.toLowerCase() !== 'plain') return true;
    return Object.values(value).some(containsTypedNode);
  }
  return false;
}

/**
 * What the run as a whole licenses.
 *
 * @param {Array<{key, field, status: 'preserved'|'flattened'|'rejected'|'skip', echoShape?}>} rows
 */
export function classifyInlineRun(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = Object.fromEntries(list.map((r) => [r.key, r]));
  const statusOf = (k) => byKey[k]?.status ?? 'skip';

  // Nothing below means anything if a plain rich send did not land: a blanket
  // rejection would otherwise read as "typed nodes unsupported".
  if (statusOf('a-string') !== 'preserved') {
    return {
      verdict: 'INCONCLUSIVE',
      reason: 'the bare-string control did not round-trip; the server or the chat is the variable, not the shape',
      styledFields: [],
      flattened: [],
      canonical: null,
      exitCode: 1,
    };
  }

  const styledRows = list.filter((r) => r.key.startsWith('c-') || r.key.startsWith('d-')
    || r.key.startsWith('field-') || r.key.startsWith('nested-'));
  const preserved = styledRows.filter((r) => r.status === 'preserved');
  const flattened = styledRows.filter((r) => r.status === 'flattened').map((r) => r.key);

  // The canonical form is whatever the SERVER echoed for a preserved probe —
  // not what we guessed. Where several agree, that agreement is the schema.
  const echoShapes = [...new Set(preserved.map((r) => r.echoShape).filter(Boolean))];

  let verdict;
  if (preserved.length === 0) {
    verdict = statusOf('b-array-of-strings') === 'preserved' ? 'ARRAYS_ONLY' : 'STRING_ONLY';
  } else if (styledRows.every((r) => r.status === 'preserved' || r.status === 'skip')) {
    verdict = 'TYPED_NODES';
  } else {
    verdict = 'PARTIAL';
  }

  return {
    verdict,
    reason: null,
    styledFields: preserved.map((r) => r.key),
    flattened,
    canonical: echoShapes.length ? echoShapes : null,
    // A probe run answers a question; it does not fail. Only a run that could
    // not ask (control down) is worth a non-zero exit.
    exitCode: 0,
  };
}

// ─── The candidate ladder ──────────────────────────────────────────────────
//
// Built as data so the dry run can print exactly what a live run would send,
// and so a shape can be added without touching the send loop.

const URL_FOR_PROBE = 'https://example.com/';

/** Every text-field shape worth asking about, in escalating order. */
export function candidateShapes() {
  return [
    { key: 'a-string', label: '(a) bare string — control, and today\'s behavior', text: `[SPIKE TEST] a — plain ${STYLE_MARKER}` },
    { key: 'b-array-of-strings', label: '(b) array of strings', text: ['[SPIKE TEST] b — ', 'two ', 'runs'] },

    // (c) the shape we would emit: short lowercase discriminators, flat text.
    { key: 'c-bold', label: '(c) array + {type:"bold"}', text: ['[SPIKE TEST] c bold — ', { type: 'bold', text: STYLE_MARKER }] },
    { key: 'c-italic', label: '(c) array + {type:"italic"}', text: ['[SPIKE TEST] c italic — ', { type: 'italic', text: STYLE_MARKER }] },
    { key: 'c-code', label: '(c) array + {type:"code"}', text: ['[SPIKE TEST] c code — ', { type: 'code', text: STYLE_MARKER }] },
    { key: 'c-url', label: '(c) array + {type:"url", url}', text: ['[SPIKE TEST] c url — ', { type: 'url', text: STYLE_MARKER, url: URL_FOR_PROBE }] },
    { key: 'c-plain-node', label: '(c) explicit {type:"plain"} node', text: ['[SPIKE TEST] c plain — ', { type: 'plain', text: STYLE_MARKER }] },

    // (d) alternate spellings. (c) failing says this spelling is wrong, not
    // that typed nodes are unsupported — so ask the other plausible ones
    // before concluding anything.
    { key: 'd-nested-text-node', label: '(d) tdlib-style nested {type:"bold", text:{type:"plain"}}', text: ['[SPIKE TEST] d nested — ', { type: 'bold', text: { type: 'plain', text: STYLE_MARKER } }] },
    { key: 'd-capitalized', label: '(d) capitalized discriminator {type:"RichTextBold"}', text: ['[SPIKE TEST] d capitalized — ', { type: 'RichTextBold', text: STYLE_MARKER }] },
    { key: 'd-snake', label: '(d) snake_case discriminator {type:"rich_text_bold"}', text: ['[SPIKE TEST] d snake — ', { type: 'rich_text_bold', text: STYLE_MARKER }] },
    { key: 'd-bare-node', label: '(d) a single typed node, not wrapped in an array', text: { type: 'bold', text: '[SPIKE TEST] d bare node' } },

    // Nesting: a bold run containing a code span is ordinary markdown
    // (`**see \`x\`**`), so if it cannot be expressed the mapping has to
    // decide which of the two to drop.
    { key: 'nested-bold-code', label: 'nested — bold containing code', text: ['[SPIKE TEST] nested — ', { type: 'bold', text: [{ type: 'code', text: STYLE_MARKER }] }] },
  ];
}

const styledRun = (prefix) => [prefix, { type: 'bold', text: STYLE_MARKER }];

/**
 * The other FIELDS we would wire. Same shape as (c); what is under test is
 * whether each field's renderer accepts it, which the reference implies but
 * does not promise.
 */
export function candidateFields() {
  return [
    {
      key: 'field-heading',
      label: 'heading text',
      block: { type: 'heading', text: styledRun('[SPIKE TEST] heading — '), size: 2 },
      read: (block) => block?.text,
    },
    {
      key: 'field-list-item',
      label: 'list item text',
      block: {
        type: 'list',
        items: [{ blocks: [{ type: 'paragraph', text: styledRun('[SPIKE TEST] list item — ') }] }],
      },
      read: (block) => block?.items?.[0]?.blocks?.[0]?.text,
    },
    {
      key: 'field-table-cell',
      label: 'table cell text',
      block: {
        type: 'table',
        cells: [
          [{ text: '[SPIKE TEST] header', is_header: true, align: 'left', valign: 'top' }],
          [{ text: styledRun('cell — '), align: 'left', valign: 'top' }],
        ],
      },
      read: (block) => block?.cells?.[1]?.[0]?.text,
    },
  ];
}

// ─── Live run ──────────────────────────────────────────────────────────────

const results = [];
function record(key, label, status, detail, echoShape) {
  const row = { key, label, status, detail: redact(detail), ...(echoShape ? { echoShape } : {}) };
  results.push(row);
  const tag = {
    preserved: 'KEEP', flattened: 'FLAT', rejected: 'REJECT', skip: 'SKIP',
  }[status];
  console.log(`[${tag}] ${label} — ${row.detail}`);
}

async function main() {
  const { botName, token, adminChatId, apiRoot } = loadBotConfig();
  const chatId = args.chat || adminChatId;

  console.log(`bot=${botName} chat=${chatId}${args.chat ? ' (explicit --chat)' : ''} `
    + `topic=${args.topic ?? '(none)'} apiRoot=${redact(apiRoot) || 'cloud'} confirm=${args.confirm}`);

  const shapes = candidateShapes();
  const fields = candidateFields();

  if (!args.confirm) {
    console.log('\nDRY RUN — nothing will be sent. Pass --confirm to run for real.');
    console.log(`Would send ${shapes.length + fields.length} messages, one per probe:\n`);
    for (const s of shapes) {
      console.log(`  ${s.key.padEnd(22)} ${s.label}`);
      console.log(`  ${' '.repeat(22)} text = ${JSON.stringify(s.text)}`);
    }
    for (const f of fields) {
      console.log(`  ${f.key.padEnd(22)} ${f.label}`);
      console.log(`  ${' '.repeat(22)} block = ${JSON.stringify(f.block)}`);
    }
    console.log('\nEach send is independent: a rejection records and moves on.');
    console.log('The ECHO is what gets read — an accepted send whose echo is a bare');
    console.log('string means the styling was dropped in transit, which is the');
    console.log('outcome worth knowing and the one acceptance alone cannot show.');
    process.exit(0);
  }

  const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);
  const threadId = args.topic != null ? Number(args.topic) : null;

  const send = async (blocks) => {
    const params = { chat_id: chatId, rich_message: { blocks } };
    if (threadId != null) params.message_thread_id = threadId;
    return bot.api.raw.sendRichMessage(params);
  };

  // ── Paragraph text shapes ───────────────────────────────────────────────
  for (const shape of shapes) {
    try {
      const res = await send([{ type: 'paragraph', text: shape.text }]);
      const echoed = res?.rich_message?.blocks?.[0]?.text;
      if (echoed === undefined) {
        // Accepted, but the response tells us nothing about the canonical
        // form. Look at the delivered message by eye before trusting it.
        record(shape.key, shape.label, 'skip',
          `accepted (message_id=${res?.message_id}) but no rich_message echo — verdict must come from the rendered bubble`,
          null);
        continue;
      }
      const status = classifyEcho(shape.text, echoed);
      record(shape.key, shape.label,
        status === 'preserved' ? 'preserved' : 'flattened',
        status === 'preserved'
          ? `accepted, echo kept the structure: ${describeShape(echoed)}`
          : `ACCEPTED BUT FLATTENED — echo came back as ${describeShape(echoed)}; the styling was dropped and nothing errored`,
        describeShape(echoed));
    } catch (err) {
      record(shape.key, shape.label, 'rejected', err.message, null);
    }
  }

  // ── The fields we would wire ────────────────────────────────────────────
  for (const field of fields) {
    try {
      const res = await send([field.block]);
      const echoed = field.read(res?.rich_message?.blocks?.[0]);
      if (echoed === undefined) {
        record(field.key, field.label, 'skip',
          `accepted (message_id=${res?.message_id}) but nothing echoed at that path`, null);
        continue;
      }
      const status = classifyEcho(field.read(field.block), echoed);
      record(field.key, field.label,
        status === 'preserved' ? 'preserved' : 'flattened',
        status === 'preserved'
          ? `accepted, echo kept the structure: ${describeShape(echoed)}`
          : `ACCEPTED BUT FLATTENED — echo came back as ${describeShape(echoed)}`,
        describeShape(echoed));
    } catch (err) {
      record(field.key, field.label, 'rejected', err.message, null);
    }
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  const { verdict, reason, styledFields, flattened, canonical, exitCode } = classifyInlineRun(results);

  console.log('\n=== Summary ===');
  for (const r of results) {
    const mark = {
      preserved: '✓', flattened: '~', rejected: '✗', skip: '−',
    }[r.status];
    console.log(`${mark} ${r.key.padEnd(22)} ${r.echoShape ?? ''}`);
  }

  console.log('\n=== Verdict ===');
  if (verdict === 'INCONCLUSIVE') {
    console.log(`INCONCLUSIVE — ${reason}`);
  } else if (verdict === 'TYPED_NODES') {
    console.log('TYPED NODES WORK — every styled probe round-tripped with its structure intact.');
    console.log('Emit the echoed form; it is the schema the server just described.');
  } else if (verdict === 'PARTIAL') {
    console.log('PARTIAL — some shapes or fields survive and others do not.');
    console.log(`  preserved: ${styledFields.join(', ') || '(none)'}`);
    console.log(`  flattened: ${flattened.join(', ') || '(none)'}`);
    console.log('Map only what survives; anything else must keep flattening to plain text.');
  } else if (verdict === 'ARRAYS_ONLY') {
    console.log('ARRAYS ONLY — the field takes a sequence, but no typed node survived.');
    console.log('Inline styling is not reachable this way; do not ship a mapping.');
  } else {
    console.log('STRING ONLY — the field is a plain string on this server. Nothing to wire.');
  }

  if (flattened.length) {
    console.log(`\nSILENT FLATTENING on: ${flattened.join(', ')}`);
    console.log('These were ACCEPTED. Shipping them would author styling that never renders');
    console.log('and never errors — the failure mode with no signal attached.');
  }
  if (canonical) {
    console.log(`\nCanonical echoed form(s): ${canonical.join('  |  ')}`);
  }

  // JSON tail so the outcome can be relayed without transcribing prose.
  console.log(`\n${JSON.stringify({
    probe: 'rich-inline-styling', bot: botName, chat: String(chatId),
    topic: args.topic ?? null, verdict, styledFields, flattened, canonical, results,
  }, null, 2)}`);

  process.exit(exitCode);
}

// Only run when executed directly: the classifiers above are imported by
// tests, and importing this file must not fire a live run.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('probe crashed:', redact(err?.stack || err));
    process.exit(2);
  });
}
