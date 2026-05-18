#!/usr/bin/env node
/**
 * Probe: does a large (~1.2 KB) bracketed paste submit when Enter is
 * sent after the current 80ms pasteText drain? Throwaway investigation
 * for the 2026-05-18 paste-without-submit bug.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');
const { buildPrompt } = require('../../lib/prompt.js');
const { CLAUDE_CLI_PINNED_VERSION } = require('../../lib/process/tmux-process.js');
const { verifyPinnedClaudeBin } = require('../../lib/claude-bin.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const runner = createTmuxRunner({ logger: console });
  const name = 'polygram-spike-spike-largepaste';
  const cwd = process.cwd();
  try { await runner.killSession(name); } catch {}
  const bin = verifyPinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION);
  if (!bin.ok) { console.error('no pinned bin:', bin.reason); process.exit(1); }

  await runner.spawn({
    name, cwd, command: bin.path,
    args: ['--session-id', crypto.randomUUID(),
      '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'],
  });
  // wait for ready
  for (let i = 0; i < 120; i++) {
    const buf = await runner.captureWide(name, { lines: 40 });
    if (/\? for shortcuts|bypass permissions on/.test(buf)) break;
    await sleep(500);
  }
  console.log('TUI ready.');

  // Build a production-realistic ~1.2 KB prompt.
  const prompt = buildPrompt({
    msg: {
      chat: { id: -1003807211164 }, message_id: 789,
      from: { first_name: 'Ivan', id: 68861949 },
      date: Math.floor(Date.now() / 1000), message_thread_id: 3,
      text: 'Reply ONLY with the word LARGEPASTEOK and nothing else.',
    },
    topicName: 'Music',
  });
  console.log('prompt length:', prompt.length, 'bytes');

  // EXACTLY what pasteAndEnter does: pasteText (80ms drain) → Enter → 50ms.
  await runner.pasteText(name, prompt);
  await runner.sendControl(name, 'Enter');
  await sleep(50);

  // Did it submit? Check the pane.
  await sleep(2000);
  const buf = await runner.captureWide(name, { lines: 50 });
  const inputBoxHasPaste = /❯.*\[Pasted text/.test(buf) || /❯ <polygram-info/.test(buf);
  console.log('=== PANE 2s after paste+Enter ===');
  console.log(buf.split('\n').slice(-20).join('\n'));
  console.log('=== END ===');
  console.log('VERDICT: prompt still sitting unsubmitted in input box?',
    inputBoxHasPaste ? 'YES — BUG REPRODUCED' : 'no (submitted)');

  // If stuck, try a second Enter to confirm that unsticks it.
  if (inputBoxHasPaste) {
    console.log('--- sending a second Enter ---');
    await runner.sendControl(name, 'Enter');
    await sleep(2500);
    const buf2 = await runner.captureWide(name, { lines: 50 });
    const stillStuck = /❯.*\[Pasted text/.test(buf2) || /❯ <polygram-info/.test(buf2);
    console.log('after 2nd Enter, still stuck?', stillStuck ? 'YES' : 'no — 2nd Enter submitted it');
  }

  await runner.killSession(name);
}
import crypto from 'node:crypto';
main().catch((e) => { console.error(e); process.exit(1); });
