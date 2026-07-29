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
      const body = stripMediaMarkdown(text) ?? '';

      try { if (getRichKnownUnsupported() === true) return plain(body); }
      catch { return plain(body); }

      // The gate toRichBlocks applies internally, asked first so the cap can
      // be resolved without rendering. Rich typography is for structure —
      // ordinary prose sent through it renders oversized with no knob to
      // correct it — so prose stays plain and stays on the plain cap.
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
        if (rendered?.usedRich && Array.isArray(rendered.blocks) && rendered.blocks.length > 0) {
          blocks = rendered.blocks;
        }
      } catch (err) {
        logger?.error?.(`[rich-edit-dispatch] render failed: ${redactError(String(err?.message || err))}`);
      }
      // A render that declined or failed costs the structure, never the edit.
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
