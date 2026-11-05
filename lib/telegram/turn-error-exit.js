'use strict';

/**
 * How a streamed turn's preview is settled when the turn ends in an error
 * (polygram.js handleMessage's catch).
 *
 * A turn that already delivered replies and THEN failed must not restate
 * them: finalize(null) publishes whatever the draft holds, which on a CLI turn
 * is usually the answer a reply already sent. So when the turn delivered
 * anything, the exit settles through the turn settler instead and, unless told
 * otherwise, sends the suffix as its own short message. With nothing
 * delivered, the partial bubble is finalized in place and carries the suffix.
 */

const { classifyTurnEndError } = require('../error/classify');

/**
 * @param {object} deps
 * @param {() => boolean} deps.hasDeliveredReplies
 * @param {() => Promise<unknown>} deps.finishStreamer - the turn settler
 * @param {{ finalize: Function }} deps.streamer
 * @param {(text: string) => Promise<unknown>} deps.sendSuffixMessage
 * @param {(msgId: number, text: string) => void} deps.persistBubbleText
 * @returns {(errorSuffix: string|null, opts?: { suffixMessage?: boolean }) => Promise<void>}
 */
function createTurnErrorExit({
  hasDeliveredReplies,
  finishStreamer,
  streamer,
  sendSuffixMessage,
  persistBubbleText,
}) {
  return async (errorSuffix, { suffixMessage = true } = {}) => {
    if (hasDeliveredReplies()) {
      await finishStreamer().catch(() => {});
      // suffixMessage:false — the error reply the dispatcher sends next is
      // already this turn's one error message.
      if (errorSuffix && suffixMessage) {
        await sendSuffixMessage(`⚠️ ${errorSuffix}`).catch(() => {});
      }
      return;
    }
    // null, not '': finalize falls back to the drafted body. Passing ''
    // REPLACED whatever had streamed with an empty bubble — the user watched
    // a partial answer appear and then get wiped by the very failure that
    // was supposed to leave it standing.
    const fin = await streamer.finalize(null, errorSuffix ? { errorSuffix } : {})
      .catch(() => null);
    // The bubble now shows the drafted body; bring its transcript row along,
    // or the row keeps the ~30-character stub the initial send wrote.
    if (fin?.finalEditOk) persistBubbleText(fin.msgId, fin.finalText);
  };
}

/**
 * The non-quiet error exit: decide the suffix from the error code
 * (classifyTurnEndError), settle the preview, and return the reactor state
 * the caller sets.
 */
async function settleTurnEndError(err, settleErrorExit) {
  const { errorSuffix, reactorState, suffixMessage } = classifyTurnEndError(err);
  // null keeps the drafted body so the suffix APPENDS to what the user was
  // reading instead of replacing it with a bare "⚠️ …".
  await settleErrorExit(errorSuffix, { suffixMessage });
  return reactorState;
}

module.exports = { createTurnErrorExit, settleTurnEndError };
