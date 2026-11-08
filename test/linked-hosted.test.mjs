import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHosted } from '../src/hosted.mjs';

const schemaVersion = 'aw-github-integration/1';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const suiteRevisionId = '33333333-3333-4333-8333-333333333333';
const admissionId = '44444444-4444-4444-8444-444444444444';
const quoteId = '55555555-5555-4555-8555-555555555555';
const runId = '66666666-6666-4666-8666-666666666666';
const apiOrigin = 'https://staging.augmentworks.ai';
const jobKey = 'agent-regression';
const cap = 11;
const selector = { schemaVersion, bindingId, suiteRevisionId, maxCredits: cap, jobKey, matrixLeg: 'default', evaluationSlot: 'default' };
const planDigest = '8'.repeat(64);
const quoted = { ok: true, schemaVersion: 'aw-billing/1', estimateOnly: true, workspaceId, executionUnits: 3, quoteId, execution_plan_digest: planDigest };
const issued = { schemaVersion, admissionId, bindingId, suiteRevisionId, quoteId, maxCredits: 5, executionPlanDigest: planDigest,
  target: { kind: 'fixed', origin: 'https://agent.example.org' }, createRequestId: 'crq_' + 'a'.repeat(36), runId: null, baselineId: null, operationId: null };
const actions = ['run:execute', 'suite:read', 'run:read', 'evaluation:read', 'criterion_detail:read', 'billing:read'];

async function scenario(t, changes = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'aw-linked-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const events = [];
  const calls = [];
  const handoffs = [];
  const config = join(cwd, 'agent.yaml');
  const manifest = join(cwd, 'manifest.json');
  const argsBase = ['test', '--headless', '--config', config, '--manifest', manifest, '--shard', 'shard-one'];
  let persisted = null;
  let attempt = 0;
  const api = {
    async recover(body) {
      events.push('recover');
      assert.deepEqual(body, selector);
      return { schemaVersion, request: persisted };
    },
    async issue(body) {
      events.push('issue');
      calls.push(body);
      persisted = { ...body };
      return issued;
    },
    async attach(id, original) {
      events.push('attach');
      assert.equal(id, admissionId);
      assert.equal(original, runId);
      return { schemaVersion, admissionId, runId };
    },
    ...changes.api,
  };
  const cli = async args => {
    if (args[0] === 'whoami') {
      events.push('identity');
      return { code: 0, stdout: JSON.stringify({ source: 'api_key', identity: { principal_kind: 'machine', workspace_id: workspaceId, actions } }) };
    }
    if (args[1] === '--help') {
      events.push('help');
      return { code: 0, stdout: changes.help ?? '  --ci-admission <path>' };
    }
    if (args.includes('--estimate')) {
      events.push('estimate');
      assert.deepEqual(args, [...argsBase, '--estimate', '--workspace', workspaceId, '--json']);
      return { code: 0, stdout: JSON.stringify({ ...quoted, ...changes.quote }) };
    }
    assert.equal(args[0], 'test');
    const handoff = args[args.indexOf('--ci-admission') + 1];
    assert.deepEqual(args, [...argsBase, '--ci-admission', handoff, '--max-credits', '5', '--yes', '--workspace', workspaceId, '--json']);
    if (process.platform !== 'win32') assert.equal((await stat(handoff)).mode & 0o777, 0o600);
    handoffs.push(JSON.parse(await readFile(handoff, 'utf8')));
    events.push('test');
    return { code: 11, stdout: JSON.stringify({ status: 'running', run_id: runId, dashboard_url: 'https://arbitrary.invalid/secret', ...changes.run }) };
  };
  const run = () => runHosted({ config, manifest, shard: 'shard-one', bindingId, suiteRevisionId, jobKey,
    workspaceId, maxCredits: cap, githubLink: 'required', apiOrigin, cli, linked: { api, tempDir: cwd },
    outputDir: join(cwd, 'out-' + (++attempt)), ...changes.inputs });
  return { run, api, events, calls, handoffs, cwd };
}

test('fresh protected runners replay the original quote and cap after a lost issue response', async t => {
  const state = await scenario(t);
  const issue = state.api.issue;
  let loseResponse = true;
  state.api.issue = async body => {
    const response = await issue(body);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('credential not for logs');
    }
    return response;
  };
  const lost = await state.run();
  assert.equal(lost.exitCode, 4);
  assert.equal(lost.linkStatus, 'unconfirmed');
  assert.doesNotMatch(lost.detail, /credential/);
  const recovered = await state.run();
  assert.equal(recovered.exitCode, 11);
  assert.equal(recovered.runId, runId);
  assert.equal(recovered.admissionId, admissionId);
  assert.equal(recovered.linkStatus, 'linked');
  assert.equal(recovered.revisionVerification, 'unknown');
  assert.equal(recovered.reportUrl, apiOrigin + '/portal/runs/' + runId);
  assert.deepEqual(state.events, ['identity', 'help', 'recover', 'estimate', 'issue', 'identity', 'help', 'recover', 'issue', 'test', 'attach']);
  const expected = { ...selector, quoteId, executionPlanDigest: planDigest };
  assert.deepEqual(state.calls, [expected, expected]);
  assert.deepEqual(state.handoffs, [issued]);
  assert.deepEqual((await readdir(state.cwd)).filter(name => name.startsWith('augmentworks-admission-')), []);
  assert.doesNotMatch(await readFile(recovered.reportPath, 'utf8'), /arbitrary|createRequestId/);
});

test('unconfirmed recovery, changed inputs, unsupported CLI and invalid quotes fail before issue or run', async t => {
  const changed = { ...selector, quoteId, executionPlanDigest: planDigest, maxCredits: cap - 1 };
  for (const [changes, expectedCode] of [
    [{ api: { recover: async () => ({}) } }, 4],
    [{ api: { recover: async () => { throw new Error('secret'); } } }, 4],
    [{ api: { recover: async () => ({ schemaVersion, request: changed }) } }, 4],
    [{ quote: { execution_plan_digest: 'invalid' } }, 4],
    [{ quote: { quoteId: '' } }, 4],
    [{ quote: { executionUnits: cap + 1 } }, 13],
    [{ help: 'test' }, 2],
    [{ inputs: { linked: undefined } }, 2],
    [{ inputs: { baselineId: bindingId } }, 2],
    [{ inputs: { apiOrigin: 'https://untrusted.invalid' } }, 2],
    [{ inputs: { shard: '' } }, 2],
  ]) {
    const { run, events } = await scenario(t, changes);
    const actual = await run();
    assert.equal(actual.exitCode, expectedCode);
    assert.ok(!events.includes('issue') && !events.includes('test'));
    assert.doesNotMatch(actual.detail, /secret/);
  }
});

test('platform ceiling, original run match and attachment determine linked status', async t => {
  const belowQuote = await scenario(t, { api: { issue: async () => ({ ...issued, maxCredits: 2 }) } });
  assert.equal((await belowQuote.run()).exitCode, 13);
  assert.ok(!belowQuote.events.includes('test'));
  const conflict = await scenario(t, { api: { issue: async () => ({ ...issued, runId: bindingId }) } });
  const mismatched = await conflict.run();
  assert.equal(mismatched.exitCode, 4);
  assert.equal(mismatched.linkStatus, 'unconfirmed');
  assert.equal(mismatched.runId, bindingId);
  assert.ok(!conflict.events.includes('attach'));
  for (const attach of [async () => { throw new Error('private'); }, async () => ({ schemaVersion, admissionId, runId: bindingId })]) {
    const { run } = await scenario(t, { api: { attach } });
    const actual = await run();
    assert.equal(actual.exitCode, 4);
    assert.equal(actual.runId, runId);
    assert.equal(actual.admissionId, admissionId);
    assert.equal(actual.linkStatus, 'unconfirmed');
    assert.equal(actual.revisionVerification, '');
    assert.equal(actual.reportUrl, apiOrigin + '/portal/runs/' + runId);
    assert.doesNotMatch(actual.detail, /private/);
  }
});
