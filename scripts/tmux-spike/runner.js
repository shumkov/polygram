/**
 * Shared tmux wrapper for the 0.10.0 spike scripts.
 *
 * Each gate script imports this for spawn / send / capture / kill.
 * Production lib/tmux/tmux-runner.js (Phase 1) will be the cleaned-up
 * descendant of this code.
 *
 * Throwaway: don't optimize, don't generalize beyond what gates need.
 */

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout; err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Sanitize against control chars — matches the v3/v4 spec's sanitizeForTmux().
const CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
function sanitize(text) {
  return String(text).replace(CONTROL_CHAR_RE, '');
}

function tmuxSessionName(label) {
  // Spike-tagged so cleanup is easy: `tmux ls | grep spike-`
  const suffix = crypto.randomBytes(3).toString('hex');
  return `spike-${label}-${suffix}`.replace(/[^\w-]/g, '_');
}

async function tmuxNewSession({ name, cwd, command, args = [], envExtras = {} }) {
  const sessArgs = ['new-session', '-d', '-s', name];
  if (cwd) sessArgs.push('-c', cwd);
  for (const [k, v] of Object.entries(envExtras)) {
    sessArgs.push('-e', `${k}=${v}`);
  }
  // Tmux's command is positional last.
  sessArgs.push(command, ...args);
  await run('tmux', sessArgs);
  // Wide pane for capture-pane semantics (G12 pre-empt).
  await run('tmux', ['set-option', '-t', name, 'pane-width', '200']).catch(() => {});
  return name;
}

async function tmuxSendKeys(name, keys) {
  await run('tmux', ['send-keys', '-t', name, keys]);
}

async function tmuxPasteText(name, text) {
  const safe = sanitize(text);
  const bufName = `spike-buf-${crypto.randomBytes(3).toString('hex')}`;
  await run('tmux', ['set-buffer', '-b', bufName, safe]);
  await run('tmux', ['paste-buffer', '-t', name, '-b', bufName, '-d']);
}

async function tmuxCapturePane(name, { lines = 1000 } = {}) {
  const { stdout } = await run('tmux', [
    'capture-pane', '-t', name, '-p', '-S', `-${lines}`,
  ]);
  return stdout;
}

async function tmuxSessionExists(name) {
  try {
    await run('tmux', ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxKillSession(name) {
  await run('tmux', ['kill-session', '-t', name]).catch(() => {});
}

async function tmuxListSpikeSessions() {
  try {
    const { stdout } = await run('tmux', ['list-sessions', '-F', '#{session_name}']);
    return stdout.trim().split('\n').filter((n) => n.startsWith('spike-'));
  } catch {
    return [];
  }
}

// Emit a JSON-Lines result for a gate.
function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

// Findings doc helpers — each gate appends a section.
function appendFinding(gateId, status, detail) {
  const docPath = path.resolve(__dirname, '..', '..', 'docs', '0.10.0-phase0-spike-findings.md');
  const ts = new Date().toISOString();
  const section = `\n## ${gateId} — ${status} (${ts})\n\n` +
    '```json\n' + JSON.stringify(detail, null, 2) + '\n```\n';
  fs.appendFileSync(docPath, section);
}

// Cleanup all spike-* tmux sessions (call at end of any script).
async function cleanupAll() {
  const names = await tmuxListSpikeSessions();
  for (const n of names) await tmuxKillSession(n);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

module.exports = {
  run, sanitize, sleep, waitUntil,
  tmuxSessionName, tmuxNewSession, tmuxSendKeys, tmuxPasteText,
  tmuxCapturePane, tmuxSessionExists, tmuxKillSession,
  tmuxListSpikeSessions, cleanupAll,
  emit, appendFinding,
};
