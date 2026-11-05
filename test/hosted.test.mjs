import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { prepareCli } from '../src/cli.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHosted } from '../src/hosted.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const baselineId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actions = ['run:execute', 'suite:read', 'run:read', 'evaluation:read', 'criterion_detail:read', 'billing:read'];
const privateText = 'private text from the target';
const pass = {
  identity: { source: 'api_key', identity: { principal_kind: 'machine', workspace_id: workspaceId, actions } },
  quote: { ok: true, schemaVersion: 'aw-billing/1', workspaceId, estimateOnly: true, executionUnits: 3 },
  admit: { run_id: runId, status: 'completed', outcome: 'passed', dashboard_url: 'https://example.invalid/secret' },
  wait: { ok: true, exit_code: 0, assessment: 'passed', workspaceId, runId, originalRunId: runId },
  report: {
    schemaVersion: 'aw-run-report-export/1', complete: true, retrieved: true, criteria: [],
    report: { schemaVersion: 'aw-run-report/1', runId, workspaceId, createsBillableRun: false,
      executionStatus: 'completed', evaluationStatus: 'complete', reportReady: true, outcome: 'passed',
      attempts: [{ text: privateText }] },
  },
  gate: { ok: true, exit_code: 0, schemaVersion: 'aw-release-policy/1', comparability: 'compatible', evaluationStatus: 'complete', command: 'gate', createsBillableRun: false, candidateRunId: runId, baselineId, decision: 'pass' },
};

async function setup(t, overrides = {}, inputs = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'aw hosted action '));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const commands = [];
  async function cli(args) {
    assert.equal(args.at(-1), '--json');
    assert.equal(args[args.indexOf('--workspace') + 1], workspaceId);
    const command = { whoami: 'identity', test: args.includes('--estimate') ? 'quote' : 'admit',
      run: args[1], gate: 'gate' }[args[0]];
    assert.ok(Object.hasOwn(pass, command));
    commands.push({ command, args });
    const [code, data] = overrides[command] ?? [0, pass[command]];
    return { code, stdout: JSON.stringify(data), stderr: privateText };
  }
  const run = () => runHosted({ cwd, config: 'target config.yaml', assessment: 'run.yaml',
    maxCredits: '3', workspaceId, baselineId, outputDir: join(cwd, 'out'), cli, ...inputs });
  return { run, commands };
}

test('quotes before admitting exactly once; waits, retrieves, and gates the original run', async t => {
  const { run, commands } = await setup(t, { admit: [11, { run_id: runId, evaluation_status: 'pending' }] });
  const result = await run();
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.reportUrl, 'https://augmentworks.ai/portal/runs/' + runId);
  assert.deepEqual(commands.map(c => c.command), ['identity', 'quote', 'admit', 'wait', 'report', 'gate']);
  const [{ args: quote }, { args: admit }] = commands.slice(1, 3);
  const base = ['test', '--headless', '--config', 'target config.yaml', '--assessment', 'run.yaml'];
  assert.deepEqual(quote, [...base, '--estimate', '--workspace', workspaceId, '--json']);
  assert.deepEqual(admit, [...base, '--max-credits', '3', '--yes', '--workspace', workspaceId, '--json']);
  for (const item of commands.slice(3)) assert.ok(item.args.includes(runId));
  const saved = await readFile(result.reportPath, 'utf8');
  assert.ok(!saved.includes(privateText));
  assert.equal(JSON.parse(saved).quotedCredits, 3);
  if (process.platform !== 'win32') assert.equal((await stat(result.reportPath)).mode & 0o777, 0o600);
  assert.equal((await run()).exitCode, 2);
  assert.equal(commands.length, 6);
});

test('preflight prevents spending on wrong account, insufficient permissions, or an over-budget quote', async t => {
  for (const [overrides, expected] of [
    [{ identity: [0, { source: 'store', identity: {} }] }, 3],
    [{ identity: [0, { ...pass.identity, identity: { ...pass.identity.identity, workspace_id: runId } }] }, 3],
    [{ identity: [0, { ...pass.identity, identity: { ...pass.identity.identity, actions: ['run:read'] } }] }, 3],
    [{ quote: [0, { ...pass.quote, workspaceId: runId }] }, 4],
    [{ quote: [0, { ...pass.quote, executionUnits: '3' }] }, 4],
    [{ quote: [0, { ...pass.quote, executionUnits: 4 }] }, 13],
    [{ quote: [13, { err: privateText }] }, 13],
  ]) {
    const { run, commands } = await setup(t, overrides);
    assert.equal((await run()).exitCode, expected);
    assert.ok(!commands.some(item => item.command === 'admit'));
  }
  for (const maxCredits of [undefined, '', -1, '1e3', 1.25, Infinity]) {
    const { run, commands } = await setup(t, {}, { maxCredits });
    assert.equal((await run()).exitCode, 2);
    assert.equal(commands.length, 0);
  }
});

test('ambiguous admission is never retried; pending and mismatched waits never reach the gate', async t => {
  for (const [overrides, expectedCode, knownRun] of [
    [{ admit: [0, {}] }, 4, ''],
    [{ admit: [4, { ok: false, run_id: runId }] }, 4, runId],
    [{ wait: [11, { ok: false }] }, 11, runId],
    [{ wait: [0, { ...pass.wait, originalRunId: baselineId }] }, 4, runId],
    [{ report: [0, { ...pass.report, complete: false }] }, 4, runId],
    [{ report: [0, { ...pass.report, report: { ...pass.report.report, reportReady: false } }] }, 11, runId],
  ]) {
    const { run, commands } = await setup(t, overrides);
    const result = await run();
    assert.equal(result.exitCode, expectedCode);
    assert.equal(result.runId, knownRun);
    assert.equal(commands.filter(item => item.command === 'admit').length, 1);
    assert.ok(!commands.some(item => item.command === 'gate'));
  }
});

test('reports only failed requirement keys and never overrides a failing candidate with a green gate', async t => {
  const failed = { ...pass.report, report: { ...pass.report.report, outcome: 'failed' }, criteria: [
    { required: true, verdict: 'fail', criterionKey: 'refund/policy-limit', evidence: privateText },
    { required: true, verdict: 'fail', criterionKey: 'aw_api_' + 'x'.repeat(48) },
    { required: false, verdict: 'fail', criterionKey: 'advisory' },
  ] };
  const { run } = await setup(t, {
    admit: [10, { ...pass.admit, outcome: 'failed' }],
    wait: [10, { ...pass.wait, exit_code: 10, assessment: 'failed' }], report: [10, failed],
  });
  const result = await run();
  assert.equal(result.exitCode, 10);
  assert.deepEqual(result.failedChecks, ['refund/policy-limit']);
  const published = await readFile(result.reportPath, 'utf8');
  assert.doesNotMatch(published, /aw_api_|private text|advisory|example\.invalid/);
});

test('can inspect without a pin; gate block, error, or different candidate fail the step', async t => {
  const without = await setup(t, {}, { baselineId: '' });
  assert.equal((await without.run()).exitCode, 0);
  assert.ok(!without.commands.some(c => c.command === 'gate'));
  for (const [gate, expected] of [
    [[10, { ...pass.gate, decision: 'block', exit_code: 10 }], 10],
    [[12, { ok: false }], 12], [[0, { ...pass.gate, candidateRunId: baselineId }], 4],
    [[0, { ...pass.gate, evaluationStatus: 'pending' }], 4],
  ]) {
    const { run } = await setup(t, { gate });
    assert.equal((await run()).exitCode, expected);
  }
});

test('the bundled CLI authenticates the machine key on loopback; read-only key cannot reach billing', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'aw hosted cli '));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const paths = [];
  const key = 'aw_api_' + 'f'.repeat(43);
  const api = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    paths.push(path);
    const valid = path === '/api/v1/cli/auth/me' && req.headers.authorization === 'Bearer ' + key;
    res.writeHead(valid ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(valid ? {
      subject: 'ci-test', connector_id: 'runner', workspace_id: workspaceId, principal_kind: 'machine',
      scopes: ['connector:identity'], actions: ['run:read'],
    } : { error: 'denied' }));
  });
  await new Promise((resolve, reject) => { api.on('error', reject); api.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => api.close(resolve)));
  const runner = await prepareCli({ cwd, env: {
    AUGMENTWORKS_API_URL: 'http://127.0.0.1:' + api.address().port,
    AUGMENTWORKS_API_KEY: key, AUGMENTWORKS_HEADLESS: '1', HOME: cwd,
  } });
  t.after(() => runner.close());
  const result = await runHosted({
    cwd, config: 'config.yaml', assessment: 'assessment.yaml',
    maxCredits: 1, workspaceId, cli: runner.cli, outputDir: join(cwd, 'out'),
  });
  assert.equal(result.exitCode, 3);
  assert.match(result.detail, /run:execute/);
  assert.deepEqual(paths, ['/api/v1/cli/auth/me']);
});
