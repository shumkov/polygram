'use strict';

const { createHash } = require('node:crypto');

function codexDispatchReservationId({
  botName,
  telegramChatId,
  telegramMessageId,
}) {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      botName,
      telegramChatId,
      telegramMessageId,
    }))
    .digest('hex');
  return `codex-dispatch:v1:${digest}`;
}

module.exports = { codexDispatchReservationId };
