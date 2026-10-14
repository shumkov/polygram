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
      return { outcome: 'succeeded', inactive: true, text: 'Synthetic document review complete' };
    },
    deliverPart: async () => ({ messageId: ++deliveries }),
  });
  const server = await start({ path: process.env.JOB_TEST_SOCKET, secret: 'synthetic-secret', handlers: createIpcHandlers({ externalJobs: jobs }), logger: { log() {}, error() {} } });
  jobs.start();
  process.send({ ready: true });
  process.on('message', async (message) => {
    if (message !== 'close') return;
    jobs.stop(); await jobs.tick(); await server.close(); db.raw.close(); process.exit(0);
  });
})().catch((error) => { process.send?.({ error: error.message }); process.exit(1); });
