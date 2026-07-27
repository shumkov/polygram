/**
 * Autosteer detection + dispatch.
 *
 * When a user types a follow-up message while the bot is mid-reply,
 * absorb it into the current turn instead of queueing a separate
 * response (OpenClaw-style "merge into active"). Saves a turn,
 * saves tokens, feels conversational.
 *
 * Two halves:
 *   - shouldAutosteer(sessionKey, chatConfig) — boolean predicate,
 *     used pre-THINKING to skip the 🤔 → ✍ flash.
 *   - tryAutosteer(...) — full dispatch: pm.injectUserMessage with
 *     priority hint ('next' for merge, 'later' for queue), records
 *     ✍ reaction ref, logs telemetry, sets reactor to AUTOSTEERED
 *     and returns true so caller short-circuits.
 *
 * Opt-out: chatConfig.autosteer === false (per-chat) or
 * config.bot.autosteer === false. Mode: chatConfig.autosteerMode
 * (or config.bot.autosteerMode) of 'merge' (default → priority='next')
 * or 'queue' (→ priority='later'); spike findings in
 * scripts/spikes/native-queue.mjs explain the difference.
 */

'use strict';

function isAutosteerEnabledFor(chatConfig, config) {
  return chatConfig.autosteer != null
    ? chatConfig.autosteer !== false
    : config.bot?.autosteer !== false;
}

function priorityFor(chatConfig, config) {
  const mode = chatConfig.autosteerMode != null
    ? chatConfig.autosteerMode
    : config.bot?.autosteerMode;
  return mode === 'queue' ? 'later' : 'next';
}

const QUEUEABLE_CODEX_STATES = new Set([
  'Active',
  'Idle',
  'StartingTurn',
]);

const AMBIGUOUS_STEER_ERROR_CODES = new Set([
  'CODEX_RPC_OUTCOME_UNKNOWN',
  'CODEX_RPC_CHECKPOINT_FAILED',
  'CODEX_DURABILITY_FAILED',
  'CODEX_RPC_ERROR',
]);

const OPAQUE_ID_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function opaqueId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 512
    && !OPAQUE_ID_CONTROL_CHAR_RE.test(value)
  )
    ? value
    : null;
}

function codexGenerationId(entry) {
  return opaqueId(entry?.generationId);
}

function isCodexEntry(pm, sessionKey, entry) {
  const backend = typeof pm.getBackend === 'function'
    ? pm.getBackend(sessionKey)
    : entry?.backend;
  return backend === 'codex' || entry?.runtime === 'codex';
}

function sameCodexGeneration(pm, sessionKey, generationId) {
  const current = pm.get(sessionKey);
  return {
    current,
    same: (
      current != null
      && codexGenerationId(current) === generationId
    ),
  };
}

function canQueueCodexNotSent(entry) {
  return (
    entry != null
    && !entry.closed
    && QUEUEABLE_CODEX_STATES.has(entry.state)
  );
}

function codexClassification(outcome, priority, reason, detail = {}) {
  return {
    autosteered: false,
    outcome,
    queueOnce: outcome === 'queue-once',
    priority,
    reason,
    ...detail,
  };
}

function createAutosteerHandlers({
  config,
  pm,
  autosteeredRefs,
  logEvent,
} = {}) {

  /**
   * Pre-THINKING predicate. Returns true when the upcoming message
   * will be autosteered (so the caller skips reactor.setState('THINKING')
   * to avoid the 🤔 → ✍ flash).
   */
  function willAutosteer(sessionKey, chatConfig) {
    if (!pm.has(sessionKey)) return false;
    if (!pm.get(sessionKey)?.inFlight) return false;
    return isAutosteerEnabledFor(chatConfig, config);
  }

  /**
   * Attempt to inject the user message into the in-flight turn.
   * Returns:
   *   - { autosteered: true, priority }  — caller marks reactor
   *     AUTOSTEERED + records ✍ ref + returns from handleMessage.
   *   - { autosteered: false }  — caller falls through to normal
   *     pm.send queue path.
   */
  function tryAutosteer({ sessionKey, chatConfig, chatId, msg, prompt }) {
    if (!isAutosteerEnabledFor(chatConfig, config)) return { autosteered: false };
    if (!pm.has(sessionKey)) return { autosteered: false };
    const entry = pm.get(sessionKey);
    if (!entry?.inFlight) return { autosteered: false };

    const priority = priorityFor(chatConfig, config);
    // rc.7: pass the autosteered msg_id through to the backend so the
    // tmux backend can route an extra-turn reply back to Telegram if
    // the TUI dequeues the paste as a fresh user turn (NEW-TURN path).
    // SDK backend ignores msgId — its PostToolBatch fold path
    // guarantees one combined reply via the primary pm.send.
    const ok = pm.injectUserMessage(sessionKey, {
      content: prompt,
      priority,
      msgId: msg.message_id,
      source: 'autosteer',   // 0.13 D2: ledger source — drop detection + redelivery eligibility
    });
    if (!ok) return { autosteered: false };

    autosteeredRefs.add(sessionKey, { chatId, msgId: msg.message_id });
    logEvent('autosteer', {
      chat_id: chatId, msg_id: msg.message_id,
      text_len: prompt?.length ?? 0,
      priority,
      // 0.13 P1: per-event backend. The 14d fold/drop investigation had to
      // reconstruct the cli-vs-sdk split by joining chats — never again.
      backend: typeof pm.getBackend === 'function' ? pm.getBackend(sessionKey) : null,
    });
    return { autosteered: true, priority };
  }

  /**
   * Attempt a native Codex turn/steer RPC.
   *
   * The caller owns the per-session intent lock and the durable Telegram
   * dispatch reservation. This function keeps that lock held by awaiting the
   * RPC and returns a classification; it never performs the fallback send.
   */
  async function tryCodexAutosteer({
    sessionKey,
    chatConfig,
    chatId,
    msg,
    prompt,
  }) {
    const priority = priorityFor(chatConfig, config);
    if (!isAutosteerEnabledFor(chatConfig, config)) {
      return codexClassification('not-applicable', priority, 'disabled');
    }
    if (!pm.has(sessionKey)) {
      return codexClassification('not-applicable', priority, 'missing-session');
    }

    const entry = pm.get(sessionKey);
    if (!isCodexEntry(pm, sessionKey, entry)) {
      return codexClassification('not-applicable', priority, 'not-codex');
    }
    const generationId = codexGenerationId(entry);
    if (!generationId) {
      return codexClassification(
        'unavailable',
        priority,
        'missing-generation-id',
        {
        generationId: null,
        },
      );
    }
    if (entry.closed || !entry.inFlight) {
      return codexClassification(
        'not-applicable',
        priority,
        entry.closed ? 'closed' : 'not-in-flight',
        { generationId },
      );
    }

    const expectedTurnId = opaqueId(entry.activeTurnId);
    if (priority === 'later') {
      return codexClassification('queue-once', priority, 'queue-mode', {
        generationId,
        turnId: expectedTurnId,
      });
    }

    let result;
    try {
      result = await pm.steerTurn(sessionKey, prompt, {
        context: { sourceMsgId: msg.message_id },
      });
    } catch (error) {
      const observed = sameCodexGeneration(pm, sessionKey, generationId);
      if (!observed.same) {
        return codexClassification('ambiguous', priority, 'generation-changed', {
          generationId,
          observedGenerationId: codexGenerationId(observed.current),
        });
      }
      if (
        error?.code === 'CODEX_RPC_NOT_SENT'
        && canQueueCodexNotSent(observed.current)
      ) {
        return codexClassification('queue-once', priority, 'rpc-not-sent', {
          generationId,
          turnId: expectedTurnId,
        });
      }
      if (AMBIGUOUS_STEER_ERROR_CODES.has(error?.code)) {
        return codexClassification(
          'ambiguous',
          priority,
          error.code === 'CODEX_RPC_OUTCOME_UNKNOWN'
            ? 'rpc-outcome-unknown'
            : 'steer-outcome-ambiguous',
          { generationId, errorCode: error.code },
        );
      }
      return codexClassification(
        'unavailable',
        priority,
        !QUEUEABLE_CODEX_STATES.has(observed.current?.state)
          ? String(observed.current?.state || 'unavailable').toLowerCase()
          : 'steer-failed',
        { generationId, errorCode: opaqueId(error?.code) },
      );
    }

    const observed = sameCodexGeneration(pm, sessionKey, generationId);
    if (!observed.same) {
      return codexClassification('ambiguous', priority, 'generation-changed', {
        generationId,
        observedGenerationId: codexGenerationId(observed.current),
      });
    }

    const turnId = opaqueId(result?.turnId);
    if (result?.outcome === 'queueable-not-active') {
      if (!canQueueCodexNotSent(observed.current)) {
        return codexClassification(
          'unavailable',
          priority,
          String(observed.current?.state || result.reason || 'unavailable')
            .toLowerCase(),
          { generationId },
        );
      }
      return codexClassification('queue-once', priority, 'not-active', {
        generationId,
        turnId,
      });
    }
    if (result?.outcome === 'unavailable') {
      return codexClassification(
        'unavailable',
        priority,
        opaqueId(result.reason) || 'unavailable',
        { generationId },
      );
    }
    if (result?.outcome !== 'accepted') {
      return codexClassification(
        'ambiguous',
        priority,
        'unrecognized-steer-outcome',
        { generationId },
      );
    }

    const resultGenerationId = opaqueId(result.generationId);
    const attemptId = opaqueId(result.attemptId);
    const targetAttemptId = result.targetAttemptId == null
      ? null
      : opaqueId(result.targetAttemptId);
    if (
      !turnId
      || !attemptId
      || !targetAttemptId
      || resultGenerationId !== generationId
      || (expectedTurnId && turnId !== expectedTurnId)
    ) {
      return codexClassification(
        'ambiguous',
        priority,
        'accepted-without-durable-identifiers',
        {
        generationId,
        turnId,
        attemptId,
        targetAttemptId,
        ...(resultGenerationId !== generationId
          ? { observedGenerationId: resultGenerationId }
          : {}),
        },
      );
    }

    autosteeredRefs.add(sessionKey, { chatId, msgId: msg.message_id });
    logEvent('autosteer', {
      chat_id: chatId,
      msg_id: msg.message_id,
      text_len: prompt?.length ?? 0,
      priority,
      backend: 'codex',
      generation_id: generationId,
      turn_id: turnId,
      attempt_id: attemptId,
      target_attempt_id: targetAttemptId,
    });
    return {
      autosteered: true,
      outcome: 'accepted',
      priority,
      generationId,
      turnId,
      attemptId,
      targetAttemptId,
    };
  }

  return { willAutosteer, tryAutosteer, tryCodexAutosteer };
}

module.exports = {
  createAutosteerHandlers,
  isAutosteerEnabledFor,
  priorityFor,
};
