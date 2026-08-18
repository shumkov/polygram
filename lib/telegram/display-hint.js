/**
 * Polygram-side display constraints injected into every chat's system
 * prompt. This is INFRASTRUCTURE knowledge — the agent's business
 * logic shouldn't have to know that Telegram's `<pre>` block on a
 * portrait iPhone wraps at ~36 monospace chars. The agent decides
 * *what* to render; polygram tells it *how* the surface displays.
 *
 * Why a polygram concern, not an agent concern:
 *   - Same agent runs across surfaces (Telegram bot, CLI, future
 *     surfaces). Each has its own width / markdown / image support.
 *   - Mixing display rules into agent prompts means every agent doc
 *     has to be updated when Telegram's rendering changes (or when
 *     we onboard a new chat surface). Centralising here keeps
 *     `_shumabit-base.md` and friends focused on business logic.
 *   - Tested in isolation; no risk of agent drift breaking tables.
 *
 * Width budget — measured 2026-04-30 from production screenshots:
 *   - iPhone portrait, default Telegram font: ~36 monospace chars
 *     per line in a `<pre>` block before wrap.
 *   - iPhone landscape: ~70.
 *   - Desktop client (macOS, default): ~85+.
 * Agents see the conservative number (40) so output stays clean on
 * the smallest reasonable surface.
 */

'use strict';

const TELEGRAM_TABLE_WIDTH_BUDGET = 40;

// Plain-mode guidance avoids structures that Telegram's HTML rendering
// cannot display well. The prompt and delivery capability must agree so
// the agent is not encouraged to author unsupported structures.
const TABLES_AND_HEADERS_SECTION_PLAIN = [
  '### Tables — HARD RULE',
  '',
  `Before emitting any markdown table, count the longest row in characters (including pipes \`|\`, padding, and separator dashes). If that row is longer than ${TELEGRAM_TABLE_WIDTH_BUDGET}, you MUST NOT emit a table. Use row blocks instead.`,
  '',
  'This applies even when the user is on desktop. Tables don\'t scroll horizontally on mobile; they wrap and become unreadable. Row blocks always work on every surface.',
  '',
  '**Row block format:** one entity per paragraph, **bold** headline, then `Field: value` lines.',
  '',
  '```',
  '**Mini dress Keen → Black dress mini**',
  'COGS: ฿546 → ฿1144 (2.1×)',
  'Margin: 84.8% → 77% ↓',
  '',
  '**Tank top Sway → Top voluminous cotton**',
  'COGS: ฿360 → ฿947 (2.6×)',
  'Margin: 78.7% → 73% ↓',
  '```',
  '',
  'Do NOT start a wide table assuming the user can scroll. Decide BEFORE you start writing the first `|` whether all rows will fit. If unsure, use row blocks — they\'re always safe.',
  '',
  '### Other Telegram quirks',
  '',
  '- Headers `#`, `##`, `###` render as plain text — use **bold** for emphasis.',
  '- Horizontal rules render as a thin divider line.',
  '- Long replies stream in chunks; prefer concise structure over walls of text.',
].join('\n');

// Media guidance is separated out because it is NOT true on every path: a
// path that cannot resolve media degrades an image to its caption, and
// teaching syntax the delivering path discards makes the agent author
// constructs that silently vanish. Each caller states what its own path can
// do. It doubles as the exposure control — media traffic starts when the
// guidance does.
const INLINE_MEDIA_PARAGRAPHS = [
  '**Inline media:** use the unchanged `![caption](/abs/path/to/file.ext)` syntax on its own line. Local `.jpg`, `.jpeg`, `.png`, and `.webp` files become photos; `.mp4` becomes video; `.gif` becomes animation. Use an absolute path inside your workspace or the attachments staging dir. An unreachable path or unsupported type degrades to a plain "(media unavailable)" line — it will not error. Always accompany media with at least a sentence of substantive text.',
  '',
  '**Grouping media:** wrap consecutive supported media in `<tg-collage>…</tg-collage>` (grid) or `<tg-slideshow>…</tg-slideshow>` (swipeable) to send them as one mixed-media block.',
  '',
  '**At most 10 media items per reply.** Extras are dropped silently — you will not be told — so split a longer visual walkthrough across several replies.',
  '',
  '**Inline media or `files:`, not both.** A file you embed inline is already delivered; listing that same path in `files:` too sends it a second time as a separate message. Use inline media when the image belongs in the reply, and `files:` when you are handing over a document.',
  '',
  '**Media and live streaming do not mix.** A message that streams grows by editing, and an edited bubble can never gain media — images degrade to their caption text. When your answer includes media (inline images, a collage, a slideshow), skip streaming for that answer entirely: compose it and send ONE reply, with the media rendering inline in the rich document, pictures in place. Do not stream the prose first, and do not split the media into a separate message.',
  '',
];

// Rich-mode guidance is limited to the constructs detected by
// needsRichRendering so ordinary prose stays on the compact plain path.
const richSection = (inlineMedia) => [
  '### Rich formatting is available in this chat',
  '',
  'This chat has rich-text rendering enabled. Real Telegram markdown tables, headings (`#`/`##`/etc.), task lists, collapsible `<details>` blocks, blockquotes (`>`), and dividers (`---`) now render as an actual structured message, not flattened text. No character-width budget applies to tables here; write a normal markdown table.',
  '',
  '**Use the real construct instead of faking it with bold text and emoji.** In plain-mode chats you had to fake structure with **bold** pseudo-headers, emoji bullets (✅ ❓ 🕓, •, etc.), and plain-text separator lines, because headings and checkboxes rendered as flattened text there. That workaround is unnecessary here and looks worse than the real thing. When you catch yourself about to write a bold pseudo-heading or an emoji-bulleted list, use the actual construct instead:',
  '',
  '- A named group of items (e.g. "ready to apply" / "needs your input" / "deferred") → a real heading (`## Ready to apply`), not `**Ready to apply:**`.',
  '- A numbered sequence (steps, ranked facts, top-N) → a real ordered list (`1.` at line start, continuation lines indented under their item), not bold pseudo-items like `**1. First thing.**` on their own paragraphs. A real list renders with native numbering and hanging indentation; the bold fake renders as flat paragraphs that merely start with a digit.',
  '- A list of items each with a yes/no/pending state (approve this? confirm that?) → a real task list (`- [ ] item`), not `• item` with an emoji glued on.',
  '- A comparison or key/value summary → a real markdown table.',
  '- Rows and columns you are laying out yourself → a real markdown table, never hand-aligned columns inside a ``` fence. A fence is not a table: its columns are just whitespace you typed, so the client cannot re-lay-out them to fit and on a narrow screen the rows break mid-row and the alignment collapses into noise. Keep fences for code, logs, and command output you are quoting verbatim — including output that is already table-shaped, which you reproduce exactly rather than retype as a markdown table.',
  '- A quoted aside, caveat, or callout you want visually set apart → a real blockquote (`> like this`), not a bold prefix.',
  '- A visual break between distinct sections of a long reply → a real divider (`---` on its own line), the same way you already reach for it, but now it renders as a divider instead of literal dashes.',
  '- Verbose supporting detail (a diff, a log, raw output) you want available but not front-and-center → `<details><summary>Label</summary>...</details>`.',
  '',
  'Worked example — triaging a batch of items into groups, each item with its own state:',
  '',
  '```',
  '## Ready to apply',
  '',
  '- [ ] Merge the two lists into one (#18)',
  '- [ ] Fix the delivery-time wording (#4)',
  '',
  '## Need your input',
  '',
  '- [ ] Hemming service — confirm we can offer it (#11)',
  '',
  '## Deferred to v2',
  '',
  '- [ ] Size-guide page (#16)',
  '```',
  '',
  '**Task lists for progress:** `- [ ] pending step` / `- [x] done step` renders as a real checkbox list — the natural way to show multi-step progress, a batch of items awaiting confirmation, or anything else with a per-item done/pending state. Checkboxes carry meaning only when their states VARY or evolve: use them when some items are already `[x]` done, or when you will send an updated list with items checked off as you complete them. A list that would be all-`[ ]` forever is just a list — use plain bullets.',
  '',
  '**Collapsible detail:** wrap verbose logs/diffs/output you want available but not front-and-center in `<details><summary>Label</summary>...</details>`.',
  '',
  ...(inlineMedia ? INLINE_MEDIA_PARAGRAPHS : []),
  'Not every reply needs this — plain prose is still right for a normal conversational answer with no distinct items or sections. Reach for structure when the CONTENT is structured, not by default.',
  '',
  '### Other Telegram quirks',
  '',
  '- Horizontal rules render as a thin divider line.',
  '- Long replies stream in chunks; prefer concise structure over walls of text.',
].join('\n');

/**
 * @param {boolean} [richText] — whether this chat renders typed rich blocks
 * @param {object} [opts]
 * @param {boolean} [opts.inlineMedia] — whether the path that will DELIVER
 *   this chat's replies renders inline media. Off by default: promising media
 *   a path cannot deliver is the failure mode worth defaulting away from.
 */
function buildPolygramDisplayHint(richText = false, { inlineMedia = false } = {}) {
  const tablesSection = richText ? richSection(inlineMedia) : TABLES_AND_HEADERS_SECTION_PLAIN;
  return [
    '## Telegram display rules',
    '',
    'Your replies render in the Telegram client. Phone is the design target.',
    '',
    tablesSection,
    '',
    '### NEVER emit shell-context canned strings — HARD RULE',
    '',
    'You are running as a Telegram chat bot, NOT as a script being piped into a shell. Certain phrases are CLI-context boilerplate from the underlying environment and MUST NEVER appear in a reply, because the user sees them as a literal message from you and they look like a system error:',
    '',
    '- `No response requested.`',
    '- `No response needed.`',
    '- `Continuing...` as a standalone reply',
    '- Any other shell-prompt-style filler that acknowledges silence',
    '',
    'If a user message is short, ambiguous, or feels like a no-op acknowledgement (e.g. `okay`, `ok`, `yes`, `got it`, `thanks`), reply with a brief substantive line — acknowledge what you understood and what (if anything) you will do next. If you genuinely have nothing useful to say, ask ONE specific clarifying question. NEVER emit a placeholder or a shell-style canned string — the chat surface has no silent-no-op state. Every reply must be intentional content.',
  ].join('\n');
}

// Pre-computed default (richText:false) — kept as a named export for
// backward compatibility with any caller/test that imported the old
// constant directly.
const POLYGRAM_DISPLAY_HINT = buildPolygramDisplayHint(false);

/**
 * Append the polygram display hint to an existing systemPrompt option,
 * preserving the original shape (string / preset object / undefined).
 * Pure function — does not mutate input.
 *
 * Shapes handled (matches @anthropic-ai/claude-agent-sdk's Options.systemPrompt):
 *   - undefined / null     → returns `{ type: 'preset', preset: 'claude_code', append: hint }`
 *   - string               → returns `string + '\n\n' + hint`
 *   - { type: 'preset', append?: string }
 *                          → merges hint into `append`
 *   - other (string[], etc.) → returns input unchanged (caller's responsibility)
 *
 * @param {*} systemPromptOpt — current SdkOptions.systemPrompt value
 * @param {string} [hint]    — override the default hint (used by tests)
 * @returns {*} new systemPrompt option with the hint appended
 */
function appendDisplayHint(systemPromptOpt, hint = POLYGRAM_DISPLAY_HINT) {
  if (!hint) return systemPromptOpt;

  if (systemPromptOpt == null) {
    return { type: 'preset', preset: 'claude_code', append: hint };
  }

  if (typeof systemPromptOpt === 'string') {
    return `${systemPromptOpt}\n\n${hint}`;
  }

  if (typeof systemPromptOpt === 'object' && systemPromptOpt.type === 'preset') {
    const existingAppend = typeof systemPromptOpt.append === 'string' ? systemPromptOpt.append : '';
    const newAppend = existingAppend ? `${existingAppend}\n\n${hint}` : hint;
    return { ...systemPromptOpt, append: newAppend };
  }

  // Unknown shape (e.g. string[]) — return as-is. Caller can opt in
  // by passing a supported shape.
  return systemPromptOpt;
}

module.exports = {
  POLYGRAM_DISPLAY_HINT,
  TELEGRAM_TABLE_WIDTH_BUDGET,
  buildPolygramDisplayHint,
  appendDisplayHint,
  // Exactly what the media gate adds, so a test can subtract it rather than
  // pattern-match for it and miss a newly added paragraph.
  INLINE_MEDIA_PARAGRAPHS,
};
