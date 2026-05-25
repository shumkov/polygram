/**
 * runStartupGate — generic helper for "spawn a tmux'd TUI and wait until
 * it's accepting input, sending Enter for known transient dialogs along
 * the way".
 *
 * Extracted from ChannelsProcess._handleStartupDialogs (M1 follow-on
 * refactor). Made caller-agnostic so future TmuxProcess flows that need
 * to navigate trust / dev-channels / approval-mode prompts can reuse
 * it without duplicating the poll loop.
 *
 * Loop semantics:
 *   - capture-pane every `pollMs` (default 300ms)
 *   - if any trigger regex matches AND its `name` hasn't been seen, send
 *     the trigger's `key` (typically 'Enter') via runner.sendControl
 *   - after each send, wait `settleMs` (default 500ms) for the TUI to
 *     transition out of the dialog before the next poll
 *   - if `readySignal` regex matches the captured pane content, resolve
 *   - if `Date.now()` exceeds the deadline, throw with `err.code = timeoutCode`
 *
 * Each trigger is one-shot per gate run (tracked by `name` in a Set).
 *
 * Caller supplies:
 *   - runner: object with `captureWide(tmuxName)` and `sendControl(tmuxName, key)`
 *   - triggers: [{name, regex, key}] — order matters; first match wins
 *   - readySignal: RegExp matching the "TUI is ready, no more dialogs" pane text
 *   - deadlineMs, pollMs, settleMs — timeouts
 *   - timeoutCode: err.code on deadline expiry (default 'TUI_STARTUP_TIMEOUT')
 *   - logger, label — for diagnostic prose
 */

'use strict';

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_POLL_MS = 300;
const DEFAULT_SETTLE_MS = 500;

/**
 * @param {object} opts
 * @param {object} opts.runner                — tmux runner with captureWide + sendControl
 * @param {string} opts.tmuxName              — tmux session name to poll
 * @param {Array<{name:string, regex:RegExp, key:string}>} opts.triggers
 * @param {RegExp} opts.readySignal           — match → resolve
 * @param {number} [opts.deadlineMs=30000]
 * @param {number} [opts.pollMs=300]
 * @param {number} [opts.settleMs=500]
 * @param {string} [opts.timeoutCode='TUI_STARTUP_TIMEOUT']
 * @param {object} [opts.logger=console]
 * @param {string} [opts.label='startup-gate']
 * @returns {Promise<{matchedTriggers: string[], elapsedMs: number}>}
 */
async function runStartupGate({
  runner,
  tmuxName,
  triggers = [],
  readySignal,
  deadlineMs = DEFAULT_DEADLINE_MS,
  pollMs = DEFAULT_POLL_MS,
  settleMs = DEFAULT_SETTLE_MS,
  timeoutCode = 'TUI_STARTUP_TIMEOUT',
  logger = console,
  label = 'startup-gate',
} = {}) {
  if (!runner || typeof runner.captureWide !== 'function' || typeof runner.sendControl !== 'function') {
    throw new TypeError('runStartupGate: runner must have captureWide + sendControl');
  }
  if (!tmuxName) throw new TypeError('runStartupGate: tmuxName required');
  if (!(readySignal instanceof RegExp)) {
    throw new TypeError('runStartupGate: readySignal must be a RegExp');
  }

  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  const seen = new Set();
  const matchedTriggers = [];

  while (Date.now() < deadline) {
    let pane;
    try {
      pane = await runner.captureWide(tmuxName);
    } catch (err) {
      logger.warn?.(`[${label}] captureWide failed: ${err.message}`);
      await new Promise(r => setTimeout(r, settleMs));
      continue;
    }

    // Walk triggers in declaration order — first match (and not yet seen) wins
    let matched = false;
    for (const trigger of triggers) {
      if (seen.has(trigger.name)) continue;
      if (!trigger.regex.test(pane)) continue;
      try {
        await runner.sendControl(tmuxName, trigger.key);
      } catch (err) {
        logger.warn?.(`[${label}] sendControl(${trigger.key}) failed for trigger=${trigger.name}: ${err.message}`);
      }
      seen.add(trigger.name);
      matchedTriggers.push(trigger.name);
      matched = true;
      // Settle window so the TUI transitions out of the dialog before next poll
      await new Promise(r => setTimeout(r, settleMs));
      break;
    }
    if (matched) continue;

    if (readySignal.test(pane)) {
      return { matchedTriggers, elapsedMs: Date.now() - startedAt };
    }

    await new Promise(r => setTimeout(r, pollMs));
  }

  const err = new Error(
    `[${label}] startup gate did not resolve within ${deadlineMs}ms for ${tmuxName} ` +
    `(matched: ${matchedTriggers.length ? matchedTriggers.join(', ') : 'none'})`,
  );
  err.code = timeoutCode;
  throw err;
}

module.exports = {
  runStartupGate,
  DEFAULT_DEADLINE_MS,
  DEFAULT_POLL_MS,
  DEFAULT_SETTLE_MS,
};
