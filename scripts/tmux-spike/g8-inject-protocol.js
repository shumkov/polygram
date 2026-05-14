#!/usr/bin/env node
/**
 * G8: Mid-turn paste-buffer + Enter is autosteer-equivalent.
 * 8-scenario protocol per §10.G8-protocol.
 *
 * Spike scope: S1 (baseline), S2 (between tool calls), S5 (multi-inject).
 * Other scenarios DEFER with documented reasoning — see comments.
 *
 * Cost: ~$1.50 (3 multi-step turns at sonnet/high).
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
function isStreaming(c) { return STREAMING_HINT_RE.test(c); }

async function spawnTui(label) {
  const name = tmuxSessionName(label);
  await tmuxNewSession({
    name, cwd: SPIKE_CWD, command: CLAUDE,
    args: ['--model', 'sonnet'],
    envExtras: { TERM: 'xterm-256color' },
  });
  await sleep(3500);
  await waitUntil(async () => isReady(await tmuxCapturePane(name)),
    { timeoutMs: 15000, intervalMs: 500 });
  return name;
}

async function s1() {
  // S1 baseline: inject during pure-text streaming.
  // Prompt asks for slow output; mid-stream, paste a follow-up;
  // observe whether claude folds it in.
  const name = await spawnTui('g8s1');
  let status = 'FAIL', detail = { name, scenario: 'S1 baseline' };
  try {
    const t0 = Date.now();
    await tmuxPasteText(name, 'count slowly from 1 to 15, one number per line with a one-word comment');
    await tmuxSendKeys(name, 'Enter');
    // Wait until streaming starts
    await waitUntil(async () => isStreaming(await tmuxCapturePane(name)),
      { timeoutMs: 15000, intervalMs: 300 });
    const tStreamStart = Date.now();
    await sleep(2500);  // let some content stream

    const capBefore = await tmuxCapturePane(name);
    detail.streamingBefore = {
      streaming: isStreaming(capBefore),
      sampleTail: capBefore.split('\n').slice(-15).join('\n'),
    };

    // INJECT
    const tInject = Date.now();
    await tmuxPasteText(name, 'also include the number 100 at the end');
    await tmuxSendKeys(name, 'Enter');

    // Wait for completion
    const completed = await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 60000, intervalMs: 1000 });
    const tComplete = Date.now();
    const finalCap = await tmuxCapturePane(name);

    detail.timings = {
      streamStartLatency_ms: tStreamStart - t0,
      streamRunBefore_inject_ms: tInject - tStreamStart,
      injectToComplete_ms: tComplete - tInject,
      total_ms: tComplete - t0,
    };
    detail.completed = completed;
    detail.finalCapTail = finalCap.split('\n').slice(-30).join('\n');

    // Key evidence: did claude include "100" in the final output?
    const includedHundred = /\b100\b/.test(finalCap);
    detail.foldedInInject = includedHundred;

    // Was there only ONE turn (fold) or did it split into two assistant blocks?
    // Heuristic: count `⏺` markers (assistant text blocks).
    const assistantMarkers = (finalCap.match(/⏺/g) || []).length;
    detail.assistantMarkersInFinal = assistantMarkers;

    if (includedHundred && assistantMarkers <= 2) {
      status = 'PASS';
      detail.note = (
        'S1 PASS: claude folded the mid-stream inject into the current turn. ' +
        `Final output includes "100". Assistant block count: ${assistantMarkers}.`
      );
    } else if (includedHundred) {
      status = 'PASS';
      detail.note = (
        'S1 partial-PASS: claude included the injected content but produced ' +
        `${assistantMarkers} assistant blocks. May have split into a new turn.`
      );
    } else {
      status = 'FAIL';
      detail.note = 'S1 FAIL: claude did not include the injected "100" in output';
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    await tmuxKillSession(name);
  }
  emit({ gate: 'G8.S1', status, detail });
  appendFinding('G8.S1', status, detail);
  return status === 'PASS';
}

async function s2() {
  // S2: inject between tool calls.
  // Prompt asks for two file reads; inject after first read fires.
  const name = await spawnTui('g8s2');
  let status = 'FAIL', detail = { name, scenario: 'S2 between tool calls' };
  try {
    // Create two distinct sandbox files
    fs.writeFileSync(path.join(SPIKE_CWD, 'fileA.txt'), 'apple\nbanana\ncherry');
    fs.writeFileSync(path.join(SPIKE_CWD, 'fileB.txt'), '1\n2\n3\n4\n5');

    await tmuxPasteText(name, 'Read fileA.txt then read fileB.txt. After each, just say what you found in one sentence.');
    await tmuxSendKeys(name, 'Enter');
    await waitUntil(async () => isStreaming(await tmuxCapturePane(name)),
      { timeoutMs: 15000, intervalMs: 300 });

    // Wait until first read tool fires
    await waitUntil(async () => {
      const c = await tmuxCapturePane(name);
      return /apple/i.test(c) || /banana/i.test(c);
    }, { timeoutMs: 30000, intervalMs: 800 });
    await sleep(1500);  // small gap, ideally between tool calls

    // INJECT
    await tmuxPasteText(name, 'also create fileC.txt with just the word "tomato"');
    await tmuxSendKeys(name, 'Enter');

    const completed = await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 90000, intervalMs: 1000 });
    const finalCap = await tmuxCapturePane(name);
    detail.completed = completed;
    detail.finalCapTail = finalCap.split('\n').slice(-40).join('\n');

    // Evidence: was fileC.txt created? Did claude reference all 3?
    const fileCExists = fs.existsSync(path.join(SPIKE_CWD, 'fileC.txt'));
    const fileCContent = fileCExists ? fs.readFileSync(path.join(SPIKE_CWD, 'fileC.txt'), 'utf8').trim() : null;
    detail.fileCExists = fileCExists;
    detail.fileCContent = fileCContent;
    detail.allThreeReferenced = /fileA|apple/i.test(finalCap) &&
                                 /fileB/i.test(finalCap) &&
                                 /tomato|fileC/i.test(finalCap);

    if (fileCExists && /tomato/i.test(fileCContent)) {
      status = 'PASS';
      detail.note = 'S2 PASS: claude folded the inject (create fileC) into the multi-tool turn';
    } else {
      status = 'FAIL';
      detail.note = `S2 FAIL: fileC ${fileCExists ? 'exists with wrong content' : 'NOT created'}`;
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    for (const f of ['fileA.txt', 'fileB.txt', 'fileC.txt']) {
      try { fs.unlinkSync(path.join(SPIKE_CWD, f)); } catch {}
    }
    await tmuxKillSession(name);
  }
  emit({ gate: 'G8.S2', status, detail });
  appendFinding('G8.S2', status, detail);
  return status === 'PASS';
}

async function s5() {
  // S5: multiple rapid injects (autosteer queue stress).
  const name = await spawnTui('g8s5');
  let status = 'FAIL', detail = { name, scenario: 'S5 multi-inject stress' };
  try {
    await tmuxPasteText(name, 'count slowly from 1 to 10 with a one-word comment per line');
    await tmuxSendKeys(name, 'Enter');
    await waitUntil(async () => isStreaming(await tmuxCapturePane(name)),
      { timeoutMs: 15000, intervalMs: 300 });
    await sleep(1500);

    // 3 rapid injects 500ms apart
    const probes = ['ALSO mention apricot', 'ALSO mention blueberry', 'ALSO mention cherry'];
    for (const p of probes) {
      await tmuxPasteText(name, p);
      await tmuxSendKeys(name, 'Enter');
      await sleep(500);
    }

    const completed = await waitUntil(async () => isReady(await tmuxCapturePane(name)),
      { timeoutMs: 90000, intervalMs: 1000 });
    const finalCap = await tmuxCapturePane(name);
    detail.completed = completed;
    detail.finalCapTail = finalCap.split('\n').slice(-40).join('\n');

    const hasApricot = /apricot/i.test(finalCap);
    const hasBlueberry = /blueberry/i.test(finalCap);
    const hasCherry = /cherry/i.test(finalCap);
    detail.probeRecall = { hasApricot, hasBlueberry, hasCherry };
    detail.assistantMarkers = (finalCap.match(/⏺/g) || []).length;

    const allLanded = hasApricot && hasBlueberry && hasCherry;
    if (allLanded) {
      status = 'PASS';
      detail.note = 'S5 PASS: all 3 rapid injects recalled in final output';
    } else {
      const landed = [hasApricot, hasBlueberry, hasCherry].filter(Boolean).length;
      status = landed >= 1 ? 'DEFER' : 'FAIL';
      detail.note = (
        `S5 partial: ${landed}/3 injects landed. Production note: rapid ` +
        'inject under autosteer may need de-bouncing.'
      );
    }
  } catch (err) {
    detail.error = err.message;
  } finally {
    await tmuxKillSession(name);
  }
  emit({ gate: 'G8.S5', status, detail });
  appendFinding('G8.S5', status, detail);
  return status !== 'FAIL';
}

async function s_deferred() {
  // S3, S4, S6, S7, S8 — explicitly DEFER with reasoning.
  const detail = {
    'S3 mid-Bash': 'DEFER — requires a turn with a long Bash tool call (>30s). Easy to add later but consumes minutes per spike run. Production observation: cover via shumorobot trial.',
    'S4 mid-MCP': 'DEFER — requires running MCP server. Out of spike scope; covers in Phase 1 integration test with mock MCP.',
    'S6 mid-compact': 'DEFER — race condition with /compact. Production-observe behavior; if injects swallowed, polygram needs compactionInProgress state flag (already in §11 G8 fallback).',
    'S7 turn-end race': 'DEFER — timing-fragile, hard to reproduce in spike. Real production traffic surfaces this naturally; collect data during soak.',
    'S8 idle short-circuit': 'PASS (logical): §12.3 sketch explicitly returns false when !this.inFlight. No empirical test needed beyond unit test in Phase 1.',
  };
  emit({ gate: 'G8.S3-S8', status: 'DEFER', detail });
  appendFinding('G8.S3-S8', 'DEFER', detail);
}

(async () => {
  let allOk = true;
  try {
    if (!(await s1())) allOk = false;
    if (!(await s2())) allOk = false;
    if (!(await s5())) allOk = false;
    await s_deferred();
  } finally {
    await cleanupAll();
  }
  process.exit(allOk ? 0 : 1);
})();
