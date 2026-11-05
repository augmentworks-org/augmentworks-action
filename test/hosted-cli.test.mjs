import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareCli } from '../src/cli.mjs';
import { runHosted } from '../src/hosted.mjs';

test('the bundled CLI authenticates to a loopback workspace and stops at an over-budget quote', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'aw-action-quote-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const key = 'aw_api_' + 'x'.repeat(43);
  const calls = [];
  const server = createServer((req, res) => {
    calls.push([req.method, req.url]);
    const ok = req.headers.authorization === 'Bearer ' + key;
    let data;
    if (ok && req.method === 'GET' && req.url === '/api/v1/cli/auth/me') {
      data = {
        subject: 'fixture', principal_kind: 'machine', workspace_id: workspaceId,
        connector_id: 'test-runner', credential_id: 'test-machine',
        scopes: ['connector:identity', 'connector:run'],
        actions: ['run:execute', 'run:cancel', 'suite:read', 'run:read', 'evaluation:read', 'criterion_detail:read', 'billing:read'],
      };
    }
    if (ok && req.method === 'GET' && req.url === '/v1/billing/capabilities') {
      data = { schemaVersion: 'aw-billing/1', asOf: new Date().toISOString(), capabilities: ['usage_v1', 'quote_v1'], workspaceId };
    }
    if (ok && req.method === 'POST' && req.url === '/v1/billing/quote') {
      data = {
        schemaVersion: 'aw-billing/1', quoteId: '55555555-5555-4555-8555-555555555555', workspaceId,
        assessmentPlanHash: 'a'.repeat(64), pricingVersion: 'aw-pricing/execution-unit/1',
        executionUnits: 30, availableUnitsAtQuote: 100, estimateOnly: true,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    }
    res.writeHead(data ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data ?? { error: { code: 'fixture_route_missing' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const client = await prepareCli({ cwd, tempDir: cwd, env: {
    AUGMENTWORKS_API_URL: origin, AUGMENTWORKS_API_KEY: key, AUGMENTWORKS_WORKSPACE_ID: workspaceId,
    CHATBOT_BASE_URL: origin, CHATBOT_API_KEY: 'synthetic-only', CI: 'true',
  } });
  t.after(() => client.close());
  const initialized = await client.cli(['init', '--agent', '--starter', 'response-quality']);
  assert.equal(initialized.code, 0);
  const result = await runHosted({
    config: 'augmentworks.yaml', assessment: 'augmentworks.assessment.yaml',
    maxCredits: 1, workspaceId, cli: client.cli, outputDir: join(cwd, 'output'),
  });
  assert.equal(result.exitCode, 13, JSON.stringify({ result, calls }));
  assert.match(result.detail, /30 credits/);
  assert.deepEqual(calls, [
    ['GET', '/api/v1/cli/auth/me'], ['GET', '/api/v1/cli/auth/me'],
    ['GET', '/v1/billing/capabilities'], ['POST', '/v1/billing/quote'],
  ]);
});
