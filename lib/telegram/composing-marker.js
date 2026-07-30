/**
 * The trailing line a still-growing preview bubble carries: "🤖💬".
 *
 * Symbols only, no words: the bot answers in whatever language the user
 * writes, so any wording would be wrong in every chat but one.
 * Mid-stream the reader cannot tell "more is coming" from "the bot stalled",
 * and the bubble itself is the only place that can answer. Polygram appends
 * the line deterministically rather than asking the agent to write one: a
 * stall is precisely the moment a model stops cooperating, so an instruction
 * to announce one cannot be relied on to run.
 *
 * Presentation, not content. It is appended AFTER a payload has been planned
 * and measured, never enters the streamer's notion of the answer, and never
 * reaches the transcript — see streamer.js for where it is applied and where
 * it is deliberately not.
 */

'use strict';

const COMPOSING_MARKER_TEXT = '🤖💬';

// The plain path's form. A blank line so it reads as its own line, and
// markdown emphasis because tg()'s formatter renders `em` as <i> — the same
// italic the rich block carries.
const COMPOSING_MARKER_SUFFIX = `\n\n_${COMPOSING_MARKER_TEXT}_`;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.styled=true] — emit the rich block's text as a typed
 *   italic node. The caller decides, and must decide from the CONTENT it is
 *   decorating, not from whether styling is available: blocksAreStyled reads
 *   the shape, so a styled marker on flat content makes the whole payload
 *   count as styled. rich-edit.js then records a styling verdict about it —
 *   an acceptance resets the latch's strike run, a refusal costs the
 *   styled→flatten retry — and every one of those verdicts would be about
 *   markup polygram injected rather than anything the agent wrote.
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
