// The op set the IPC server registers.
//
// Assembled here rather than inline at the call site so tests exercise the SAME
// object production serves. A test that builds its own handler map proves the
// transport works and nothing about which ops a running daemon actually answers
// — it would keep passing after an op was dropped.

'use strict';

const { buildBusySnapshot } = require('../queue-utils');
const { REFUSAL, refusal } = require('../mailbox/rules');
const { isReservedRouteId, JOB_BACKENDS } = require('../external-jobs/runtime');
const {
  assertClosedQualificationRequest,
  projectQualificationResponse,
} = require('../ops/clean-restart-qualification');

// Implicit and reserved routes belong to the mailbox inside the daemon. An
// IPC client may not submit to them or ask for their status, or a session
// address would become a way to reach any session of the bot. external_job_get
// still reads one job by its exact request id, as for configured routes.
function publicRoute(input) {
  if (isReservedRouteId(input?.routeId)) throw Object.assign(new Error('External job route is unavailable'), { code: 'EXTERNAL_JOB_ROUTE_UNAVAILABLE' });
  return input;
}

/**
 * @param {object} opts
 * @param {string} opts.botName
 * @param {object} opts.daemonIdentity
 * @param {() => Map<string, number>} opts.getInFlightHandlers — read late, not
 *   captured: the dispatcher's map is assigned during boot and replaced on
 *   reload, so a value bound at wiring time can go stale.
 * @param {(req) => any} opts.handleSendOverIpc
 * @param {(req) => any} opts.requestDeployRestart
 * @param {(req) => any} opts.requestForegroundCanaryTarget
 * @param {() => any} opts.inspectCleanRestartQualification
 * @param {object} [opts.mailbox] — the session mailbox. send and reply take
 *   the caller's session token separately from the message fields; identify
 *   takes only a token; submit is for configured system senders and has none.
 * @param {object} [opts.history] — scoped transcript reads; history_query
 *   takes the caller's session scope token separately from the query fields.
 */
function createIpcHandlers({
  botName,
  daemonIdentity,
  getInFlightHandlers,
  handleSendOverIpc,
  requestDeployRestart,
  requestForegroundCanaryTarget,
  inspectCleanRestartQualification,
  externalJobs = null,
  notifications = null,
  mailbox = null,
  history = null,
} = {}) {
  const requireJobs = () => {
    if (!externalJobs) throw new Error('External jobs are not enabled');
    return externalJobs;
  };
  const requireNotifications = () => { if (!notifications) throw new Error('Recorded notifications are disabled'); return notifications; };
  const requireMailbox = () => { if (!mailbox) throw refusal(REFUSAL.disabled, 'Mailbox is disabled'); return mailbox; };
  const requireHistory = () => { if (!history) throw new Error('History reads are not available'); return history; };
  const requestData = ({ op, id, secret, ...request }) => request;
  return {
    notify: (req) => requireNotifications().notify(requestData(req)),
    notification_get: (req) => requireNotifications().get(requestData(req)),
    notification_reinspect: (req) => requireNotifications().reinspect(requestData(req)),
    notification_status: (req) => requireNotifications().scopedStatus(req.scope),
    notification_wake: (req) => { const { scope, ...input } = requestData(req); return requireNotifications().schedule(scope, input); },
    mailbox_send: (req) => { const { token, ...input } = requestData(req); return requireMailbox().send(token, input); },
    mailbox_reply: (req) => { const { token, ...input } = requestData(req); return requireMailbox().reply(token, input); },
    mailbox_submit: (req) => requireMailbox().submit(requestData(req)),
    mailbox_identify: (req) => requireMailbox().identify(requestData(req)),
    mailbox_directory: (req) => { const { token, ...input } = requestData(req); return requireMailbox().directory(token, input); },
    mailbox_open: (req) => { const { token, ...input } = requestData(req); return requireMailbox().open(token, input); },
    history_query: (req) => { const { token, ...input } = requestData(req); return requireHistory().query(token, input); },
    external_jobs_info: () => externalJobs?.info() ?? { protocolVersion: 1, enabled: false, supportedBackends: [...JOB_BACKENDS] },
    external_job_submit: (req) => requireJobs().submit(publicRoute(requestData(req))),
    external_job_get: (req) => requireJobs().get(requestData(req)),
    external_jobs_status: (req) => requireJobs().status(publicRoute(requestData(req))),
    ping: async () => ({ pong: true, bot: botName }),

    identity: async () => ({ bot: botName, ...daemonIdentity }),

    // Deploy pre-flight: what would restarting this daemon interrupt right now?
    // Counts and session keys only — enough to decide, nothing quotable.
    busy: async () => buildBusySnapshot({
      inFlightHandlers: typeof getInFlightHandlers === 'function' ? getInFlightHandlers() : null,
      botName,
    }),

    deploy_restart: (req) => requestDeployRestart(req),

    foreground_canary_target: (req) => requestForegroundCanaryTarget(req),

    clean_restart_qualification: async (req) => {
      assertClosedQualificationRequest(req);
      let observation = null;
      try {
        observation = typeof inspectCleanRestartQualification === 'function'
          ? await inspectCleanRestartQualification()
          : null;
      } catch {}
      return projectQualificationResponse({
        botName,
        daemonIdentity,
        observation,
      });
    },

    send: (req) => handleSendOverIpc(req),
  };
}

module.exports = { createIpcHandlers };
