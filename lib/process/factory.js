/**
 * Process factory + lifecycle-event bridge.
 *
 * The generic `lib/process-manager.js` calls processFactory(sessionKey, ctx)
 * to mint a fresh Process instance per chat. This module wires that
 * factory and bridges the legacy underlying-SDK-pm's callback style
 * (onInit(sessionKey, ...), onStreamChunk(sessionKey, ...), etc.)
 * into the per-Process EventEmitter that the generic pm subscribes to.
 *
 * Phase 1 only ships SDK backend; tmux backend lands in Phase 2.
 *
 * @see docs/0.10.0-process-manager-abstraction-plan.md §6.4
 */

'use strict';

const { SdkProcess } = require('./sdk-process');

/**
 * Build a processFactory + the legacy callbacks the underlying SDK pm
 * needs at construction time.
 *
 * @param {object} opts
 * @param {() => object} opts.sdkPmGetter — accessor for the underlying
 *   ProcessManagerSdk instance. Lazy because the underlying pm is
 *   constructed after the factory wiring is established (polygram.js
 *   needs the factory + the legacy callbacks first).
 * @param {object} opts.config — runtime config for backend choice
 * @returns {{
 *   factory: Function,
 *   legacyCallbacks: object,
 * }}
 */
function createProcessFactory({ sdkPmGetter, config }) {
  // Per-sessionKey lookup table: ties an SdkProcess instance back to
  // its sessionKey so the legacy callbacks can route events to the
  // right EventEmitter.
  const procIndex = new Map(); // sessionKey → SdkProcess

  // Each legacy callback fires (sessionKey, ...payload, entry).
  // We look up the SdkProcess by sessionKey and re-emit on its
  // EventEmitter using the matching event name. The generic pm
  // subscribes to those events and forwards to operator callbacks.
  function makeBridge(eventName) {
    return (sessionKey, ...args) => {
      const proc = procIndex.get(sessionKey);
      if (!proc) return;
      proc.emit(eventName, ...args);
    };
  }

  const legacyCallbacks = {
    onInit:                       makeBridge('init'),
    onClose:                      makeBridge('close'),
    onResult:                     makeBridge('result'),
    onStreamChunk:                makeBridge('stream-chunk'),
    onToolUse:                    makeBridge('tool-use'),
    onAssistantMessageStart:      makeBridge('assistant-message-start'),
    onAutonomousAssistantMessage: makeBridge('autonomous-assistant-message'),
    onCompactBoundary:            makeBridge('compact-boundary'),
    onQueueDrop:                  makeBridge('queue-drop'),
    onThinking:                   makeBridge('thinking'),
  };

  function factory(sessionKey, ctx) {
    const chatId = ctx?.chatId ?? null;
    const threadId = ctx?.threadId ?? null;
    const label = ctx?.label || sessionKey;

    // Phase 1: only SDK backend. Phase 2 adds tmux per-chat selection.
    // Pre-emptively read the config so the audit trail of WHY shows up
    // in events even when nothing's actually different yet.
    const choice = pickBackend({ config, chatId, threadId });

    if (choice === 'tmux') {
      // Phase 2 hook — but for Phase 1 the factory falls back to SDK.
      // Once TmuxProcess ships we replace this with:
      //   return new TmuxProcess({ sessionKey, chatId, threadId, label, runner });
      // For now: same as sdk path.
    }

    const sdkPm = sdkPmGetter();
    if (!sdkPm) {
      throw new Error('processFactory: sdkPm not yet available (factory called too early in main wiring)');
    }
    const proc = new SdkProcess({ sessionKey, chatId, threadId, label, sdkPm });
    // Register for legacy-callback routing.
    procIndex.set(sessionKey, proc);
    // De-register on close (the legacy pm's _runIteration deletes
    // its entry; we should drop our index too).
    proc.once('close', () => procIndex.delete(sessionKey));
    return proc;
  }

  return { factory, legacyCallbacks, procIndex };
}

/**
 * Per-chat / per-topic backend choice. Phase 1 always returns 'sdk'.
 * Phase 2 honors chatConfig.pm / topicConfig.pm / config.bot.pm.
 */
function pickBackend({ config, chatId, threadId }) {
  // Phase 1: hard-coded sdk. Phase 2 will look at:
  //   topicConfig?.pm || chatConfig?.pm || config.bot?.pm || 'sdk'
  return 'sdk';
}

module.exports = { createProcessFactory, pickBackend };
