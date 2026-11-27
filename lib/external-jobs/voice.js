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

module.exports = { renderJobVoice, JOB_VOICE };
