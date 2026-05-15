'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTmuxRunner, sessionName, debugLogPath, sanitize, MULTILINE_SEPARATOR,
} = require('../lib/tmux/tmux-runner');

// ── Mock runFn ──────────────────────────────────────────────────────

function makeMockRun() {
  const calls = [];
  const stubs = new Map(); // cmd+args key → response
  const mock = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = `${cmd} ${args.join(' ')}`;
    const stub = stubs.get(key) || stubs.get(`${cmd} ${args[0]}`);
    if (stub) {
      if (stub.error) throw Object.assign(new Error(stub.error), { stderr: stub.stderr });
      return { stdout: stub.stdout || '', stderr: stub.stderr || '' };
    }
    return { stdout: '', stderr: '' };
  };
  mock.calls = calls;
  mock.stub = (key, response) => stubs.set(key, response);
  return mock;
}

// ── sanitize ────────────────────────────────────────────────────────

describe('sanitize', () => {
  test('strips C0 control chars (0x00-0x08, 0x0b-0x1f)', () => {
    const dangerous = 'a\x00b\x03c\x04d\x1be';
    assert.equal(sanitize(dangerous), 'abcde');
  });
  test('strips DEL (0x7f)', () => {
    assert.equal(sanitize('hello\x7fworld'), 'helloworld');
  });
  test('allows \\t (0x09) and \\n (0x0a)', () => {
    assert.equal(sanitize('a\tb\nc'), 'a\tb\nc');
  });
  test('strips multi-byte sequences anywhere in string', () => {
    const input = 'safe text\x03 trying to interrupt';
    assert.equal(sanitize(input), 'safe text trying to interrupt');
  });
  test('handles non-string input', () => {
    assert.equal(sanitize(42), '42');
    assert.equal(sanitize(null), 'null');
  });
});

// ── sessionName ──────────────────────────────────────────────────────

describe('sessionName', () => {
  test('bot-prefixed; chat + thread tail', () => {
    assert.equal(sessionName('shumabit', 100, 3), 'polygram-shumabit-100-3');
  });
  test('null threadId → -main', () => {
    assert.equal(sessionName('shumabit', 100, null), 'polygram-shumabit-100-main');
    assert.equal(sessionName('shumabit', 100), 'polygram-shumabit-100-main');
  });
  test('hyphens preserved (valid in tmux session names); dots/slashes replaced with _', () => {
    // Negative chat IDs are common in Telegram (supergroups) — keep the dash.
    assert.equal(sessionName('shumabit', -1002400136088, null),
      'polygram-shumabit--1002400136088-main');
    // Path traversal attempts in topic ID — dots become _.
    assert.equal(sessionName('shumabit', '100', '..'),
      'polygram-shumabit-100-__');
    // Slashes become _.
    assert.equal(sessionName('shumabit', '100', 'a/b'),
      'polygram-shumabit-100-a_b');
  });
  test('produces valid tmux session name (no slashes)', () => {
    const name = sessionName('shumabit', 100, '../etc/passwd');
    assert.ok(!name.includes('/'));
    assert.ok(!name.includes('.'));
  });
});

// ── debugLogPath ────────────────────────────────────────────────────

describe('debugLogPath', () => {
  test('uses ~/.polygram/<bot>/logs by default', () => {
    const p = debugLogPath('shumabit', 100, 3);
    assert.match(p, /\/\.polygram\/shumabit\/logs\/tmux-claude-100-3\.log$/);
  });
  test('respects custom logsDir', () => {
    const p = debugLogPath('shumabit', 100, null, '/var/log/poly');
    assert.equal(p, '/var/log/poly/tmux-claude-100-main.log');
  });
  test('sanitizes path components', () => {
    const p = debugLogPath('shumabit', 100, '../etc/passwd', '/tmp');
    assert.ok(!p.includes('/etc/passwd'));
    assert.match(p, /tmux-claude-100-_+/);
  });
  test('SECURITY: refuses /tmp fallback when HOME is unset', () => {
    const prev = process.env.HOME;
    delete process.env.HOME;
    try {
      assert.throws(
        () => debugLogPath('shumabit', 100, null),
        (err) => err.code === 'HOME_UNSET',
      );
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
    }
  });
  test('SECURITY: custom logsDir bypasses the HOME check (explicit caller intent)', () => {
    const prev = process.env.HOME;
    delete process.env.HOME;
    try {
      const p = debugLogPath('shumabit', 100, null, '/var/log/poly');
      assert.equal(p, '/var/log/poly/tmux-claude-100-main.log');
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
    }
  });
});

// ── spawn ────────────────────────────────────────────────────────────

describe('runner.spawn', () => {
  test('issues correct tmux new-session command', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.spawn({
      name: 'polygram-test-100-main',
      cwd: '/home/user',
      command: 'claude',
      args: ['--model', 'sonnet'],
    });
    const spawnCall = mockRun.calls.find((c) => c.args[0] === 'new-session');
    assert.ok(spawnCall);
    assert.deepEqual(spawnCall.args, [
      'new-session', '-d', '-s', 'polygram-test-100-main',
      '-c', '/home/user',
      'claude', '--model', 'sonnet',
    ]);
  });

  test('attaches env extras via -e flags', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.spawn({
      name: 'sess', cwd: '.', command: 'claude',
      envExtras: { TERM: 'xterm-256color', HOME: '/root' },
    });
    const spawnCall = mockRun.calls.find((c) => c.args[0] === 'new-session');
    assert.ok(spawnCall.args.includes('TERM=xterm-256color'));
    assert.ok(spawnCall.args.includes('HOME=/root'));
  });

  test('widens pane via resize-window after spawn (was buggy set-option pane-width)', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.spawn({
      name: 'sess', cwd: '.', command: 'claude', paneWidth: 250,
    });
    const resize = mockRun.calls.find((c) => c.args[0] === 'resize-window');
    assert.ok(resize, 'should issue resize-window');
    assert.ok(resize.args.includes('-x'));
    assert.ok(resize.args.includes('250'));
    // The pre-incident set-option pane-width call MUST NOT happen
    // (it's a tmux format variable, not a settable option, and always
    // errored "invalid option: pane-width" on tmux 3.x).
    assert.ok(!mockRun.calls.some((c) => c.args[0] === 'set-option' && c.args.includes('pane-width')),
      'set-option pane-width is a bug — must not appear');
  });

  test('throws structured error on spawn failure', async () => {
    const mockRun = makeMockRun();
    mockRun.stub('tmux new-session', { error: 'duplicate session: foo' });
    const runner = createTmuxRunner({ runFn: mockRun, logger: { warn: () => {} } });
    try {
      await runner.spawn({ name: 'sess', cwd: '.', command: 'claude' });
      assert.fail('should throw');
    } catch (err) {
      assert.equal(err.code, 'TMUX_SPAWN_FAILED');
      assert.equal(err.name, 'sess');
      assert.match(err.message, /duplicate session/);
    }
  });
});

// ── sendControl ──────────────────────────────────────────────────────

describe('runner.sendControl', () => {
  test('sends Enter without -l flag (key name interpretation)', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.sendControl('sess', 'Enter');
    const call = mockRun.calls.find((c) => c.args[0] === 'send-keys');
    assert.deepEqual(call.args, ['send-keys', '-t', 'sess', 'Enter']);
    assert.ok(!call.args.includes('-l'));
  });

  test('sends C-c for interrupt', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.sendControl('sess', 'C-c');
    const call = mockRun.calls[0];
    assert.equal(call.args[3], 'C-c');
  });
});

// ── pasteText ───────────────────────────────────────────────────────

describe('runner.pasteText', () => {
  test('multiline → MULTILINE_SEPARATOR encoded before paste', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    const result = await runner.pasteText('sess', 'line1\nline2\nline3');
    assert.equal(result.oneLine, `line1${MULTILINE_SEPARATOR}line2${MULTILINE_SEPARATOR}line3`);
    const setBufCall = mockRun.calls.find((c) => c.args[0] === 'set-buffer');
    // Last arg is the buffer content
    assert.ok(setBufCall.args[setBufCall.args.length - 1].includes(MULTILINE_SEPARATOR));
    assert.ok(!setBufCall.args[setBufCall.args.length - 1].includes('\n'));
  });

  test('control chars sanitized BEFORE multiline encoding', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    const result = await runner.pasteText('sess', 'safe\x03text');
    assert.equal(result.stripped, 1);
    assert.equal(result.sanitized, 'safetext');
    const setBufCall = mockRun.calls.find((c) => c.args[0] === 'set-buffer');
    assert.equal(setBufCall.args[setBufCall.args.length - 1], 'safetext');
  });

  test('uses set-buffer + paste-buffer pattern (not send-keys -l)', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.pasteText('sess', 'hello');
    const sendKeys = mockRun.calls.find((c) => c.args[0] === 'send-keys');
    assert.equal(sendKeys, undefined, 'pasteText must not use send-keys');
    assert.ok(mockRun.calls.find((c) => c.args[0] === 'set-buffer'));
    assert.ok(mockRun.calls.find((c) => c.args[0] === 'paste-buffer'));
  });

  test('paste-buffer uses -d flag (auto-delete buffer)', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.pasteText('sess', 'hello');
    const pasteCall = mockRun.calls.find((c) => c.args[0] === 'paste-buffer');
    assert.ok(pasteCall.args.includes('-d'));
  });

  test('emoji + CJK + RTL pass through unchanged', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    const text = '👋 你好 שלום';
    const result = await runner.pasteText('sess', text);
    assert.equal(result.stripped, 0);
    assert.equal(result.oneLine, text);
  });
});

describe('runner.pasteAndEnter — rc.13.1 paste+Enter atomic lock', () => {
  // rc.13.1 root cause: pre-fix, two parallel pasteText + sendControl
  // pairs would interleave their tmux command streams. Real-world
  // symptom on shumorobot 2026-05-15: msg 696's prompt was truncated
  // at `chat_id="-1003` because msg 698's autosteer pasteText cut
  // in mid-flight, concatenating two distinct polygram prompts into
  // ONE TUI user message → agent mis-attributed the reply (msg 697
  // got msg 698's answer; msg 696 was served last).
  //
  // The fix: pasteAndEnter holds a per-session async lock around
  // the paste + Enter pair so the keystrokes are atomic from the
  // TUI's bracketed-paste-mode perspective.

  test('two concurrent pasteAndEnter calls serialise per session — no interleave', async () => {
    // We track the order of (paste-buffer, send-keys Enter) commands.
    // The atomic guarantee is: paste-buffer for call N MUST be
    // followed by its Enter BEFORE any commands from call N+1 begin.
    const orderedOps = [];
    let activeCallTag = null;
    const slowRun = (cmd, args) => {
      const op = args[0];
      // Tag the active call by inspecting the buffer name set
      // earliest in the call's chain.
      if (op === 'set-buffer') {
        // Buffer name is the 3rd arg (after -b)
        activeCallTag = args[2];
      }
      orderedOps.push({ tag: activeCallTag, op });
      // Simulate tmux latency so concurrent calls have time to race
      return new Promise((r) => setTimeout(() => r({ stdout: '', stderr: '' }), 10));
    };
    const runner = createTmuxRunner({ runFn: slowRun });
    // Two concurrent pasteAndEnter calls on the SAME session.
    await Promise.all([
      runner.pasteAndEnter('sess-A', 'prompt-1'),
      runner.pasteAndEnter('sess-A', 'prompt-2'),
    ]);

    // Group ops by their tag (each pasteAndEnter has its own buffer
    // name). Within each group, the ops should be contiguous in
    // orderedOps — meaning no other call's ops landed in between.
    const groups = {};
    for (let i = 0; i < orderedOps.length; i++) {
      const t = orderedOps[i].tag;
      if (!groups[t]) groups[t] = { firstIdx: i, lastIdx: i };
      else groups[t].lastIdx = i;
    }
    for (const tag of Object.keys(groups)) {
      const { firstIdx, lastIdx } = groups[tag];
      const span = lastIdx - firstIdx + 1;
      // For each pasteAndEnter we expect 3 tmux commands:
      // set-buffer, paste-buffer (with -d), send-keys (Enter).
      // (delete-buffer error path doesn't run on success.)
      assert.equal(span, 3,
        `commands for buffer ${tag} must be contiguous (3 ops in a row); got span=${span}, ops=${JSON.stringify(orderedOps)}`);
      // Verify the order within the group: set-buffer → paste-buffer → send-keys
      assert.equal(orderedOps[firstIdx].op, 'set-buffer');
      assert.equal(orderedOps[firstIdx + 1].op, 'paste-buffer');
      assert.equal(orderedOps[firstIdx + 2].op, 'send-keys');
    }
  });

  test('different sessions do NOT block each other (per-session lock keying)', async () => {
    let pasteABusy = false;
    let bothInFlight = false;
    const concurrentRun = (cmd, args) => {
      const op = args[0];
      // Detect overlapping paste-buffer calls across sessions
      if (op === 'paste-buffer') {
        const target = args[args.indexOf('-t') + 1];
        if (target === 'sess-A') pasteABusy = true;
      }
      return new Promise((r) => setTimeout(() => {
        if (op === 'paste-buffer' && args[args.indexOf('-t') + 1] === 'sess-B' && pasteABusy) {
          bothInFlight = true;
        }
        r({ stdout: '', stderr: '' });
      }, 20));
    };
    const runner = createTmuxRunner({ runFn: concurrentRun });
    await Promise.all([
      runner.pasteAndEnter('sess-A', 'A'),
      runner.pasteAndEnter('sess-B', 'B'),
    ]);
    assert.equal(bothInFlight, true,
      'paste-buffer for two different sessions should be allowed to overlap (the lock is per-session, not global)');
  });

  test('pasteAndEnter returns the pasteText result shape', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    const result = await runner.pasteAndEnter('sess', 'hello');
    assert.equal(typeof result.sanitized, 'string');
    assert.equal(typeof result.oneLine, 'string');
    assert.equal(typeof result.stripped, 'number');
    // And the Enter actually fired.
    const enter = mockRun.calls.find((c) => c.args[0] === 'send-keys' && c.args.includes('Enter'));
    assert.ok(enter, 'send-keys Enter must fire as part of pasteAndEnter');
  });
});

// ── capturePane / captureWide ───────────────────────────────────────

describe('runner.capturePane', () => {
  test('default args include -J (join wrapped) and -S -1000', async () => {
    const mockRun = makeMockRun();
    mockRun.stub('tmux capture-pane', { stdout: 'pane content' });
    const runner = createTmuxRunner({ runFn: mockRun });
    const out = await runner.capturePane('sess');
    assert.equal(out, 'pane content');
    const call = mockRun.calls[0];
    assert.ok(call.args.includes('-J'));
    assert.ok(call.args.includes('-1000'));
  });

  test('respects custom lines + joinWrapped:false', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.capturePane('sess', { lines: 500, joinWrapped: false });
    const call = mockRun.calls[0];
    assert.ok(!call.args.includes('-J'));
    assert.ok(call.args.includes('-500'));
  });

  test('captureWide is an alias with joinWrapped:true', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    await runner.captureWide('sess', { lines: 300 });
    const call = mockRun.calls[0];
    assert.ok(call.args.includes('-J'));
    assert.ok(call.args.includes('-300'));
  });
});

// ── sessionExists / killSession / listPolygramSessions ──────────────

describe('runner.sessionExists', () => {
  test('returns true when has-session succeeds', async () => {
    const mockRun = makeMockRun();
    const runner = createTmuxRunner({ runFn: mockRun });
    assert.equal(await runner.sessionExists('alive'), true);
  });
  test('returns false when has-session fails', async () => {
    const mockRun = makeMockRun();
    mockRun.stub('tmux has-session', { error: "can't find session" });
    const runner = createTmuxRunner({ runFn: mockRun });
    assert.equal(await runner.sessionExists('gone'), false);
  });
});

describe('runner.killSession', () => {
  test('swallows kill errors (already-dead session)', async () => {
    const mockRun = makeMockRun();
    mockRun.stub('tmux kill-session', { error: 'no such session' });
    const runner = createTmuxRunner({ runFn: mockRun });
    // Should NOT throw
    await runner.killSession('gone');
  });
});

describe('runner.listPolygramSessions', () => {
  test('filters to polygram-* sessions', async () => {
    const mockRun = makeMockRun();
    mockRun.stub('tmux list-sessions', {
      stdout: 'polygram-shumabit-100-main\npolygram-umi-200-main\nmysess\nother',
    });
    const runner = createTmuxRunner({ runFn: mockRun });
    const sessions = await runner.listPolygramSessions();
    assert.deepEqual(sessions, ['polygram-shumabit-100-main', 'polygram-umi-200-main']);
  });

  test('bot prefix narrows the filter', async () => {
    const mockRun = makeMockRun();
    mockRun.stub('tmux list-sessions', {
      stdout: 'polygram-shumabit-100-main\npolygram-umi-200-main\npolygram-shumabit-300-t5',
    });
    const runner = createTmuxRunner({ runFn: mockRun });
    const sessions = await runner.listPolygramSessions('shumabit');
    assert.deepEqual(sessions.sort(), [
      'polygram-shumabit-100-main', 'polygram-shumabit-300-t5',
    ].sort());
  });

  test('returns empty array when tmux not running', async () => {
    const mockRun = makeMockRun();
    mockRun.stub('tmux list-sessions', { error: 'no server running' });
    const runner = createTmuxRunner({ runFn: mockRun });
    assert.deepEqual(await runner.listPolygramSessions(), []);
  });
});
