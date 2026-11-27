'use strict';

// Ordinary text-only agent replies that contain "![" without meaning an
// image, plus the helper that says which of their words a delivery lost.
// Shared by every test that pins "a text-only reply arrives whole".

// Words and emoji a reader must find. HTML tag names (`<summary>`) are
// markup, not content: a rich <details> block carries its summary as a
// field, never the tag.
const WORD_RE = /[\p{L}\p{N}]{2,}/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
function missing(text, wire) {
  const visible = text.replace(/<\/?[a-z][^>]*>/gi, ' ');
  const need = [...new Set([...(visible.match(WORD_RE) || []), ...(visible.match(EMOJI_RE) || [])])];
  return need.filter((w) => !wire.includes(w));
}

const E = ' ENDMARK';
const CASES = [
  ['prose vec![]', 'Replaced vec![] with Vec::new() in src/lib.rs' + E],
  ['prose JS ![1,2]', 'if (![1,2].includes(n)) in utils/x.js' + E],
  ['prose Wow![1] + path', 'Wow![1] neat, see /tmp/notes' + E],
  ['prose ![WIP] line start', '![WIP] still drafting the release notes' + E],
  ['prose ![ at line end', 'Typing ![\nnext line here' + E],
  ['prose wow![ in quotes', 'He said "wow![" and left' + E],
  ['code span image', 'Use `![alt](/abs/path.png)` to embed' + E],
  ['code span spaced image', 'Write `![alt](/path with spaces.png)` inline' + E],
  ['code span + trailing text', 'Syntax: `![a](/x.png)` then more text after it' + E],
  ['code span vec![]', 'Use `vec![]` for empty vectors' + E],
  ['fence ``` with images', 'Example:\n\n```md\n![fenced](/w/j k.png)\n![b](/w/b.png)\n```\nAfter fence' + E],
  ['fence ~~~ with image', '~~~\n![x](/a.png)\n~~~\nAfter tilde fence' + E],
  ['rust macros', 'let v = vec![1, 2, 3]; assert!(v.len() == 3); println!("{}", v[0]);' + E],
  ['rust matches![]', 'Call matches![x, Some(_)] in src/a.rs then return' + E],
  ['rust vec![](..)', 'Write vec![](see ./docs) never like that' + E],
  ['JS ![a,b].some', 'return ![a, b].some(Boolean) && ok(/x/)' + E],
  ['JS ![].length ./lib', 'const empty = ![].length; // see ./lib/a.js for why' + E],
  ['markdown links', 'See [the docs](https://example.com/a) and [file](/path/y.md) today' + E],
  ['link after "! "', 'Done! [PR 162](https://github.com/x/y/pull/162) merged' + E],
  ['cyrillic Готово![1]', 'Готово![1] Смотри /tmp/заметки сегодня' + E],
  ['cyrillic Внимание![важно]', 'Внимание![важно] файл лежит в ~/docs/a.md' + E],
  ['cyrillic ![см. (PR)]', 'Сделано![см. (PR 162)] всё работает' + E],
  ['footnotes [^1]', 'Claim[^1] and another![^2] here\n\n[^1]: Source text\n[^2]: Other text' + E],
  ['emoji ![🎉]', 'Party 🎉![🎉] launch 🚀 today' + E],
  ['emoji ![✅](not a path)', 'Готово ✅![✅](not a path) всё' + E],
  ['table w/ code + macro', '| expr | meaning |\n|---|---|\n| `![a](/b.png)` | image syntax |\n| vec![] | macro call |\n\nAfter table' + E],
  ['URL in parens', 'See the PR (https://github.com/shumkov/polygram/pull/162) for details' + E],
  ['URL in parens after ![', 'Note![1] (https://example.com/a) explains it' + E],
  ['![x] (/path) gap prose', 'Toggle ![x] (/settings/page) to enable' + E],
  ['bold Wow![1]', '**Wow![1]** and _done_ with it' + E],
  ['details w/ vec![]', '<details><summary>Log</summary>\n\nvec![] in src/x.rs line\n\n</details>\n\nAfter details' + E],
  ['escaped \\![', 'Literal \\![not image] stays text' + E],
  ['shell ![ -f ]', 'Run if ![ -f /etc/hosts ]; then echo missing; fi' + E],
  // Prose whose "![…](" destination starts like a path but names no media.
  ['cyrillic ![1] (/tmp/report.md)', 'Готово![1] (/tmp/report.md) лежит там' + E],
  ['See![note](./docs/read me.md)', 'See![note](./docs/read me.md) first' + E],
];

module.exports = { CASES, missing };
