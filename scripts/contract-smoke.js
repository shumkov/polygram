#!/usr/bin/env node
/**
 * Phase 2.6 Tier 2 — real-claude contract smoke.
 *
 * Runs ~5 high-value contract scenarios against REAL `claude` over
 * REAL SDK and REAL `claude` inside REAL `tmux`. Verifies the abstraction
 * holds end-to-end before each rc tag. Manual gate — not in CI.
 *
 * Usage:
 *   CONTRACT_REAL=1 node scripts/contract-smoke.js
 *   CONTRACT_REAL=1 node scripts/contract-smoke.js --only S1,S5  # subset
 *   CONTRACT_REAL=1 node scripts/contract-smoke.js --backend tmux  # one backend
 *   node scripts/contract-smoke.js --dry-run   # validate wiring without spending money
 *
 * Cost: ~5 turns × 2 backends ≈ $1–2 with haiku, more with sonnet.
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §7.2.6 Tier 2
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Lazy require — only load the SDK if we actually need it (real run).
let SdkProcess, TmuxProcess, createTmuxRunner;

// ─── CLI args ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    only: null,            // Set<string> | null
    backends: ['sdk', 'tmux'],
    dryRun: false,
    model: 'haiku',
    cwd: process.cwd(),
    timeoutMs: 120_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') opts.only = new Set(argv[++i].split(','));
    else if (a === '--backend') opts.backends = [argv[++i]];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: contract-smoke.js [--only S1,S5] [--backend sdk|tmux] [--model haiku|sonnet] [--cwd PATH] [--dry-run]');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// ─── Backend factories ──────────────────────────────────────────────

async function makeRealSdkProcess({ sessionKey, existingSessionId, model, cwd }) {
  // Minimal SDK Options — bypass polygram's buildSdkOptions entirely.
  // We're testing the abstraction's parity, not the bot integration.
  const spawnFn = () => ({
    model,
    permissionMode: 'acceptEdits',
    ...(existingSessionId ? { resume: existingSessionId } : {}),
    cwd,
  });
  const proc = new SdkProcess({
    sessionKey,
    chatId: 'smoke',
    threadId: null,
    label: `sdk-smoke`,
    spawnFn,
    logger: { warn: console.warn, error: console.error, log: () => {}, debug: () => {}, info: () => {} },
  });
  return proc;
}

async function makeRealTmuxProcess({ sessionKey, existingSessionId, model, cwd }) {
  const runner = createTmuxRunner({ logger: { warn: () => {}, error: console.error, debug: () => {} } });
  const proc = new TmuxProcess({
    sessionKey,
    chatId: `smoke-${Date.now()}`,   // ensure unique session per scenario
    threadId: null,
    label: 'tmux-smoke',
    runner,
    botName: 'smoke',
    logger: { warn: () => {}, error: console.error, debug: () => {} },
    readyTimeoutMs: 30_000,
    turnTimeoutMs: 120_000,
    pollMs: 200,
    quiesceMs: 1500,
    lateGraceMs: 4000,   // give JSONL plenty of time after capture-pane wins
  });
  return proc;
}

async function spawnBackend(kind, opts) {
  const proc = kind === 'sdk'
    ? await makeRealSdkProcess(opts)
    : await makeRealTmuxProcess(opts);
  await proc.start({
    existingSessionId: opts.existingSessionId,
    chatConfig: { model: opts.model, effort: 'low', cwd: opts.cwd, permissionMode: 'acceptEdits' },
  });
  return proc;
}

// ─── Scenarios ──────────────────────────────────────────────────────

const SCENARIOS = {
  S1: {
    name: 'Cold spawn + simple Q&A',
    async run({ kind, opts, log }) {
      const proc = await spawnBackend(kind, { sessionKey: `S1-${kind}-${Date.now()}`, model: opts.model, cwd: opts.cwd });
      try {
        const res = await proc.send('What is 2+2? Reply with just the number.');
        const ok = res.error === null && /4/.test(res.text);
        const sessOk = !!proc.claudeSessionId;
        log(`text="${res.text.slice(0, 120)}" sessionId=${proc.claudeSessionId?.slice(0, 8) || 'NONE'} err=${res.error}`);
        return { ok: ok && sessOk, why: ok ? (sessOk ? '' : 'no sessionId') : `text missing "4": ${res.text.slice(0, 80)}` };
      } finally {
        await proc.kill('S1-done');
      }
    },
  },

  S2: {
    name: 'Resume continuity',
    async run({ kind, opts, log }) {
      const procA = await spawnBackend(kind, { sessionKey: `S2-${kind}-${Date.now()}-A`, model: opts.model, cwd: opts.cwd });
      let sessionId;
      try {
        await procA.send('Remember the number 42 for later. Reply with just "OK".');
        sessionId = procA.claudeSessionId;
        log(`stored sessionId=${sessionId?.slice(0, 8)}`);
      } finally {
        await procA.kill('S2A-done');
      }
      if (!sessionId) return { ok: false, why: 'no sessionId from first turn' };

      // Give claude a moment to flush the session JSONL fully to disk
      // before procB tries to --resume it. Without this, the tmux backend
      // intermittently fails: claude --resume exits when the session file
      // hasn't fully flushed → tmux session terminates → capture-pane
      // can't find the pane on waitForReady.
      await new Promise((r) => setTimeout(r, 3000));

      const procB = await spawnBackend(kind, {
        sessionKey: `S2-${kind}-${Date.now()}-B`,
        existingSessionId: sessionId,
        model: opts.model, cwd: opts.cwd,
      });
      try {
        const res = await procB.send('What number did I ask you to remember? Reply with just the number.');
        const ok = res.error === null && /42/.test(res.text);
        log(`resume text="${res.text.slice(0, 120)}"`);
        return { ok, why: ok ? '' : `expected "42" in resumed reply: ${res.text.slice(0, 80)}` };
      } finally {
        await procB.kill('S2B-done');
      }
    },
  },

  S3: {
    name: '/new resets context (resetSession)',
    async run({ kind, opts, log }) {
      // Use a non-obvious 5-digit number unlikely to be guessed cold.
      const secret = 10000 + Math.floor(Math.random() * 90000);
      const proc = await spawnBackend(kind, { sessionKey: `S3-${kind}-${Date.now()}`, model: opts.model, cwd: opts.cwd });
      try {
        await proc.send(`Remember the number ${secret} for later. Reply with just "OK".`);
        const resetRes = await proc.resetSession({ reason: 'smoke' });
        log(`resetSession returned ${JSON.stringify(resetRes)} secret=${secret}`);
        // After reset, SDK closes its Query (closed=true) — need a NEW proc.
        // Tmux keeps the proc alive (closed=false). Branch.
        let active = proc;
        if (resetRes.closed) {
          active = await spawnBackend(kind, { sessionKey: `S3-${kind}-${Date.now()}-2`, model: opts.model, cwd: opts.cwd });
        }
        try {
          const res = await active.send('What was the most recent number you were asked to remember in THIS conversation? If none, reply "I don\'t know".');
          // Successful reset → reply should NOT contain the secret.
          const re = new RegExp(`\\b${secret}\\b`);
          const ok = res.error === null && !re.test(res.text);
          log(`after-reset text="${res.text.slice(0, 120)}"`);
          return { ok, why: ok ? '' : `reset did not clear context: secret ${secret} leaked into reply` };
        } finally {
          if (active !== proc) await active.kill('S3-2-done');
        }
      } finally {
        await proc.kill('S3-done');
      }
    },
  },

  S4: {
    name: 'Mid-turn inject (G8)',
    async run({ kind, opts, log }) {
      const proc = await spawnBackend(kind, { sessionKey: `S4-${kind}-${Date.now()}`, model: opts.model, cwd: opts.cwd });
      try {
        // Start a slow-ish turn (a brief enumeration).
        const sendPromise = proc.send(
          'Count slowly from 1 to 5, one number per line. Pause briefly between each.',
        );
        // 2 seconds in, inject an additional instruction.
        await new Promise((r) => setTimeout(r, 2000));
        const injected = proc.injectUserMessage({
          content: 'Also include the letter A B C D E in front of each number.',
        });
        log(`inject returned ${injected}`);
        const res = await sendPromise;
        // G8 is best-effort: claude treats priority='now' inject as
        // "queue for next user-msg slot" not "fold mid-stream" in most
        // current versions. Both backends still complete the first turn
        // without error; the inject either folds into the next turn or
        // becomes the next-turn prompt. Contract assertion is narrow:
        // no error + non-empty reply containing at least some
        // recognisable content from EITHER the first turn (1-5) OR the
        // injected continuation (A-E).
        const hasNumbers = /1.*2.*3.*4.*5/s.test(res.text);
        const hasLetters = /[ABCDE]/.test(res.text);
        const hasContent = res.text && res.text.trim().length > 5;
        log(`text="${res.text.slice(0, 200)}" numbers=${hasNumbers} letters=${hasLetters} injected=${injected}`);
        const ok = res.error === null && hasContent && (hasNumbers || hasLetters);
        return {
          ok,
          why: ok
            ? `inject=${injected} numbers=${hasNumbers} letters=${hasLetters}`
            : `error=${res.error} hasContent=${hasContent} text=${res.text.slice(0, 60)}`,
        };
      } finally {
        await proc.kill('S4-done');
      }
    },
  },

  S5: {
    name: 'kill() is idempotent',
    async run({ kind, opts, log }) {
      const proc = await spawnBackend(kind, { sessionKey: `S5-${kind}-${Date.now()}`, model: opts.model, cwd: opts.cwd });
      let closeFires = 0;
      proc.on('close', () => closeFires++);
      await proc.kill('first');
      await proc.kill('second');
      // Tiny wait to let any delayed events fire
      await new Promise((r) => setTimeout(r, 200));
      log(`close fired ${closeFires} times across 2 kills`);
      return { ok: closeFires === 1, why: closeFires === 1 ? '' : `expected 1 close, got ${closeFires}` };
    },
  },
};

// ─── Runner ─────────────────────────────────────────────────────────

async function runScenario(name, kind, opts) {
  const def = SCENARIOS[name];
  const prefix = `[${name}/${kind}]`;
  const t0 = Date.now();
  const log = (msg) => console.log(`  ${prefix} ${msg}`);
  try {
    const { ok, why } = await def.run({ kind, opts, log });
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const status = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`${status} ${prefix} ${def.name} (${dur}s)${why ? ` — ${why}` : ''}`);
    return ok;
  } catch (err) {
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\x1b[31mERROR\x1b[0m ${prefix} ${def.name} (${dur}s) — ${err.message}`);
    if (process.env.SMOKE_VERBOSE) console.error(err.stack);
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  const filtered = Object.keys(SCENARIOS).filter((s) => !opts.only || opts.only.has(s));

  if (opts.dryRun) {
    console.log('=== DRY RUN — wiring sanity check (no real claude calls) ===');
    console.log(`would test backends: ${opts.backends.join(', ')}`);
    console.log(`scenarios: ${filtered.join(', ')}${opts.only ? ` (filtered)` : ''}`);
    console.log(`model: ${opts.model} cwd: ${opts.cwd}`);
    console.log(`total runs: ${filtered.length * opts.backends.length}`);
    console.log('To run for real:  CONTRACT_REAL=1 node scripts/contract-smoke.js');
    return 0;
  }

  if (process.env.CONTRACT_REAL !== '1') {
    console.error('refuse to spend money: set CONTRACT_REAL=1 to run (or --dry-run for wiring check)');
    return 2;
  }

  // Lazy-load real modules now that we know we're running for real.
  ({ SdkProcess } = require('../lib/process/sdk-process'));
  ({ TmuxProcess } = require('../lib/process/tmux-process'));
  ({ createTmuxRunner } = require('../lib/tmux/tmux-runner'));

  const scenarios = filtered;
  if (scenarios.length === 0) {
    console.error('no scenarios match --only filter');
    return 2;
  }

  console.log(`=== Phase 2.6 Tier 2 real-claude smoke ===`);
  console.log(`backends: ${opts.backends.join(', ')}`);
  console.log(`scenarios: ${scenarios.join(', ')}`);
  console.log(`model: ${opts.model} cwd: ${opts.cwd}`);
  console.log('');

  const results = [];
  for (const name of scenarios) {
    for (const kind of opts.backends) {
      const ok = await runScenario(name, kind, opts);
      results.push({ name, kind, ok });
    }
  }

  console.log('');
  console.log('=== Summary ===');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log('FAILED:');
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  ${r.name}/${r.kind}`);
    }
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code || 0),
  (err) => { console.error(err); process.exit(1); },
);
