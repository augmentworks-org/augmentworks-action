import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment, readEvent, readInputs } from '../src/inputs.mjs';
import { publishResult, writeProvenance } from '../src/reporting.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'aw action input '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('trust only same-repo hosted PRs and refuse privileged or unknown execution events', async t => {
  const dir = await directory(t);
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/repo', GITHUB_EVENT_PATH: join(dir, 'pr.json') };
  const event = { number: 7, pull_request: {
    base: { repo: { full_name: 'acme/repo' } }, head: { repo: { full_name: 'acme/repo', fork: true }, sha: 'a'.repeat(40) },
  } };
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  assert.equal((await readEvent(env, 'hosted')).pr_number, 7);
  event.pull_request.head.repo.full_name = 'stranger/repo';
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  await assert.rejects(readEvent(env, 'hosted'), /fork/);
  assert.equal((await readEvent(env, 'local')).pr_number, 7);
  await assert.rejects(readEvent({ ...env, GITHUB_EVENT_NAME: 'pull_request_target' }, 'local'), /Privileged/);
  await assert.rejects(readEvent({ ...env, GITHUB_EVENT_NAME: 'workflow_run' }, 'hosted'), /trusted/);
  await rm(env.GITHUB_EVENT_PATH);
  await assert.rejects(readEvent(env, 'hosted'), /verify/);
});

test('inputs stay in the checkout, hosted budget is explicit, and checkout metadata stays separate from target revision', async t => {
  const dir = await directory(t);
  const root = join(dir, 'application');
  await mkdir(root);
  await Promise.all(['augmentworks.yaml', 'augmentworks.assessment.yaml', 'packet.json'].map(name => writeFile(join(root, name), 'test')));
  const env = { GITHUB_WORKSPACE: root, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'outputs'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    AUGMENTWORKS_API_KEY: 'aw_api_' + 'x'.repeat(40), GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40) };
  const local = await readInputs({ ...env, INPUT_PACKET: '.' });
  assert.equal(local.packet, join(root, 'packet.json'));
  assert.equal(childEnvironment(env, local).AUGMENTWORKS_API_KEY, undefined);
  await assert.rejects(readInputs({ ...env, 'INPUT_WORKING-DIRECTORY': '..' }), /inside/);
  await assert.rejects(readInputs({ ...env, 'INPUT_MODE': 'hosted' }), /max-credits/);
  const hosted = await readInputs({ ...env, INPUT_MODE: 'hosted', 'INPUT_MAX-CREDITS': '0',
    'INPUT_WORKSPACE-ID': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'INPUT_TESTED-REVISION': 'b'.repeat(40) });
  assert.equal(hosted.maxCredits, 0);
  assert.equal(childEnvironment({ ...env, AUGMENTWORKS_API_URL: 'https://example.invalid' }, hosted).AUGMENTWORKS_API_URL, 'https://augmentworks.ai');
  const outcome = { outcome: 'failed', exitCode: 10, runId: 'local_run_abc', failedChecks: ['limit'] };
  const path = await writeProvenance(env, await readEvent(env, 'local'), local, outcome);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.tested_revision, null);
  assert.equal(evidence.event_sha, env.GITHUB_SHA);
  const hostedPath = await writeProvenance(env, await readEvent(env, 'hosted'), hosted, outcome);
  assert.equal(JSON.parse(await readFile(hostedPath, 'utf8')).tested_revision, hosted.testedRevision);
  await publishResult(env, outcome, path);
  assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /^failed-checks=\["limit"\]$/m);
  assert.match(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), /<code>limit<\/code>/);
});

test('reject a packet file that symlinks outside the workspace', { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t);
  const root = join(dir, 'app');
  await mkdir(root);
  await writeFile(join(root, 'augmentworks.yaml'), '');
  await writeFile(join(dir, 'private-file'), '');
  await symlink(join(dir, 'private-file'), join(root, 'packet.json'));
  await assert.rejects(readInputs({ GITHUB_WORKSPACE: root, INPUT_PACKET: '.' }), /inside/);
});
