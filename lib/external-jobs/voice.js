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
