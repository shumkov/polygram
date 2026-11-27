'use strict';

const { isMailboxRequest, jobTurn } = require('../mailbox/service');
const { renderJobVoice } = require('./voice');

// The dispatch path every external job takes in the daemon: append the
// per-session tool instructions to the trusted task, record what was actually
// sent at the send point, and run the turn as a tracked external event.
function createExternalJobDispatch({ dispatchExternalEvent, runtime, getNotifications = () => null, getMailbox = () => null,
  getHistory = () => null, logger = console, logEvent = () => {} }) {
  return function dispatch(job, hooks = {}) {
    const mailbox = getMailbox();
    // Kill switch: while the mailbox is disabled its queued jobs are
    // withdrawn unsent. Reporting them inactive is truthful, and keeps them
    // from holding the session's queue, notifications included.
    if (isMailboxRequest(job.requestId) && mailbox?.enabled !== true) {
      logger.warn?.(`[mailbox] withdrew ${job.requestId} unsent: the mailbox is disabled`);
      logEvent('mailbox-withdrawn', { request_id: job.requestId, route_id: job.routeId, session_key: job.target.sessionKey });
      return Promise.resolve({ outcome: 'failed', inactive: true, error: 'withdrawn' });
    }
    const { sessionKey } = job.target;
    const run = () => runtime.dispatch({
      // Every job turn is told who reads its final text, right after its
      // stored task; added here, so jobs stored earlier get it too. The
      // mailbox block carries a grant for this job that takes effect only
      // at the send point below, so a deferred job never activates it. A
      // mailbox delivery or notice also gets the Telegram links of what it is
      // about, read at this moment.
      ...job, task: job.task + renderJobVoice({ person: mailbox?.assistantName?.(sessionKey) ?? null })
        + (getNotifications()?.instructions(sessionKey) || '') + (mailbox?.links?.(job) || '')
        + (mailbox?.instructions(sessionKey, job) || '') + (getHistory()?.instructions(sessionKey, job) || ''),
    }, { ...hooks, onSend: () => { mailbox?.noteJobSend(job); getHistory()?.noteJobSend?.(job); } });
    return dispatchExternalEvent({ ...job.target, eventId: job.requestId }, () => {
      // A mailbox delivery whose card is still being posted waits for it
      // (bounded by the mailbox), so its prompt can carry the card's link.
      const ready = mailbox?.cardReady?.(job);
      return (ready ? ready.then(run) : run())
        // A person's assistant's grants end with the job's turn. Only the turn
        // this job started is ended, so a deferred job ends nothing.
        .finally(() => mailbox?.noteTurnEnd?.(sessionKey, jobTurn(job)));
    });
  };
}

module.exports = { createExternalJobDispatch };
