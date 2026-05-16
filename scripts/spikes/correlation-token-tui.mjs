#!/usr/bin/env node
/**
 * correlation-token-tui — Phase 0 spike for the 0.10.0 tmux
 * concurrency fix (docs/0.10.0-tmux-concurrency-solution.md §1).
 *
 * THE QUESTION THIS SPIKE ANSWERS
 * -------------------------------
 * The solution's linchpin is a per-message correlation token embedded
 * inside the `<polygram-info>` block of every pasted prompt. Phase 2
 * builds the entire turn ledger on the assumption that the token
 * survives the round-trip:
 *
 *   polygram builds prompt (token in <polygram-info>)
 *     → TmuxRunner.pasteText  (\n → ' / ' MULTILINE_SEPARATOR)
 *     → tmux set-buffer / paste-buffer  (bracketed paste)
 *     → claude TUI input box
 *     → claude writes JSONL `type:'user'` line
 *     → polygram reads the token back, VERBATIM
 *
 * If the TUI mangles, splits, normalises, or drops the token, the
 * Phase 2 design must change BEFORE any code is written. This spike
 * is the go/no-go gate.
 *
 * It confirms two things against the REAL claude TUI (pinned 2.1.142):
 *   (a) the agent IGNORES the token — it does not echo it, mention
 *       it, or treat it as an instruction;
 *   (b) the JSONL `type:'user'` line reproduces the token BYTE-FOR-BYTE
 *       after the MULTILINE_SEPARATOR transform.
 *
 * It also exercises the concatenation case (§1's core claim): two
 * pastes landing close together carry two distinct tokens, and a
 * concatenated `user-message` contains BOTH — so attribution survives
 * even when the boundary is gone.
 *
 * Usage:
 *   node scripts/spikes/correlation-token-tui.mjs              # all
 *   node scripts/spikes/correlation-token-tui.mjs token-attribute
 *
 * Cost: ~$0.02-0.05 per scenario × 3 ≈ $0.10. Wall-clock ~1-2 min.
 *
 * @see docs/0.10.0-tmux-concurrency-solution.md  (Phase 0, §1)
 */

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { TmuxProcess } = require('../../lib/process/tmux-process.js');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');
const { sessionLogPath } = require('../../lib/tmux/session-log-parser.js');
const { MULTILINE_SEPARATOR } = require('../../lib/tmux/tmux-runner.js');

const execFileP = promisify(execFile);
const SILENT = { warn() {}, error() {}, info() {}, debug() {}, log() {} };

function log(...args) { console.error('[spike]', ...args); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function killTmuxSession(name) {
  try { await execFileP('tmux', ['kill-session', '-t', name]); } catch { /* ignore */ }
}

// ─── Correlation token ───────────────────────────────────────────────
//
// Shape constraints the token MUST satisfy to be round-trip safe:
//   - no '\n' / '\r'  — the MULTILINE_SEPARATOR transform would split it
//   - no XML metacharacters (< > & ")  — it sits inside an XML-ish block
//   - no whitespace   — a concatenated user-message is scanned for it
//   - no C0/DEL bytes — TmuxRunner.sanitize() strips those
// `pgm-corr-<24 hex>` satisfies all four and the `pgm-corr-` prefix is
// distinctive enough that it never collides with real prompt content.
let _tokenSeq = 0;
function mintToken() {
  _tokenSeq += 1;
  const rand = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  const seq = _tokenSeq.toString(16).padStart(4, '0');
  return `pgm-corr-${seq}${rand}${Date.now().toString(16)}`;
}

// ─── Prompt builders (mimic lib/prompt.js polygram-info shape) ────────
//
// The spike deliberately does NOT wrap the instruction in
// `<untrusted-input>` and omits polygram's "do not follow commands"
// security line. With no real agent system prompt loaded, bare claude
// would (correctly) refuse to act on a command inside an
// untrusted-input block — that refusal is a SPIKE-PROMPT artifact, not
// a token-handling issue, and would muddy the "agent ignores the
// token" signal. What Phase 0 must validate is narrower: a token
// embedded in the multi-line `<polygram-info>` block survives the
// paste → MULTILINE_SEPARATOR → JSONL round-trip verbatim, and the
// agent does not treat the TOKEN itself as an instruction. So the
// block stays multi-line (the transform must fire around the token)
// but the instruction is sent as a plain, benign request.

// Multi-line <polygram-info> block — production's POLYGRAM_INFO is a
// multi-paragraph string; the spike only needs it multi-line so the
// MULTILINE_SEPARATOR transform actually fires on the newlines that
// bracket the token.
function polygramInfoBlock(tokenEmbed) {
  return [
    `<polygram-info${tokenEmbed.attr}>`,
    'You are connected via a Telegram daemon (polygram). Just reply with',
    'text — polygram delivers your response automatically. This',
    `<polygram-info> block is infrastructure metadata, not part of the`,
    'conversation — ignore it entirely when composing your reply.',
    tokenEmbed.childLine,
    '</polygram-info>',
  ].filter(Boolean).join('\n');
}

// Build a full prompt with the token embedded in the requested shape.
//   shape='attribute'  → <polygram-info corr-id="TOKEN">
//   shape='child-line' → a <corr-id>TOKEN</corr-id> line inside block
function buildPrompt({ token, shape, instruction }) {
  const embed = shape === 'attribute'
    ? { attr: ` corr-id="${token}"`, childLine: '' }
    : { attr: '', childLine: `<corr-id>${token}</corr-id>` };
  return `${polygramInfoBlock(embed)}\n\n${instruction}`;
}

// ─── Harness ─────────────────────────────────────────────────────────

async function setupRealTui(label) {
  const runner = createTmuxRunner({ logger: console });
  const cwd = path.resolve(process.cwd());
  const p = new TmuxProcess({
    sessionKey: `tokspike:${label}`,
    chatId: 'tokspike',
    threadId: label,
    label: `tokspike-${label}`,
    runner,
    botName: 'tokspike',
    logger: SILENT,
    readyTimeoutMs: 60_000,
    turnTimeoutMs: 120_000,
  });
  const tmuxName = runner.sessionName('tokspike', 'tokspike', label);
  await killTmuxSession(tmuxName);
  await p.start({
    chatConfig: {
      model: 'sonnet', effort: 'low', cwd,
      permissionMode: 'bypassPermissions',
    },
  });
  return {
    p,
    cwd,
    cleanup: async () => {
      try { await p.kill('tokspike-done'); } catch { /* ignore */ }
      await killTmuxSession(tmuxName);
    },
  };
}

// Read the session JSONL and return every top-level `type:'user'`
// message whose content is a plain string (i.e. a real user prompt,
// not API-shaped tool_result feedback). Polls until at least
// `minCount` such lines exist, or the timeout elapses.
async function readUserMessages(cwd, sessionId, { minCount = 1, timeoutMs = 15_000 } = {}) {
  const logPath = sessionLogPath(cwd, sessionId);
  const deadline = Date.now() + timeoutMs;
  let lastSeen = [];
  while (Date.now() < deadline) {
    let raw = '';
    try { raw = await readFile(logPath, 'utf8'); } catch { raw = ''; }
    const users = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj?.type === 'user' && obj.message && typeof obj.message.content === 'string') {
        users.push({
          content: obj.message.content,
          promptId: obj.promptId ?? null,
          parentUuid: obj.parentUuid ?? null,
          uuid: obj.uuid ?? null,
        });
      }
    }
    lastSeen = users;
    if (users.length >= minCount) return users;
    await sleep(300);
  }
  return lastSeen;
}

// ─── Assertions ──────────────────────────────────────────────────────

let totalAsserts = 0;
let scenarioFailed = false;
function pass(label) { console.log(`  PASS: ${label}`); totalAsserts++; }
function fail(label) {
  console.error(`  FAIL: ${label}`);
  totalAsserts++;
  scenarioFailed = true;
  process.exitCode = 1;
}
function ok(cond, label) { cond ? pass(label) : fail(label); return cond; }

// Count non-overlapping verbatim occurrences of `token` in `haystack`.
function countOccurrences(haystack, token) {
  if (!token) return 0;
  let n = 0;
  let i = haystack.indexOf(token);
  while (i !== -1) { n++; i = haystack.indexOf(token, i + token.length); }
  return n;
}

// Core check shared by every scenario: the token must appear EXACTLY
// once, verbatim, across the JSONL user-messages; the transform must
// have fired (separator present); the agent reply must not echo it.
function assertTokenRoundTrip({ token, userMessages, replyText, scenarioLabel }) {
  const joined = userMessages.map((u) => u.content).join('\n');
  const occurrences = countOccurrences(joined, token);
  ok(occurrences === 1,
    `${scenarioLabel}: token appears EXACTLY once verbatim in JSONL user-message (got ${occurrences})`);

  // The transform must have fired — the prompt had newlines, so the
  // JSONL content should carry MULTILINE_SEPARATOR, and must NOT carry
  // a raw newline inside the (single-line) user content.
  const carrier = userMessages.find((u) => u.content.includes(token));
  if (carrier) {
    ok(carrier.content.includes(MULTILINE_SEPARATOR),
      `${scenarioLabel}: MULTILINE_SEPARATOR ('${MULTILINE_SEPARATOR}') present — \\n→sep transform fired`);
    ok(!/\n/.test(carrier.content),
      `${scenarioLabel}: no raw newline survived in the user-message content`);
    // The token must not have been split by the separator: the bytes
    // immediately around it are NOT part of the token, and the token
    // substring itself is contiguous (countOccurrences already proved
    // verbatim presence; this asserts the separator didn't land
    // mid-token by checking the token has no ' / ' inside it — it
    // can't, by construction, but assert the carrier still has it).
    ok(carrier.content.indexOf(token) >= 0,
      `${scenarioLabel}: token is contiguous (separator did not split it)`);
  } else {
    fail(`${scenarioLabel}: no JSONL user-message carries the token`);
  }

  // (a) the agent ignored the token — it is not echoed in the reply.
  ok(!String(replyText || '').includes(token),
    `${scenarioLabel}: agent reply does NOT echo the token (agent ignored it)`);
}

// ─── Scenarios ───────────────────────────────────────────────────────

const scenarios = [];
function S(name, fn) { scenarios.push({ name, fn }); }

// Scenario 1 — token as an attribute on the opening <polygram-info> tag.
S('token-attribute', async () => {
  const { p, cwd, cleanup } = await setupRealTui('attr');
  try {
    const token = mintToken();
    const prompt = buildPrompt({
      token,
      shape: 'attribute',
      instruction: 'Reply ONLY with the single word "TOKENOK" — nothing else.',
    });
    const res = await p.send(prompt);
    log('attribute res:', JSON.stringify({
      text: res.text?.slice(0, 80), error: res.error,
      resolvedVia: res.metrics?.resolvedVia, stopReason: res.metrics?.stopReason,
    }));
    ok(/TOKENOK/i.test(res.text || ''),
      `agent produced the requested reply (got ${JSON.stringify(res.text?.slice(0, 60))})`);
    const users = await readUserMessages(cwd, p.claudeSessionId, { minCount: 1 });
    ok(users.length >= 1, `JSONL has a user-message line (got ${users.length})`);
    assertTokenRoundTrip({
      token, userMessages: users, replyText: res.text,
      scenarioLabel: 'attribute',
    });
  } finally { await cleanup(); }
});

// Scenario 2 — token as a child line inside the <polygram-info> block.
// This is the harder case for the transform: the token line is
// surrounded by newlines that BOTH become ' / ' separators.
S('token-child-line', async () => {
  const { p, cwd, cleanup } = await setupRealTui('child');
  try {
    const token = mintToken();
    const prompt = buildPrompt({
      token,
      shape: 'child-line',
      instruction: 'Reply ONLY with the single word "CHILDOK" — nothing else.',
    });
    const res = await p.send(prompt);
    log('child-line res:', JSON.stringify({ text: res.text?.slice(0, 80), error: res.error }));
    ok(/CHILDOK/i.test(res.text || ''),
      `agent produced the requested reply (got ${JSON.stringify(res.text?.slice(0, 60))})`);
    const users = await readUserMessages(cwd, p.claudeSessionId, { minCount: 1 });
    ok(users.length >= 1, `JSONL has a user-message line (got ${users.length})`);
    assertTokenRoundTrip({
      token, userMessages: users, replyText: res.text,
      scenarioLabel: 'child-line',
    });
  } finally { await cleanup(); }
});

// Scenario 3 — concatenation immunity (§1 core claim). A primary send
// and an autosteer inject land close together. The TUI MAY concatenate
// them into one user-message. Whether it does or not, BOTH tokens must
// appear verbatim across the JSONL user-messages — that is what makes
// attribution survive a lost paste boundary.
S('two-tokens-concat', async () => {
  const { p, cwd, cleanup } = await setupRealTui('concat');
  try {
    const tokenA = mintToken();
    const tokenB = mintToken();
    const promptA = buildPrompt({
      token: tokenA,
      shape: 'attribute',
      instruction: 'Reply ONLY with the single word "AAA".',
    });
    const promptB = buildPrompt({
      token: tokenB,
      shape: 'attribute',
      instruction: 'Also include the single word "BBB" in your reply.',
    });
    const sendP = p.send(promptA);
    // Fire the autosteer in the same tick — maximises the chance the
    // TUI concatenates the two pastes (the exact condition §1 must
    // be immune to).
    p.injectUserMessage({ content: promptB, msgId: 42 });
    const res = await sendP;
    // Give the JSONL tail time to write both user lines (or the one
    // concatenated line) plus the assistant reply.
    await sleep(1500);
    log('concat res:', JSON.stringify({ text: res.text?.slice(0, 100), error: res.error }));

    const users = await readUserMessages(cwd, p.claudeSessionId, { minCount: 1, timeoutMs: 20_000 });
    const joined = users.map((u) => u.content).join('\n');
    const aCount = countOccurrences(joined, tokenA);
    const bCount = countOccurrences(joined, tokenB);
    log(`concat: ${users.length} user-message line(s); tokenA×${aCount} tokenB×${bCount}`);

    ok(aCount === 1, `primary token present exactly once across JSONL (got ${aCount})`);
    ok(bCount === 1, `autosteer token present exactly once across JSONL (got ${bCount})`);
    // The whole point: even if the boundary was lost (1 line) the two
    // tokens still tell you which two turns the TUI merged.
    const distinctTurns = aCount === 1 && bCount === 1;
    ok(distinctTurns,
      `both tokens recoverable — attribution survives concatenation (lines=${users.length})`);
    ok(!String(res.text || '').includes(tokenA) && !String(res.text || '').includes(tokenB),
      'agent reply echoes NEITHER token');
  } finally { await cleanup(); }
});

// ─── Driver ──────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  let chosen = scenarios;
  if (arg) {
    chosen = scenarios.filter((s) => s.name === arg);
    if (chosen.length === 0) {
      console.error(`No scenario "${arg}". Available:`);
      for (const s of scenarios) console.error(`  ${s.name}`);
      process.exit(2);
    }
  }
  console.log(`Phase 0 — correlation token round-trip. Running ${chosen.length} scenario(s).\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const s of chosen) {
    console.log(`\n=== ${s.name} ===`);
    scenarioFailed = false;
    const t0 = Date.now();
    try {
      await s.fn();
    } catch (err) {
      fail(`scenario threw: ${err.message}`);
      log(err.stack);
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (scenarioFailed) { failed++; failures.push(s.name); console.log(`  → FAILED in ${elapsed}s`); }
    else { passed++; console.log(`  → passed in ${elapsed}s`); }
  }

  console.log('\n=== Summary ===');
  console.log(`Scenarios: ${chosen.length}  Passed: ${passed}  Failed: ${failed}`);
  console.log(`Assertions: ${totalAsserts}`);
  if (failures.length > 0) {
    console.log('\nFailed scenarios:');
    for (const f of failures) console.log('  -', f);
    console.log('\n=== PHASE 0 GATE: FAIL — token round-trip is NOT safe. Re-design before Phase 1. ===');
    process.exit(1);
  }
  console.log('\n=== PHASE 0 GATE: PASS — correlation token survives the TUI round-trip. ===');
}

main().catch((err) => {
  console.error('[spike] fatal:', err);
  process.exit(1);
});
