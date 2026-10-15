'use strict';
const { open } = require('../../lib/db');
const { start } = require('../../lib/ipc/server');
const { createIpcHandlers } = require('../../lib/ipc/handlers');
const { createExternalJobService } = require('../../lib/external-jobs/service');

(async () => {
  const db = open(process.env.JOB_TEST_DATABASE);
  let executions = 0;
  let deliveries = 0;
  const jobs = createExternalJobService({
    config: { bot: { externalJobs: { enabled: true, routes: { review: { chatId: '42' } } } } }, db, botName: 'fixture',
    resolveTarget: () => ({ chatId: '42', threadId: null, sessionKey: '42' }),
    dispatch: async (_job, hooks) => {
      hooks.onTurnId(`turn-${++executions}`);
      if (_job.payload.crashAt === 'execution') {
        process.send({ boundary: 'execution' });
        await new Promise(() => {});
      }
      return { outcome: 'succeeded', inactive: true, text: 'Synthetic document review complete' };
    },
    deliverPart: async (job) => {
      if (job.payload.crashAt === 'report') {
        process.send({ boundary: 'report' });
        await new Promise(() => {});
      }
      return { messageId: ++deliveries };
    },
  });
  const handlers = createIpcHandlers({ externalJobs: jobs });
  if (process.env.JOB_TEST_DROP_ACK === '1') {
    const submit = handlers.external_job_submit;
    let drop = true;
    handlers.external_job_submit = (request) => {
      const receipt = submit(request);
      if (drop) { drop = false; process.send({ boundary: 'acceptance' }); return new Promise(() => {}); }
      return receipt;
    };
  }
  const server = await start({ path: process.env.JOB_TEST_SOCKET, secret: 'synthetic-secret', handlers, logger: { log() {}, error() {} } });
  if (process.env.JOB_TEST_HOLD_QUEUE !== '1') jobs.start();
  process.send({ ready: true });
  process.on('message', async (message) => {
    if (message === 'stats') { process.send({ stats: { executions, deliveries } }); return; }
    if (message !== 'close') return;
    jobs.stop(); await jobs.tick(); await server.close(); db.raw.close(); process.exit(0);
  });
})().catch((error) => { process.send?.({ error: error.message }); process.exit(1); });
