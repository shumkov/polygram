'use strict';

const { isMailboxRequest, jobTurn, NOTICE_REQUEST } = require('../mailbox/service');
const { renderJobVoice, reportOf } = require('./voice');

// Polygram's own delivery notice about an ask this session sent.
const isNotice = (job) => typeof job.requestId === 'string' && job.requestId.startsWith(NOTICE_REQUEST);

// The dispatch path every external job takes in the daemon: append the
// per-session tool instructions to the trusted task, record what was actually
// sent at the send point, and run the turn as a tracked external event.
function createExternalJobDispatch({ dispatchExternalEvent, runtime, getNotifications = () => null, getMailbox = () => null,
  getHistory = () => null, getPresence = () => null, logger = console, logEvent = () => {} }) {
  // What the chat shows while the job's turn runs (presence.js): typing, and
  // reactions on the job's card when it has one. Display only, so a failure
  // here leaves it out and the job runs as before.
  async function preparePresence(job, mailbox) {
    const presence = getPresence();
    if (!presence) return null;
    try { return await presence.prepare(job, { card: mailbox?.cardFor?.(job) ?? null }); }
    catch (error) {
      logger.warn?.(`[external-jobs] presence for ${job.requestId} left out: ${error?.code || error?.name || 'Error'}`);
      return null;
    }
  }
  // What of the turn's text is posted (voice.js): nothing for a delivery
  // notice or an explicit NO_REPLY, and the token is cut from any other text.
  // Applied here, so every job kind on both backends gets the same rule.
  function applyReport(job, result) {
    if (!result || typeof result !== 'object' || result.deferred) return result;
    const report = reportOf(result.text, { notice: isNotice(job) });
    if (report.silent) return { ...result, text: '', silent: report.silent };
    if (!report.stripped) return result;
    try { logEvent('job-report-no-reply-stripped', { request_id: job.requestId, session_key: job.target.sessionKey }); }
    catch { /* Telemetry is best effort. */ }
    return { ...result, text: report.text };
  }
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
    const run = async () => {
      // Prepared before the task, whose mailbox block mints this job's grant,
      // so preparing adds no wait between the grant and the send.
      const presence = await preparePresence(job, mailbox);
      return runtime.dispatch({
        // Every job turn is told who reads its final text, right after its
        // stored task; added here, so jobs stored earlier get it too. The
        // mailbox block carries a grant for this job that takes effect only
        // at the send point below, so a deferred job never activates it. A
        // mailbox delivery or notice also gets the Telegram links of what it
        // is about, read at this moment.
        ...job, task: job.task + renderJobVoice({ person: mailbox?.assistantName?.(sessionKey) ?? null })
          + (getNotifications()?.instructions(sessionKey) || '') + (mailbox?.links?.(job) || '')
          + (mailbox?.instructions(sessionKey, job) || '') + (getHistory()?.instructions(sessionKey, job) || ''),
      }, { ...hooks, onSend: () => { mailbox?.noteJobSend(job); getHistory()?.noteJobSend?.(job); }, presence })
        .then((result) => applyReport(job, result));
    };
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
