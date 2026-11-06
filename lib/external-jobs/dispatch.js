'use strict';

const { isMailboxRequest } = require('../mailbox/service');

// The dispatch path every external job takes in the daemon: append the
// per-session tool instructions to the trusted task, record what was actually
// sent at the send point, and run the turn as a tracked external event.
function createExternalJobDispatch({ dispatchExternalEvent, runtime, getNotifications = () => null, getMailbox = () => null,
  logger = console, logEvent = () => {} }) {
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
    return dispatchExternalEvent({ ...job.target, eventId: job.requestId }, () => runtime.dispatch({
      ...job, task: job.task + (getNotifications()?.instructions(sessionKey) || '') + (mailbox?.instructions(sessionKey) || ''),
    }, { ...hooks, onSend: () => mailbox?.noteJobSend(job) }));
  };
}

module.exports = { createExternalJobDispatch };
