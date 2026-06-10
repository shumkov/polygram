#!/usr/bin/env node
/**
 * probe-ups-semantics.mjs — 0.13 P0 spike (docs/0.13-channels-lifecycle-design.md §4 P0).
 *
 * Empirically answers the UPS/fold-echo/Stop questions that pick the InputLedger tier:
 *   Q1  does UserPromptSubmit's `prompt` carry the <channel … turn_id="…"> envelope?
 *   Q2  (Q-A) does a message injected mid-cycle that FOLDS fire its own UPS?
 *   Q3  does a message processed as a NEXT cycle fire UPS at pickup?
 *   Q5  (Q-B) for a fold answered in one combined reply, which turn_id(s) does claude echo —
 *       and does it SEE both envelopes (we ask it to list every channel message it received)?
 *   Q6  does Stop fire at the end of a fireUserMessage (no-pending) cycle?
 *   (Q4 drop / Q7 stopHookActive+compaction are answered separately: Q4 is an absence
 *    detector by definition; Q7 via archival events-DB queries — see the findings doc.)
 *
 * Method: real CliProcess (current driver — it writes its own --settings hook files),
 * a SECOND hook tail on the proc's own ndjson for raw payload capture (incl. `prompt`),
 * and thin wrappers on _writeToBridge / _handleBridgeMessage to record every outgoing
 * user_msg turn_id and every incoming tool call's echoed turn_id.
 *
 * Output: <TMPDIR>/ups-probe-<ts>/findings.json + raw captures. Exit 0 always (this is
 * an evidence collector; the verdict is read by a human / the findings doc).
 *
 * Cost: ~3 short turns on sonnet (subscription via pinned claude).
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { CliProcess }      = require('../../lib/process/cli-process.js');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');
const { createHookTail }  = require('../../lib/process/hook-event-tail.js');

let CLAUDE_BIN = process.env.POLYGRAM_CLAUDE_BIN || null;
if (!CLAUDE_BIN) {
  const { CLAUDE_CLI_PINNED_VERSION, verifyPinnedClaudeBin } = require('../../lib/claude-bin.js');
  const check = verifyPinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION);
  if (!check.ok) { console.error(`pinned claude missing: ${check.reason}`); process.exit(2); }
  CLAUDE_BIN = check.path;
}

const STAMP    = Date.now();
const BOT_NAME = 'ups-probe';
const SESSION_KEY = `ups-probe-${STAMP}`;
const CHAT_ID  = '-9999999998';
const OUT_DIR  = path.join(os.tmpdir(), `ups-probe-${STAMP}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── capture state ───────────────────────────────────────────────────
const sentUserMsgs = [];   // {ts, turn_id, text_head, via}  — every user_msg written to the bridge
const inboundTools = [];   // {ts, name, tool_call_id, echoed_turn_id, text_head}
const hookEvents   = [];   // normalized hook events incl. prompt
const dispatches   = [];   // delivered replies
let   msgIdSeq     = 1000;

const UUID_RE = /turn_id="([0-9a-f-]{36})"/g;

function head(s, n = 160) { return typeof s === 'string' ? s.slice(0, n).replace(/\n/g, '\\n') : s; }

async function main() {
  console.log(`=== probe-ups-semantics === out=${OUT_DIR}\nclaude=${CLAUDE_BIN}`);

  const runner = createTmuxRunner({ logger: console });
  const toolDispatcher = async ({ toolName, text }) => {
    dispatches.push({ ts: Date.now(), toolName, text });
    console.log(`[dispatch ${toolName}] ${head(text)}`);
    return { ok: true, message_id: ++msgIdSeq };
  };

  const proc = new CliProcess({
    sessionKey: SESSION_KEY, chatId: CHAT_ID, threadId: null, label: 'ups-probe',
    tmuxRunner: runner, botName: BOT_NAME, claudeBin: CLAUDE_BIN,
    toolDispatcher, logger: console,
    turnQuietMs: 2000, turnTimeoutMs: 120_000,
  });

  // Wrap bridge IO for turn_id round-trip capture.
  const realWrite = proc._writeToBridge.bind(proc);
  proc._writeToBridge = (obj) => {
    if (obj?.kind === 'user_msg') {
      sentUserMsgs.push({ ts: Date.now(), turn_id: obj.turn_id, text_head: head(obj.text, 60) });
      console.log(`[user_msg →] turn_id=${obj.turn_id} "${head(obj.text, 60)}"`);
    }
    return realWrite(obj);
  };
  const realHandle = proc._handleBridgeMessage.bind(proc);
  proc._handleBridgeMessage = (msg) => {
    if (msg?.kind === 'tool') {
      inboundTools.push({
        ts: Date.now(), name: msg.name, tool_call_id: msg.tool_call_id,
        echoed_turn_id: msg.args?.turn_id ?? null, text_head: head(msg.args?.text, 120),
      });
      console.log(`[tool ←] ${msg.name} echoed_turn_id=${msg.args?.turn_id ?? 'NONE'}`);
    }
    return realHandle(msg);
  };

  console.log('\n[start]…');
  await proc.start({ cwd: OUT_DIR, model: 'sonnet', effort: 'medium', permissionMode: 'bypassPermissions' });

  // Second tail on the proc's own ndjson for RAW payloads (prompt field).
  const tail = createHookTail({ path: proc._hookNdjsonPath, logger: console });
  tail.on('event', (ev) => {
    hookEvents.push({ ts: Date.now(), type: ev.type, prompt: ev.prompt ?? null,
      toolName: ev.toolName ?? null, stopHookActive: ev.stopHookActive ?? null });
    if (ev.type === 'UserPromptSubmit') {
      const ids = [...String(ev.prompt || '').matchAll(UUID_RE)].map((m) => m[1]);
      console.log(`[UPS] envelope_turn_ids=[${ids.join(',')}] prompt_head="${head(ev.prompt, 120)}"`);
    } else if (ev.type === 'Stop') {
      console.log(`[Stop] stop_hook_active=${ev.stopHookActive}`);
    }
  });
  tail.start();

  // ── Phase A (Q1): plain primary turn ──────────────────────────────
  console.log('\n── Phase A: primary turn (Q1) ──');
  await proc.send('Reply with exactly the single word: ALPHA', {
    context: { chatId: CHAT_ID, user: 'probe', sourceMsgId: 1 } });
  await sleep(4000); // let Stop land

  // ── Phase B (Q2/Q3/Q5): mid-cycle inject during a slow turn ───────
  console.log('\n── Phase B: inject mid-cycle (Q-A, Q-B) ──');
  const sendP = proc.send(
    'Run `sleep 12` via Bash. After it finishes, send ONE reply that (a) answers any '
    + 'follow-up channel messages you received during the sleep, and (b) lists the turn_id '
    + 'attribute value of EVERY <channel> message you have received in this conversation so far, one per line.',
    { context: { chatId: CHAT_ID, user: 'probe', sourceMsgId: 2 } });
  await sleep(5000); // mid-sleep — cycle is busy
  const injected = proc.injectUserMessage({
    content: 'Mid-turn follow-up: what is 2+2? Include the answer in your reply.',
    priority: 'next', msgId: 43 });
  console.log(`[inject] returned ${injected}`);
  await sendP.catch((e) => console.log(`[phase B send err] ${e.message}`));
  await sleep(12_000); // window for a second cycle / late UPS / Stop(s)

  // ── Phase D (Q6): fireUserMessage — no-pending cycle ───────────────
  console.log('\n── Phase D: fireUserMessage cycle (Q6) ──');
  const upsBefore = hookEvents.filter((e) => e.type === 'UserPromptSubmit').length;
  const stopsBefore = hookEvents.filter((e) => e.type === 'Stop').length;
  proc.fireUserMessage('Reply with exactly the single word: CHARLIE');
  await sleep(20_000);

  // ── Persist + summarize ────────────────────────────────────────────
  await proc.kill('probe-done').catch(() => {});
  try { tail.close(); } catch {}

  const ups = hookEvents.filter((e) => e.type === 'UserPromptSubmit')
    .map((e) => ({ ts: e.ts, envelope_turn_ids: [...String(e.prompt || '').matchAll(UUID_RE)].map((m) => m[1]),
                   has_channel_tag: /<channel\s/.test(String(e.prompt || '')), prompt_head: head(e.prompt, 200) }));
  const stops = hookEvents.filter((e) => e.type === 'Stop')
    .map((e) => ({ ts: e.ts, stopHookActive: e.stopHookActive }));

  const findings = {
    timestamp: new Date().toISOString(), claudeBin: CLAUDE_BIN, outDir: OUT_DIR,
    sentUserMsgs, ups, stops,
    inboundToolEchoes: inboundTools,
    deliveredReplies: dispatches.map((d) => ({ ts: d.ts, toolName: d.toolName, text: d.text })),
    phaseD: { upsBefore, stopsBefore,
      upsAfter: ups.length, stopsAfter: stops.length },
    q1_ups_carries_envelope: ups.length > 0 ? ups.every((u) => u.has_channel_tag) : null,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
  fs.copyFileSync(proc._hookNdjsonPath ?? '/dev/null', path.join(OUT_DIR, 'hook-events.ndjson'));

  console.log('\n=== summary ===');
  console.log(`user_msgs sent:   ${sentUserMsgs.length} (${sentUserMsgs.map((m) => m.turn_id.slice(0, 8)).join(', ')})`);
  console.log(`UPS events:       ${ups.length}`);
  for (const u of ups) console.log(`  UPS ids=[${u.envelope_turn_ids.map((i) => i.slice(0, 8)).join(',')}] channel_tag=${u.has_channel_tag}`);
  console.log(`Stop events:      ${stops.length} (${stops.map((s) => `shA=${s.stopHookActive}`).join(', ')})`);
  console.log(`reply echoes:     ${inboundTools.filter((t) => t.name === 'reply').map((t) => (t.echoed_turn_id || 'NONE').slice(0, 8)).join(', ')}`);
  console.log(`findings: ${path.join(OUT_DIR, 'findings.json')}`);
  process.exit(0);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => { console.error('[FATAL]', err.stack || err.message); process.exit(2); });
