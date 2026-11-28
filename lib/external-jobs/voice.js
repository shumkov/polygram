'use strict';

// The agent's explicit silence, the same token a human turn honors. A job
// turn rarely ends with an empty text on purpose, so it needs a word for "post
// nothing".
const NO_REPLY = 'NO_REPLY';

// What every job turn is told about the text it writes, as the last thing in
// its prompt. A job turn is one no person in the chat started (another
// session's message, a polygram notice, a system sender's task, a
// notification batch). Its final text is posted to the chat as the job
// report: on the Claude CLI the final message, on Codex every message the
// turn wrote, joined. Without this an agent writes private turn summaries for
// an operator, in whatever language it thinks in, and follows the progress
// rules meant for a person waiting on it (a plan checklist first, no silent
// turn), which fill the topic with noise.
const LEAD = 'No person in this chat wrote to you in this turn.';
const NEED = 'a result, a problem, or a decision they must make, addressed to them, in the language they use in this chat.';
const NO_PLAN = 'Post no plan or progress note: the chat already shows that you are working.';
const JOB_VOICE = Object.freeze({
  cli: `${LEAD} Your final message is not a private summary: polygram posts it, word for word, to this chat as a message from you.`
    + ` If it would describe what you did, say that you posted nothing, or say that nothing was needed, make your entire final message exactly ${NO_REPLY}.`
    + ` Write a final message only when a person here needs it: ${NEED}`
    + ` If you already told them with the reply tool, end with ${NO_REPLY}. ${NO_PLAN}`,
  codex: `${LEAD} What you write is not a private summary: polygram joins every message you write in this turn and posts them, word for word, to this chat as a message from you.`
    + ` If what you would write describes what you did, says that you posted nothing, or says that nothing was needed, write nothing in this turn but exactly ${NO_REPLY}.`
    + ` Write only when a person here needs it: ${NEED} ${NO_PLAN}`,
});

// A delivery notice is polygram's status message to the session, and its text
// is never posted (reportOf). Codex has no reply tool, so it cannot speak to
// people in a notice turn at all; the notice card is the topic's view.
const NOTICE_VOICE = Object.freeze({
  cli: 'This notice is for you, not for the people in this chat: polygram does not post your final message in this turn.'
    + ' Use the reply tool only if a person here must know something now; post no plan or progress note.',
  codex: 'This notice is for you, not for the people in this chat: polygram posts nothing you write in this turn.',
});

// A person's assistant is their direct chat: its text is how the person
// learns that someone asked them something, even though the message's card
// in that chat already shows it.
const personVoice = (name, backend) => ` This is ${name}'s direct chat with you.`
  + ` If what you received asks something of ${name} or is for ${name}, tell ${name} ${backend === 'codex' ? 'in what you write' : 'with the reply tool or in your final message'}:`
  + ` who asks, what, by when, in ${name}'s language. Never end such a turn with ${NO_REPLY} before ${name} has been told.`;

// The paragraph that ends a job's prompt. `backend` is the target's backend
// (an unknown one gets the Claude CLI wording), `person` the name of the
// person whose assistant runs the turn, else null, and `notice` whether the
// job is a delivery notice, whose paragraph has no person sentence.
function renderJobVoice({ backend = 'cli', person = null, notice = false } = {}) {
  const kind = backend === 'codex' ? 'codex' : 'cli';
  if (notice) return NOTICE_VOICE[kind];
  return JOB_VOICE[kind] + (person ? personVoice(person, kind) : '');
}

const WORD = '(?<![\\p{L}\\p{N}_])NO_REPLY(?![\\p{L}\\p{N}_])';
const TOKEN = new RegExp(WORD, 'u');
const TOKENS = new RegExp(WORD, 'gu');
const READABLE = /[\p{L}\p{N}]/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
// Markup around the token, and the dash or punctuation that joins it to the
// rest of the text. Scanned character by character: this runs on the event
// loop over text an agent wrote, so it must stay linear.
const WRAP = '`*~';
const JOIN = /[\s:;,—–-]/u;
const isFence = (line) => { const start = line.trimStart(); return start.startsWith('```') || start.startsWith('~~~'); };

// The text without a token that is its first word, with the markup and
// joining punctuation after it ("NO_REPLY — nothing else" → "nothing else").
function cutLeading(text) {
  let i = text.length - text.trimStart().length;
  while (i < text.length && WRAP.includes(text[i])) i++;
  if (!text.startsWith(NO_REPLY, i)) return text;
  let j = i + NO_REPLY.length;
  if (j < text.length && WORD_CHAR.test(text[j])) return text;
  while (j < text.length && WRAP.includes(text[j])) j++;
  while (j < text.length && (JOIN.test(text[j]) || text[j] === '.' || text[j] === '!')) j++;
  return text.slice(j);
}

// The text without a token that is its last word, with the markup around it
// and the joining punctuation before it ("Done — NO_REPLY" → "Done").
function cutTrailing(text) {
  const end = text.trimEnd();
  const at = end.lastIndexOf(NO_REPLY);
  if (at < 0) return text;
  let k = at + NO_REPLY.length;
  while (k < end.length && WRAP.includes(end[k])) k++;
  if (k < end.length && (end[k] === '.' || end[k] === '!')) k++;
  if (k !== end.length || (at > 0 && WORD_CHAR.test(end[at - 1]))) return text;
  let i = at;
  while (i > 0 && WRAP.includes(end[i - 1])) i--;
  while (i > 0 && JOIN.test(end[i - 1])) i--;
  return end.slice(0, i);
}

// The text without the token where it is a control word: a line whose only
// readable content is the token (`NO_REPLY`, **NO_REPLY**, — NO_REPLY), and
// the first or last word of the whole text. Anywhere else, and inside fenced
// code, it is a mention (a result about this very rule, a code sample) and
// stays, since cutting it would garble the sentence. Null when nothing is cut.
function withoutToken(text) {
  const kept = [];
  let fenced = false;
  let dropped = false;
  let lastBlank = false;
  for (const line of text.split('\n')) {
    if (isFence(line)) fenced = !fenced;
    else if (!fenced && TOKEN.test(line) && !READABLE.test(line.replace(TOKENS, ''))) { dropped = true; continue; }
    const blank = !line.trim();
    // A dropped line between two blank lines would leave a double gap.
    if (dropped && blank && lastBlank) continue;
    if (!blank) dropped = false;
    lastBlank = blank;
    kept.push(line);
  }
  const lines = kept.join('\n');
  const cut = cutTrailing(cutLeading(lines));
  return cut === text ? null : cut.trim();
}

// What of a job turn's text polygram posts: `text` is what to post, `silent`
// why nothing is ('notice' or 'no-reply'), and `stripped` whether the token
// was cut from a text that is still posted. A delivery notice is polygram's
// own status message to the session, so its text is never posted. Otherwise
// silent when the text holds nothing a person could read once the token is
// gone: an exact NO_REPLY, the token in markdown, or a Codex turn whose joined
// messages were all NO_REPLY. A result written next to the token is posted
// without it, since silence there would lose something a person needed.
function reportOf(text, { notice = false } = {}) {
  if (notice) return { text: '', silent: 'notice', stripped: false };
  if (typeof text !== 'string' || !TOKEN.test(text)) return { text, silent: null, stripped: false };
  const kept = withoutToken(text);
  if (kept === null) return { text, silent: null, stripped: false };
  return READABLE.test(kept) ? { text: kept, silent: null, stripped: true } : { text: '', silent: 'no-reply', stripped: false };
}

module.exports = { renderJobVoice, reportOf, JOB_VOICE, NO_REPLY };
