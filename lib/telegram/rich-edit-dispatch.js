/**
 * Rich rendering for the `edit_message` tool: decide, then edit.
 *
 * Sibling of rich-dispatch.js, which does the same job for `reply`. It lives
 * here rather than in the channels dispatcher because rich-media.js requires
 * that module — importing the rich modules from there would close a require
 * cycle — and because the decision is worth testing without a dispatcher
 * around it.
 *
 * The split into plan() + edit() is the whole point. A rich-eligible edit may
 * run to the rich ceiling; everything else is bound by the caller's plain one.
 * The caller therefore has to know WHICH ceiling applies before anything
 * reaches the network — otherwise an oversized body rides a rich attempt down
 * to its plain fallback and comes back as Telegram's raw "message is too
 * long", after the bubble has already been rewritten. So plan() resolves the
 * flag, the latch, the body and the blocks without sending anything, and never
 * throws; edit() is the only half that talks to Telegram.
 *
 * Media is deliberately out of scope. Rendering runs on media-stripped text —
 * no resolver, no mediaContext, no preflight — so `![shot](/abs/path)`
 * degrades to its caption exactly as on every other path that cannot upload,
 * and no branch can render an absolute local path into the chat. Media in an
 * edit would need its own resolver and TOCTOU story; it is a separate feature
 * if it is ever one.
 */

'use strict';

const {
  toTelegramRichBlocks,
  needsRichRendering,
  stripMediaMarkdown,
  RICH_MAX_LEN,
} = require('./rich');

// Did the render actually produce structure, or just prose?
//
// The gate that admits text to the renderer is pattern-based and therefore
// looser than the parser: `---|` at the start of a line satisfies the
// table-row pattern, but marked needs a header row to build a table, so a
// megabyte of prose with one such line renders as paragraphs and nothing
// else. Sending that as rich would ship a document of plain prose AND hand it
// the 32k ceiling on the strength of structure it does not have.
//
// So the verdict comes from the rendered tree, not from the source: anything
// other than a paragraph is structure. A list, table, heading, blockquote,
// divider, details or code block all qualify; a tree of paragraphs does not.
// Top-level is enough — a paragraph cannot contain blocks, so structure
// nested anywhere has a non-paragraph ancestor here.
function hasStructuralBlock(blocks) {
  return (blocks || []).some((b) => b && typeof b.type === 'string' && b.type !== 'paragraph');
}

/**
 * @param {object} deps
 * @param {Function} deps.editRich — ({chatId, threadId, messageId, blocks, sourceText})
 *   → Promise<{result, wentRich}>; polygram wires richEditMessageText (bot and
 *   phase closed over). Contracted to RETHROW transients, which is why edit()
 *   does not catch: the caller owns the tool result.
 * @param {(chatId, threadId) => boolean} deps.isRichTextEnabled — resolved per
 *   call against live config, so a config change mid-session applies at once
 * @param {() => boolean} [deps.getRichKnownUnsupported] — the EDIT verb's
 *   capability latch, the same one richEditMessageText consults
 * @param {Function} [deps.toRichBlocks] — markdown → { blocks, usedRich }
 * @param {() => boolean} [deps.isInlineStylingEnabled] — process-wide styling
 *   verdict, re-read per edit so a latch that trips applies to the next one
 * @param {number} [deps.richMaxLen]
 * @param {(s: string) => string} [deps.redactError]
 * @param {object} [deps.logger]
 * @returns {{plan: Function, edit: Function}}
 */
function createRichEditStrategy({
  editRich,
  isRichTextEnabled,
  getRichKnownUnsupported = () => false,
  toRichBlocks = toTelegramRichBlocks,
  isInlineStylingEnabled = () => false,
  richMaxLen = RICH_MAX_LEN,
  redactError = (s) => s,
  logger = console,
} = {}) {
  if (typeof editRich !== 'function') {
    throw new TypeError('rich-edit-dispatch: editRich required');
  }
  if (typeof isRichTextEnabled !== 'function') {
    throw new TypeError('rich-edit-dispatch: isRichTextEnabled required');
  }

  return {
    /**
     * Pure: no network, no throw. Returns the mode, the body that mode would
     * deliver, and the length cap that applies to it.
     *
     * @param {object} args
     * @param {number} args.plainMaxLen — the caller's single-bubble cap, used
     *   whenever this edit is not rich-shaped
     * @returns {{mode: 'rich'|'plain', text: string, maxLen: number, blocks?: Array}}
     */
    plan({ chatId, threadId = null, text, plainMaxLen }) {
      const plain = (body, maxLen = plainMaxLen) => ({ mode: 'plain', text: body, maxLen });

      // Flag off → this chat never opted into rich. Behave exactly as before,
      // raw markdown included: rewriting text here would change delivery for a
      // chat that asked for nothing.
      let richCapable = false;
      try { richCapable = isRichTextEnabled(chatId, threadId) === true; }
      catch (err) { logger?.error?.(`[rich-edit-dispatch] richText gate failed: ${redactError(String(err?.message || err))}`); }
      if (!richCapable) return plain(text);

      // From here the chat IS rich-enabled, so no branch may render a local
      // path — including the branches that end up delivering plain.
      //
      // keepPathlessFragments: an edit arrives COMPLETE. The streaming
      // projection cuts any dangling "![alt" because the rest of the path may
      // still be on its way; here nothing is on its way, so that same cut just
      // eats the tail of a sentence the agent finished writing. Only a
      // fragment that has opened its destination and shows a separator can
      // leak a path, and that one still goes.
      const body = stripMediaMarkdown(text, { keepPathlessFragments: true }) ?? '';

      try { if (getRichKnownUnsupported() === true) return plain(body); }
      catch { return plain(body); }

      // The gate toRichBlocks applies internally, asked first so the cap can
      // be resolved without rendering. Rich typography is for structure —
      // ordinary prose sent through it renders oversized with no knob to
      // correct it — so prose stays plain and stays on the plain cap.
      //
      // This gate treats a divider or a blockquote as structure, so 6k of
      // prose ending in one `---` renders rich and takes the 32k ceiling.
      // That is deliberate: it is the same trigger set the REPLY path uses,
      // and an edit that rendered differently from the reply that created the
      // bubble would be the worse surprise. The rendered-output check below is
      // what keeps the loose PATTERNS from admitting prose that produced no
      // structure at all.
      let richShaped = false;
      try { richShaped = needsRichRendering(body) === true; } catch { richShaped = false; }
      if (!richShaped) return plain(body);

      // Rich-shaped content is measured against the rich ceiling even when it
      // busts it: reporting the plain cap for a chat that renders 32k
      // checklists would be a lie about what this chat accepts. Checked
      // BEFORE rendering — a body that cannot be sent either way should not
      // cost a parse.
      if (body.length > richMaxLen) return plain(body, richMaxLen);

      let blocks = null;
      try {
        const rendered = toRichBlocks(body, { inlineStyling: isInlineStylingEnabled() === true });
        if (rendered?.usedRich && Array.isArray(rendered.blocks) && rendered.blocks.length > 0
            // The source looked structural to the pattern gate; the tree is
            // what says whether it IS. Paragraph-only means the gate matched
            // something the parser did not build (see hasStructuralBlock), and
            // this edit is prose — plain, on the plain cap.
            && hasStructuralBlock(rendered.blocks)) {
          blocks = rendered.blocks;
        }
      } catch (err) {
        logger?.error?.(`[rich-edit-dispatch] render failed: ${redactError(String(err?.message || err))}`);
      }
      // A render that declined, failed, or produced no structure costs the
      // structure, never the edit.
      if (!blocks) return plain(body);

      return { mode: 'rich', text: body, blocks, maxLen: richMaxLen };
    },

    /**
     * The only half that talks to Telegram. Transients propagate by design.
     */
    edit({ chatId, threadId = null, messageId, blocks, sourceText }) {
      return editRich({ chatId, threadId, messageId, blocks, sourceText });
    },
  };
}

module.exports = { createRichEditStrategy };
