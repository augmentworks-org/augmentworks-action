import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runLocal } from '../src/local.mjs';
import { prepareCli } from '../src/cli.mjs';

const packetFile = new URL('../fixtures/faq/packet.json', import.meta.url);

async function testCli(t, cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AUGMENTWORKS_|CHATBOT_)/i.test(key)) delete env[key];
  }
  const runtime = await prepareCli({ cwd, env });
  t.after(runtime.close);
  return runtime.cli;
}

async function project(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'AugmentWorks action '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('demo uses the published CLI to fail and fix the refund policy', async t => {
  const cwd = await project(t);
  const cli = await testCli(t, cwd);
  const result = await runLocal({ mode: 'demo', cwd, outputDir: 'evidence', cli });
  assert.equal(result.exitCode, 0, result.detail);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.reportPath, join(cwd, 'evidence', 'passing', 'report.json'));
  assert.equal(result.reportUrl, '');
  const corrected = JSON.parse(await readFile(result.reportPath, 'utf8'));
  const faulty = JSON.parse(await readFile(join(cwd, 'evidence', 'failing', 'report.json'), 'utf8'));
  assert.equal(corrected.run_id, result.runId);
  assert.equal(corrected.outcome, 'passed');
  assert.equal(faulty.outcome, 'failed');
  assert.ok(faulty.attempts.some(a => a.assertions.some(c => !c.passed && c.key === 'policy-limit-order-remains-paid')));
});

test('local mode reports a real failure and pass while keeping response data private', async t => {
  const cwd = await project(t);
  const cli = await testCli(t, cwd);
  const localPacket = JSON.parse(await readFile(packetFile, 'utf8'));
  const testToken = 'ci-local-action-fixture';
  let answer = 'Private test transcript. You have 7 days.';
  let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat' || req.headers.authorization !== 'Bearer ' + testToken) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    if (JSON.parse(body).message !== localPacket.scenarios[0].turns[0].content) {
      res.writeHead(400).end();
      return;
    }
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answer, finished: true }));
  });
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  assert.equal((await cli(['init', '--agent'])).code, 0);
  await writeFile(join(cwd, '.env'), 'CHATBOT_BASE_URL=http://127.0.0.1:' + server.address().port + '\nCHATBOT_API_KEY=' + testToken + '\n');
  await copyFile(packetFile, join(cwd, 'faq packet.json'));
  const options = { mode: 'local', cwd, packet: 'faq packet.json', cli };
  const before = await runLocal(options);
  assert.equal(before.exitCode, 10, before.detail);
  assert.equal(before.outcome, 'failed');
  assert.deepEqual(before.failedChecks, ['return-window-30-days']);
  assert.doesNotMatch(JSON.stringify(before), /Private test transcript|ci-local-action-fixture/);
  answer = 'You have 30 days to return the item.';
  const after = await runLocal(options);
  assert.equal(after.exitCode, 0, after.detail);
  assert.equal(after.outcome, 'passed');
  assert.deepEqual(after.failedChecks, []);
  assert.notEqual(before.reportPath, after.reportPath);
  assert.equal(requests, 2);
});

test('reuse, escape and symlinked report locations are refused before running the CLI', async t => {
  const cwd = await project(t);
  await writeFile(join(cwd, 'existing'), 'retain');
  await symlink(tmpdir(), join(cwd, 'link'));
  const never = () => { assert.fail('CLI must not start'); };
  for (const outputDir of ['existing', '../outside', 'link/nested', '.']) {
    const result = await runLocal({ mode: 'demo', cwd, outputDir, cli: never });
    assert.equal(result.exitCode, 2);
    assert.equal(result.reportPath, '');
  }
  assert.equal(await readFile(join(cwd, 'existing'), 'utf8'), 'retain');
});

test('a missing report or unexpected demo story fails closed without echoing child output', async t => {
  const cwd = await project(t);
  const cli = async () => ({ code: 0, stdout: 'sensitive response body', stderr: 'sensitive error' });
  for (const mode of ['local', 'demo']) {
    const result = await runLocal({ mode, cwd, packet: 'packet.json', cli });
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.outcome, 'error');
    assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  }
});
