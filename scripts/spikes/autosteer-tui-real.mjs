#!/usr/bin/env node
/**
 * autosteer-tui-real — exercise the rc.7→rc.14 autosteer fixes against
 * a REAL claude TUI in tmux. This is the AUTHORITATIVE autosteer
 * test suite for polygram — no simulator, just polygram's real
 * TmuxProcess + TmuxRunner driving an actual claude session.
 *
 * Run before tagging each rc that touches autosteer / tmux-process /
 * tmux-runner.
 *
 * Cost: ~$0.05-0.20 per scenario sonnet/low + a few Bash tool calls.
 *   - 8 scenarios → ~$0.50-1.50 total.
 *
 * Hard wall-clock cap: 600s total. process.exit on hang.
 *
 * What each scenario verifies is documented at the scenario site.
 *
 * Usage:
 *   node scripts/spikes/autosteer-tui-real.mjs            # all
 *   node scripts/spikes/autosteer-tui-real.mjs short      # one by name
 *
 * Side-effects: spawns transient tmux sessions, writes JSONL files
 * under ~/.claude/projects/<encoded-cwd>/.
 */

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { TmuxProcess } = require('../../lib/process/tmux-process.js');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');

const execFileP = promisify(execFile);
const HARD_TIMEOUT_MS = 600_000;

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

function log(...args) { console.error('[spike]', ...args); }
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function killTmuxSession(name) {
  try { await execFileP('tmux', ['kill-session', '-t', name]); } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Spin up a real TmuxProcess. Returns { p, events, cleanup }. The
 * `events` array captures every polygram-level event for assertions.
 *
 * Uses the polygram repo as cwd (already trusted by claude CLI) so
 * the workspace-trust prompt doesn't appear.
 */
async function setupRealTui(label) {
  const runner = createTmuxRunner({ logger: console });
  const cwd = path.resolve(process.cwd());

  const p = new TmuxProcess({
    sessionKey: `spike:${label}`,
    chatId: 'spike',
    threadId: label,
    label: `spike-${label}`,
    runner,
    botName: 'spike',
    logger: SILENT,
    readyTimeoutMs: 60_000,
    turnTimeoutMs: 90_000,
  });

  const events = [];
  const eventNames = [
    'extra-turn-started', 'extra-turn-reply',
    'autosteer-resolution', 'autosteer-match-miss',
    'autonomous-assistant-message', 'inject-user-message',
    'result', 'tool-use',
  ];
  for (const name of eventNames) {
    p.on(name, (payload) => events.push({ name, payload, t: Date.now() }));
  }

  const tmuxName = runner.sessionName('spike', 'spike', label);
  await killTmuxSession(tmuxName);

  await p.start({
    chatConfig: {
      model: 'sonnet', effort: 'low', cwd,
      // bypassPermissions so the spike's Bash test calls don't trip
      // a permission prompt. The READY_HINTS_RE now recognises
      // "bypass permissions on" (added alongside this spike).
      permissionMode: 'bypassPermissions',
    },
  });

  return {
    p,
    events,
    cleanup: async () => {
      try { await p.kill('spike-done'); } catch {}
      await killTmuxSession(tmuxName);
    },
  };
}

// Wait until `events` contains a `kind` event, or timeout.
async function waitForEvent(events, kind, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some((e) => e.name === kind)) return;
    await sleep(200);
  }
}

function assertEquals(actual, expected, label) {
  if (actual !== expected) {
    console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`  PASS: ${label}`);
  return true;
}
function assertTrue(cond, label) {
  if (!cond) {
    console.error(`  FAIL: ${label}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`  PASS: ${label}`);
  return true;
}
function assertEventFired(events, name, label) {
  return assertTrue(events.some((e) => e.name === name), `${label} (event '${name}' fired)`);
}
function assertEventNotFired(events, name, label) {
  return assertTrue(!events.some((e) => e.name === name), `${label} (event '${name}' did NOT fire)`);
}

// Wait for autosteer to fully resolve (either fold or new-turn).
async function waitForResolution(events, msgId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resolution = events.find((e) =>
      e.name === 'autosteer-resolution' && e.payload?.msgId === msgId);
    if (resolution) {
      if (resolution.payload.via === 'fold') return;
      // NEW-TURN: wait for extra-turn-reply too.
      if (events.some((e) => e.name === 'extra-turn-reply' && e.payload?.msgId === msgId)) return;
    }
    await sleep(200);
  }
}

// Polygram-level invariants that hold across ALL valid autosteer
// outcomes. Use these instead of asserting on a specific fold/new-turn
// path, since the TUI's choice depends on timing the spike can't fully
// pin down.
function assertInvariants(events, { autosteeredMsgId, expectAutosteer }) {
  // INV-1: no content-match miss (proves no paste corruption).
  assertEventNotFired(events, 'autosteer-match-miss',
    'INV-1: no content-match miss (rc.14 paste atomicity holds)');

  // INV-2: no autonomous-assistant-message leakage when there was
  // a normal turn (would indicate _turnState mis-routing).
  assertEventNotFired(events, 'autonomous-assistant-message',
    'INV-2: no autonomous-wakeup leak (proper turn attribution)');

  if (!expectAutosteer) {
    // INV-3a: when no autosteer occurred, no autosteer events fire.
    assertEventNotFired(events, 'autosteer-resolution',
      'INV-3a: no spurious autosteer-resolution');
    assertEventNotFired(events, 'extra-turn-started',
      'INV-3a: no spurious extra-turn-started');
    return;
  }

  // INV-3b: autosteer-resolution MUST fire for an autosteered msgId.
  const resolution = events.find((e) =>
    e.name === 'autosteer-resolution' && e.payload?.msgId === autosteeredMsgId);
  assertTrue(resolution != null,
    `INV-3b: autosteer-resolution fires for msgId=${autosteeredMsgId} (paths: fold | new-turn)`);
  if (!resolution) return;
  assertTrue(['fold', 'new-turn'].includes(resolution.payload.via),
    `INV-3c: autosteer-resolution.via is fold OR new-turn (got ${resolution.payload.via})`);

  // INV-4: path consistency.
  if (resolution.payload.via === 'new-turn') {
    const started = events.find((e) =>
      e.name === 'extra-turn-started' && e.payload?.msgId === autosteeredMsgId);
    const replied = events.find((e) =>
      e.name === 'extra-turn-reply' && e.payload?.msgId === autosteeredMsgId);
    assertTrue(started != null,
      `INV-4a: NEW-TURN path emits extra-turn-started for msgId=${autosteeredMsgId}`);
    assertTrue(replied != null,
      `INV-4b: NEW-TURN path emits extra-turn-reply for msgId=${autosteeredMsgId}`);
    if (replied) {
      assertTrue(typeof replied.payload.text === 'string' && replied.payload.text.length > 0,
        'INV-4c: extra-turn-reply carries non-empty text');
    }
  } else if (resolution.payload.via === 'fold') {
    assertEventNotFired(events, 'extra-turn-started',
      'INV-4d: FOLD path does NOT emit extra-turn-started (primary reply covers both)');
    assertEventNotFired(events, 'extra-turn-reply',
      'INV-4e: FOLD path does NOT emit extra-turn-reply');
  }
}

// ─── Scenarios ───────────────────────────────────────────────────────

const scenarios = {

  /** Short primary turn + autosteer mid-flight. Verifies the
   *  invariants that hold regardless of whether the TUI ends up
   *  folding or routing as NEW-TURN — both are valid user outcomes
   *  Ivan accepts. The point is that ONE of them happens cleanly,
   *  not which one. */
  'short-then-autosteer': async () => {
    const { p, events, cleanup } = await setupRealTui('short');
    try {
      const sendP = p.send('Reply ONLY with "OK" — one word, no punctuation.');
      await sleep(50);
      const okInject = p.injectUserMessage({
        content: 'Reply ONLY with "GO" — one word, no punctuation.',
        msgId: 9001,
      });
      assertEquals(okInject, true, 'injectUserMessage returns true when turn in flight');
      const r1 = await sendP;
      log('primary reply:', r1.text?.slice(0, 60));

      // Wait for resolution to land (either path).
      await waitForResolution(events, 9001, 45_000);
      await sleep(500);

      assertInvariants(events, { autosteeredMsgId: 9001, expectAutosteer: true });
      // Either path is valid; assert the text content lands SOMEWHERE.
      const reply = events.find((e) => e.name === 'extra-turn-reply');
      if (reply) {
        assertTrue(/GO/i.test(reply.payload.text || ''),
          `NEW-TURN: extra-turn-reply text matches /GO/ (got ${JSON.stringify(reply.payload.text?.slice(0,40))})`);
      } else {
        // FOLD path: the primary reply should cover the autosteered
        // intent (mentions "GO" or both words).
        assertTrue(/GO|OK/i.test(r1.text || ''),
          `FOLD: primary reply mentions one of OK/GO (got ${JSON.stringify(r1.text?.slice(0,80))})`);
      }
    } finally { await cleanup(); }
  },

  /** Long primary turn with tool + autosteer mid-flight. */
  'long-with-tool-then-autosteer': async () => {
    const { p, events, cleanup } = await setupRealTui('long');
    try {
      const sendP = p.send('Run `echo HELLO123` with Bash, then reply with one word "PRIMARY".');
      await sleep(400);
      p.injectUserMessage({
        content: 'Also include the word "EXTRA" in your reply.',
        msgId: 9002,
      });
      await sendP;
      await waitForResolution(events, 9002, 45_000);
      await sleep(500);
      assertInvariants(events, { autosteeredMsgId: 9002, expectAutosteer: true });
    } finally { await cleanup(); }
  },

  /** rc.11: tool_use stop_reason is INTERMEDIATE, doesn't end the turn. */
  'tool-use-not-terminal': async () => {
    const { p, events, cleanup } = await setupRealTui('toolonly');
    try {
      const res = await p.send('Run `echo COUNT-42` with Bash, then in your reply say ONE word: "TOOLDONE".');
      log('reply text:', JSON.stringify(res.text?.slice(0, 80)));
      assertTrue(res.metrics?.numToolUses >= 1,
        `tool_use count tracked (got ${res.metrics?.numToolUses})`);
      assertTrue(typeof res.text === 'string' && res.text.length > 0,
        `pm.send waited past tool_use intermediate and got terminal text (got ${JSON.stringify(res.text?.slice(0,80))})`);
      assertInvariants(events, { expectAutosteer: false });
    } finally { await cleanup(); }
  },

  /** rc.14: concurrent paste safety — fire send + inject in same tick. */
  'concurrent-paste-no-corruption': async () => {
    const { p, events, cleanup } = await setupRealTui('concurrent');
    try {
      const sendP = p.send('Reply ONLY with "ALPHA" — one word.');
      p.injectUserMessage({
        content: 'Reply ONLY with "BRAVO" — one word.',
        msgId: 9003,
      });
      await sendP;
      await waitForResolution(events, 9003, 45_000);
      await sleep(500);
      assertInvariants(events, { autosteeredMsgId: 9003, expectAutosteer: true });
    } finally { await cleanup(); }
  },

  /** Sanity: single pm.send with no inject emits no autosteer events. */
  'single-turn-no-autosteer': async () => {
    const { p, events, cleanup } = await setupRealTui('single');
    try {
      const res = await p.send('Reply ONLY with "SOLO" — one word.');
      assertTrue(/SOLO/i.test(res.text || ''),
        `single reply contains SOLO (got ${JSON.stringify(res.text?.slice(0,60))})`);
      assertInvariants(events, { expectAutosteer: false });
    } finally { await cleanup(); }
  },

  /** Two autosteers fired during one primary turn. */
  'two-autosteers-in-one-turn': async () => {
    const { p, events, cleanup } = await setupRealTui('multi');
    try {
      const sendP = p.send('Run `echo MULTI` with Bash, then reply with ONE word: "MULTIDONE".');
      await sleep(400);
      p.injectUserMessage({
        content: 'Also mention "extra-A" in your reply.',
        msgId: 9101,
      });
      await sleep(50);
      p.injectUserMessage({
        content: 'And mention "extra-B" too.',
        msgId: 9102,
      });
      await sendP;
      // Wait for both to resolve.
      await waitForResolution(events, 9101, 45_000);
      await waitForResolution(events, 9102, 45_000);
      await sleep(500);
      assertInvariants(events, { autosteeredMsgId: 9101, expectAutosteer: true });
      assertInvariants(events, { autosteeredMsgId: 9102, expectAutosteer: true });
    } finally { await cleanup(); }
  },
};

// ─── Driver ──────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  const names = arg ? [arg] : Object.keys(scenarios);
  const unknown = names.filter((n) => !scenarios[n]);
  if (unknown.length > 0) {
    console.error('Unknown scenarios:', unknown.join(','));
    console.error('Available:', Object.keys(scenarios).join(', '));
    process.exit(2);
  }

  const timer = setTimeout(() => {
    console.error('[spike] HARD TIMEOUT exceeded, aborting');
    process.exit(2);
  }, HARD_TIMEOUT_MS).unref();

  for (const name of names) {
    console.log(`\n=== Scenario: ${name} ===`);
    try {
      await scenarios[name]();
    } catch (err) {
      console.error(`[spike] scenario ${name} threw:`, err.message);
      process.exitCode = 1;
    }
  }
  clearTimeout(timer);

  if (process.exitCode === 1) {
    console.log('\n=== SPIKE FAILED ===');
    process.exit(1);
  } else {
    console.log('\n=== SPIKE PASS ===');
  }
}

main().catch((err) => {
  console.error('[spike] fatal:', err);
  process.exit(1);
});
