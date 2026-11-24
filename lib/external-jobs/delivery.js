'use strict';

const { sanitizeAssistantReply } = require('../telegram/sanitize-reply');
const { chunkMarkdownText } = require('../telegram/chunk');
const { isHtmlParseError } = require('../telegram/format');

function prepareReport(text) {
  return chunkMarkdownText(sanitizeAssistantReply(text).text, 3500);
}

// Only a definite API rejection or pre-connect failure permits another
// attempt. A reset, timeout or missing receipt may have sent the report.
function classify(error) {
  const code = error?.code ?? error?.cause?.code;
  const apiCode = error?.error_code;
  error.definitelyNotSent = [400, 401, 403, 404, 429].includes(apiCode)
    || ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code);
  return error;
}

const unknownOutcome = (message) => Object.assign(new Error(message), { definitelyNotSent: false });

// A report part is the agent's final answer in the same markdown as a normal
// reply, so it renders the same way: rich in a chat that has rich text (the
// same renderer as a non-streamed final reply), otherwise Telegram HTML from
// tg()'s markdown conversion, which records the agent's own text. Each part
// still goes out exactly once: a rich attempt that may have landed is never
// followed by another send, and the only retry is an HTML refusal, which
// proves nothing was sent.
function createReportDelivery({ bot, tg, botName, deliverRich = null, logger = console }) {
  return async function deliverPart(job, part) {
    const { chatId, threadId, sessionKey } = job.target;
    const meta = { source: 'external-job-report', botName, sessionKey, turnId: job.turnId, strictDestination: true, durableDelivery: true };
    let text = part.text;
    if (typeof deliverRich === 'function') {
      let rich;
      try { rich = await deliverRich({ chatId, threadId, text, meta: { ...meta, source: 'external-job-report-rich' } }); }
      catch { throw unknownOutcome('Rich report delivery threw; the part may have been sent'); }
      if (rich?.handled) {
        const result = rich.results?.[0];
        if (!Number.isSafeInteger(result?.message_id)) throw unknownOutcome('Telegram rich report receipt is missing');
        // A rich send into a topic that no longer exists lands in General
        // instead of failing, so the receipt says where it really went.
        const landed = result.message_thread_id ?? null;
        if (String(landed ?? '') !== String(threadId ?? '')) {
          logger.warn?.(`[external-jobs] report part for ${sessionKey} landed outside its topic`);
        }
        return { transport: 'telegram', chatId, threadId: landed, messageId: result.message_id };
      }
      if (rich?.ambiguous) throw unknownOutcome('Rich report delivery outcome is unknown; the part is not sent again');
      // The rich path's own fallback body: in a rich chat its media markdown
      // is already reduced to captions, as for a normal reply.
      if (typeof rich?.text === 'string' && rich.text.trim()) text = rich.text;
    }
    const send = (plainText) => tg(bot, 'sendMessage', {
      chat_id: chatId, ...(threadId == null ? {} : { message_thread_id: threadId }), text,
    }, { ...meta, ...(plainText ? { plainText: true } : {}) });
    try {
      let result;
      try { result = await send(false); }
      catch (error) {
        // tg() skips its own HTML-to-plain retry for durable sends, so the
        // report does it here, once, and only for a refusal of the HTML.
        if (!isHtmlParseError(error)) throw error;
        result = await send(true);
      }
      if (!Number.isSafeInteger(result?.message_id)) throw new Error('Telegram report receipt is missing');
      return { transport: 'telegram', chatId, threadId, messageId: result.message_id };
    } catch (error) {
      throw classify(error);
    }
  };
}

module.exports = { prepareReport, createReportDelivery };
