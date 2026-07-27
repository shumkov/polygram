'use strict';

const { createHash, randomUUID } = require('node:crypto');

const CALLBACK_PREFIX = 'cxr';
const CALLBACK_TOKEN_BYTES = 16;

const ACTIONS = Object.freeze({
  incorporated: Object.freeze({
    callback: 'i',
    disposition: 'incorporated',
    reason: 'owner marked the ambiguous input incorporated via Telegram',
    acknowledgement: 'Marked incorporated. No retry was authorized.',
  }),
  dismissed: Object.freeze({
    callback: 'd',
    disposition: 'dismissed',
    reason: 'owner dismissed the ambiguous input without retry via Telegram',
    acknowledgement: 'Dismissed without retry.',
  }),
  retry: Object.freeze({
    callback: 'r',
    disposition: 'retry-authorized',
    reason: 'owner authorized one retry after the duplicate-risk warning via Telegram',
    acknowledgement: 'One retry was authorized. It remains fenced by containment.',
  }),
});

const ACTION_BY_CALLBACK = new Map(
  Object.values(ACTIONS).map((action) => [action.callback, action]),
);

function attemptToken(attemptId) {
  if (typeof attemptId !== 'string' || attemptId.length === 0) {
    throw new TypeError('Codex reconciliation attempt ID is required');
  }
  return createHash('sha256')
    .update(attemptId)
    .digest('hex')
    .slice(0, CALLBACK_TOKEN_BYTES * 2);
}

function callbackData(action, attemptId) {
  const value = `${CALLBACK_PREFIX}:${action.callback}:${attemptToken(attemptId)}`;
  if (Buffer.byteLength(value, 'utf8') > 64) {
    throw new TypeError('Codex reconciliation callback exceeds Telegram limits');
  }
  return value;
}

function buildCodexReconciliationView(attempt) {
  if (
    !attempt
    || typeof attempt.attempt_id !== 'string'
    || typeof attempt.telegram_message_id !== 'string'
  ) {
    throw new TypeError('Codex reconciliation view requires a located attempt');
  }
  const quarantined = attempt.containment_status === 'quarantined';
  const containment = quarantined
    ? 'This decision does not release containment quarantine; the prescribed host reboot is still required.'
    : 'This decision does not release containment quarantine.';
  return {
    text: [
      '⚠️ Codex input needs reconciliation',
      `Original Telegram message #${attempt.telegram_message_id} may already have been incorporated.`,
      'Choose one owner action. Retrying can duplicate output or side effects.',
      containment,
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '✓ Mark incorporated',
            callback_data: callbackData(ACTIONS.incorporated, attempt.attempt_id),
          },
          {
            text: 'Dismiss without retry',
            callback_data: callbackData(ACTIONS.dismissed, attempt.attempt_id),
          },
        ],
        [{
          text: '⚠ Authorize one retry (duplicate risk)',
          callback_data: callbackData(ACTIONS.retry, attempt.attempt_id),
        }],
      ],
    },
  };
}

function configuredOperatorUserId(config) {
  const configured = config?.bot?.operatorUserId
    ?? config?.bot?.adminChatId;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function acknowledge(ctx, text, showAlert = false) {
  if (typeof ctx?.answerCallbackQuery !== 'function') return;
  await ctx.answerCallbackQuery({
    text,
    ...(showAlert ? { show_alert: true } : {}),
  }).catch(() => {});
}

function createHandleCodexReconciliationCallback({
  config,
  db,
  intentLock,
  getSessionKey,
  retryAttemptId = randomUUID,
  now = Date.now,
  isAuthorizedActor = null,
  logger = console,
} = {}) {
  if (
    !config
    || typeof db?.listUnresolvedCodexAttempts !== 'function'
    || typeof db?.reconcileCodexAttempt !== 'function'
    || typeof intentLock?.acquire !== 'function'
    || typeof getSessionKey !== 'function'
    || typeof retryAttemptId !== 'function'
    || typeof now !== 'function'
  ) {
    throw new TypeError('Codex reconciliation handler dependencies are incomplete');
  }

  return async function handleCodexReconciliationCallback(ctx) {
    const data = String(ctx?.callbackQuery?.data ?? '');
    const match = /^cxr:([idr]):([a-f0-9]{32})$/.exec(data);
    if (!match) return false;

    const action = ACTION_BY_CALLBACK.get(match[1]);
    const token = match[2];
    const message = ctx.callbackQuery?.message;
    const chatId = message?.chat?.id == null
      ? null
      : String(message.chat.id);
    const chatConfig = chatId == null ? null : config.chats?.[chatId];
    if (!chatConfig) {
      await acknowledge(ctx, 'This reconciliation is not available.', true);
      return true;
    }

    const actorId = ctx.from?.id ?? ctx.callbackQuery?.from?.id;
    const operatorUserId = configuredOperatorUserId(config);
    const allowed = typeof isAuthorizedActor === 'function'
      ? await isAuthorizedActor({ actorId, chatId, ctx })
      : (
        operatorUserId != null
        && Number(actorId) === operatorUserId
      );
    if (!allowed) {
      await acknowledge(ctx, 'Not authorised to reconcile Codex input.', true);
      return true;
    }

    const threadId = message.message_thread_id?.toString() ?? null;
    const sessionKey = getSessionKey(chatId, threadId, chatConfig);
    const release = await intentLock.acquire(sessionKey);
    try {
      const matching = db.listUnresolvedCodexAttempts({
        session_key: sessionKey,
      }).filter((attempt) => attemptToken(attempt.attempt_id) === token);
      if (matching.length !== 1) {
        await acknowledge(
          ctx,
          matching.length === 0
            ? 'This input was already resolved or is no longer available.'
            : 'Reconciliation identity conflict; no action was recorded.',
          true,
        );
        return true;
      }

      const attempt = matching[0];
      const input = {
        attempt_id: attempt.attempt_id,
        disposition: action.disposition,
        actor: `telegram-user:${actorId}`,
        reason: action.reason,
        ts: now(),
      };
      if (action.disposition === 'retry-authorized') {
        input.retry_attempt_id = retryAttemptId();
        input.duplicate_risk_acknowledged = true;
      }

      try {
        db.reconcileCodexAttempt(input);
      } catch (error) {
        if (
          error?.code === 'CODEX_ATTEMPT_ALREADY_RECONCILED'
          || error?.code === 'CODEX_ATTEMPT_NOT_AMBIGUOUS'
        ) {
          await acknowledge(ctx, 'This input was already resolved.', true);
          return true;
        }
        if (error?.code === 'CODEX_RETRY_GENERATION_NOT_TERMINAL') {
          await acknowledge(
            ctx,
            'Wait for the prior Codex generation to finish before authorizing retry.',
            true,
          );
          return true;
        }
        throw error;
      }

      if (typeof ctx.editMessageReplyMarkup === 'function') {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch((error) => {
          logger.error?.(
            `Codex reconciliation UI update failed: ${error?.message || error}`,
          );
        });
      }
      await acknowledge(ctx, action.acknowledgement);
      return true;
    } finally {
      release();
    }
  };
}

module.exports = {
  ACTIONS,
  attemptToken,
  buildCodexReconciliationView,
  createHandleCodexReconciliationCallback,
};
