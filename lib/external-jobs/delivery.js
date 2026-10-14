'use strict';

const { sanitizeAssistantReply } = require('../telegram/sanitize-reply');
const { chunkMarkdownText } = require('../telegram/chunk');

function prepareReport(text) {
  return chunkMarkdownText(sanitizeAssistantReply(text).text, 3500);
}

function createReportDelivery({ bot, tg, botName }) {
  return async function deliverPart(job, part) {
    const { chatId, threadId, sessionKey } = job.target;
    try {
      const result = await tg(bot, 'sendMessage', {
        chat_id: chatId, ...(threadId == null ? {} : { message_thread_id: threadId }), text: part.text,
      }, { source: 'external-job-report', botName, sessionKey, turnId: job.turnId,
        strictDestination: true, durableDelivery: true, plainText: true });
      if (!Number.isSafeInteger(result?.message_id)) throw new Error('Telegram report receipt is missing');
      return { transport: 'telegram', chatId, threadId, messageId: result.message_id };
    } catch (error) {
      // Only a definite API rejection or pre-connect failure permits another
      // attempt. A reset, timeout or missing receipt may have sent the report.
      const code = error?.code ?? error?.cause?.code;
      const apiCode = error?.error_code;
      error.definitelyNotSent = [400, 401, 403, 404, 429].includes(apiCode)
        || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code);
      throw error;
    }
  };
}

module.exports = { prepareReport, createReportDelivery };
