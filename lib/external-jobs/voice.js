'use strict';

// What every job turn is told about the text it writes. A job turn is one no
// person in the chat started (another session's message, a polygram notice, a
// system sender's task, a notification batch). Its final text is posted to
// the chat as the job report; on Codex that is every message the turn wrote,
// and on the Claude CLI a reply-tool message reaches the chat too. Without
// this an agent writes private turn summaries in whatever language it thinks
// in, and follows the progress rules meant for a person waiting on it (a plan
// checklist first, no silent turn), which fill the topic with noise.
const JOB_VOICE = 'No person in this chat wrote to you in this turn, yet any text you write in it is posted to the people here, like any message you send to this chat.'
  + ' Write only when a person here needs to know something: a result, a problem you found, or a decision they must make;'
  + ' write it to them, in the language they are using in this chat now.'
  + ' Otherwise write no text at all and just end the turn: that is the right outcome here.'
  + ' The chat already shows that you are working, so post no plan, checklist or progress note;'
  + ' and that nothing was needed, your own bookkeeping, or a restatement of what you received is not worth their time.';

// A person's assistant is their direct chat: its text is how the person
// learns that someone asked them something, even though the message's card
// in that chat already shows it.
const personVoice = (name) => ` This is ${name}'s direct chat with you. When what you received is for ${name} or asks something of ${name},`
  + ` telling ${name} is the point of this turn: say who is asking, what, and what they need from ${name}, even though the message card shows it.`;

// The paragraph appended to a job's stored task at dispatch. `person` is the
// name of the person whose assistant runs the turn, else null.
function renderJobVoice({ person = null } = {}) {
  return `\n${JOB_VOICE}${person ? personVoice(person) : ''}`;
}

// The agent's explicit silence, the same token a human turn honors. A job
// turn rarely ends with an empty text on purpose, so it needs a word for "post
// nothing".
const NO_REPLY = 'NO_REPLY';
const TOKEN = /(?<![\p{L}\p{N}_])NO_REPLY(?![\p{L}\p{N}_])/gu;
const READABLE = /[\p{L}\p{N}]/u;

// The text without the token: each word-bounded NO_REPLY is cut, a line it
// leaves blank is dropped, and runs of blank lines close up.
function withoutToken(text) {
  return text.split('\n').flatMap((line) => {
    const cut = line.replace(TOKEN, '');
    if (cut === line) return [line];
    const kept = cut.replace(/[ \t]{2,}/g, ' ').trim();
    return kept ? [kept] : [];
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
  if (typeof text !== 'string' || !text.includes(NO_REPLY)) return { text, silent: null, stripped: false };
  const kept = withoutToken(text);
  if (kept === text) return { text, silent: null, stripped: false };
  return READABLE.test(kept) ? { text: kept, silent: null, stripped: true } : { text: '', silent: 'no-reply', stripped: false };
}

module.exports = { renderJobVoice, reportOf, JOB_VOICE, NO_REPLY };
