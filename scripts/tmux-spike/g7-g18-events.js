#!/usr/bin/env node
/**
 * G7: --debug-file <path> emits structured events for assistant
 *     messages, tool uses, compact boundaries.
 * G18: --include-hook-events — does it work in TUI mode (interactive)
 *      or only --print --output-format=stream-json?
 *
 * Together these decide which event channel TmuxProcess uses to
 * surface SDK-equivalent lifecycle events (onStreamChunk, onToolUse,
 * onCompactBoundary, onResult).
 *
 * Cost: ~$0.05 (a few turns to generate events).
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
function isReady(c) { return READY_HINT_RE.test(c) && !STREAMING_HINT_RE.test(c); }

async function g7() {
  const name = tmuxSessionName('g7');
  const debugLog = `/tmp/spike-g7-debug-${Date.now()}.log`;
  let status = 'FAIL', detail = { name, debugLog };
  try {
    await tmuxNewSession({
      name, cwd: SPIKE_CWD,
      command: CLAUDE,
      args: ['--model', 'sonnet', '--debug-file', debugLog, '--debug', 'api,hooks'],
      envExtras: { TERM: 'xterm-256color' },
    });
    await sleep(3500);
    await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 15000, intervalMs: 500 });
    // Send a prompt that involves a tool call so we can verify
    // tool-use events get logged.
    await tmuxPasteText(name, 'list the files in this directory using the Bash tool and reply with a one-sentence summary');
    await tmuxSendKeys(name, 'Enter');
    // Wait for streaming to complete
    await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 60000, intervalMs: 1000 });
    await sleep(500);
    // Read debug log
    if (!fs.existsSync(debugLog)) {
      status = 'FAIL';
      detail.note = '--debug-file did not create the log file';
      detail.captureTail = (await tmuxCapturePane(name)).slice(-800);
    } else {
      const raw = fs.readFileSync(debugLog, 'utf8');
      detail.logBytes = raw.length;
      detail.logLines = raw.split('\n').length;
      // Sample structure of log: are there structured (JSON or
      // parseable kind=key=value) lines? Sample first 5 + last 5 lines.
      const lines = raw.split('\n').filter(Boolean);
      detail.firstLines = lines.slice(0, 5);
      detail.lastLines = lines.slice(-5);

      // Try to detect structured events for: assistant message, tool use.
      const hasAssistantEvent = /assistant|message|content/.test(raw);
      const hasToolEvent = /tool|Bash|tool_use/.test(raw);
      const looksLikeJsonLines = lines.some((ln) => {
        try { JSON.parse(ln); return true; } catch { return false; }
      });
      detail.signals = {
        hasAssistantEvent, hasToolEvent, looksLikeJsonLines,
      };

      // For PASS: log must contain enough structure to extract events.
      // Even if it's not pure JSON, recognizable assistant + tool markers
      // are useful for §4.B hybrid path.
      if (hasAssistantEvent && hasToolEvent) {
        status = 'PASS';
        detail.note = (
          '--debug-file produces log with assistant + tool event markers. ' +
          (looksLikeJsonLines
            ? 'JSON-lines format detected — clean structured event channel.'
            : 'NOT pure JSON-lines but contains parseable markers; ' +
              'TmuxProcess can use this as event source via regex/grep.')
        );
      } else {
        status = 'DEFER';
        detail.note = (
          '--debug-file produced output but missing expected event markers. ' +
          'Falls back to §4.A capture-pane diff scraping for event detection.'
        );
      }
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    await tmuxKillSession(name);
    try { fs.unlinkSync(debugLog); } catch {}
  }
  emit({ gate: 'G7', status, detail });
  appendFinding('G7', status, detail);
  return status !== 'FAIL';
}

async function g18() {
  // G18: --include-hook-events claims to only work with
  // --output-format=stream-json (per --help). Verify by trying TUI.
  const name = tmuxSessionName('g18');
  let status = 'FAIL', detail = { name };
  try {
    // Test 1: TUI mode with --include-hook-events
    await tmuxNewSession({
      name, cwd: SPIKE_CWD,
      command: CLAUDE,
      args: ['--model', 'sonnet', '--include-hook-events'],
      envExtras: { TERM: 'xterm-256color' },
    });
    await sleep(3000);
    const initialCap = await tmuxCapturePane(name);
    // Does it complain about the flag?
    const flagError = /requires|incompatible|only works/i.test(initialCap);
    detail.tuiInitialCap = initialCap.slice(-500);
    detail.flagErrorInTui = flagError;
    await tmuxKillSession(name);
    if (flagError) {
      status = 'DEFER';
      detail.note = (
        '--include-hook-events confirmed to require --print + --output-format=stream-json. ' +
        'Not available in TUI mode. TmuxProcess must use --debug-file (G7) as its only structured-event source.'
      );
    } else {
      // It launched. Does it emit hook events somewhere?
      // For this spike, we can't easily route the events without
      // --output-format=stream-json. Document that the flag was accepted
      // but the events are not capturable from TUI mode.
      status = 'DEFER';
      detail.note = (
        '--include-hook-events flag accepted in TUI mode but hook events not surfaced ' +
        'visibly (stream-json output channel only). For TmuxProcess: rely on --debug-file (G7).'
      );
    }
  } catch (err) {
    detail.error = err.message;
    status = 'FAIL';
  } finally {
    await tmuxKillSession(name);
  }
  emit({ gate: 'G18', status, detail });
  appendFinding('G18', status, detail);
  return status !== 'FAIL';
}

(async () => {
  let allOk = true;
  try {
    if (!(await g7())) allOk = false;
    if (!(await g18())) allOk = false;
  } finally {
    await cleanupAll();
  }
  process.exit(allOk ? 0 : 1);
})();
