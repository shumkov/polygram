#!/usr/bin/env node
'use strict';

/**
 * SPIKE: reproduce the channels mid-turn-inject → claude RE-ANNOUNCES a prior
 * completion (the message-duplication bug, shumorobot general 2026-06-04).
 *
 * Incident shape:
 *   Turn A finishes and emphatically announces completion ("All done. **76
 *   snippets**…" + sticker). Then the user fires status-probe follow-ups
 *   ("Are you redownloading?"); the 2nd is autosteered → injectUserMessage folds
 *   it into the in-flight turn as a FRESH-turn_id channel notification. Claude,
 *   re-prompted with its just-delivered completion still in context, RE-EMITS the
 *   announcement (byte-identical + a reworded variant + a duplicate sticker).
 *
 * This spike replays that shape against REAL claude and counts how many times the
 * completion SENTINEL is delivered. >1 = the re-announce bug reproduced.
 *
 * Variants (env INJECT_VARIANT):
 *   baseline  — current injectUserMessage (fresh turn_id)              [default]
 *   bind      — inject reuses the active turn's turn_id (option-3 V1)
 *   frame     — inject content prefixed with a "don't repeat" directive (V2)
 *   bind+frame— both
 *
 * Run (needs the pinned claude + keychain; NOT sandboxed):
 *   node scripts/spikes/channels-reannounce-repro.mjs
 *   INJECT_VARIANT=frame node scripts/spikes/channels-reannounce-repro.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliProcess } from '../../lib/process/cli-process.js';
import { createTmuxRunner } from '../../lib/tmux/tmux-runner.js';
import { resolvePinnedClaudeBin, CLAUDE_CLI_PINNED_VERSION } from '../../lib/claude-bin.js';

const VARIANT = process.env.INJECT_VARIANT || 'baseline';
const SENTINEL = 'ARTIFACT-QZ7K-9931';   // unique; a re-announce must echo this

const noopStreamer = {
  onChunk: async () => {}, forceNewMessage: () => {},
  finalize: async () => ({ streamed: false }), flushDraft: async () => {}, discard: async () => {},
};
const noopReactor = { setState: () => {}, heartbeat: () => {}, clear: async () => {}, stop: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Captured reply-tool deliveries (what would reach Telegram).
const replies = [];

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'polygram-reannounce-'));

const proc = new CliProcess({
  sessionKey: 'spike-reannounce:1',
  chatId: '987654399',
  threadId: null,
  label: 'reannounce',
  tmuxRunner: createTmuxRunner(),
  botName: 'spiketest',
  claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
  toolDispatcher: async ({ toolName, text }) => {
    if (toolName === 'reply' && typeof text === 'string') {
      replies.push({ t: Date.now(), text });
      console.log(`  [reply #${replies.length}] ${JSON.stringify(text.slice(0, 90))}`);
    }
    return { ok: true };
  },
  logger: { warn: () => {}, error: (...a) => console.error('[err]', ...a), log: () => {}, debug: () => {} },
  db: { logEvent: () => {} },
});

// ── Option-3 variant patching (spike-only; the real fix would live in CliProcess) ──
if (VARIANT === 'bind' || VARIANT === 'bind+frame') {
  // V1: make injectUserMessage reuse the in-flight turn's turn_id instead of a
  // fresh one, so claude sees the follow-up as part of the SAME turn rather than
  // a new channel message.
  const orig = proc.injectUserMessage.bind(proc);
  proc.injectUserMessage = function patched(opts = {}) {
    const [activeId] = this.pendingTurns.keys();   // the in-flight turn's id
    if (activeId) this._spikeBindTurnId = activeId;
    return orig(opts);
  };
  // Patch _writeToBridge to swap in the bound turn_id for user_msg writes.
  const origWrite = proc._writeToBridge.bind(proc);
  proc._writeToBridge = function patchedWrite(msg) {
    if (msg && msg.kind === 'user_msg' && this._spikeBindTurnId) {
      msg = { ...msg, turn_id: this._spikeBindTurnId };
      this._spikeBindTurnId = null;
    }
    return origWrite(msg);
  };
}

function frameContent(content) {
  if (VARIANT === 'frame' || VARIANT === 'bind+frame') {
    return `[Follow-up to your in-progress work — I already received every message you sent. Do NOT resend or repeat any earlier message; just address this:] ${content}`;
  }
  return content;
}

async function main() {
  console.log(`\n=== channels re-announce repro — VARIANT=${VARIANT} ===`);
  await proc.start({
    cwd,
    chatConfig: { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true },
    existingSessionId: null,
  });
  console.log('claude started.\n');

  // ── Turn A: produce an emphatic completion announcement carrying the sentinel.
  console.log('TURN A: completion announcement…');
  await proc.send(
    `Do this small task, then announce completion. Step 1: run the bash command \`true\`. `
    + `Step 2: reply with EXACTLY this one line and nothing else: `
    + `"✅ All done — artifact ${SENTINEL} is ready."`,
    { timeoutMs: 90_000, maxTurnMs: 120_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
  );
  const afterA = replies.length;
  const sentinelInA = replies.filter((r) => r.text.includes(SENTINEL)).length;
  console.log(`  → turn A delivered ${afterA} replies, sentinel x${sentinelInA}\n`);

  const turnAText = replies[0]?.text || '__none__';

  // ── PHASE B: the AUTONOMOUS background-shell-completion path (the incident had
  //    "Background command 'Import 308 clean tracks' completed (exit 0)" firing in
  //    the replay window). Turn B launches a detached background shell + announces,
  //    then we WAIT (no user input) for the shell to complete and watch whether
  //    claude AUTONOMOUSLY re-emits a prior message VERBATIM.
  console.log('TURN B: launch a background shell that will complete in ~10s, then go idle…');
  await proc.send(
    `Use the Bash tool with run_in_background=true to run exactly: \`sleep 10\`. Do not wait for it. `
    + `Then reply with EXACTLY this one line: "🚀 Kicked off — ${SENTINEL} processing in the background." `
    + `Then end your turn; I will wait.`,
    { timeoutMs: 90_000, maxTurnMs: 120_000, context: { streamer: noopStreamer, reactor: noopReactor, threadId: null } },
  );
  const afterB = replies.length;
  console.log(`  → turn B delivered ${afterB - afterA} replies; now idling ~16s for the bg shell to COMPLETE…\n`);

  // No user input — just wait for the background shell completion notification to
  // reach claude and see if it autonomously re-announces.
  await sleep(16_000);

  // ── Verdict. The REAL bug signature = a delivery byte-identical to a PRIOR
  //    delivery (verbatim replay), OR a duplicate of turn A/B's exact text.
  const priorTexts = new Set();
  let verbatimReplays = 0;
  const replayed = [];
  for (let i = 0; i < replies.length; i++) {
    const tx = replies[i].text;
    if (priorTexts.has(tx)) { verbatimReplays++; replayed.push(tx); }
    priorTexts.add(tx);
  }
  const autonomousAfterB = replies.slice(afterB);
  console.log('\n=== RESULT ===');
  console.log(`variant               : ${VARIANT}`);
  console.log(`total replies         : ${replies.length}`);
  console.log(`VERBATIM REPLAYS      : ${verbatimReplays}  (byte-identical re-deliveries — the real bug signature)`);
  console.log(`autonomous after-B    : ${autonomousAfterB.length} deliveries with NO user input (bg-completion path)`);
  console.log(`BUG (verbatim replay) : ${verbatimReplays > 0 ? 'REPRODUCED ✗' : 'not observed ✓'}`);
  if (replayed.length) for (const r of replayed) console.log(`  REPLAYED: ${JSON.stringify(r.slice(0, 100))}`);
  console.log('\nall deliveries after turn A:');
  for (const r of replies.slice(afterA)) console.log(`  - ${JSON.stringify(r.text.slice(0, 100))}`);
}

main()
  .catch((err) => { console.error('SPIKE ERROR:', err?.stack || err); process.exitCode = 1; })
  .finally(async () => {
    try { await proc.kill('spike-done'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  });
