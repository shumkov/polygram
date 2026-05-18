'use strict';

// TmuxProcess.start() verifies the pinned claude binary exists
// (lib/claude-bin.js); the real binary isn't present in CI. Point
// the override at the node executable — always present. The fake
// runner never actually execs it.
if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

/**
 * Approval-flow tests for TmuxProcess. When a chat is spawned without
 * --permission-mode acceptEdits, claude TUI pauses on risky tools and
 * shows a "Do you want to do this?" prompt. TmuxProcess detects this
 * via capture-pane, fires approval-required, and waits for the
 * consumer to call respond('allow'|'deny'|'always-allow').
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { TmuxProcess } = require('../lib/process/tmux-process');

const APPROVAL_CAPTURE = [
  '⏺ Bash(rm /tmp/foo.txt)',
  '  ⎿  Do you want to do this?',
  '       1. Yes',
  '       2. Yes, allow always for similar commands',
  '       3. No, and tell Claude what to do differently',
  '',
  '❯ ',
].join('\n');

// Production TUI rendering as observed on shumorobot 2026-05-15:
// the ❯ selection cursor is rendered INLINE before the highlighted
// option ("❯ 1. Yes"), not on a separate line at the bottom. This
// fixture must stay byte-faithful to the real capture-pane output —
// it's the regression that rc.5 fixes (rc.1–rc.4 regex assumed no
// inline cursor, so every approval-gated tool call deadlocked in
// the TUI without ever reaching Telegram).
const APPROVAL_CAPTURE_INLINE_CURSOR = [
  '⏺ Bash(./bin/dl "https://www.youtube.com/watch?v=abc" ~/Downloads/Music 2>&1)',
  '  ⎿  Waiting…',
  '',
  '────────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  '   ./bin/dl "https://www.youtube.com/watch?v=abc" ~/Downloads/Music 2>&1',
  '   Download YouTube track to Downloads/Music',
  '',
  ' This command requires approval',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don’t ask again for: ./bin/dl *',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

// Production TUI rendering observed on shumorobot 2026-05-18 (Music
// topic wedged 7+ min): a Write tool's approval prompt. The verb is
// "create", NOT one of proceed/do this/continue — the pre-fix
// APPROVAL_PROMPT_RE verb whitelist missed it, so polygram never
// surfaced the card and the turn hung silently
// (THINKING→TOOL→STALL→TIMEOUT). The verb varies per tool; the
// numbered menu is the stable, security-bearing structure.
const APPROVAL_CAPTURE_CREATE = [
  '⏺ Write(CLAUDE.md)',
  '  ⎿  Waiting…',
  '',
  '────────────────────────────────────────────────────────────',
  ' Create file',
  '',
  '   CLAUDE.md',
  '',
  ' Do you want to create CLAUDE.md?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

// Another verb variant — an Edit tool's approval prompt ("make this
// edit"). Same structural shape; exercises the broadened regex
// against a different verb phrase.
const APPROVAL_CAPTURE_EDIT = [
  '⏺ Edit(lib/config.js)',
  '  ⎿  Waiting…',
  '',
  '────────────────────────────────────────────────────────────',
  ' Edit file',
  '',
  ' Do you want to make this edit?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

const READY_CAPTURE = 'welcome\n? for shortcuts';

function makeFakeRunner({ captureSequence } = {}) {
  const calls = [];
  let idx = 0;
  return {
    _calls: calls,
    spawn: async () => { calls.push({ kind: 'spawn' }); },
    sendControl: async (n, k) => { calls.push({ kind: 'sendControl', name: n, key: k }); },
    pasteText: async (n, t) => {
      calls.push({ kind: 'pasteText', name: n, text: t });
      return { sanitized: t, oneLine: t, stripped: 0 };
    },
    captureWide: async () => {
      const v = captureSequence?.[Math.min(idx, captureSequence.length - 1)] ?? READY_CAPTURE;
      idx++;
      return v;
    },
    capturePane: async () => READY_CAPTURE,
    sessionExists: async () => true,
    killSession: async (n) => { calls.push({ kind: 'killSession', name: n }); },
    listPolygramSessions: async () => [],
    setPaneReadOnly: async () => {},
    sessionName: (b, c, t) => `polygram-${b}-${c}-${t || 'main'}`,
    debugLogPath: (b, c, t) => `/tmp/${b}-${c}-${t || 'main'}.log`,
  };
}

const SILENT = { warn: () => {}, error: () => {}, debug: () => {}, log: () => {}, info: () => {} };

function makeProc(runner) {
  return new TmuxProcess({
    sessionKey: 'chat:100', chatId: '100', threadId: null, label: 'test',
    runner, botName: 'shumabit', logger: SILENT,
    pollMs: 1, quiesceMs: 5, readyTimeoutMs: 500, turnTimeoutMs: 500,
    pasteConfirmMs: 10,
  });
}

describe('TmuxProcess approval — detection', () => {
  test('SECURITY: assistant message containing "Do you want to proceed?" alone does NOT fire approval-required', async () => {
    // Without the menu structure (numbered options), this is just
    // text claude generated — must not trigger a fake approval card.
    const fakeAssistantText = [
      '⏺ Read(/etc/passwd)',  // a prior tool use lingering in scrollback
      '',
      '...',
      '',
      'Do you want to proceed? Let me know if you have any other questions.',
      '? for shortcuts',
    ].join('\n');
    const runner = makeFakeRunner({
      captureSequence: [READY_CAPTURE, fakeAssistantText, READY_CAPTURE],
    });
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    let fired = false;
    p.on('approval-required', () => { fired = true; });
    const turnPromise = p._awaitTurnComplete({ timeoutMs: 200 }).catch(() => null);
    await turnPromise;
    assert.equal(fired, false, 'approval-required must NOT fire for assistant-rendered question');
  });

  test('emits approval-required when capture-pane shows the prompt', async () => {
    const runner = makeFakeRunner({
      captureSequence: [READY_CAPTURE, APPROVAL_CAPTURE],
    });
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    const fired = new Promise((resolve) => p.once('approval-required', resolve));
    // Drive the poll loop directly. _awaitTurnComplete catches the
    // approval pattern and surfaces the event before deciding on
    // ready/streaming state.
    const turnPromise = p._awaitTurnComplete({ timeoutMs: 1000 }).catch(() => null);
    const ev = await Promise.race([
      fired,
      new Promise((_, rej) => setTimeout(() => rej(new Error('not emitted')), 500)),
    ]);
    assert.equal(ev.toolName, 'Bash');
    assert.match(ev.toolInput, /rm \/tmp\/foo\.txt/);
    assert.equal(ev.backend, 'tmux');
    assert.equal(typeof ev.respond, 'function');
    // Settle the lingering turn poll. Respond to release it.
    await ev.respond('allow');
    await turnPromise;
  });

  test('emits approval-required for production TUI rendering with inline ❯ cursor', async () => {
    // REGRESSION: rc.1-rc.4 regex required `\s*1\.` directly after a
    // newline, but the real TUI renders the selection cursor inline:
    //   " ❯ 1. Yes"
    // The ❯ breaks the [\s\S]{0,400}?(?:^|\n)\s*1\.\s+ chain — once
    // [\s\S] consumes past the `\n`, only one [^\S\n]* space matches
    // before `1.`, but the next char is `❯`, not `1`. Symptom: every
    // approval-gated tool call in shumorobot hung in the TUI for
    // 8m+ until orphan-sweep killed the session, NEVER surfacing
    // to Telegram. Discovered via shumorobot--1003807211164-3 stuck
    // on ./bin/dl after rc.4 deploy.
    const runner = makeFakeRunner({
      captureSequence: [READY_CAPTURE, APPROVAL_CAPTURE_INLINE_CURSOR],
    });
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    const fired = new Promise((resolve) => p.once('approval-required', resolve));
    const turnPromise = p._awaitTurnComplete({ timeoutMs: 1000 }).catch(() => null);
    const ev = await Promise.race([
      fired,
      new Promise((_, rej) => setTimeout(() => rej(new Error('approval-required not emitted — inline ❯ cursor broke detection')), 500)),
    ]);
    assert.equal(ev.toolName, 'Bash');
    assert.match(ev.toolInput, /bin\/dl/);
    assert.equal(ev.backend, 'tmux');
    await ev.respond('allow');
    await turnPromise;
  });

  test('emits approval-required for a Write prompt — verb "create" (2026-05-18 incident)', async () => {
    // REGRESSION: APPROVAL_PROMPT_RE matched only the verbs
    // proceed|do this|continue. The real TUI varies the verb per tool
    // — Write → "Do you want to create CLAUDE.md?". The whitelist
    // missed it, so polygram never fired approval-required: the Music
    // topic hung 7+ min (reactor THINKING→TOOL→STALL→TIMEOUT) with no
    // way for the user to approve. The fix matches the STRUCTURE — a
    // "Do you want to …?" question + the numbered menu — not a verb.
    const runner = makeFakeRunner({
      captureSequence: [READY_CAPTURE, APPROVAL_CAPTURE_CREATE],
    });
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    const fired = new Promise((resolve) => p.once('approval-required', resolve));
    const turnPromise = p._awaitTurnComplete({ timeoutMs: 1000 }).catch(() => null);
    const ev = await Promise.race([
      fired,
      new Promise((_, rej) => setTimeout(
        () => rej(new Error('approval-required not emitted — the "create" verb was not matched')), 500)),
    ]);
    assert.equal(ev.toolName, 'Write');
    assert.match(ev.toolInput, /CLAUDE\.md/);
    assert.equal(ev.backend, 'tmux');
    await ev.respond('allow');
    await turnPromise;
  });

  test('emits approval-required for an Edit prompt — verb "make this edit"', async () => {
    const runner = makeFakeRunner({
      captureSequence: [READY_CAPTURE, APPROVAL_CAPTURE_EDIT],
    });
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    const fired = new Promise((resolve) => p.once('approval-required', resolve));
    const turnPromise = p._awaitTurnComplete({ timeoutMs: 1000 }).catch(() => null);
    const ev = await Promise.race([
      fired,
      new Promise((_, rej) => setTimeout(
        () => rej(new Error('approval-required not emitted — the "make this edit" verb was not matched')), 500)),
    ]);
    assert.equal(ev.toolName, 'Edit');
    assert.match(ev.toolInput, /config\.js/);
    assert.equal(ev.backend, 'tmux');
    await ev.respond('allow');
    await turnPromise;
  });

  test('duplicate approval captures do not re-fire the event (dedup)', async () => {
    const runner = makeFakeRunner({
      captureSequence: [
        READY_CAPTURE,
        APPROVAL_CAPTURE,
        APPROVAL_CAPTURE,
        APPROVAL_CAPTURE,
        READY_CAPTURE,
      ],
    });
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    const fires = [];
    p.on('approval-required', (ev) => fires.push(ev));
    const turnPromise = p._awaitTurnComplete({ timeoutMs: 1000 }).catch(() => null);
    // Give the loop time to see the prompt + dedup repeats.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fires.length, 1, `expected 1 emit, got ${fires.length}`);
    await fires[0].respond('allow');
    await turnPromise;
  });
});

describe('TmuxProcess approval — respond', () => {
  test('respond("allow") pastes "1" + Enter', async () => {
    const runner = makeFakeRunner();
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    p._pendingApprovalId = 'approval-123';
    const ok = await p.respondToApproval('approval-123', 'allow');
    assert.equal(ok, true);
    const paste = runner._calls.find((c) => c.kind === 'pasteText');
    assert.equal(paste.text, '1');
    const enter = runner._calls.find((c) => c.kind === 'sendControl' && c.key === 'Enter');
    assert.ok(enter);
    assert.equal(p._pendingApprovalId, null);
  });

  test('respond("always-allow") pastes "2" + Enter', async () => {
    const runner = makeFakeRunner();
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    p._pendingApprovalId = 'approval-123';
    await p.respondToApproval('approval-123', 'always-allow');
    const paste = runner._calls.find((c) => c.kind === 'pasteText');
    assert.equal(paste.text, '2');
  });

  test('respond("deny") pastes "3" + Enter', async () => {
    const runner = makeFakeRunner();
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    p._pendingApprovalId = 'approval-123';
    await p.respondToApproval('approval-123', 'deny');
    const paste = runner._calls.find((c) => c.kind === 'pasteText');
    assert.equal(paste.text, '3');
  });

  test('respond("deny", message) pastes "3" + Enter, then message + Enter (separated)', async () => {
    // SECURITY: choice + feedback split into two pastes so a feedback
    // string starting with a digit can't be re-parsed as a menu choice.
    const runner = makeFakeRunner();
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    p._pendingApprovalId = 'approval-123';
    await p.respondToApproval('approval-123', 'deny', 'use Glob instead');
    const pastes = runner._calls.filter((c) => c.kind === 'pasteText').map((c) => c.text);
    assert.deepEqual(pastes, ['3', 'use Glob instead']);
    const enters = runner._calls.filter((c) => c.kind === 'sendControl' && c.key === 'Enter');
    assert.equal(enters.length, 2, 'two Enters: one after choice, one after feedback');
  });

  test('respond with mismatched id is a no-op (stale prompt)', async () => {
    const runner = makeFakeRunner();
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    p._pendingApprovalId = 'approval-NEW';
    const ok = await p.respondToApproval('approval-STALE', 'allow');
    assert.equal(ok, false);
    assert.equal(runner._calls.length, 0);  // no paste, no enter
    assert.equal(p._pendingApprovalId, 'approval-NEW');
  });

  test('paste failure surfaces as approval-fail event, returns false', async () => {
    const runner = makeFakeRunner();
    runner.pasteText = async () => { throw new Error('paste boom'); };
    const p = makeProc(runner);
    p.tmuxName = 'polygram-test';
    p._pendingApprovalId = 'approval-123';
    const fired = new Promise((resolve) => p.once('approval-fail', resolve));
    const ok = await p.respondToApproval('approval-123', 'allow');
    assert.equal(ok, false);
    const ev = await fired;
    assert.match(ev.err, /paste boom/);
  });
});
