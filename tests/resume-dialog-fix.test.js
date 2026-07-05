'use strict';

/**
 * Resume-dialog fix (docs/0.13-resume-dialog-fix-spec.md, B1+B2).
 *
 * Production incident (shumorobot Music 2026-06-10 19:31, handoff doc
 * docs/0.13-followup-resume-dialog-context-loss.md): claude's session-age
 * "resume-return" dialog pre-selects "Resume from summary" — which literally
 * runs /compact on the resumed session. polygram's startup gate answered bare
 * Enter, silently compacting every aged-session resume (incl. every /model
 * reload of a >70min/>100k-token session) — violating the rc.36 "/model keeps
 * the conversation" guarantee.
 *
 * B1: suppress the dialog at spawn via CLAUDE_CODE_RESUME_THRESHOLD_MINUTES
 *     in tmux envExtras (binary-verified threshold env of claude 2.1.158;
 *     dialog fires only when age ≥ thresholdMinutes AND tokens ≥ 1e5).
 * B2: belt-and-braces — if the dialog still appears (upstream renames the
 *     env var on a future binary bump), the gate picks "Resume full session
 *     as-is" (Down,Enter — NOT bare Enter = compact) and emits
 *     session-age-dialog-fallback so the suppression regression is visible.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CliProcess } = require('@shumkov/orchestra');

const quietLogger = { warn: () => {}, error: () => {}, log: () => {}, debug: () => {} };

const DIALOG_PANE = [
  'This session is 6h 39m old and 115.8k tokens.',
  'Resuming the full session will consume a substantial portion of your usage limits.',
  'We recommend resuming from a summary.',
  '❯ 1. Resume from summary (recommended)',
  '  2. Resume full session as-is',
  '  3. Don\'t ask me again',
  '  Enter to confirm · Esc to cancel',
].join('\n');

const READY_PANE = 'Listening for channel messages from: server:polygram-bridge';

test('B1: spawn envExtras suppress the session-age resume dialog', async () => {
  const spawns = [];
  const proc = new CliProcess({
    sessionKey: 's', chatId: '1',
    tmuxRunner: {
      spawn: async (o) => { spawns.push(o); throw new Error('stop-after-capture'); },
      sendControl: async () => {}, killSession: async () => {}, captureWide: async () => '',
    },
    botName: 'b', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
  });
  proc.sockPath = '/tmp/polygram-test-resume-dialog.sock';
  proc.claudeSessionId = 'test-session-id';
  await proc._spawnTmuxClaude({ tmuxName: 't', opts: {} }).catch(() => {});
  assert.ok(spawns.length, 'spawn must have been reached');
  const env = spawns[0].envExtras || {};
  const minutes = Number(env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES);
  assert.ok(Number.isFinite(minutes) && minutes >= 100_000,
    `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES must be set huge (got ${env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES}) — ` +
    'an aged-session --resume must never see the compact-by-default dialog');
});

test('B2: gate fallback picks "Resume full session as-is" (Down,Enter) + emits telemetry', async () => {
  const sent = [];
  const events = [];
  const frames = [DIALOG_PANE, READY_PANE];
  let i = 0;
  const proc = new CliProcess({
    sessionKey: 's', chatId: '1',
    tmuxRunner: {
      spawn: async () => {},
      sendControl: async (_n, key) => { sent.push(key); },
      killSession: async () => {},
      captureWide: async () => frames[Math.min(i++, frames.length - 1)],
    },
    botName: 'b', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
  });
  await proc._handleStartupDialogs('t');
  assert.deepEqual(sent, ['Down', 'Enter'],
    'bare Enter selects "Resume from summary" = /compact — the fallback must navigate to full resume');
  assert.ok(events.some(e => e.kind === 'session-age-dialog-fallback'),
    'the dialog appearing at all means env suppression failed — must be visible in telemetry');
});

test('B2-midturn: the mid-turn dialog watchdog also picks FULL resume + emits telemetry (review F2)', async () => {
  // The session-age dialog can render AFTER the startup gate resolved (the
  // F#17 mid-turn watchdog exists for exactly that). Pre-fix the catalog
  // dismissed it with bare Enter — selecting "Resume from summary" = /compact.
  const sent = [];
  const events = [];
  const proc = new CliProcess({
    sessionKey: 's', chatId: '1',
    tmuxRunner: {
      spawn: async () => {},
      sendControl: async (_n, key) => { sent.push(key); },
      killSession: async () => {},
      captureWide: async () => DIALOG_PANE,
    },
    botName: 'b', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
    db: { logEvent: (kind, detail) => events.push({ kind, detail }) },
  });
  proc.tmuxSession = 'pgr-test-midturn';
  // a pending turn so the watchdog has work to do
  proc.pendingTurns.set('t-1', { resolve: () => {}, reject: () => {} });
  try {
    await proc._pollMidTurnDialogs();
    assert.deepEqual(sent, ['Down', 'Enter'],
      'mid-turn bare Enter selects "Resume from summary" = /compact — must navigate to full resume');
    assert.ok(events.some(e => e.kind === 'session-age-dialog-fallback' && e.detail.phase === 'mid-turn'),
      'the mid-turn fallback must be soak-visible under the same event kind');
  } finally {
    proc.pendingTurns.clear();
    proc.kill?.();
  }
});

test('pin 2.1.173: the NEW channels banner resolves the startup gate (old banner still matches)', async () => {
  // claude 2.1.173 reworked the channels UI: the persistent banner is now
  // "▎ Channels (experimental) messages from server:polygram-bridge inject
  // directly in this session · restart without --dangerously-load-development-
  // channels to stop" (live-captured 2026-06-11). The 2.1.158 text
  // ("Listening for channel messages from: …") is gone from the binary —
  // an unchanged readySignal would stall EVERY spawn into
  // CHANNELS_DIALOG_TIMEOUT.
  const NEW_BANNER = 'Channels (experimental) messages from server:polygram-bridge inject directly in this session · restart without --dangerously-load-development-channels to stop';
  for (const banner of [NEW_BANNER, READY_PANE]) {
    let resolved = false;
    const proc = new CliProcess({
      sessionKey: 's', chatId: '1',
      tmuxRunner: {
        spawn: async () => {},
        sendControl: async () => {},
        killSession: async () => {},
        captureWide: async () => banner,
      },
      botName: 'b', claudeBin: '/usr/bin/false',
      toolDispatcher: async () => ({ ok: true }),
      logger: quietLogger,
    });
    proc.startupGateStallMs = 500;
    proc.startupGateDeadlineMs = 1500;
    await proc._handleStartupDialogs('t').then(() => { resolved = true; }).catch(() => {});
    assert.ok(resolved, `gate must resolve on banner: ${banner.slice(0, 60)}…`);
  }
});

test('pin 2.1.173: collapsed notices ("+N more") must not stall the gate — interactive footer counts as ready', async () => {
  // 2.1.173 renders the channels banner in a COLLAPSIBLE notice list. With
  // ≥3 notices the pane shows "+2 more · /status" and the banner is hidden —
  // a banner-only readySignal then stalls 60s into a false
  // CHANNELS_DIALOG_TIMEOUT (caught live by the cancel-cheap E2E on a cwd
  // with a settings.json model notice; zero prod hits at fix time). An
  // interactive prompt footer with no pending dialog IS ready — channel
  // liveness is separately guaranteed by mcp-ready + the delivery watchdog.
  const COLLAPSED_PANE = [
    ' ▎ Using Fable 5 (from .claude/settings.json) · /model',
    '   +2 more · /status',
    '────────────',
    '❯ ',
    '────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ].join('\n');
  let resolved = false;
  const proc = new CliProcess({
    sessionKey: 's', chatId: '1',
    tmuxRunner: {
      spawn: async () => {}, sendControl: async () => {}, killSession: async () => {},
      captureWide: async () => COLLAPSED_PANE,
    },
    botName: 'b', claudeBin: '/usr/bin/false',
    toolDispatcher: async () => ({ ok: true }),
    logger: quietLogger,
  });
  proc.startupGateStallMs = 400;
  proc.startupGateDeadlineMs = 1200;
  await proc._handleStartupDialogs('t').then(() => { resolved = true; }).catch(() => {});
  assert.ok(resolved, 'an interactive prompt with collapsed notices must resolve the gate');
});
