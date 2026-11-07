import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const exec = promisify(execFile);
const action = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const loopback = fileURLToPath(new URL('../fixtures/linked/loopback.cjs', import.meta.url));

const manifestFile = new URL('./linked-e2e-manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
const failedReport = await readFile(new URL('./linked-e2e-report.json', import.meta.url), 'utf8');
const { workspaceId, suiteId, suiteRevisionId } = manifest;
const bindingId = '33333333-3333-4333-8333-333333333333';
const quoteId = '55555555-5555-4555-8555-555555555555';
const runId = '88888888-8888-4888-8888-888888888888';
const admissionId = '99999999-9999-4999-8999-999999999999';
const createRequestId = 'crq_action_return_window_fixture_0001';
const apiKey = 'aw_api_' + 'x'.repeat(43);
const apiOrigin = 'https://staging.augmentworks.ai';
const audience = 'https://augmentworks.ai/integrations/github/actions';
const version = 'aw-github-integration/1';
const prefix = '/v1/integrations/github/ci/admissions';
const config = [
  'version: 1', 'target:', '  name: fixture', '  connector: http', '  base_url: ${FIXTURE_TARGET}',
  '  operations:', '    send:', '      method: POST', '      path: /chat', '      request: $input',
].join('\n');

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('a clean runner reclaims the original linked quote, reports a pending run, then its failing criterion', { timeout: 60_000 }, async t => {
  let origin, originalRequest, createHash;
  let reservations = 0, quotes = 0, completed = false, targetConnections = 0;
  const issueBodies = [], selectors = [], creates = [], attaches = [], problems = [];
  const provider = new URL('https://example.actions.githubusercontent.com/token');
  const assertions = new Set();
  let minted = 0;
  let currentAttempt;

  const target = createServer();
  target.on('connection', socket => { targetConnections++; socket.destroy(); });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => new Promise(resolve => target.close(resolve)));
  const targetOrigin = 'https://127.0.0.1:' + target.address().port;

  async function handle(req, res) {
    const { pathname } = new URL(req.url, origin);
    const route = req.method + ' ' + pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (route === 'GET /token') {
      assert.equal(new URL(req.url, origin).searchParams.get('audience'), audience);
      assert.equal(req.headers.authorization, 'Bearer runner-request-token');
      const iat = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://token.actions.githubusercontent.com', aud: audience, iat, exp: iat + 300,
        run_attempt: String(currentAttempt), jti: String(++minted) };
      const token = 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture';
      assertions.add(token);
      return json(res, 200, { value: token });
    }
    assert.equal(req.headers.authorization, 'Bearer ' + apiKey);
    if (pathname.startsWith(prefix)) {
      assert.ok(assertions.delete(req.headers['x-github-actions-oidc']), 'a fresh job assertion accompanies each operation');
    } else {
      assert.equal(req.headers['x-github-actions-oidc'], undefined);
    }
    switch (route) {
      case 'GET /api/v1/cli/auth/me':
        return json(res, 200, {
          subject: 'fixture', principal_kind: 'machine', workspace_id: workspaceId, connector_id: 'ci', credential_id: 'fixture',
          scopes: ['connector:identity', 'connector:run'],
          actions: ['run:execute', 'run:read', 'suite:read', 'evaluation:read', 'criterion_detail:read', 'billing:read'],
        });
      case 'GET /v1/billing/capabilities':
        return json(res, 200, { schemaVersion: 'aw-billing/1', workspaceId, asOf: new Date().toISOString(), capabilities: ['quote_v1', 'status_v1', 'usage_v1'] });
      case 'GET /v1/suites/' + suiteId + '/revisions/' + suiteRevisionId:
        return json(res, 200, { workspaceId, suiteId, revisionId: suiteRevisionId, contentHash: manifest.suiteBinding.canonicalHash,
          canonicalDocument: { schemaVersion: 'aw-customer-suite/1' } });
      case 'POST /v1/billing/quote':
        assert.equal(quotes++, 0, 'a recovered request must not be requoted');
        assert.equal(body.assessment.suite_revision_id, suiteRevisionId);
        return json(res, 200, { schemaVersion: 'aw-billing/1', workspaceId, quoteId, executionUnits: 2, availableUnitsAtQuote: 8,
          assessmentPlanHash: 'a'.repeat(64), pricingVersion: 'aw-pricing/execution-unit/1',
          estimateOnly: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      case 'POST ' + prefix + '/recover':
        selectors.push(body);
        return json(res, 200, { schemaVersion: version, request: originalRequest ?? null });
      case 'POST ' + prefix:
        issueBodies.push(body);
        if (originalRequest) assert.deepEqual(body, originalRequest);
        originalRequest = body;
        if (issueBodies.length === 1) {
          // The platform persisted the request; the runner never received its admission.
          res.destroy();
          return;
        }
        return json(res, 200, {
          schemaVersion: version, bindingId, quoteId, suiteRevisionId, maxCredits: 4,
          executionPlanDigest: body.executionPlanDigest, target: { kind: 'fixed', origin: targetOrigin },
          admissionId, createRequestId, operationId: null, baselineId: null, runId: reservations ? runId : null,
        });
      case 'POST /v1/relay/run-intents:reconcile':
        assert.equal(body.create_request_id, createRequestId);
        assert.match(body.create_request_sha256, /^[a-f0-9]{64}$/);
        if (createHash) assert.equal(body.create_request_sha256, createHash);
        createHash = body.create_request_sha256;
        return json(res, 200, { protocol_version: 'aw-relay-recovery/0.1', create_request_id: createRequestId, create_request_sha256: createHash,
          outcome: reservations ? 'bound' : 'unknown', run_id: reservations ? runId : null,
          next_action: reservations ? 'inspect_or_resume_existing_run' : 'preserve_local_intent_and_retry',
          dashboard_url: reservations ? origin + '/portal/runs/' + runId : null });
      case 'POST /v1/relay/runs':
        assert.equal(body.ci_admission_id, admissionId);
        assert.equal(body.create_request_id, createRequestId);
        assert.equal(req.headers['idempotency-key'], createRequestId);
        assert.equal(body.quote_id, quoteId);
        assert.equal(body.max_credits, 4);
        creates.push(body);
        if (reservations === 0) {
          reservations++;
          // Commit the row and lose the acknowledgement. No local run ID survived this job.
          res.destroy();
          return;
        }
        assert.deepEqual(body, creates[0]);
        return json(res, 200, { protocol_version: 'aw-relay/0.3', create_request_id: createRequestId, create_request_sha256: createHash,
          create_disposition: 'replayed', run_id: runId, session_id: 'fixture-session', config_sha256: body.config_sha256,
          packet: { ...body.packet, sha256: '2'.repeat(64) }, fencing_epoch: 1, status: 'queued', credit_state: 'reserved',
          dashboard_url: origin + '/portal/runs/' + runId, run_expires_at: new Date(Date.now() + 60_000).toISOString() });
      case 'GET /v1/relay/runs/' + runId:
        return json(res, 200, { protocol_version: 'aw-relay/0.1', run_id: runId, status: completed ? 'completed' : 'running',
          outcome: completed ? 'failed' : null, credit_state: completed ? 'consumed' : 'reserved',
          ...(completed && { evaluation_status: 'complete' }), dashboard_url: origin + '/portal/runs/' + runId });
      case 'PUT ' + prefix + '/' + admissionId + '/run':
        assert.deepEqual(body, { schemaVersion: version, runId });
        attaches.push(body.runId);
        return json(res, 200, { ...body, admissionId });
      case 'GET /v1/billing/status':
        assert.ok(completed);
        return json(res, 200, { schemaVersion: 'aw-billing/1', workspaceId, runId, originalRunId: runId,
          executionStatus: 'completed', evaluationStatus: 'complete', outcome: 'failed', credit: { reservedUnits: 0, consumedUnits: 2, releasedUnits: 0, compensatedUnits: 0 },
          progress: { plannedAttempts: 1, completedAttempts: 1, plannedJudgeJobs: 1, completedJudgeJobs: 1 },
          savedEvidence: true, retryEligible: false, retryReason: null, nextActions: ['inspect'], asOf: new Date().toISOString(),
          dashboardUrl: origin + '/portal/runs/' + runId });
      case 'GET /v1/relay/runs/' + runId + '/report':
        assert.ok(completed);
        return json(res, 200, JSON.parse(failedReport.replaceAll('https://platform.invalid', origin)).report);
      default: {
        const { criteria } = JSON.parse(failedReport);
        const indexPath = '/v1/runs/' + runId + '/evaluations/' + criteria.evaluationId + '/attempts/' + criteria.attemptId + '/criteria';
        assert.equal(route, 'GET ' + indexPath);
        return json(res, 200, criteria);
      }
    }
  }

  const server = createServer((req, res) => handle(req, res).catch(error => {
    problems.push(error);
    if (!res.headersSent && !res.destroyed) json(res, 500, { error: { code: 'FIXTURE_ERROR' } });
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = 'http://127.0.0.1:' + server.address().port;

  async function attempt(attemptNumber) {
    const cwd = await mkdtemp(join(tmpdir(), 'aw-ci-fresh-'));
    currentAttempt = attemptNumber;
    try {
      await writeFile(join(cwd, 'augmentworks.yaml'), config);
      await copyFile(manifestFile, join(cwd, 'suite.json'));
      const env = {
        CI: 'true', HOME: cwd, RUNNER_TEMP: cwd, FIXTURE_SERVER: origin, FIXTURE_TARGET: targetOrigin,
        AUGMENTWORKS_STATE_DIR: join(cwd, 'state'), AUGMENTWORKS_API_KEY: apiKey,
        GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_JOB: 'policy',
        GITHUB_REPOSITORY: 'acme/fixture', GITHUB_REPOSITORY_ID: '123', GITHUB_REPOSITORY_OWNER_ID: '42',
        GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '1001', GITHUB_RUN_ATTEMPT: String(attemptNumber),
        GITHUB_WORKSPACE: cwd, GITHUB_OUTPUT: join(cwd, 'outputs'), GITHUB_STEP_SUMMARY: join(cwd, 'summary'),
        ACTIONS_ID_TOKEN_REQUEST_URL: provider.href, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token',
        INPUT_MODE: 'hosted', 'INPUT_GITHUB-LINK': 'required', 'INPUT_BINDING-ID': bindingId,
        'INPUT_SUITE-REVISION-ID': suiteRevisionId, 'INPUT_WORKSPACE-ID': workspaceId, 'INPUT_MAX-CREDITS': '4',
        INPUT_MANIFEST: 'suite.json', INPUT_SHARD: 'shard-000',
      };
      let exitCode = 0;
      try {
        await exec(process.execPath, ['--require', loopback, action], { env, cwd, timeout: 20_000 });
      } catch (error) {
        if (typeof error.code !== 'number') throw error;
        exitCode = error.code;
      }
      assert.deepEqual(problems, []);
      const raw = await readFile(env.GITHUB_OUTPUT, 'utf8');
      const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
      const values = Object.fromEntries(raw.trimEnd().split('\n').map(line => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }));
      assert.equal(values['exit-code'], String(exitCode), summary);
      assert.ok(!raw.includes(apiKey) && !summary.includes(apiKey));
      assert.ok(!(await readdir(cwd)).some(name => name.startsWith('augmentworks-admission-')));
      if (values['run-id']) {
        const provenance = JSON.parse(await readFile(values['provenance-path'], 'utf8'));
        assert.equal(provenance.run_id, runId);
        assert.equal(provenance.workflow_attempt, String(attemptNumber));
        assert.equal(provenance.revision_verification, 'unknown');
        assert.equal(values['report-url'], apiOrigin + '/portal/runs/' + runId);
      }
      return { exitCode, runId: values['run-id'], linkStatus: values['link-status'],
        failedChecks: JSON.parse(values['failed-checks']), detail: summary };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  const lostAdmission = await attempt(1);
  assert.equal(lostAdmission.exitCode, 4, lostAdmission.detail);
  assert.equal(lostAdmission.linkStatus, 'unconfirmed');
  assert.equal(reservations, 0);
  const interrupted = await attempt(2);
  assert.equal(interrupted.exitCode, 4, interrupted.detail);
  assert.equal(reservations, 1, interrupted.detail);
  assert.equal(attaches.length, 0);
  const pending = await attempt(3);
  assert.equal(pending.exitCode, 11, pending.detail);
  assert.equal(pending.linkStatus, 'linked');
  assert.equal(pending.runId, runId);
  completed = true;
  const failed = await attempt(4);
  assert.equal(failed.exitCode, 10, failed.detail);
  assert.equal(failed.linkStatus, 'linked');
  assert.deepEqual(failed.failedChecks, ['response-quality/0.1.0/R01/facts']);
  assert.deepEqual(attaches, [runId, runId]);
  assert.equal(quotes, 1);
  assert.equal(reservations, 1);
  assert.equal(issueBodies.length, 4);
  assert.equal(creates.length, 3);
  const selector = { schemaVersion: version, bindingId, suiteRevisionId, maxCredits: 4,
    jobKey: 'policy', matrixLeg: 'default', evaluationSlot: 'default' };
  assert.deepEqual(selectors, Array(4).fill(selector));
  assert.match(originalRequest.executionPlanDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(originalRequest, { ...selector, quoteId, executionPlanDigest: originalRequest.executionPlanDigest });
  assert.equal(assertions.size, 0);
  assert.equal(targetConnections, 0);
});
