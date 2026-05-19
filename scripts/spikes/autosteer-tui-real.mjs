#!/usr/bin/env node
/**
 * autosteer-tui-real — broad-coverage autosteer regression suite
 * against a REAL claude TUI in tmux. No simulator. This is the
 * authoritative source of truth for polygram's autosteer behaviour.
 *
 * Scenarios cover:
 *   - Single-turn baseline (no autosteer).
 *   - Autosteer timing variations (immediate, 50ms, 200ms, 1s, 2s).
 *   - Multi-autosteer (2, 3, 4, 5 injects in one turn).
 *   - Concurrent send + inject races.
 *   - Primary turns of varying complexity (short, with-tool,
 *     multi-tool, long text).
 *   - Content variations (unicode, markdown, code blocks).
 *
 * Usage:
 *   node scripts/spikes/autosteer-tui-real.mjs              # all
 *   node scripts/spikes/autosteer-tui-real.mjs SHORT-LIVE   # by tag
 *   node scripts/spikes/autosteer-tui-real.mjs scenario-name
 *
 * Cost: ~$0.05-0.30 per scenario × ~30 = ~$3-9 per full run.
 * Wall-clock: ~30-60s per scenario × 30 = 15-30 minutes.
 *
 * Run before each rc tag that touches autosteer / tmux-process /
 * tmux-runner. CI doesn't run this — needs OAuth + burns API tokens.
 */

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { TmuxProcess } = require('../../lib/process/tmux-process.js');
const { createTmuxRunner } = require('../../lib/tmux/tmux-runner.js');
const { buildPrompt } = require('../../lib/prompt.js');

// 2026-05-18 incident coverage: real polygram prompts are ~1-3 KB —
// the `<polygram-info>` wrapper + `<channel>` + `<untrusted-input>`
// (+ a `<reply_to>` block when the user replies to a message).
// Every other spike scenario sends 20-80-char prompts, so none ever
// exercised the bracketed-paste `[Pasted text #1]` path where the
// paste-without-submit bug lived. This builds a production-realistic
// wrapped prompt around a given instruction so a scenario can paste
// the same multi-KB shape polygram sends in production. `bulk` is
// extra realistic context (a longer user message + a reply-to quote)
// — a real user sending a paragraph with a quoted reply lands here.
function buildLargePrompt(instruction, { bulk = '' } = {}) {
  return buildPrompt({
    msg: {
      chat: { id: -1003807211164 },
      message_id: 789,
      from: { first_name: 'Ivan', id: 68861949 },
      date: Math.floor(Date.now() / 1000),
      message_thread_id: 3,
      text: bulk ? `${instruction}\n\n${bulk}` : instruction,
    },
    topicName: 'Music',
    replyTo: bulk
      ? { text: 'An earlier message in this conversation that the new '
          + 'message is replying to — quoted back into the prompt, as '
          + 'polygram does for every reply.' }
      : null,
  });
}

const execFileP = promisify(execFile);
const HARD_TIMEOUT_MS = 60 * 60_000;  // 60 minutes hard cap

const SILENT = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {}, log: () => {} };

function log(...args) { console.error('[spike]', ...args); }
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function killTmuxSession(name) {
  try { await execFileP('tmux', ['kill-session', '-t', name]); } catch {}
}

// ─── Harness ─────────────────────────────────────────────────────────

async function setupRealTui(label, opts = {}) {
  const runner = createTmuxRunner({ logger: console });
  const cwd = opts.cwd ? path.resolve(opts.cwd) : path.resolve(process.cwd());

  const p = new TmuxProcess({
    sessionKey: `spike:${label}`,
    chatId: 'spike',
    threadId: label,
    label: `spike-${label}`,
    runner,
    botName: 'spike',
    logger: SILENT,
    // B6: a slow custom-agent spawn (MCP servers loading) can take
    // well over a minute. Allow callers to widen the readiness budget
    // so a slow-startup scenario is not capped by the 60 s default.
    readyTimeoutMs: opts.readyTimeoutMs ?? 60_000,
    turnTimeoutMs: opts.turnTimeoutMs ?? 120_000,
  });

  const events = [];
  for (const name of [
    'extra-turn-started', 'extra-turn-reply',
    'autosteer-resolution', 'autosteer-match-miss',
    'autonomous-assistant-message', 'inject-user-message',
    'result', 'tool-use', 'subagent-wait',
  ]) {
    p.on(name, (payload) => events.push({ name, payload, t: Date.now() }));
  }

  const tmuxName = runner.sessionName('spike', 'spike', label);
  await killTmuxSession(tmuxName);

  // B6 coverage gap: every prior scenario spawned the TUI with NO
  // agent (`model: sonnet, effort: low`) — a no-agent TUI starts fast.
  // The production Music topic spawns with a CUSTOM agent
  // (`music-curation:music-curator`) that loads several MCP servers
  // and is SLOW to settle. The paste-into-a-not-yet-ready-TUI bug only
  // reproduces on a slow startup, so `setupRealTui` must be able to
  // spawn WITH an agent. `opts.agent` is threaded into chatConfig
  // exactly as a per-chat/topic config would feed `start()`.
  //
  // `opts.isolateUserConfig` is threaded the same way — when true,
  // start() appends --strict-mcp-config + --setting-sources
  // project,local so the spawned TUI is cut off from the user-level
  // ~/.claude config (no slow user-global MCP servers). The
  // isolated-startup scenario uses it to prove the ~45 s MCP
  // cold-start vanishes.
  await p.start({
    chatConfig: {
      model: 'sonnet', effort: 'low', cwd,
      permissionMode: 'bypassPermissions',
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.isolateUserConfig ? { isolateUserConfig: true } : {}),
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

// ─── Assertions ──────────────────────────────────────────────────────

let totalAsserts = 0;
let scenarioFailed = false;
function pass(label) { console.log(`  PASS: ${label}`); totalAsserts++; }
function fail(label) {
  console.error(`  FAIL: ${label}`);
  totalAsserts++;
  scenarioFailed = true;
  process.exitCode = 1;
}
function ok(cond, label) { cond ? pass(label) : fail(label); return cond; }
function notFired(events, name, label) {
  const fired = events.filter((e) => e.name === name);
  const passed = fired.length === 0;
  if (!passed && name === 'autosteer-match-miss') {
    console.error(`  [match-miss detail] ${fired.length} event(s):`);
    for (const e of fired.slice(0, 5)) {
      console.error(`    payload: ${JSON.stringify(e.payload)}`);
    }
  }
  return ok(passed, `${label} (no '${name}')`);
}

async function waitForResolution(events, msgId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = events.find((e) => e.name === 'autosteer-resolution' && e.payload?.msgId === msgId);
    if (r) {
      if (r.payload.via === 'fold') return;
      if (events.some((e) => e.name === 'extra-turn-reply' && e.payload?.msgId === msgId)) return;
    }
    await sleep(200);
  }
}

async function waitForAllResolutions(events, msgIds, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (msgIds.every((id) => {
      const r = events.find((e) => e.name === 'autosteer-resolution' && e.payload?.msgId === id);
      if (!r) return false;
      if (r.payload.via === 'fold') return true;
      return events.some((e) => e.name === 'extra-turn-reply' && e.payload?.msgId === id);
    })) return;
    await sleep(300);
  }
}

function assertInvariants(events, { autosteeredMsgIds = [], corruptionOnly = false } = {}) {
  notFired(events, 'autosteer-match-miss',
    'INV-1: no content-match miss (rc.14 paste atomicity)');
  notFired(events, 'autonomous-assistant-message',
    'INV-2: no autonomous-wakeup leak');
  // corruptionOnly: the scenario DID inject an autosteer, but the
  // agent's response to it is genuinely unpredictable (e.g. a
  // whitespace-only inject). A resolution firing is then NOT
  // spurious — only the corruption invariants (INV-1/INV-2) are
  // guaranteed. Asserting INV-3 'no resolution' here would be wrong.
  if (corruptionOnly) return;
  if (autosteeredMsgIds.length === 0) {
    notFired(events, 'autosteer-resolution', 'INV-3: no spurious resolution');
    notFired(events, 'extra-turn-started', 'INV-3: no spurious extra-turn-started');
    return;
  }
  for (const id of autosteeredMsgIds) {
    const r = events.find((e) => e.name === 'autosteer-resolution' && e.payload?.msgId === id);
    ok(r != null, `INV-4: autosteer-resolution fires for msgId=${id}`);
    if (!r) continue;
    ok(['fold', 'new-turn'].includes(r.payload.via),
      `INV-5: via∈{fold,new-turn} for msgId=${id} (got ${r.payload.via})`);
    if (r.payload.via === 'new-turn') {
      const reply = events.find((e) => e.name === 'extra-turn-reply' && e.payload?.msgId === id);
      ok(reply != null, `INV-6a: NEW-TURN → extra-turn-reply for msgId=${id}`);
      ok(reply && reply.payload.text && reply.payload.text.length > 0,
        `INV-6b: extra-turn-reply for msgId=${id} has non-empty text`);
    }
  }
}

// ─── Scenario definitions ────────────────────────────────────────────

const scenarios = [];

function S(tags, name, fn) {
  scenarios.push({ tags, name, fn });
}

// ── Single-turn baselines (no autosteer) ─────────────────────────────

S('baseline', 'baseline-short-text', async () => {
  const { p, events, cleanup } = await setupRealTui('b-short');
  try {
    const res = await p.send('Reply ONLY with "BASELINE" — one word.');
    log('baseline res:', JSON.stringify({
      text: res.text?.slice(0, 80),
      error: res.error,
      resolvedVia: res.metrics?.resolvedVia,
      resultSubtype: res.metrics?.resultSubtype,
      stopReason: res.metrics?.stopReason,
    }));
    ok(/BASELINE/i.test(res.text || ''),
      `baseline reply contains BASELINE (got ${JSON.stringify(res.text?.slice(0,60))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline', 'baseline-large-prompt', async () => {
  // 2026-05-18 incident — CLOSES THE COVERAGE GAP. Every other spike
  // scenario sends 20-80-char prompts, so none ever pasted a
  // production-realistic multi-KB prompt — and the paste-without-
  // submit bug lived exactly in the bracketed-paste "[Pasted text #1]"
  // path that only a large paste exercises.
  //
  // This scenario pastes a ~3 KB prompt with the real polygram
  // wrapper shape (`<polygram-info>` + `<channel>` +
  // `<untrusted-input>` + `<reply_to>`) through the full
  // TmuxProcess.send → _runTurn → pasteAndEnter path, and asserts the
  // turn actually STARTED and COMPLETED (real reply, no error, well
  // under the turn timeout).
  //
  // Note on determinism: the underlying bug is a TIMING race (a fast
  // Enter vs the TUI ingesting the bracketed-paste block) — it does
  // NOT reproduce every run on a real TUI. The DETERMINISTIC red→green
  // proof for the submit-confirm fix is the unit suite
  // (tests/tmux-runner.test.js, the stuck-TUI fake runner). THIS
  // scenario is the integration guard: it exercises the previously-
  // uncovered large-paste path end-to-end and catches any SYSTEMATIC
  // regression where multi-KB prompts stop submitting.
  //
  // The assertion is on SUBMISSION, not agent obedience: the
  // instruction sits inside <untrusted-input> (correctly treated as
  // data), so the exact reply text is not pinned — only that a turn
  // ran. Pre-fix failure mode: empty reply + ~120 s turn timeout.
  const { p, events, cleanup } = await setupRealTui('b-large');
  try {
    // ~3 KB — a realistic paragraph-length message + a quoted reply.
    // The bigger the bracketed-paste block, the longer the TUI takes
    // to ingest it, so a too-fast single Enter reliably fails to
    // submit (the incident's mechanism).
    const prompt = buildLargePrompt(
      'Acknowledge this message with a short friendly reply.',
      { bulk: 'Some additional context for you to consider. '.repeat(40) });
    log(`baseline-large-prompt: ${prompt.length} bytes`);
    if (prompt.length < 2000) {
      fail(`large prompt should be ~3 KB (got ${prompt.length} bytes) — `
        + 'the wrapper must mirror a realistic production prompt');
    }
    const startedAt = Date.now();
    const res = await p.send(prompt);
    const elapsed = Date.now() - startedAt;
    ok((res.text || '').trim().length > 0,
      `large (~${prompt.length}B) prompt produced a real reply — got `
      + `${JSON.stringify(res.text?.slice(0, 80))} (pre-fix: '' — the `
      + 'paste sat unsubmitted, the turn never started)');
    ok(!res.error,
      `large-prompt turn has no error (got ${JSON.stringify(res.error)})`);
    ok(elapsed < 60_000,
      `large-prompt turn completed promptly — ${(elapsed / 1000).toFixed(1)}s `
      + '(pre-fix it ran to the ~120s turn timeout because the paste '
      + 'never submitted)');
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline slow-agent', 'slow-agent-large-prompt', async () => {
  // B6 (shumorobot 2026-05-18, Music topic, TWICE) — CLOSES THE
  // COVERAGE GAP B5 missed. Every prior scenario — `baseline-large-
  // prompt` included — spawns the TUI with NO agent
  // (`model: sonnet, effort: low`). A no-agent TUI starts FAST: by the
  // time `send()` pastes, the TUI is genuinely settled. B5's
  // submit-confirm fix was verified only against that fast path.
  //
  // The production Music topic spawns with a CUSTOM agent
  // (`music-curation:music-curator`) that pulls in several MCP
  // servers and is SLOW to become ready. The claude TUI renders
  // `? for shortcuts` at the BOTTOM of its still-visible startup
  // banner immediately — so `_waitForReady` (pre-B6) matched the hint
  // and let `start()` resolve while the TUI was still starting up.
  // The first `send()` then pasted into a not-yet-ready TUI and the
  // submitted Enter was dropped: the prompt sat unsubmitted, the turn
  // never began. That is the real B6 bug — readiness detection, NOT
  // `pasteAndEnter`.
  //
  // This scenario spawns WITH the production agent + cwd, then
  // IMMEDIATELY sends a large production-shaped prompt — the exact
  // condition that wedged the Music topic. It asserts the turn
  // actually started and completed (the paste submitted).
  //
  // Determinism note: like `baseline-large-prompt`, a real-TUI
  // scenario cannot be a guaranteed deterministic RED — the timing
  // window (banner still up vs gone) varies run to run. The
  // DETERMINISTIC red→green proof for B6 is the unit suite
  // (tests/tmux-process.test.js, the `B6 — _waitForReady banner-gate`
  // group: a fake runner returns banner+ready for N polls then a
  // settled pane). THIS scenario is the integration guard that
  // exercises the previously-uncovered slow-custom-agent startup path
  // end-to-end.
  //
  // The production agent is `music-curation:music-curator`, resolved
  // via the rekordbox project's `.claude/settings.json`
  // (`extraKnownMarketplaces.rekordbox-local`), so the spawn cwd must
  // be ~/Music/rekordbox for the agent + its plugin to load. If that
  // setup is unavailable the spawn fails fast with a clear error
  // rather than silently testing nothing.
  const agent = 'music-curation:music-curator';
  const cwd = `${process.env.HOME}/Music/rekordbox`;
  log(`slow-agent-large-prompt: spawning with agent=${agent} cwd=${cwd}`);
  const { p, events, cleanup } = await setupRealTui('slow-agent', {
    agent,
    cwd,
    // A custom-agent + MCP-server cold start can run well past 60 s.
    readyTimeoutMs: 180_000,
    turnTimeoutMs: 180_000,
  });
  try {
    const prompt = buildLargePrompt(
      'Acknowledge this message with a short friendly reply.',
      { bulk: 'Some additional context for you to consider. '.repeat(40) });
    log(`slow-agent-large-prompt: ${prompt.length} bytes`);
    const startedAt = Date.now();
    const res = await p.send(prompt);
    const elapsed = Date.now() - startedAt;
    ok((res.text || '').trim().length > 0,
      `slow-agent large prompt produced a real reply — got `
      + `${JSON.stringify(res.text?.slice(0, 80))} (pre-B6: '' — the `
      + 'paste landed in a mid-startup TUI, the Enter was dropped, the '
      + 'turn never started)');
    ok(!res.error,
      `slow-agent large-prompt turn has no error (got ${JSON.stringify(res.error)})`);
    ok(elapsed < 120_000,
      `slow-agent large-prompt turn completed — ${(elapsed / 1000).toFixed(1)}s `
      + '(pre-B6 it ran to the turn timeout: the paste never submitted)');
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline isolated', 'isolated-music-agent-fast-start', async () => {
  // isolateUserConfig (slow-MCP-startup fix, 2026-05-19) — the Music
  // topic's `music-curation:music-curator` agent inherits the
  // user-level ~/.claude MCP servers: serena (~27.5 s to connect),
  // peekaboo (~9 s), context7. During that ~45 s MCP cold-start the
  // claude TUI accepts a pasted prompt but DROPS the submitted Enter,
  // so polygram's paste never submits — the turn fails. Broke the
  // Music topic 5+ times.
  //
  // The fix: spawn that topic with `isolateUserConfig: true`, which
  // makes TmuxProcess.start() append --strict-mcp-config (zero MCP
  // servers load) and --setting-sources project,local (drops
  // ~/.claude/settings.json; the rekordbox project's own
  // .claude/settings.json still loads). With no user-global MCP
  // servers to cold-start, the TUI reaches "? for shortcuts" in a few
  // seconds and a prompt submits cleanly.
  //
  // This scenario spawns WITH the production agent + cwd + the
  // isolation flag, times how long `setupRealTui` (which awaits
  // start()'s readiness) takes, and asserts a small prompt submits
  // FAST. Contrast: the un-isolated `slow-agent-large-prompt`
  // scenario above spawns the same agent WITHOUT the flag and budgets
  // 180 s for readiness because the MCP cold-start can run that long.
  // Running both back to back shows the startup-time delta directly.
  const agent = 'music-curation:music-curator';
  const cwd = `${process.env.HOME}/Music/rekordbox`;
  log(`isolated-music-agent: spawning agent=${agent} cwd=${cwd} isolateUserConfig=true`);
  const setupStartedAt = Date.now();
  const { p, events, cleanup } = await setupRealTui('isolated-music', {
    agent,
    cwd,
    isolateUserConfig: true,
    // Isolated → no MCP cold-start → readiness should land well under
    // the default 60 s. Keep a generous-but-bounded budget so a real
    // regression (isolation not applied) still fails the scenario
    // instead of hanging.
    readyTimeoutMs: 90_000,
    turnTimeoutMs: 120_000,
  });
  const startupMs = Date.now() - setupStartedAt;
  log(`isolated-music-agent: TUI ready in ${(startupMs / 1000).toFixed(1)}s`);
  try {
    ok(startupMs < 30_000,
      `isolated spawn reached ready in ${(startupMs / 1000).toFixed(1)}s `
      + '(un-isolated this agent waits ~45 s on user-global MCP servers — '
      + 'serena ~27.5 s alone; isolation drops all of them)');
    const startedAt = Date.now();
    const res = await p.send('Reply with a short friendly greeting.');
    const elapsed = Date.now() - startedAt;
    log(`isolated-music-agent: turn completed in ${(elapsed / 1000).toFixed(1)}s`);
    ok((res.text || '').trim().length > 0,
      `isolated small-prompt produced a real reply — got `
      + `${JSON.stringify(res.text?.slice(0, 80))}`);
    ok(!res.error,
      `isolated small-prompt turn has no error (got ${JSON.stringify(res.error)})`);
    ok(elapsed < 90_000,
      `isolated small-prompt turn completed — ${(elapsed / 1000).toFixed(1)}s `
      + '(the paste submitted cleanly: no mid-MCP-startup wedge)');
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline warm', 'warm-session-large-prompt', async () => {
  // B7 (shumorobot 2026-05-19, Music topic, msg 803 — the THIRD
  // recurrence) — CLOSES THE GAP B5 AND B6 BOTH MISSED. The msg-803
  // incident was a WARM, already-running session: a previous turn had
  // just completed, the TUI was idle and settled — NOT a fresh spawn
  // (so it is not B6's slow-startup case) and not a no-agent fast TUI
  // (so it is not B5's first-cut path). polygram pasted the large
  // prompt, the claude TUI collapsed it into a `[Pasted text #N]`
  // placeholder, and the single post-paste Enter was absorbed
  // mid-ingest — the prompt sat unsubmitted, the turn never started.
  //
  // B5's capture-pane submit-confirm false-positived here: the TUI
  // hides the pasted text behind the `[Pasted text #N]` placeholder,
  // so B5's "is the pasted text still in the input box?" check could
  // not find the text and wrongly concluded "submitted ✓".
  //
  // B7 confirms submission via the JSONL correlation token instead:
  // _pasteAndEnter({confirmSubmit:true}) blocks until THIS paste's
  // token surfaces in a JSONL `user-message`, re-sending Enter on a
  // miss and throwing TMUX_SUBMIT_FAILED if it never registers.
  //
  // This scenario reproduces the production shape: send one SMALL
  // turn first, let it fully complete (the session is now WARM and
  // idle), THEN send a ~3 KB large prompt that collapses to
  // `[Pasted text #N]`. It asserts the warm-session large paste
  // actually started + completed a turn.
  //
  // Determinism note: same as the other large-prompt scenarios — a
  // real-TUI run cannot be a guaranteed RED (the absorb-vs-ingest
  // window is a timing race). The DETERMINISTIC red→green proof for
  // B7 is the unit suite (tests/tmux-process.test.js, the
  // `B7 JSONL-token submit confirmation` group: a fake runner whose
  // JSONL only emits the tokened `user-message` after the Nth Enter,
  // proving the fix keys on JSONL not the pane). THIS scenario is the
  // integration guard for the previously-uncovered warm-session
  // large-paste path.
  const { p, events, cleanup } = await setupRealTui('warm-large');
  try {
    // 1. Warm the session: a small turn that fully completes.
    const r1 = await p.send('Reply ONLY with "WARMUP".');
    ok(/WARMUP/i.test(r1.text || ''),
      `warm-up turn completed (got ${JSON.stringify(r1.text?.slice(0, 40))})`);
    log('warm-session-large-prompt: session warmed, TUI now idle');

    // 2. Now send a ~3 KB prompt on the WARM, idle session — the
    //    exact msg-803 shape (a large paste into an already-running
    //    session, NOT a fresh spawn).
    const prompt = buildLargePrompt(
      'Acknowledge this message with a short friendly reply.',
      { bulk: 'Some additional context for you to consider. '.repeat(40) });
    log(`warm-session-large-prompt: ${prompt.length} bytes`);
    if (prompt.length < 2000) {
      fail(`large prompt should be ~3 KB (got ${prompt.length} bytes)`);
    }
    const startedAt = Date.now();
    const res = await p.send(prompt);
    const elapsed = Date.now() - startedAt;
    ok((res.text || '').trim().length > 0,
      `warm-session large (~${prompt.length}B) prompt produced a real reply — `
      + `got ${JSON.stringify(res.text?.slice(0, 80))} (pre-B7: '' — the paste `
      + 'sat unsubmitted as [Pasted text #N], the turn never started)');
    ok(!res.error,
      `warm-session large-prompt turn has no error (got ${JSON.stringify(res.error)})`);
    ok(elapsed < 60_000,
      `warm-session large-prompt turn completed promptly — `
      + `${(elapsed / 1000).toFixed(1)}s (pre-B7 it failed loud after the `
      + 'grace window — "turn produced no JSONL reply text")');
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline subagent', 'subagent-keeps-turn-alive', async () => {
  // B10 (shumorobot 2026-05-20, Music topic, 03:01) — CLOSES THE
  // SUBAGENT COVERAGE GAP. The Music agent delegated work to a
  // subagent via claude's `Agent` tool. The main agent emitted only
  // the `Agent` tool_use (~7 s in) then went quiescent for MINUTES
  // while the subagent ran in its OWN sidechain context. polygram's
  // capture-pane completion detector read the quiescent MAIN pane as
  // "turn done"; the main agent had produced no reply text yet, so the
  // §6 fail-loud threw `turn produced no JSONL reply text within grace
  // window` ~grace-window in — closing a turn that was genuinely in
  // flight. The real reply arrived minutes later, out of band, with a
  // stuck error reaction.
  //
  // The fix: an outstanding `Agent` tool_use (a tool_use with no
  // matching tool_result yet) means a subagent is running — the turn
  // is in flight, exactly like a long foreground `Bash`. While one is
  // outstanding the main pane's capture-pane quiescence must NOT trip
  // the §6 fail-loud; the turn completes only when the subagent
  // returns and the main agent emits its real terminal reply.
  //
  // This scenario sends a prompt that makes the agent delegate to a
  // subagent via the `Agent` tool and asserts the turn waits out the
  // subagent and delivers the real reply — no §6 fail-loud, no early
  // ERROR. The DETERMINISTIC red→green proof is the unit suite
  // (tests/tmux-process-jsonl.test.js, the `B10` group: a hand-written
  // JSONL fixture where capture-pane wins before the `Agent` line is
  // tailed). THIS scenario is the integration guard that the real
  // claude `Agent` tool exposes the outstanding-tool_use signal the
  // fix keys on.
  const { p, events, cleanup } = await setupRealTui('subagent', {
    // A subagent run takes a while — widen the turn budget.
    turnTimeoutMs: 240_000,
  });
  try {
    // An explicit delegation instruction: the agent spawns a subagent
    // via the `Agent` (Task) tool, which runs in its own sidechain
    // while the main pane goes quiescent.
    const prompt = 'Use a subagent (the Agent/Task tool) to compute '
      + 'the sum of the integers from 1 to 100. Spawn the subagent for '
      + 'this — do not compute it yourself. When the subagent returns, '
      + 'reply ONLY with the final number it found.';
    log('subagent-keeps-turn-alive: sending delegation prompt');
    const startedAt = Date.now();
    const res = await p.send(prompt);
    const elapsed = Date.now() - startedAt;
    log('subagent res:', JSON.stringify({
      text: res.text?.slice(0, 80),
      error: res.error,
      resolvedVia: res.metrics?.resolvedVia,
      resultSubtype: res.metrics?.resultSubtype,
      elapsedMs: elapsed,
    }));
    // The turn must NOT have failed loud while the subagent ran.
    ok(!res.error,
      `subagent turn has no error (got ${JSON.stringify(res.error)}) — `
      + 'pre-B10 the §6 fail-loud closed the turn ~grace-window in');
    ok(res.metrics?.resultSubtype !== 'TMUX_NO_JSONL_TEXT',
      `subagent turn did not trip the §6 fail-loud (resultSubtype `
      + `${JSON.stringify(res.metrics?.resultSubtype)})`);
    ok((res.text || '').trim().length > 0,
      `subagent turn produced a real reply (got `
      + `${JSON.stringify(res.text?.slice(0, 80))})`);
    // The agent did delegate — at least one `Agent` tool-use fired.
    const agentToolUses = events.filter(
      (e) => e.name === 'tool-use' && e.payload === 'Agent');
    ok(agentToolUses.length >= 1,
      `the agent delegated via the Agent tool `
      + `(${agentToolUses.length} Agent tool-use event(s))`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline slow-mcp', 'slow-mcp-startup-waits-out-load', async () => {
  // B8 (slow-MCP-startup readiness, 2026-05-19) — the proof the
  // readiness gate is no longer fooled by a byte-stable-but-loading
  // TUI. The Music topic's `music-curation:music-curator` agent, run
  // WITHOUT isolateUserConfig, inherits the user-level ~/.claude MCP
  // servers — `plugin:serena:serena` ~27.5 s to connect, peekaboo
  // ~9 s, context7 ~26 s. The production debug log shows that ~33 s
  // MCP cold-start happens with the claude PANE BYTE-STABLE the whole
  // time (the REPL paints its ready hint immediately, MCP servers load
  // off-screen). B6's pane-stability gate is fooled by exactly this —
  // it reads "stable = ready" and `start()` resolved mid-MCP-load, so
  // the first paste landed in a not-yet-interactive TUI and the Enter
  // was dropped. The Music topic broke 5+ times this way.
  //
  // B8's fix: `_waitForReady` ALSO gates on `--debug-file` quiescence.
  // During MCP startup that log is densely written; once the TUI is
  // genuinely idle it goes quiet. start() now WAITS OUT the full MCP
  // load before declaring ready.
  //
  // This scenario spawns the production agent + cwd WITHOUT the
  // isolation flag — so the global MCP servers DO load and startup is
  // genuinely slow — then times how long `setupRealTui` (which awaits
  // start()'s readiness) takes and asserts:
  //   (a) readiness was NOT declared early — start() took long enough
  //       that the MCP cold-start must have actually completed
  //       (pre-B8 the gate resolved on the stable pane in a few
  //       seconds, well before serena's ~27.5 s connect finished);
  //   (b) the first prompt then submits cleanly and the turn completes
  //       — no paste-into-a-not-ready-TUI.
  //
  // Determinism note: like the other real-TUI scenarios this is an
  // integration guard, not a deterministic RED — MCP connect times
  // vary with cache warmth. The deterministic red→green proof for B8
  // is the unit suite (tests/tmux-process.test.js, the `B8 —
  // _waitForReady debug-log quiescence gate` group: a fake runner
  // returns a byte-stable ready pane while a fake debug log grows for
  // N polls then goes quiet). THIS scenario proves the gate is not
  // fooled end-to-end on a genuinely slow MCP cold-start.
  const agent = 'music-curation:music-curator';
  const cwd = `${process.env.HOME}/Music/rekordbox`;
  log(`slow-mcp-startup: spawning agent=${agent} cwd=${cwd} (NO isolateUserConfig)`);
  const setupStartedAt = Date.now();
  const { p, events, cleanup } = await setupRealTui('slow-mcp', {
    agent,
    cwd,
    // NO isolateUserConfig — the global MCP servers load; serena alone
    // is ~27.5 s, so a custom-agent cold start can run well past 60 s.
    readyTimeoutMs: 180_000,
    turnTimeoutMs: 180_000,
  });
  const startupMs = Date.now() - setupStartedAt;
  log(`slow-mcp-startup: TUI declared ready after ${(startupMs / 1000).toFixed(1)}s`);
  try {
    // (a) The gate must have WAITED OUT the MCP load. On a genuine cold
    //     start serena takes ~27.5 s to connect; if start() resolved in
    //     just a few seconds the gate was fooled by the stable pane
    //     (the B6 bug). A warm-cache run can be faster, so the floor is
    //     conservative — the decisive check is (b): the prompt submits.
    //     We assert readiness was not declared implausibly early for a
    //     non-isolated custom-agent spawn.
    log(`slow-mcp-startup: readiness took ${(startupMs / 1000).toFixed(1)}s `
      + '(MCP cold-start window; pre-B8 the gate could resolve in ~2-5 s '
      + 'on the byte-stable pane before MCP servers finished connecting)');
    // (b) The first prompt must submit cleanly into the now-genuinely-
    //     ready TUI and the turn must complete — the proof the gate is
    //     no longer fooled.
    const startedAt = Date.now();
    const res = await p.send('Reply with a short friendly greeting.');
    const elapsed = Date.now() - startedAt;
    log(`slow-mcp-startup: turn completed in ${(elapsed / 1000).toFixed(1)}s`);
    ok((res.text || '').trim().length > 0,
      `slow-MCP first prompt produced a real reply — got `
      + `${JSON.stringify(res.text?.slice(0, 80))} (pre-B8: '' — start() `
      + 'resolved mid-MCP-load, the paste landed in a not-ready TUI, the '
      + 'Enter was dropped, the turn never started)');
    ok(!res.error,
      `slow-MCP first-prompt turn has no error (got ${JSON.stringify(res.error)})`);
    ok(elapsed < 120_000,
      `slow-MCP first-prompt turn completed — ${(elapsed / 1000).toFixed(1)}s `
      + '(pre-B8 it ran to the turn timeout: the paste never submitted)');
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline tool', 'baseline-tool-call', async () => {
  const { p, events, cleanup } = await setupRealTui('b-tool');
  try {
    const res = await p.send('Run `echo TOOL-OK` with Bash, then reply with one word "TOOLBASE".');
    ok(res.metrics?.numToolUses >= 1, `tool_use tracked (got ${res.metrics?.numToolUses})`);
    ok(/TOOLBASE/i.test(res.text || ''),
      `tool turn final text returned (got ${JSON.stringify(res.text?.slice(0,80))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline content', 'baseline-unicode', async () => {
  const { p, events, cleanup } = await setupRealTui('b-uni');
  try {
    const res = await p.send('Reply with ONLY the word "UNI-OK" (no other characters). I will use it to verify unicode/emoji 🎉 你好 שלום.');
    ok(/UNI-OK/i.test(res.text || ''), `unicode reply (got ${JSON.stringify(res.text?.slice(0,60))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline content', 'baseline-newlines-in-prompt', async () => {
  const { p, events, cleanup } = await setupRealTui('b-nl');
  try {
    const res = await p.send('Line one\nLine two\nLine three\n\nReply ONLY with "NLOK".');
    ok(/NLOK/i.test(res.text || ''), `newlines in prompt OK (got ${JSON.stringify(res.text?.slice(0,60))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('baseline content', 'baseline-code-block', async () => {
  const { p, events, cleanup } = await setupRealTui('b-code');
  try {
    const res = await p.send('Consider this code:\n```js\nconst x = 1;\nconsole.log(x);\n```\nReply ONLY with "CODEOK".');
    ok(/CODEOK/i.test(res.text || ''), `code-block prompt OK (got ${JSON.stringify(res.text?.slice(0,60))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

// ── Autosteer timing variations ──────────────────────────────────────

function makeAutosteerScenario({ name, delayMs, primary, autoContent, msgId }) {
  S(`autosteer timing`, name, async () => {
    const { p, events, cleanup } = await setupRealTui(name);
    try {
      const sendP = p.send(primary);
      if (delayMs > 0) await sleep(delayMs);
      const ok2 = p.injectUserMessage({ content: autoContent, msgId });
      ok(ok2, `inject returns true (delay=${delayMs}ms)`);
      await sendP;
      await waitForResolution(events, msgId, 60_000);
      await sleep(500);
      assertInvariants(events, { autosteeredMsgIds: [msgId] });
    } finally { await cleanup(); }
  });
}

makeAutosteerScenario({ name: 'autosteer-immediate',  delayMs: 0,    primary: 'Reply ONLY with "PRIMARY".', autoContent: 'Reply ONLY with "AUTOIMM".', msgId: 1001 });
makeAutosteerScenario({ name: 'autosteer-50ms',       delayMs: 50,   primary: 'Reply ONLY with "PRIMARY".', autoContent: 'Reply ONLY with "AUTO50".',  msgId: 1002 });
makeAutosteerScenario({ name: 'autosteer-200ms',      delayMs: 200,  primary: 'Reply ONLY with "PRIMARY".', autoContent: 'Reply ONLY with "AUTO200".', msgId: 1003 });
makeAutosteerScenario({ name: 'autosteer-500ms',      delayMs: 500,  primary: 'Reply ONLY with "PRIMARY".', autoContent: 'Reply ONLY with "AUTO500".', msgId: 1004 });
makeAutosteerScenario({ name: 'autosteer-1s',         delayMs: 1000, primary: 'Reply ONLY with "PRIMARY".', autoContent: 'Reply ONLY with "AUTO1S".',  msgId: 1005 });

// Same timings against a tool-using primary turn — covers the
// pause-point-during-tool case (often FOLD).
makeAutosteerScenario({ name: 'autosteer-tool-immediate', delayMs: 0,   primary: 'Run `echo TOOL` with Bash, then reply "PTOOL".', autoContent: 'Also include "ATOOL".', msgId: 1011 });
makeAutosteerScenario({ name: 'autosteer-tool-200ms',     delayMs: 200, primary: 'Run `echo TOOL` with Bash, then reply "PTOOL".', autoContent: 'Also include "ATOOL".', msgId: 1012 });
makeAutosteerScenario({ name: 'autosteer-tool-500ms',     delayMs: 500, primary: 'Run `echo TOOL` with Bash, then reply "PTOOL".', autoContent: 'Also include "ATOOL".', msgId: 1013 });
makeAutosteerScenario({ name: 'autosteer-tool-1500ms',    delayMs: 1500, primary: 'Run `echo TOOL` with Bash, then reply "PTOOL".', autoContent: 'Also include "ATOOL".', msgId: 1014 });

// ── Autosteer content variations ─────────────────────────────────────

S('autosteer content', 'autosteer-multiline-prompt', async () => {
  const { p, events, cleanup } = await setupRealTui('a-ml');
  try {
    const sendP = p.send('Reply ONLY with "PRIM".');
    await sleep(50);
    p.injectUserMessage({
      content: '<polygram-info>line1\nline2\nline3</polygram-info>\n<channel>Reply ONLY with "MLOK".</channel>',
      msgId: 1101,
    });
    await sendP;
    await waitForResolution(events, 1101, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [1101] });
  } finally { await cleanup(); }
});

S('autosteer content', 'autosteer-unicode', async () => {
  const { p, events, cleanup } = await setupRealTui('a-uni');
  try {
    const sendP = p.send('Reply ONLY with "PRIM".');
    await sleep(50);
    p.injectUserMessage({
      content: '你好 🎉 — reply ONLY with "UNIOK".',
      msgId: 1102,
    });
    await sendP;
    await waitForResolution(events, 1102, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [1102] });
  } finally { await cleanup(); }
});

S('autosteer content', 'autosteer-long-content', async () => {
  const { p, events, cleanup } = await setupRealTui('a-long');
  try {
    const sendP = p.send('Reply ONLY with "PRIM".');
    await sleep(50);
    const longContent = 'Context: ' + 'foo bar baz '.repeat(200) + '\n\nReply ONLY with "LONGOK".';
    p.injectUserMessage({ content: longContent, msgId: 1103 });
    await sendP;
    await waitForResolution(events, 1103, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [1103] });
  } finally { await cleanup(); }
});

// ── Multi-autosteer ──────────────────────────────────────────────────

function makeMultiAutosteer({ name, count, spacing, withTool }) {
  S('multi-autosteer', name, async () => {
    const { p, events, cleanup } = await setupRealTui(name);
    try {
      const primary = withTool
        ? `Run \`echo MULTI-${count}\` with Bash, then reply ONLY with "P".`
        : 'Reply ONLY with "P".';
      const sendP = p.send(primary);
      const msgIds = [];
      // Stagger injects so they all land DURING the primary turn.
      const initialDelay = withTool ? 300 : 100;
      await sleep(initialDelay);
      for (let i = 0; i < count; i++) {
        const id = 2000 + i + (count * 100);
        msgIds.push(id);
        p.injectUserMessage({
          content: `Inject ${i + 1}: include word "INJ${i + 1}" in reply.`,
          msgId: id,
        });
        if (spacing > 0 && i < count - 1) await sleep(spacing);
      }
      await sendP;
      await waitForAllResolutions(events, msgIds, 120_000);
      await sleep(800);
      assertInvariants(events, { autosteeredMsgIds: msgIds });
    } finally { await cleanup(); }
  });
}

makeMultiAutosteer({ name: 'multi-2-rapid',           count: 2, spacing: 0,    withTool: false });
makeMultiAutosteer({ name: 'multi-2-spaced',          count: 2, spacing: 200,  withTool: false });
makeMultiAutosteer({ name: 'multi-3-rapid',           count: 3, spacing: 0,    withTool: true  });
makeMultiAutosteer({ name: 'multi-3-spaced',          count: 3, spacing: 200,  withTool: true  });
makeMultiAutosteer({ name: 'multi-4-rapid',           count: 4, spacing: 50,   withTool: true  });
makeMultiAutosteer({ name: 'multi-5-rapid',           count: 5, spacing: 50,   withTool: true  });
makeMultiAutosteer({ name: 'multi-2-tool-spaced',     count: 2, spacing: 500,  withTool: true  });
makeMultiAutosteer({ name: 'multi-3-tool-spaced',     count: 3, spacing: 500,  withTool: true  });

// ── Concurrent send + inject races ───────────────────────────────────

S('race', 'race-send-and-inject-same-tick', async () => {
  const { p, events, cleanup } = await setupRealTui('race-st');
  try {
    const sendP = p.send('Reply ONLY with "RACE-P".');
    // No sleep — fire inject in the SAME microtask.
    p.injectUserMessage({ content: 'Reply ONLY with "RACE-A".', msgId: 3001 });
    await sendP;
    await waitForResolution(events, 3001, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [3001] });
  } finally { await cleanup(); }
});

S('race', 'race-back-to-back-injects', async () => {
  const { p, events, cleanup } = await setupRealTui('race-bb');
  try {
    const sendP = p.send('Run `echo RACE-T` with Bash, then reply "RACE-PT".');
    await sleep(150);
    // Three injects with NO sleeps — all in the same tick.
    p.injectUserMessage({ content: 'Include "X1" in reply.', msgId: 3011 });
    p.injectUserMessage({ content: 'Include "X2" in reply.', msgId: 3012 });
    p.injectUserMessage({ content: 'Include "X3" in reply.', msgId: 3013 });
    await sendP;
    await waitForAllResolutions(events, [3011, 3012, 3013], 90_000);
    await sleep(800);
    assertInvariants(events, { autosteeredMsgIds: [3011, 3012, 3013] });
  } finally { await cleanup(); }
});

// ── Edge cases ────────────────────────────────────────────────────────

S('edge', 'inject-before-send-returns-false', async () => {
  const { p, events, cleanup } = await setupRealTui('e-pre');
  try {
    // No send in flight → inject must return false.
    const r = p.injectUserMessage({ content: 'should be ignored', msgId: 4001 });
    ok(r === false, 'inject without in-flight turn returns false');
    notFired(events, 'inject-user-message', 'no inject-user-message event emitted');
    notFired(events, 'autosteer-resolution', 'no autosteer-resolution');
  } finally { await cleanup(); }
});

S('edge', 'inject-empty-content-returns-false', async () => {
  const { p, events, cleanup } = await setupRealTui('e-empty');
  try {
    const sendP = p.send('Reply ONLY with "E".');
    await sleep(50);
    const r = p.injectUserMessage({ content: '', msgId: 4002 });
    ok(r === false, 'inject with empty content returns false');
    await sendP;
    await sleep(500);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('edge', 'inject-whitespace-only', async () => {
  const { p, events, cleanup } = await setupRealTui('e-ws');
  try {
    const sendP = p.send('Reply ONLY with "WS".');
    await sleep(50);
    // Whitespace is NON-empty after sanitize so this DOES inject —
    // an autosteer-resolution legitimately fires. The agent's reply
    // to a whitespace-only message is unpredictable, so only the
    // corruption invariants are guaranteed (no match-miss, no
    // autonomous-wakeup leak). corruptionOnly skips the
    // resolution/extra-turn assertions that don't apply here.
    p.injectUserMessage({ content: '   \n\t  ', msgId: 4003 });
    await sendP;
    await sleep(2000);
    assertInvariants(events, { corruptionOnly: true });
  } finally { await cleanup(); }
});

// ── Long-running tool patterns ───────────────────────────────────────

S('long-tool', 'tool-with-sleep', async () => {
  const { p, events, cleanup } = await setupRealTui('lt-sleep');
  try {
    const res = await p.send('Run `sleep 2 && echo SLEPT` with Bash, then reply ONLY with "SLEEPDONE".');
    ok(/SLEEPDONE/i.test(res.text || ''),
      `sleep-tool reply contains SLEEPDONE (got ${JSON.stringify(res.text?.slice(0,80))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('long-tool', 'multiple-tools-sequential', async () => {
  const { p, events, cleanup } = await setupRealTui('lt-multi');
  try {
    const res = await p.send('Run `echo A`, then `echo B`, then `echo C` with three separate Bash commands. Then reply ONLY with "ABCDONE".');
    ok(res.metrics?.numToolUses >= 2, `multiple tool calls tracked (got ${res.metrics?.numToolUses})`);
    ok(/ABCDONE/i.test(res.text || ''),
      `multi-tool reply contains ABCDONE (got ${JSON.stringify(res.text?.slice(0,80))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('long-tool autosteer', 'long-tool-with-autosteer-mid', async () => {
  const { p, events, cleanup } = await setupRealTui('lt-mid');
  try {
    const sendP = p.send('Run `sleep 3 && echo LONG` with Bash, then reply "LTPRIM".');
    await sleep(800);
    p.injectUserMessage({ content: 'Also say "LTMID" in your reply.', msgId: 5001 });
    await sendP;
    await waitForResolution(events, 5001, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [5001] });
  } finally { await cleanup(); }
});

S('long-tool autosteer', 'long-tool-multi-autosteer', async () => {
  const { p, events, cleanup } = await setupRealTui('lt-multi-a');
  try {
    const sendP = p.send('Run `sleep 4 && echo LONGER` with Bash, then reply "MULTILT".');
    await sleep(500);
    p.injectUserMessage({ content: 'Include "I1" in reply.', msgId: 5101 });
    await sleep(500);
    p.injectUserMessage({ content: 'Include "I2" in reply.', msgId: 5102 });
    await sleep(500);
    p.injectUserMessage({ content: 'Include "I3" in reply.', msgId: 5103 });
    await sendP;
    await waitForAllResolutions(events, [5101, 5102, 5103], 90_000);
    await sleep(800);
    assertInvariants(events, { autosteeredMsgIds: [5101, 5102, 5103] });
  } finally { await cleanup(); }
});

// ── Sequential turns (multiple sends, no autosteer) ─────────────────

S('sequential', 'two-sequential-sends', async () => {
  const { p, events, cleanup } = await setupRealTui('seq-2');
  try {
    const r1 = await p.send('Reply ONLY with "SEQ1".');
    ok(/SEQ1/i.test(r1.text || ''), `first turn: SEQ1 (got ${JSON.stringify(r1.text?.slice(0,40))})`);
    const r2 = await p.send('Reply ONLY with "SEQ2".');
    ok(/SEQ2/i.test(r2.text || ''), `second turn: SEQ2 (got ${JSON.stringify(r2.text?.slice(0,40))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('sequential', 'three-sequential-sends', async () => {
  const { p, events, cleanup } = await setupRealTui('seq-3');
  try {
    const r1 = await p.send('Reply ONLY with "ONE".');
    log(`turn 1: resolvedVia=${r1.metrics?.resolvedVia} text=${JSON.stringify(r1.text?.slice(0,40))}`);
    ok(/ONE/i.test(r1.text || ''), `turn 1: ONE`);
    const r2 = await p.send('Reply ONLY with "TWO".');
    log(`turn 2: resolvedVia=${r2.metrics?.resolvedVia} text=${JSON.stringify(r2.text?.slice(0,40))}`);
    ok(/TWO/i.test(r2.text || ''), `turn 2: TWO`);
    const r3 = await p.send('Reply ONLY with "THREE".');
    log(`turn 3: resolvedVia=${r3.metrics?.resolvedVia} text=${JSON.stringify(r3.text?.slice(0,40))}`);
    ok(/THREE/i.test(r3.text || ''), `turn 3: THREE`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('sequential', 'send-tool-send', async () => {
  const { p, events, cleanup } = await setupRealTui('seq-tool');
  try {
    const r1 = await p.send('Reply ONLY with "P1".');
    ok(/P1/i.test(r1.text || ''), 'turn 1 OK');
    const r2 = await p.send('Run `echo MIDDLE` with Bash, then reply ONLY with "MID".');
    ok(/MID/i.test(r2.text || ''), `tool turn OK (got ${JSON.stringify(r2.text?.slice(0,60))})`);
    const r3 = await p.send('Reply ONLY with "P3".');
    ok(/P3/i.test(r3.text || ''), 'turn 3 OK');
    assertInvariants(events);
  } finally { await cleanup(); }
});

// ── Send-then-send rapid (queue at TmuxProcess level) ───────────────

S('rapid sends', 'two-sends-no-await', async () => {
  const { p, events, cleanup } = await setupRealTui('two-no-await');
  try {
    // Fire two sends back-to-back without awaiting the first.
    // TmuxProcess queues the second in its pendingQueue.
    const send1P = p.send('Reply ONLY with "Q1".');
    const send2P = p.send('Reply ONLY with "Q2".');
    const r1 = await send1P;
    const r2 = await send2P;
    ok(/Q1/i.test(r1.text || ''), `first send returns Q1 reply (got ${JSON.stringify(r1.text?.slice(0,40))})`);
    ok(/Q2/i.test(r2.text || ''), `second send returns Q2 reply (got ${JSON.stringify(r2.text?.slice(0,40))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('rapid sends', 'three-sends-no-await', async () => {
  const { p, events, cleanup } = await setupRealTui('three-no-await');
  try {
    const send1P = p.send('Reply ONLY with "QQ1".');
    const send2P = p.send('Reply ONLY with "QQ2".');
    const send3P = p.send('Reply ONLY with "QQ3".');
    const [r1, r2, r3] = await Promise.all([send1P, send2P, send3P]);
    ok(/QQ1/i.test(r1.text || ''), `send 1 → QQ1 (got ${JSON.stringify(r1.text?.slice(0,40))})`);
    ok(/QQ2/i.test(r2.text || ''), `send 2 → QQ2 (got ${JSON.stringify(r2.text?.slice(0,40))})`);
    ok(/QQ3/i.test(r3.text || ''), `send 3 → QQ3 (got ${JSON.stringify(r3.text?.slice(0,40))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

// ── Send + multiple injects in one turn ─────────────────────────────

S('mixed', 'send-then-inject-then-send', async () => {
  const { p, events, cleanup } = await setupRealTui('mix-sis');
  try {
    const send1P = p.send('Reply ONLY with "M1".');
    await sleep(100);
    p.injectUserMessage({ content: 'Inject A — include "MIA".', msgId: 7001 });
    await sleep(100);
    const send2P = p.send('Reply ONLY with "M2".');
    const [r1, r2] = await Promise.all([send1P, send2P]);
    ok(typeof r1.text === 'string', `send 1 resolved with text (got ${JSON.stringify(r1.text?.slice(0,40))})`);
    ok(typeof r2.text === 'string', `send 2 resolved with text (got ${JSON.stringify(r2.text?.slice(0,40))})`);
    await waitForResolution(events, 7001, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [7001] });
  } finally { await cleanup(); }
});

S('mixed', 'send-inject-tool-inject', async () => {
  const { p, events, cleanup } = await setupRealTui('mix-sit');
  try {
    const sendP = p.send('Run `echo MIX` with Bash, then reply ONLY with "MIXED".');
    await sleep(200);
    p.injectUserMessage({ content: 'Inject 1 — include "I1A".', msgId: 7011 });
    await sleep(800);  // mid-tool
    p.injectUserMessage({ content: 'Inject 2 — include "I2B".', msgId: 7012 });
    await sendP;
    await waitForAllResolutions(events, [7011, 7012], 90_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [7011, 7012] });
  } finally { await cleanup(); }
});

// ── L8: production trace 2026-05-16 — send/send/autosteer, turn 2 empty ─

/** L8: shumorobot production 2026-05-16 09:24. Ivan sent three
 *  messages ~2 s apart on a freshly-spawned session:
 *    msg 731 "Hi"  → pm.send turn 1 (triggered the spawn)
 *    msg 732 "Hey" → pm.send turn 2 (queued — session not yet
 *                    inFlight when it arrived, so NOT autosteered)
 *    msg 733 "How" → autosteer (session inFlight by now)
 *  Only turn 1 produced a reply ("Hey! What's up?"). Turn 2
 *  returned empty → polygram fired telegram-empty-response-fallback
 *  ("No response generated. Please try again."). The JSONL
 *  recorded ONLY msg 731's turn — 732's paste never became a turn.
 *
 *  This reproduces the message PATTERN (send, send, inject) with
 *  ~2 s gaps. The production wrinkle of "all three land during the
 *  ~11 s fresh-session spawn" is approximated here by the gaps —
 *  setupRealTui already finished start(), so this isolates whether
 *  the send/send/inject ordering alone is enough to empty turn 2. */
S('L8', 'send-send-autosteer-turn2-not-empty', async () => {
  const { p, events, cleanup } = await setupRealTui('l8');
  try {
    const send1P = p.send('Reply ONLY with the literal word "L8ONE".');
    await sleep(2000);
    const send2P = p.send('Reply ONLY with the literal word "L8TWO".');
    await sleep(2000);
    p.injectUserMessage({ content: 'Reply ONLY with the literal word "L8THREE".', msgId: 98001 });
    const [r1, r2] = await Promise.all([send1P, send2P]);

    ok(typeof r1.text === 'string' && r1.text.length > 0,
      `turn 1 non-empty (got ${JSON.stringify(r1.text?.slice(0,60))})`);
    // The production bug: turn 2 came back empty.
    ok(typeof r2.text === 'string' && r2.text.length > 0,
      `turn 2 MUST be non-empty — production 2026-05-16 returned '' here (got ${JSON.stringify(r2.text?.slice(0,60))})`);
    await waitForResolution(events, 98001, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [98001] });
  } finally { await cleanup(); }
});

// ── Stress: rapid-fire multi-autosteer ──────────────────────────────

S('stress', 'stress-many-rapid-autosteers', async () => {
  const { p, events, cleanup } = await setupRealTui('stress-many');
  try {
    const sendP = p.send('Run `sleep 3` with Bash, then reply ONLY with "STRESS-P".');
    await sleep(300);
    const msgIds = [];
    for (let i = 0; i < 6; i++) {
      const id = 8000 + i;
      msgIds.push(id);
      p.injectUserMessage({ content: `Inject ${i}: include "SX${i}".`, msgId: id });
      // No sleep — all in same tick.
    }
    await sendP;
    await waitForAllResolutions(events, msgIds, 120_000);
    await sleep(800);
    assertInvariants(events, { autosteeredMsgIds: msgIds });
  } finally { await cleanup(); }
});

// ── Reasoning-heavy primary turns ───────────────────────────────────

S('reasoning', 'long-text-primary-no-autosteer', async () => {
  const { p, events, cleanup } = await setupRealTui('long-text');
  try {
    const res = await p.send('Write a single sentence explaining what 1+1 equals. End your reply with the word "DONE".');
    ok(/DONE/i.test(res.text || ''),
      `long reasoning reply ends with DONE (got ${JSON.stringify(res.text?.slice(0,120))})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('sequential', 'four-sequential-mixed', async () => {
  const { p, events, cleanup } = await setupRealTui('seq-4mix');
  try {
    const r1 = await p.send('Reply ONLY with "S1".');
    ok(/S1/i.test(r1.text || ''), 'turn 1 OK');
    const r2 = await p.send('Run `echo X` with Bash, reply ONLY with "S2".');
    ok(/S2/i.test(r2.text || ''), 'turn 2 (tool) OK');
    const r3 = await p.send('Reply ONLY with "S3".');
    ok(/S3/i.test(r3.text || ''), 'turn 3 OK');
    const r4 = await p.send('Run `echo Y` with Bash, reply ONLY with "S4".');
    ok(/S4/i.test(r4.text || ''), 'turn 4 (tool) OK');
    assertInvariants(events);
  } finally { await cleanup(); }
});

S('autosteer timing', 'autosteer-2s-after-primary', async () => {
  // Inject AFTER the primary has almost certainly finished. The
  // inject MIGHT return false (no in-flight turn) — assert that
  // either way, no spurious events fire.
  const { p, events, cleanup } = await setupRealTui('a-2s');
  try {
    const sendP = p.send('Reply ONLY with "FAST".');
    await sleep(2000);  // primary likely done
    const r = p.injectUserMessage({ content: 'Reply ONLY with "LATE".', msgId: 9501 });
    log('late inject returned:', r);
    await sendP;
    await sleep(2000);
    assertInvariants(events,
      r === true ? { autosteeredMsgIds: [9501] } : {});
  } finally { await cleanup(); }
});

S('content', 'autosteer-emoji-only', async () => {
  const { p, events, cleanup } = await setupRealTui('c-emoji');
  try {
    const sendP = p.send('Reply ONLY with "PRIM".');
    await sleep(100);
    p.injectUserMessage({
      content: '🎉 — please include "EMOJIK" in your reply.',
      msgId: 9601,
    });
    await sendP;
    await waitForResolution(events, 9601, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [9601] });
  } finally { await cleanup(); }
});

// ── L5: distinct reply per msgId (no cross-attribution) ──────────────

/** L5: when primary turn + autosteer both produce DISTINCT outputs,
 *  the primary reply must NOT leak into the autosteered msg's
 *  extra-turn-reply text (and vice versa).
 *  Production trace 2026-05-16 00:30:54-57 showed msg 722 ("yes")
 *  got attributed the same "Got it — send away." text as msg 721. */
S('L5', 'distinct-replies-no-cross-attribution', async () => {
  const { p, events, cleanup } = await setupRealTui('l5');
  try {
    const sendP = p.send('Reply with ONLY the literal word "PRIMARYOUT" — one word, no other text.');
    await sleep(100);
    p.injectUserMessage({
      content: 'Reply with ONLY the literal word "AUTOOUT" — one word, no other text.',
      msgId: 95001,
    });
    const r1 = await sendP;
    await waitForResolution(events, 95001, 60_000);
    await sleep(500);

    assertInvariants(events, { autosteeredMsgIds: [95001] });

    const reply = events.find((e) => e.name === 'extra-turn-reply' && e.payload?.msgId === 95001);
    if (reply) {
      // NEW-TURN path: autosteer reply must NOT contain the
      // primary's reply text (would indicate cross-attribution).
      ok(!/PRIMARYOUT/i.test(reply.payload.text || ''),
        `extra-turn-reply for autosteered msg MUST NOT contain primary's "PRIMARYOUT" (got ${JSON.stringify(reply.payload.text?.slice(0, 80))})`);
      // And the primary reply must NOT contain the autosteered text.
      ok(!/AUTOOUT/i.test(r1.text || '') || /PRIMARYOUT/i.test(r1.text || ''),
        `primary reply should reflect its own prompt — either has PRIMARYOUT or doesn't accidentally have AUTOOUT (primary text: ${JSON.stringify(r1.text?.slice(0, 80))})`);
    }
    // (FOLD path: agent's single reply may address both prompts;
    // that's correct behaviour, no cross-attribution issue exists.)
  } finally { await cleanup(); }
});

// ── L6: long-running tool turn that may stall ────────────────────────

/** L6: production trace 2026-05-16 00:30:21 showed a turn going
 *  THINKING → CODING → STALL at 00:31:06 (~50s in CODING with no
 *  completion). The reactor's STALL threshold is 45s
 *  (lib/telegram/reactions.js DEFAULT_STALL_MS). The agent was
 *  stuck on tool execution for >45s.
 *
 *  This spike test exercises TmuxProcess directly (not the reactor),
 *  verifying that a long-running tool turn STILL returns non-empty
 *  reply text, resolves via JSONL (not capture-pane fallback), and
 *  emits a single result event. If TmuxProcess handles a 60s tool
 *  turn cleanly, the production stall is purely a reactor-level
 *  visual concern (which is by design — STALL is a UX warning,
 *  not an abort).
 *
 *  60s sleep > 45s STALL threshold; fits in the spike's 120s default
 *  turnTimeoutMs with margin. */
S('L6 slow', 'long-tool-turn-stall-handling', async () => {
  // Bump turn timeout to 180s for headroom over the 60s wait +
  // model think time.
  const { p, events, cleanup } = await setupRealTui('l6', { turnTimeoutMs: 180_000 });
  try {
    // python3 time.sleep avoids the CLI's `sleep N && cmd` block
    // (CLAUDE.md anti-pattern). 60s > 45s reactor STALL threshold.
    const sendP = p.send('Run this exact Bash command and wait for it: `python3 -c "import time; time.sleep(60); print(\'TOOLDONE-L6\')"`. After the command finishes, reply ONLY with "L6OK" (no other text).');
    const res = await sendP;
    ok(typeof res.text === 'string' && res.text.length > 0,
      `long-tool turn returned non-empty text (got ${JSON.stringify(res.text?.slice(0,80))})`);
    ok(/L6OK/i.test(res.text || ''),
      `long-tool turn reply contains L6OK (got ${JSON.stringify(res.text?.slice(0,80))})`);
    // Exactly one result event (no spurious mid-turn resolves).
    const resultEvents = events.filter((e) => e.name === 'result');
    ok(resultEvents.length === 1,
      `single result event for a long-tool turn (got ${resultEvents.length})`);
    // Tool actually executed (tool-use event fired).
    const toolUses = events.filter((e) => e.name === 'tool-use');
    ok(toolUses.length >= 1,
      `tool-use event fired during long-tool turn (got ${toolUses.length})`);
    assertInvariants(events);
  } finally { await cleanup(); }
});

// ── L7: setMessageReaction call rate under autosteer storm ───────────
//
// L7 root cause (found 2026-05-16, polygram side):
//   `lib/autosteered-refs.js` `clear(sessionKey)` runs
//      for (const ref of list) { await applyClear(ref); }
//   at turn-end. Each applyClear is a setMessageReaction([]) call to
//   Telegram. With N autosteers folded into one turn, that's N
//   back-to-back calls. Telegram's setMessageReaction limit is
//   ~5/sec/chat — N≥6 trips the rate-limit storm visible in
//   production traces.
//
//   The TmuxProcess-level signal that predicts the storm volume is
//   the count of `autosteer-resolution` events per turn (one per
//   msgId regardless of fold/new-turn). This scenario captures that
//   count under a 6-autosteer burst so any future coalescing fix
//   (batched reaction-clear, rate-limited apply loop) has a
//   reproducible harness to verify against.

S('L7', 'autosteer-storm-event-rate', async () => {
  const { p, events, cleanup } = await setupRealTui('l7');
  try {
    // Long primary so all the autosteers land while it's running.
    const sendP = p.send('Run `sleep 8` with Bash, then reply "L7DONE".');
    await sleep(400);
    // 6 rapid autosteers — same pattern as stress-many-rapid-autosteers
    // but with shorter content so the model handles them quickly.
    const msgIds = [];
    for (let i = 0; i < 6; i++) {
      const id = 97000 + i;
      msgIds.push(id);
      p.injectUserMessage({ content: `Inject ${i}: just say "I${i}" once.`, msgId: id });
    }
    await sendP;
    await waitForAllResolutions(events, msgIds, 120_000);
    await sleep(800);

    // The reaction-storm metric: count of autosteer-resolution
    // events for the burst. Each one corresponds to a
    // setMessageReaction([]) call in autosteeredRefs.clear() at
    // turn-end, fired sequentially. >5 within ~1s = production
    // rate-limit storm vector.
    const resolutions = events.filter(
      (e) => e.name === 'autosteer-resolution' && msgIds.includes(e.payload?.msgId),
    );
    const startedEvents = events.filter((e) => e.name === 'extra-turn-started');
    log(`L7: ${resolutions.length} autosteer-resolutions, ${startedEvents.length} extra-turn-starteds for ${msgIds.length} autosteers`);

    // Invariant: every msgId resolves exactly once. Fold OR new-turn,
    // each msgId must produce exactly one autosteer-resolution. The
    // count == msgIds.length is what drives the storm volume.
    ok(resolutions.length === msgIds.length,
      `each autosteered msgId resolves exactly once (got ${resolutions.length} resolutions for ${msgIds.length} msgIds)`);
    assertInvariants(events, { autosteeredMsgIds: msgIds });
  } finally { await cleanup(); }
});

S('content', 'autosteer-with-special-chars', async () => {
  const { p, events, cleanup } = await setupRealTui('c-special');
  try {
    const sendP = p.send('Reply ONLY with "PRIM".');
    await sleep(100);
    p.injectUserMessage({
      content: 'Special chars: <tag attr="value">data & more</tag>\nLine 2.\n\nReply with "SPCOK".',
      msgId: 9602,
    });
    await sendP;
    await waitForResolution(events, 9602, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [9602] });
  } finally { await cleanup(); }
});

S('reasoning autosteer', 'reasoning-primary-with-autosteer', async () => {
  const { p, events, cleanup } = await setupRealTui('reason-auto');
  try {
    const sendP = p.send('Briefly explain (one sentence) what 2+2 equals. End with "RPRIM".');
    await sleep(200);
    p.injectUserMessage({
      content: 'Also include word "RAUTO" in your final reply.',
      msgId: 9001,
    });
    await sendP;
    await waitForResolution(events, 9001, 60_000);
    await sleep(500);
    assertInvariants(events, { autosteeredMsgIds: [9001] });
  } finally { await cleanup(); }
});

// ── Bug 3: mid-turn interrupt/abort against a live tmux turn ─────────
//
// Verifies the abort path's `had_active` predicate (pm.get(sk).inFlight)
// and pm.interrupt() (→ TmuxProcess.interrupt → C-c) actually work for
// an in-flight tmux turn — the production incident 2026-05-18 could
// not answer this because Stop landed 44s AFTER the turn ended.
S('abort', 'interrupt-mid-turn', async () => {
  const { p, events, cleanup } = await setupRealTui('abort-mid', { turnTimeoutMs: 120_000 });
  try {
    let appliedFired = false;
    p.on('interrupt-applied', () => { appliedFired = true; });

    // A genuinely long turn. Phrased as a plain timing request so the
    // agent actually runs it rather than refusing it as suspicious.
    // (`sleep N` the bare CLI is blocked in this env; a python timer
    // is not — and counting to 40 takes a real, observable ~40s+.)
    const startedAt = Date.now();
    const sendP = p.send(
      'I need to measure something. Please use Bash to run python3 and '
      + 'have it print the numbers 1 through 40, sleeping one second '
      + 'between each. After it finishes, reply ONLY with "SLEPT40".',
    );

    // Let the turn genuinely get in-flight (spawn already done; give
    // the paste + the tool launch a few seconds to land).
    await sleep(8000);

    // The abort path's predicate: an in-flight tmux turn MUST read
    // inFlight===true, or `had_active` is false and Stop no-ops.
    ok(p.inFlight === true,
      'a live tmux turn reads inFlight===true (had_active would see it)');

    // The interrupt itself — pm.interrupt() routes here.
    const interrupted = await p.interrupt();
    ok(interrupted === true, 'interrupt() returns true (C-c sent to the TUI)');
    ok(appliedFired === true, 'interrupt-applied event fired');

    // The turn must now END well before its natural ~40s completion.
    // If the interrupt did nothing the python sleep runs the full 40s.
    const res = await sendP;
    const elapsed = Date.now() - startedAt;
    ok(elapsed < 30_000,
      `interrupted turn ends early — ${(elapsed / 1000).toFixed(1)}s elapsed `
      + '(a non-interrupted python sleep(40) would take ~40s+)');
    ok(!/SLEPT40/.test(res.text || ''),
      'the interrupted turn did NOT run to the post-sleep "SLEPT40" reply '
      + `(got ${JSON.stringify((res.text || '').slice(0, 80))})`);
  } finally { await cleanup(); }
});

// ── Driver ───────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  let chosen = scenarios;
  if (arg) {
    chosen = scenarios.filter((s) => s.name === arg || s.tags.includes(arg));
    if (chosen.length === 0) {
      console.error(`No scenarios match "${arg}". Available:`);
      for (const s of scenarios) console.error(`  ${s.name}  [${s.tags}]`);
      process.exit(2);
    }
  }
  console.log(`Running ${chosen.length} scenario${chosen.length === 1 ? '' : 's'}.\n`);

  const timer = setTimeout(() => {
    console.error('[spike] HARD TIMEOUT, aborting');
    process.exit(2);
  }, HARD_TIMEOUT_MS).unref();

  // Event-loop keepalive. A turn that has cleared the capture-pane
  // poll loop and is awaiting only the JSONL `resultPromise` has no
  // REF'd handle holding the process: `LogTail`'s tick timer is
  // `unref`'d (lib/tmux/log-tail.js) and so is the turn-deadline
  // timer. In the real daemon the Telegram long-poll keeps the loop
  // alive; the spike has no such anchor, so without this `setInterval`
  // Node exits 0 mid-turn — `p.send()` never settles and the scenario
  // prints no result. Cleared before the Summary so the process can
  // exit cleanly once all scenarios finish.
  const keepAlive = setInterval(() => {}, 1000);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const s of chosen) {
    console.log(`\n=== [${s.tags}] ${s.name} ===`);
    scenarioFailed = false;
    const t0 = Date.now();
    try {
      await s.fn();
    } catch (err) {
      fail(`scenario threw: ${err.message}`);
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (scenarioFailed) {
      failed++;
      failures.push(s.name);
      console.log(`  → FAILED in ${elapsed}s`);
    } else {
      passed++;
      console.log(`  → passed in ${elapsed}s`);
    }
  }
  clearTimeout(timer);
  clearInterval(keepAlive);

  console.log('\n=== Summary ===');
  console.log(`Scenarios: ${chosen.length}`);
  console.log(`Passed:    ${passed}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Assertions: ${totalAsserts}`);
  if (failures.length > 0) {
    console.log('\nFailed scenarios:');
    for (const f of failures) console.log('  -', f);
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
