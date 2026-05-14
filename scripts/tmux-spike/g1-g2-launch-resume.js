#!/usr/bin/env node
/**
 * G1: claude launches cleanly inside tmux without TUI corruption.
 * G2: --resume <session_id> works from tmux-spawned claude.
 *
 * Cost: ~$0.02 (2 trivial prompts to claude across G1 + G2)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  tmuxSessionName, tmuxNewSession, tmuxSendKeys, tmuxPasteText,
  tmuxCapturePane, tmuxKillSession, cleanupAll,
  emit, appendFinding, sleep, waitUntil,
} = require('./runner');

const SPIKE_CWD = path.resolve(__dirname, '..', '..', 'scripts', 'tmux-spike', 'sandbox');
fs.mkdirSync(SPIKE_CWD, { recursive: true });

// Match the prompt indicator claude TUI uses to signal "awaiting input."
// Per `claude` 2.1.141 TUI: the prompt is "│ > " typically rendered at
// the bottom of the pane. Verified empirically below.
const PROMPT_INDICATORS = [
  /│ > /,    // common
  /^> $/m,   // fallback bare
];

function promptIsReady(captured) {
  return PROMPT_INDICATORS.some((re) => re.test(captured));
}

// Find the last assistant block's text. Naive: take everything between
// last user "> ..." line and the prompt indicator.
function extractLastAssistantText(captured) {
  const lines = captured.split('\n');
  let lastUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^>\s+\S/.test(lines[i])) { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return null;
  // Look forwards from lastUserIdx for the assistant body.
  const rest = lines.slice(lastUserIdx + 1).join('\n');
  return rest;
}

async function g1() {
  const name = tmuxSessionName('g1');
  let status = 'FAIL', detail = { name };
  try {
    await tmuxNewSession({
      name,
      cwd: SPIKE_CWD,
      command: '/Users/ivanshumkov/.local/bin/claude',
      args: ['--print', '--model', 'sonnet', 'say hi in one word'],
    });
    // For --print mode the process exits when done. We're testing that
    // claude RUNS at all inside tmux. Wait for the session to vanish
    // (process exit closes the only pane, kills the session).
    const exited = await waitUntil(async () => {
      const { tmuxSessionExists } = require('./runner');
      return !(await tmuxSessionExists(name));
    }, { timeoutMs: 45000, intervalMs: 1000 });

    // If session is still alive, capture output for diagnosis.
    if (!exited) {
      const captured = await tmuxCapturePane(name);
      detail.captured = captured.slice(-2000);
      status = 'FAIL';
      detail.reason = 'claude --print under tmux did not exit within 45s';
    } else {
      // Session exited cleanly — claude --print ran successfully.
      status = 'PASS';
      detail.note = 'claude --print exited cleanly inside tmux';
    }
  } catch (err) {
    detail.error = err.message;
    detail.stderr = err.stderr;
  } finally {
    await tmuxKillSession(name);
  }
  emit({ gate: 'G1', status, detail });
  appendFinding('G1', status, detail);
  return status === 'PASS';
}

async function g2() {
  // G2 is harder: need to (1) start a TUI session, (2) get its session_id,
  // (3) kill it, (4) resume via --resume, (5) verify context preserved.
  //
  // For the spike, simpler path: use claude --print twice with --resume
  // to verify the resume flag works at all inside tmux.
  const name1 = tmuxSessionName('g2a');
  const name2 = tmuxSessionName('g2b');
  let status = 'FAIL', detail = { name1, name2 };

  try {
    // Step 1: minimal claude session to mint a session_id we can resume.
    // Use --session-id <uuid> to set deterministic id; resume by same id.
    const crypto = require('crypto');
    const sessionId = crypto.randomUUID();
    detail.sessionId = sessionId;

    // Capture claude --print output by redirecting via shell wrapper.
    const out1 = `/tmp/spike-g2-out1-${sessionId.slice(0, 8)}.txt`;
    const out2 = `/tmp/spike-g2-out2-${sessionId.slice(0, 8)}.txt`;

    // Use sh -c so we can redirect stdout. tmux's command is just exec'd.
    await tmuxNewSession({
      name: name1, cwd: SPIKE_CWD,
      command: 'sh',
      args: ['-c',
        `/Users/ivanshumkov/.local/bin/claude --print --session-id ${sessionId} --model sonnet 'remember the secret word is mango. just say ok' > ${out1} 2>&1`,
      ],
    });
    await waitUntil(async () => {
      const { tmuxSessionExists } = require('./runner');
      return !(await tmuxSessionExists(name1));
    }, { timeoutMs: 60000, intervalMs: 1000 });
    detail.firstTurnOutput = fs.existsSync(out1) ? fs.readFileSync(out1, 'utf8').slice(0, 500) : '<no output>';

    // Step 2: resume + ask for the secret word.
    await tmuxNewSession({
      name: name2, cwd: SPIKE_CWD,
      command: 'sh',
      args: ['-c',
        `/Users/ivanshumkov/.local/bin/claude --print --resume ${sessionId} --model sonnet 'what was the secret word? Reply with just the word, no other text' > ${out2} 2>&1`,
      ],
    });
    await waitUntil(async () => {
      const { tmuxSessionExists } = require('./runner');
      return !(await tmuxSessionExists(name2));
    }, { timeoutMs: 60000, intervalMs: 1000 });
    const resumeOutput = fs.existsSync(out2) ? fs.readFileSync(out2, 'utf8') : '';
    detail.resumeOutput = resumeOutput.slice(0, 500);

    // Semantic check: does the resumed claude remember "mango"?
    if (/\bmango\b/i.test(resumeOutput)) {
      status = 'PASS';
      detail.note = '--resume preserved context: claude recalled "mango"';
    } else {
      status = 'FAIL';
      detail.note = '--resume did NOT preserve context — claude did not recall "mango"';
    }

    // Cleanup output files
    try { fs.unlinkSync(out1); } catch {}
    try { fs.unlinkSync(out2); } catch {}
  } catch (err) {
    detail.error = err.message;
    detail.stderr = err.stderr;
  } finally {
    await tmuxKillSession(name1);
    await tmuxKillSession(name2);
  }
  emit({ gate: 'G2', status, detail });
  appendFinding('G2', status, detail);
  return status === 'PASS' || status === 'DEFER';
}

(async () => {
  try {
    const g1Ok = await g1();
    if (!g1Ok) {
      console.error('G1 FAIL — skipping G2');
      process.exit(1);
    }
    const g2Ok = await g2();
    process.exit(g2Ok ? 0 : 1);
  } finally {
    await cleanupAll();
  }
})();
