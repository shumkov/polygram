#!/usr/bin/env node
/**
 * G13: Permission-prompt handling for TmuxProcess.
 *
 * G8.S2 surfaced: claude TUI ALWAYS prompts before Write/Edit/Bash
 * unless --permission-mode is set or a PreToolUse hook intervenes.
 *
 * This gate tests the simplest path: --permission-mode bypassPermissions
 * (matches today's SDK pm default). If this works, polygram's tmux
 * backend can ship by simply passing this flag at spawn — no hook
 * revival needed for Phase 1. The hook (R1-F6 / R2-F4) becomes a
 * future enhancement, not a blocker.
 *
 * Cost: ~$0.30
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  tmuxSessionName, tmuxNewSession, tmuxSendKeys, tmuxPasteText,
  tmuxCapturePane, tmuxKillSession, cleanupAll,
  emit, appendFinding, sleep, waitUntil,
} = require('./runner');

const SPIKE_CWD = path.resolve(__dirname, 'sandbox');
fs.mkdirSync(SPIKE_CWD, { recursive: true });
const CLAUDE = '/Users/ivanshumkov/.local/bin/claude';

const READY_HINT_RE = /\?\s+for shortcuts/;
const STREAMING_HINT_RE = /esc to interrupt/;
const PERMISSION_PROMPT_RE = /Do you want to|allow all edits|Yes, allow all/;
function isReady(c) { return READY_HINT_RE.test(c) && !STREAMING_HINT_RE.test(c); }
function isStreaming(c) { return STREAMING_HINT_RE.test(c); }
function hasPermissionPrompt(c) { return PERMISSION_PROMPT_RE.test(c); }

async function testPermissionMode(mode) {
  const name = tmuxSessionName('g13-' + mode);
  const probeFile = path.join(SPIKE_CWD, `g13-probe-${mode}.txt`);
  try { fs.unlinkSync(probeFile); } catch {}

  let detail = { name, mode, probeFile };
  try {
    const args = ['--model', 'sonnet'];
    if (mode !== 'none') args.push('--permission-mode', mode);

    await tmuxNewSession({
      name, cwd: SPIKE_CWD, command: CLAUDE,
      args, envExtras: { TERM: 'xterm-256color' },
    });
    await sleep(3500);
    await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 15000, intervalMs: 500 });

    // Ask claude to write a file
    const probeFileName = path.basename(probeFile);
    await tmuxPasteText(name, `create a file called ${probeFileName} containing just the word "ok"`);
    await tmuxSendKeys(name, 'Enter');

    // Wait up to 45s for: ready (success) OR permission prompt (blocked)
    let outcome = 'timeout';
    await waitUntil(async () => {
      const c = await tmuxCapturePane(name);
      if (hasPermissionPrompt(c)) { outcome = 'prompted'; return true; }
      if (isReady(c) && fs.existsSync(probeFile)) { outcome = 'succeeded'; return true; }
      if (isReady(c) && !fs.existsSync(probeFile)) { outcome = 'completed_no_write'; return true; }
      return false;
    }, { timeoutMs: 45000, intervalMs: 1000 });

    detail.outcome = outcome;
    const finalCap = await tmuxCapturePane(name);
    detail.fileCreated = fs.existsSync(probeFile);
    detail.finalCapTail = finalCap.split('\n').slice(-25).join('\n');
  } catch (err) {
    detail.error = err.message;
  } finally {
    await tmuxKillSession(name);
    try { fs.unlinkSync(probeFile); } catch {}
  }
  return detail;
}

(async () => {
  // Test modes: default (none = TUI default), bypassPermissions, acceptEdits
  const modes = ['none', 'bypassPermissions', 'acceptEdits'];
  const results = {};

  for (const m of modes) {
    console.error(`Testing --permission-mode ${m}...`);
    results[m] = await testPermissionMode(m);
  }

  let status = 'FAIL';
  const detail = { results, conclusion: '' };

  // PASS criteria: at least ONE mode reliably writes the file without
  // a permission prompt.
  const goodMode = modes.find((m) => results[m].outcome === 'succeeded');
  if (goodMode) {
    status = 'PASS';
    detail.conclusion = (
      `Mode '${goodMode}' writes files without TUI permission prompt. ` +
      `polygram TmuxProcess should pass --permission-mode ${goodMode} on cold spawn. ` +
      `Phase 1 ships with this approach; canUseTool / PreToolUse hook (R1-F6) ` +
      `becomes a future enhancement for users who WANT the approval flow.`
    );
  } else {
    status = 'FAIL';
    detail.conclusion = 'No permission mode reliably bypassed the TUI prompt — PreToolUse hook revival becomes mandatory.';
  }

  emit({ gate: 'G13', status, detail });
  appendFinding('G13', status, detail);
  await cleanupAll();
  process.exit(status === 'PASS' ? 0 : 1);
})();
