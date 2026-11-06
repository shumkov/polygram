'use strict';

// The dispatch path every external job takes in the daemon: append the
// per-session tool instructions to the trusted task, record what was actually
// sent at the send point, and run the turn as a tracked external event.
function createExternalJobDispatch({ dispatchExternalEvent, runtime, getNotifications = () => null, getMailbox = () => null }) {
  return function dispatch(job, hooks = {}) {
    const mailbox = getMailbox();
    const { sessionKey } = job.target;
    return dispatchExternalEvent({ ...job.target, eventId: job.requestId }, () => runtime.dispatch({
      ...job, task: job.task + (getNotifications()?.instructions(sessionKey) || '') + (mailbox?.instructions(sessionKey) || ''),
    }, { ...hooks, onSend: () => mailbox?.noteJobSend(job) }));
  };
}

module.exports = { createExternalJobDispatch };
