/**
 * Process contract suite — runs the SAME 20 scenarios (C1–C20) against
 * SdkProcess AND TmuxProcess. The Process abstraction is only useful
 * if callers can swap backends without behavior change; this suite is
 * the proof.
 *
 * If a scenario breaks on either backend, the abstraction is broken.
 * Failures here MUST block merging.
 *
 * Phase 2.6 Tier 1 (mocked). Tier 2 (real-claude smoke) lives at
 * scripts/contract-smoke.js, gated on CONTRACT_REAL=1.
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §7.2.6
 */

'use strict';

// TmuxProcess.start() verifies the pinned claude binary exists
// (lib/claude-bin.js); the real binary isn't present in CI. Point
// the override at the node executable — always present. The fake
// runner never actually execs it.
if (!process.env.POLYGRAM_CLAUDE_BIN) {
  process.env.POLYGRAM_CLAUDE_BIN = process.execPath;
}

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { makeBackend } = require('./_helpers/backend-driver');

const BACKENDS = ['sdk', 'tmux'];

const CHAT_CONFIG = { model: 'sonnet', effort: 'high', cwd: '/tmp' };

async function setupReady(kind) {
  const { process: proc, driver } = makeBackend(kind);
  await driver.start();
  await proc.start({ chatConfig: CHAT_CONFIG });
  return { proc, driver };
}

// Helper: assert text contains the reply (tmux capture-pane diff has
// trailing artifacts; SDK text is clean). Both backends must surface
// the reply substring.
function assertTextContains(actual, expected, kind) {
  assert.ok(
    typeof actual === 'string' && actual.includes(expected),
    `[${kind}] expected text to include "${expected}" but got ${JSON.stringify(actual)}`,
  );
}

// ─── Run each scenario against every backend ───────────────────────

for (const kind of BACKENDS) {
  describe(`Process contract — backend=${kind}`, () => {

    // ── Lifecycle (C1–C5) ────────────────────────────────────────────

    test('C1 start() resolves and emits init exactly once', async () => {
      const { process: proc, driver } = makeBackend(kind);
      await driver.start();
      let inits = 0;
      proc.on('init', () => inits++);
      await proc.start({ chatConfig: CHAT_CONFIG });
      // Allow init to propagate (sdk emits via iteration loop tick).
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(inits, 1, `${kind}: expected 1 init, got ${inits}`);
      await proc.kill('test');
    });

    test('C2 send() returns PmSendResult with non-empty text, error===null, numeric duration', async () => {
      const { proc, driver } = await setupReady(kind);
      driver.replyTo('hello?', 'world!');
      const res = await proc.send('hello?');
      assert.equal(res.error, null);
      assertTextContains(res.text, 'world!', kind);
      assert.equal(typeof res.duration, 'number');
      assert.ok(res.duration >= 0);
      assert.equal(res.metrics.resultSubtype, 'success');
      await proc.kill('test');
    });

    test('C3 send() on closed Process rejects (polygram dispatch wraps in try/catch)', async () => {
      const { proc, driver } = await setupReady(kind);
      await proc.kill('preclose');
      await assert.rejects(
        () => proc.send('hi'),
        (err) => err && err.message && /process|closed|no process/i.test(err.message),
        `${kind}: send-on-closed should reject`,
      );
    });

    test('C4 kill() is idempotent — second call is no-op', async () => {
      const { proc, driver } = await setupReady(kind);
      let closeCount = 0;
      proc.on('close', () => closeCount++);
      await proc.kill('first');
      await proc.kill('second');
      // Both backends fire at most 1 close per session.
      assert.equal(closeCount, 1, `${kind}: close fired ${closeCount}× expected 1`);
    });

    test('C5 kill() rejects queued pendings with code KILLED', async () => {
      const { proc, driver } = await setupReady(kind);
      // Push a fake pending so we can verify reject.
      let rejected = null;
      proc.pendingQueue.push({
        reject: (e) => { rejected = e; },
        clearTimers: () => {},
      });
      await proc.kill('drain-test');
      assert.ok(rejected, `${kind}: pending was not rejected on kill`);
      assert.equal(rejected.code, 'KILLED');
    });

    // ── Hot-path no-throw (C6–C12) ──────────────────────────────────

    test('C6 drainQueue returns count and never throws', async () => {
      // NOTE: event-emission on drain differs across backends.
      // SDK emits 'queue-drop' ONLY on cap-overflow (not on intentional
      // drain — different semantic: drop=overflow, drain=reject).
      // Tmux emits on drain too. Both behaviors are backend-correct;
      // contract narrows to count + no-throw.
      const { proc, driver } = await setupReady(kind);
      proc.pendingQueue.push(
        { reject: () => {}, clearTimers: () => {} },
        { reject: () => {}, clearTimers: () => {} },
      );
      const n = proc.drainQueue('TEST');
      assert.equal(n, 2);
      assert.equal(proc.pendingQueue.length, 0);
      await proc.kill('cleanup');
    });

    test('C7 drainQueue with throwing reject does NOT bubble', async () => {
      const { proc, driver } = await setupReady(kind);
      proc.pendingQueue.push({
        reject: () => { throw new Error('reject boom'); },
        clearTimers: () => {},
      });
      // No throw expected:
      const n = proc.drainQueue();
      assert.equal(n, 1);
      await proc.kill('cleanup');
    });

    test('C8 injectUserMessage returns false when content is empty/whitespace-only', async () => {
      // NOTE: !inFlight semantic differs — tmux requires live turn (TUI fold);
      // SDK accepts anytime (stream-input queues for next user-msg slot).
      // Each backend's own suite asserts its specific false conditions.
      // The cross-backend contract: empty content always returns false.
      const { proc, driver } = await setupReady(kind);
      proc.inFlight = true; // give both backends maximum "yes" capacity
      assert.equal(proc.injectUserMessage({ content: '' }), false);
      assert.equal(proc.injectUserMessage({ content: null }), false);
      proc.inFlight = false;
      await proc.kill('cleanup');
    });

    test('C9 injectUserMessage returns false when content sanitizes to empty (control chars only)', async () => {
      const { proc, driver } = await setupReady(kind);
      proc.inFlight = true;
      // tmux strips C0/DEL via G5b sanitize; SDK's empty-string check
      // doesn't sanitize, so an all-control-char string reaches the
      // inputController as a non-empty (but garbage) message. To make
      // this assertable cross-backend, use the empty string — both
      // backends agree on that.
      // (SDK's behavior with control-char-only strings is governed by
      // its own backend suite, not the cross-backend contract.)
      if (kind === 'tmux') {
        const onlyControl = '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0d\x0e\x0f\x1f\x7f';
        assert.equal(proc.injectUserMessage({ content: onlyControl }), false);
      }
      // Cross-backend agreement:
      assert.equal(proc.injectUserMessage({ content: '' }), false);
      proc.inFlight = false;
      await proc.kill('cleanup');
    });

    test('C10 injectUserMessage with valid content + live turn returns true + emits inject-user-message event', async () => {
      const { proc, driver } = await setupReady(kind);
      proc.inFlight = true;
      const fired = new Promise((resolve) => proc.once('inject-user-message', resolve));
      const ok = proc.injectUserMessage({ content: 'autosteer payload' });
      assert.equal(ok, true);
      const ev = await Promise.race([
        fired,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${kind}: inject-user-message not emitted`)), 200)),
      ]);
      assert.equal(ev.text_len, 'autosteer payload'.length);
      proc.inFlight = false;
      await proc.kill('cleanup');
    });

    test('C11 injectUserMessage transport failure surfaces as event, not throw', async () => {
      const { proc, driver } = await setupReady(kind);
      proc.inFlight = true;
      // Backend-specific: poison the transport so the underlying paste/push
      // fails. SdkProcess's inputController.push throws on closed input;
      // closing the query first works. TmuxProcess: replace pasteText.
      if (kind === 'sdk') {
        proc.inputController.close();
      } else {
        proc.runner.pasteText = async () => { throw new Error('boom'); };
      }
      // Must not throw synchronously:
      let returned = null;
      try { returned = proc.injectUserMessage({ content: 'will fail' }); }
      catch (e) { assert.fail(`${kind}: injectUserMessage threw: ${e.message}`); }
      // We don't require failure to surface as 'inject-fail' in both
      // backends (SDK reports via logger.error; tmux uses event). The
      // contract is: NEVER throw to caller. That's already proven above.
      proc.inFlight = false;
      await proc.kill('cleanup');
    });

    test('C12 steer is hot-path-safe (never throws)', async () => {
      const { proc, driver } = await setupReady(kind);
      proc.inFlight = true;
      // Should never throw, regardless of internal state.
      let ok;
      try { ok = proc.steer('steer text', { shouldQuery: false }); }
      catch (e) { assert.fail(`${kind}: steer threw: ${e.message}`); }
      assert.equal(typeof ok, 'boolean', `${kind}: steer must return boolean`);
      proc.inFlight = false;
      await proc.kill('cleanup');
    });

    // ── API parity (C13–C20) ─────────────────────────────────────────

    test('C13 resetSession returns shape {closed:boolean, drainedPendings:number}', async () => {
      // NOTE: `closed` differs across backends.
      // SDK: closes the Query (closed=true) so a fresh one spawns on next send.
      // Tmux: sends /new to the TUI (closed=false; same pty kept alive).
      // Both are correct for their backend. Contract is shape-only;
      // backend-specific semantics live in their own suites.
      const { proc, driver } = await setupReady(kind);
      proc.pendingQueue.push(
        { reject: () => {}, clearTimers: () => {} },
        { reject: () => {}, clearTimers: () => {} },
      );
      const res = await proc.resetSession({ reason: 'test' });
      assert.equal(typeof res.closed, 'boolean');
      assert.equal(typeof res.drainedPendings, 'number');
      assert.equal(res.drainedPendings, 2);
      await proc.kill('cleanup');
    });

    test('C14 interrupt() resolves without throw on idle process', async () => {
      const { proc, driver } = await setupReady(kind);
      // Both backends accept interrupt as best-effort even when idle.
      await proc.interrupt();
      await proc.kill('cleanup');
    });

    test('C15 setModel + applyFlagSettings resolve without throw', async () => {
      const { proc, driver } = await setupReady(kind);
      await proc.setModel('haiku');
      await proc.applyFlagSettings({ effortLevel: 'low' });
      await proc.kill('cleanup');
    });

    test('C16 setPermissionMode resolves without throw', async () => {
      const { proc, driver } = await setupReady(kind);
      await proc.setPermissionMode('default');
      await proc.kill('cleanup');
    });

    test('C17 getContextUsage returns SDK-shaped usage OR throws UnsupportedOperationError', async () => {
      const { proc, driver } = await setupReady(kind);
      // Seed a usage snapshot on each backend so getContextUsage has
      // data to return. Without this, both backends correctly throw
      // UnsupportedOperationError (which is also a valid contract
      // outcome — caller falls through).
      if (kind === 'sdk') {
        // SDK's fakeQuery exposes a _contextUsage override slot.
        proc.query._contextUsage = {
          percentage: 50,
          totalTokens: 100_000,
          maxTokens: 200_000,
          model: 'claude-haiku-4-5-20251001',
          isAutoCompactEnabled: true,
          autoCompactThreshold: 85,
        };
      } else {
        proc._lastUsage = {
          type: 'usage',
          inputTokens: 10,
          outputTokens: 100,
          cacheReadTokens: 99_890,
          cacheCreationTokens: 0,
          model: 'claude-haiku-4-5-20251001',
        };
      }
      const usage = await proc.getContextUsage();
      assert.ok(usage && typeof usage === 'object', `${kind}: non-object usage`);
      assert.equal(typeof usage.percentage, 'number');
      assert.equal(typeof usage.totalTokens, 'number');
      assert.equal(typeof usage.maxTokens, 'number');
      assert.ok(usage.percentage >= 0 && usage.percentage <= 100,
        `${kind}: percentage out of range: ${usage.percentage}`);
      assert.ok(usage.maxTokens >= 100_000,
        `${kind}: maxTokens too small: ${usage.maxTokens}`);
      await proc.kill('cleanup');
    });

    test('C18 cost is positive integer (sdk≥1, tmux≥3)', () => {
      const { process: proc } = makeBackend(kind);
      assert.equal(typeof proc.cost, 'number');
      assert.ok(Number.isInteger(proc.cost));
      if (kind === 'sdk') assert.ok(proc.cost >= 1, `sdk cost ${proc.cost} < 1`);
      if (kind === 'tmux') assert.ok(proc.cost >= 3, `tmux cost ${proc.cost} < 3`);
    });

    test('C19 backend identifier is concrete, never "abstract"', () => {
      const { process: proc } = makeBackend(kind);
      assert.notEqual(proc.backend, 'abstract');
      assert.equal(proc.backend, kind);
    });

    // ── Event-emission parity (C21–C23) ──────────────────────────────

    test('C21 send() with control chars in prompt fires prompt-sanitized event + strips them', async () => {
      const { proc, driver } = await setupReady(kind);
      driver.replyTo('clean prompt', 'ok');
      // Register the listener BEFORE calling send() — SDK emits the
      // event synchronously within the send() function before the
      // returned promise even resolves.
      const sanitizedEvents = [];
      proc.on('prompt-sanitized', (ev) => sanitizedEvents.push(ev));
      // Send a prompt with C0 + DEL bytes mixed in. The clean form
      // is what the underlying transport (SDK inputController / tmux
      // pasteText) actually receives.
      const dirty = 'clean\x03 pro\x7fmpt';
      const sendP = proc.send(dirty);
      // Give the async transport (tmux pasteText) a moment to fire the
      // event. SDK has already fired synchronously by now.
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(sanitizedEvents.length >= 1, `${kind}: expected ≥1 prompt-sanitized event, got 0`);
      const ev = sanitizedEvents[0];
      assert.equal(typeof ev.stripped, 'number');
      assert.ok(ev.stripped >= 2, `${kind}: expected ≥2 chars stripped, got ${ev.stripped}`);
      // Let the in-flight send settle before kill (don't leak handles).
      sendP.catch(() => {});
      await proc.kill('cleanup');
    });

    test('C22 interrupt() emits interrupt-applied event', async () => {
      const { proc, driver } = await setupReady(kind);
      const fired = new Promise((resolve) => proc.once('interrupt-applied', resolve));
      await proc.interrupt();
      const ev = await Promise.race([
        fired,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${kind}: interrupt-applied not emitted`)), 200)),
      ]);
      assert.equal(typeof ev, 'object');
      await proc.kill('cleanup');
    });

    test('C23 injectUserMessage transport failure emits inject-fail event', async () => {
      const { proc, driver } = await setupReady(kind);
      proc.inFlight = true;
      // Poison the underlying transport so the inject path's send fails.
      if (kind === 'sdk') {
        proc.inputController.close();  // pushes throw on closed input
      } else {
        proc.runner.pasteText = async () => { throw new Error('paste boom'); };
      }
      const fired = new Promise((resolve) => proc.once('inject-fail', resolve));
      const ok = proc.injectUserMessage({ content: 'doomed' });
      // SDK returns false sync (push throws); tmux returns true sync
      // and fails async — both backends must NOT throw.
      assert.equal(typeof ok, 'boolean');
      const ev = await Promise.race([
        fired,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${kind}: inject-fail not emitted`)), 200)),
      ]);
      assert.ok(typeof ev.err === 'string' && ev.err.length > 0);
      proc.inFlight = false;
      await proc.kill('cleanup');
    });

    test('C28 fireUserMessage returns true for valid content + delivers to underlying transport', async () => {
      // P0.3 / 0.10.0: both backends implement fireUserMessage as a
      // fire-and-forget user-message push regardless of inFlight state.
      // Polygram's /compact slash command depends on this working
      // identically across backends.
      const { proc, driver } = await setupReady(kind);
      const ok = proc.fireUserMessage('/compact some hint');
      assert.equal(ok, true, `${kind}: fireUserMessage should return true for valid content`);

      // Empty content → false on both backends.
      assert.equal(proc.fireUserMessage(''), false);
      assert.equal(proc.fireUserMessage(null), false);

      // After close → false on both backends.
      await proc.kill('cleanup');
      assert.equal(proc.fireUserMessage('still trying'), false);
    });

    test('C26 compact-boundary fires when claude auto-compacts mid-conversation', async () => {
      const { proc, driver } = await setupReady(kind);
      const compactEvents = [];
      proc.on('compact-boundary', (ev) => compactEvents.push(ev));
      // Drive via the driver — SDK fires synthetic compact_boundary
      // system event; tmux writes two JSONL usage lines with token drop.
      await driver.simulateCompactBoundary({ preTokens: 180_000, postTokens: 20_000 });
      assert.equal(compactEvents.length, 1, `${kind}: expected 1 compact-boundary, got ${compactEvents.length}`);
      await proc.kill('cleanup');
    });

    test('C27 in-flight send keeps pendingQueue[0].context for streamer/reactor lookups', async () => {
      // Polygram's onStreamChunk reads entry.pendingQueue[0].context.
      // {streamer,reactor}. The abstraction holds only if BOTH backends
      // populate pendingQueue[0] with a context-bearing pending while
      // a turn is in flight.
      const { proc, driver } = await setupReady(kind);
      driver.replyTo('q', 'a');
      const sentinel = { streamer: { onChunk: () => {} }, reactor: { heartbeat: () => {} } };
      const sendP = proc.send('q', { context: sentinel });
      // Give the underlying transport one tick to enqueue the head pending.
      await new Promise((r) => setImmediate(r));
      assert.ok(proc.pendingQueue.length >= 1,
        `${kind}: expected ≥1 pending while in flight, got ${proc.pendingQueue.length}`);
      const head = proc.pendingQueue[0];
      assert.equal(head.context, sentinel,
        `${kind}: pendingQueue[0].context must be the caller-supplied context`);
      await sendP;
      await proc.kill('cleanup');
    });

    test('C25 send() result populates cost + token-breakdown metrics', async () => {
      const { proc, driver } = await setupReady(kind);
      driver.replyTo('hi', 'hello!');
      const res = await proc.send('hi');
      assert.equal(res.error, null);
      // Cost may be 0 on a tiny stub turn but should NEVER be null —
      // null was the pre-parity state for tmux. Both backends must
      // populate the field.
      assert.equal(typeof res.cost, 'number', `${kind}: cost must be a number, got ${res.cost}`);
      assert.ok(res.cost >= 0, `${kind}: cost must be ≥ 0, got ${res.cost}`);
      // Token breakdown — both backends populate from their native
      // telemetry channel (SDK: result event usage; tmux: JSONL usage).
      // Allow null for backends with no usage on the fake stub turn,
      // but if non-null it must be a number.
      const m = res.metrics;
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) {
        assert.ok(m[k] === null || typeof m[k] === 'number',
          `${kind}: metrics.${k} must be number or null, got ${m[k]}`);
      }
      await proc.kill('cleanup');
    });

    test('C24 autonomous assistant message (no in-flight turn) fires autonomous-assistant-message event', async () => {
      const { proc, driver } = await setupReady(kind);
      // Make sure nothing is in flight — autonomous messages are by
      // definition unsolicited (e.g. ScheduleWakeup firing).
      assert.equal(proc.inFlight, false);
      const fired = new Promise((resolve) => proc.once('autonomous-assistant-message', resolve));
      // Drive the simulated autonomous message via the driver. Each
      // backend implements this via its native channel (SDK: emit on
      // fakeQuery; tmux: write to JSONL log file).
      await driver.simulateAutonomousMessage('hello from claude unprompted');
      const ev = await Promise.race([
        fired,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${kind}: autonomous-assistant-message not emitted`)), 500)),
      ]);
      assert.ok(ev, `${kind}: expected an event object`);
      await proc.kill('cleanup');
    });

    test('C20 concurrent send() serializes — second only fires after first resolves', async () => {
      const { proc, driver } = await setupReady(kind);
      driver.replyTo('first', 'reply-1');
      driver.replyTo('second', 'reply-2');
      const order = [];
      const p1 = proc.send('first').then((r) => order.push({ p: 'first', text: r.text }));
      const p2 = proc.send('second').then((r) => order.push({ p: 'second', text: r.text }));
      await Promise.all([p1, p2]);
      // FIFO: first must resolve before second.
      assert.equal(order[0].p, 'first', `${kind}: send order broken: ${JSON.stringify(order)}`);
      assert.equal(order[1].p, 'second');
      assertTextContains(order[0].text, 'reply-1', kind);
      assertTextContains(order[1].text, 'reply-2', kind);
      await proc.kill('cleanup');
    });
  });
}
