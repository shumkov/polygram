'use strict';

const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');
const root = mkdtempSync(path.join(os.tmpdir(), 'polygram-test-proxy-'));
const clientKeyFile = path.join(root, 'key');
const key = 'synthetic-proxy-fixture-key';
writeFileSync(clientKeyFile, key, { mode: 0o600 });
after(() => rmSync(root, { recursive: true, force: true }));
const access = { mode: 'trusted', commandPath: '/usr/bin:/bin' };
const proxy = { baseUrl: 'http://127.0.0.1:8318/v1', clientKeyFile };
const provider = { name: 'CLIProxyAPI', base_url: proxy.baseUrl, wire_api: 'responses',
  requires_openai_auth: false, experimental_bearer_token: key, supports_websockets: true };
module.exports = { policy: { access, proxy }, access, proxy, provider };
