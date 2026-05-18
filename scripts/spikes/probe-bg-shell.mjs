#!/usr/bin/env node
/**
 * Probe: how does the claude TUI render a running background shell,
 * and how can polygram kill it?  Throwaway investigation script for
 * Bug 1 (2026-05-18 incident).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TmuxProcess } = require('../../lib/process/tmux-process.js');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');
const path = require('node:path');

const SILENT = { warn(){}, error(){}, info(){}, debug(){}, log(){} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const runner = createTmuxRunner({ logger: console });
  const cwd = path.resolve(process.cwd());
  const label = 'probe-bg';
  const p = new TmuxProcess({
    sessionKey: `spike:${label}`, chatId: 'spike', threadId: label,
    label: `spike-${label}`, runner, botName: 'spike', logger: SILENT,
    readyTimeoutMs: 60_000, turnTimeoutMs: 120_000,
  });
  const tmuxName = runner.sessionName('spike', 'spike', label);
  try { await runner.killSession(tmuxName); } catch {}

  await p.start({ chatConfig: { model: 'sonnet', effort: 'low', cwd, permissionMode: 'bypassPermissions' } });

  // Ask the agent to start a long background shell.
  const sendP = p.send(
    'Use the Bash tool with run_in_background:true to start a process '
    + 'that prints a number every second for 5 minutes (python3 loop). '
    + 'Do NOT wait for it. Once it is launched in the background, '
    + 'reply ONLY with "BGSTARTED".',
  );
  await sendP.catch(() => {});
  await sleep(2000);

  console.log('=== PANE after background shell started ===');
  const buf1 = await runner.captureWide(tmuxName, { lines: 60 });
  console.log(buf1);
  console.log('=== END PANE ===');

  // Probe kill option A: Ctrl-B (background-task manager).
  console.log('\n--- sending C-b ---');
  await runner.sendControl(tmuxName, 'C-b');
  await sleep(1500);
  console.log(await runner.captureWide(tmuxName, { lines: 60 }));

  console.log('\n--- sending Escape ---');
  await runner.sendControl(tmuxName, 'Escape');
  await sleep(800);

  // Probe kill option B: /bashes slash command.
  console.log('\n--- pasting /bashes ---');
  await runner.pasteText(tmuxName, '/bashes');
  await sleep(800);
  console.log(await runner.captureWide(tmuxName, { lines: 60 }));
  await runner.sendControl(tmuxName, 'Enter');
  await sleep(2000);
  console.log('=== PANE after /bashes Enter ===');
  console.log(await runner.captureWide(tmuxName, { lines: 60 }));

  await p.kill('probe-done');
  try { await runner.killSession(tmuxName); } catch {}
}
main().catch((e) => { console.error(e); process.exit(1); });
