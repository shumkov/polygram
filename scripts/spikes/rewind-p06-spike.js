'use strict';
/**
 * P0.6 spike: does a COPY-ONLY, hand-built prefix JSONL resume as a CORRECT rewound
 * conversation on the pinned CLI? Generates a real channels session (codewords + a
 * Bash tool-use turn in the kept prefix), forks it (cut before "BANANA", rewrite the
 * in-file sessionId), resumes the fork, and asserts: remembers APPLE + the earlier tool
 * output, does NOT know BANANA/DATE, AND can run a fresh Bash turn. Gates B-safe.
 * Run: node scripts/spikes/rewind-p06-spike.js
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { CliProcess } = require('../../lib/process/cli-process');
const { createTmuxRunner } = require('@shumkov/orchestra');
const { resolvePinnedClaudeBin, CLAUDE_CLI_PINNED_VERSION } = require('../../lib/claude-bin');

const noopStreamer = { onChunk: async () => {}, forceNewMessage: () => {}, finalize: async () => ({ streamed: false }), flushDraft: async () => {}, discard: async () => {} };
const noopReactor = { setState: () => {}, heartbeat: () => {}, clear: async () => {}, stop: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transcriptPathFor = (cwd, id) => path.join(os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'), `${id}.jsonl`);

function mkProc(sessionKey, cwd, existingSessionId, replies) {
  return new CliProcess({
    sessionKey, chatId: '987654398', threadId: null, label: sessionKey,
    tmuxRunner: createTmuxRunner(), botName: 'p06',
    claudeBin: resolvePinnedClaudeBin(CLAUDE_CLI_PINNED_VERSION),
    toolDispatcher: async ({ toolName, text }) => { if (toolName === 'reply') replies.push(text); return { ok: true, message_id: replies.length }; },
    logger: { warn: () => {}, error: (...a) => console.error('[err]', ...a), log: () => {}, debug: () => {} },
    db: { logEvent: () => {} },
  });
}

(async () => {
  // realpath so cwd == claude's resolved workspace (/tmp → /private/tmp on macOS),
  // keeping our projects-dir mangling identical to cli-process's resume-path check.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p06-')));
  const chatConfig = { cwd, permissionMode: 'bypassPermissions', isolateUserConfig: true };
  const ctx = { streamer: noopStreamer, reactor: noopReactor, threadId: null };
  const repliesA = [];
  let procA = mkProc('p06A:1', cwd, null, repliesA);
  let ok = false;
  try {
    // ---- session A: build a transcript with a tool-use turn in the prefix ----
    await procA.start({ cwd, chatConfig, existingSessionId: null });
    await procA.send('Remember the codeword APPLE. Reply with exactly: OK1', { timeoutMs: 90_000, maxTurnMs: 110_000, context: ctx });
    await procA.send('Run the bash command: echo PREFIX-TOOL-OUT — then tell me exactly what it printed.', { timeoutMs: 90_000, maxTurnMs: 110_000, context: ctx });
    await procA.send('Remember the codeword BANANA. Reply with exactly: OK2', { timeoutMs: 90_000, maxTurnMs: 110_000, context: ctx });
    await procA.send('Remember the codeword DATE. Reply with exactly: OK3', { timeoutMs: 90_000, maxTurnMs: 110_000, context: ctx });
    await sleep(1500);
    // Discover the real transcript by listing the projects dir (filename = claude's actual id).
    const projDir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
    const jsonls = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    const tfile = jsonls.find((f) => f === `${procA.claudeSessionId}.jsonl`)
      || jsonls.sort((a, b) => fs.statSync(path.join(projDir, b)).mtimeMs - fs.statSync(path.join(projDir, a)).mtimeMs)[0];
    const tpath = path.join(projDir, tfile);
    const sidA = tfile.replace('.jsonl', '');
    console.log('projDir:', projDir, '\nfiles:', jsonls, '\nusing transcript id:', sidA, '(proc.claudeSessionId=' + procA.claudeSessionId + ')');

    // ---- inspect + fork ----
    const lines = fs.readFileSync(tpath, 'utf8').split('\n').filter(Boolean);
    const types = {};
    let sidMatch = 0;
    for (const l of lines) { try { const o = JSON.parse(l); types[o.type] = (types[o.type] || 0) + 1; if (o.sessionId === sidA) sidMatch++; } catch {} }
    console.log('transcript: lines=%d types=%j sessionId-match=%d/%d', lines.length, types, sidMatch, lines.length);

    const cutIdx = lines.findIndex((l) => { try { const o = JSON.parse(l); return o.type === 'user' && JSON.stringify(o.message?.content || '').includes('BANANA'); } catch { return false; } });
    console.log('cut before line index:', cutIdx, '(the BANANA user turn)');
    if (cutIdx <= 0) throw new Error('could not locate BANANA cut point');

    const newId = crypto.randomUUID();
    const forked = lines.slice(0, cutIdx).map((l) => { const o = JSON.parse(l); if ('sessionId' in o) o.sessionId = newId; return JSON.stringify(o); });
    const forkPath = path.join(projDir, `${newId}.jsonl`);
    fs.writeFileSync(forkPath, forked.join('\n') + '\n');
    console.log('wrote fork:', newId, 'lines=%d', forked.length, 'at', fs.existsSync(forkPath));

    await procA.kill('p06-forked');
    await sleep(1500);

    // ---- session B: resume the fork, verify correctness ----
    const repliesB = [];
    const procB = mkProc('p06B:1', cwd, newId, repliesB);
    try {
      await procB.start({ cwd, chatConfig, existingSessionId: newId });
      await procB.send('Answer concisely: (1) what codewords do you remember from THIS conversation? (2) Did you run a bash command earlier, and what did it print? (3) Now run the bash command: echo FRESH-TOOL-OK — and report its exact output.', { timeoutMs: 120_000, maxTurnMs: 140_000, context: ctx });
      const ans = repliesB.join('\n');
      console.log('\n=== session B reply ===\n' + ans.slice(0, 800));
      const hasApple = /APPLE/i.test(ans);
      const hasPrefixTool = /PREFIX-TOOL-OUT/.test(ans);
      const hasBanana = /BANANA/i.test(ans);
      const hasDate = /\bDATE\b/i.test(ans);
      const hasFresh = /FRESH-TOOL-OK/.test(ans);
      console.log('\n=== ASSERTIONS ===');
      console.log('remembers APPLE (kept):           ', hasApple);
      console.log('remembers PREFIX tool output(kept):', hasPrefixTool);
      console.log('does NOT know BANANA (dropped):   ', !hasBanana);
      console.log('does NOT know DATE (dropped):     ', !hasDate);
      console.log('fresh Bash turn works:            ', hasFresh);
      ok = hasApple && !hasBanana && !hasDate && hasFresh;
      console.log('\nP0.6 RESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
    } finally { try { await procB.kill('p06-done'); } catch {} }
  } catch (e) {
    console.error('SPIKE ERROR:', e && e.stack || e);
  } finally {
    try { await procA.kill('cleanup'); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    process.exit(ok ? 0 : 1);
  }
})();
