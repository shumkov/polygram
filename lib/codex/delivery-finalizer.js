'use strict';

function claimsCodexRuntime(result) {
  return result?.runtime === 'codex' || result?.backend === 'codex';
}

function missingControllerError() {
  const error = new Error(
    'A Codex result cannot be finalized without its runtime controller',
  );
  error.code = 'CODEX_DELIVERY_CONTROLLER_MISSING';
  return error;
}

async function finalizeTelegramDelivery({
  controller,
  sessionKey,
  result,
  deliveryComplete = true,
  queuedDispatch = null,
  markHandlerStatus,
} = {}) {
  if (typeof markHandlerStatus !== 'function') {
    throw new TypeError('markHandlerStatus function required');
  }

  if (!claimsCodexRuntime(result)) {
    await markHandlerStatus('replied');
    return Object.freeze({
      runtime: 'claude',
      disposition: 'delivered',
      handlerStatus: 'replied',
    });
  }
  if (!controller) throw missingControllerError();

  const disposition = (
    result?.error == null
    && deliveryComplete === true
  )
    ? 'delivered'
    : 'failed';
  await controller.settleTelegramDelivery(
    sessionKey,
    result,
    { disposition },
  );

  if (disposition === 'delivered' && queuedDispatch?.reservationId) {
    controller.settleQueuedDispatch({
      sessionKey,
      generationId: result.generationId,
      reservationId: queuedDispatch.reservationId,
      attemptId: result.attemptId,
      botName: queuedDispatch.botName,
      telegramChatId: queuedDispatch.telegramChatId,
      telegramMessageId: queuedDispatch.telegramMessageId,
    });
  }

  const handlerStatus = disposition === 'delivered' ? 'replied' : 'failed';
  await markHandlerStatus(handlerStatus);
  return Object.freeze({
    runtime: 'codex',
    disposition,
    handlerStatus,
  });
}

function createTelegramDeliveryFinalizer(options = {}) {
  let outcome = null;

  async function finalize(deliveryComplete = true) {
    if (outcome) return outcome;
    outcome = await finalizeTelegramDelivery({
      ...options,
      deliveryComplete,
    });
    return outcome;
  }

  async function failIfPending() {
    if (outcome || !claimsCodexRuntime(options.result)) return outcome;
    return finalize(false);
  }

  return Object.freeze({
    finalize,
    failIfPending,
  });
}

module.exports = {
  claimsCodexRuntime,
  createTelegramDeliveryFinalizer,
  finalizeTelegramDelivery,
};
