/**
 * The `callback_query:data` dispatcher: refuses a malformed or inline-mode
 * query, then routes by the data's prefix.
 *
 * Handlers are looked up per query through `routes()`, because several of
 * them are wired after the bot is created and some are absent on a bot that
 * has the feature off. A missing handler behaves exactly as the inline
 * dispatcher it replaces did: `cxr:` and `q:` are dropped, `mbx:` gets the
 * stale-button toast.
 */

'use strict';

const STALE_BUTTON = 'Stale or invalid button.';

/**
 * @param {object} deps
 * @param {string} deps.botName
 * @param {(kind: string, detail: object) => void} deps.logEvent
 * @param {(cb: object) => boolean} deps.isWellFormedCallbackQuery
 * @param {() => {config?: Function, codexReconciliation?: Function,
 *   question?: Function, mailbox?: Function, approval?: Function}} deps.routes
 * @param {object} [deps.logger]
 */
function createCallbackQueryHandler({
  botName,
  logEvent,
  isWellFormedCallbackQuery,
  routes,
  logger = console,
}) {
  const answerStale = (ctx) => ctx.answerCallbackQuery({ text: STALE_BUTTON }).catch(() => {});

  return async function handleCallbackQuery(ctx) {
    if (!isWellFormedCallbackQuery(ctx.callbackQuery)) {
      logEvent('malformed-update', {
        bot: botName,
        update_id: ctx.update?.update_id,
        reason: 'callback_query missing message/from/data or inline-mode',
      });
      // Best-effort ack so Telegram stops re-sending. May fail silently.
      await answerStale(ctx);
      return;
    }
    try {
      const data = ctx.callbackQuery.data;
      const handlers = routes();
      if (data.startsWith('cfg:')) {
        await handlers.config(ctx);
      } else if (data.startsWith('cxr:')) {
        if (handlers.codexReconciliation) await handlers.codexReconciliation(ctx);
      } else if (data.startsWith('q:')) {
        if (handlers.question) await handlers.question(ctx);
      } else if (data.startsWith('mbx:')) {
        if (handlers.mailbox) await handlers.mailbox(ctx);
        else await answerStale(ctx);
      } else {
        await handlers.approval(ctx);
      }
    } catch (err) {
      logger.error(`[${botName}] callback_query error: ${err.message}`);
    }
  };
}

module.exports = { createCallbackQueryHandler, STALE_BUTTON };
