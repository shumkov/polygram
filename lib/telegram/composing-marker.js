/**
 * The trailing line a still-growing preview bubble carries: "⏳ пишу дальше…".
 *
 * Mid-stream the reader cannot tell "more is coming" from "the bot stalled",
 * and the bubble itself is the only place that can answer. Polygram appends
 * the line deterministically rather than asking the agent to write one: model
 * compliance is exactly what failed in the snapshot contract this shipped
 * alongside, and a stall is precisely the moment a model stops cooperating.
 *
 * Presentation, not content. It is appended AFTER a payload has been planned
 * and measured, never enters the streamer's notion of the answer, and never
 * reaches the transcript — see streamer.js for where it is applied and where
 * it is deliberately not.
 */

'use strict';

const COMPOSING_MARKER_TEXT = '⏳ пишу дальше…';

// The plain path's form. A blank line so it reads as its own line, and
// markdown emphasis because tg()'s formatter renders `em` as <i> — the same
// italic the rich block carries.
const COMPOSING_MARKER_SUFFIX = `\n\n_${COMPOSING_MARKER_TEXT}_`;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.styled=true] — emit the rich block's text as a typed
 *   italic node. The caller decides, because a hard-coded typed node would
 *   make EVERY payload "styled" (blocksAreStyled reads the shape, not the
 *   intent): against a server that refuses typed nodes, each edit would take
 *   rich-edit.js's styled→refused→flatten retry — two API calls per edit, plus
 *   styling verdicts recorded against markup polygram injected rather than
 *   anything the agent wrote.
 * @returns {{ block: object, plainSuffix: string }}
 */
function composingMarker({ styled = true } = {}) {
  return {
    block: {
      type: 'paragraph',
      text: styled
        ? [{ type: 'italic', text: COMPOSING_MARKER_TEXT }]
        : COMPOSING_MARKER_TEXT,
    },
    plainSuffix: COMPOSING_MARKER_SUFFIX,
  };
}

module.exports = {
  composingMarker,
  COMPOSING_MARKER_TEXT,
  COMPOSING_MARKER_SUFFIX,
};
