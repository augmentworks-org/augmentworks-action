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

test('linked hosted inputs require an explicit saved shard and protect the platform key destination', async t => {
  const root = await directory(t);
  for (const name of ['augmentworks.yaml', 'augmentworks.assessment.yaml', 'selection.json']) await writeFile(join(root, name), '');
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const env = { GITHUB_WORKSPACE: root, GITHUB_JOB: 'policy', INPUT_MODE: 'hosted', 'INPUT_GITHUB-LINK': 'required',
    'INPUT_API-KEY': 'aw_api_' + 'x'.repeat(40), 'INPUT_MAX-CREDITS': '3', 'INPUT_WORKSPACE-ID': id,
    'INPUT_BINDING-ID': id, 'INPUT_SUITE-REVISION-ID': id, INPUT_SHARD: 'shard-000' };
  const options = await readInputs(env);
  assert.equal(options.jobKey, 'policy');
  const uppercase = await readInputs({ ...env, 'INPUT_BINDING-ID': id.toUpperCase(), 'INPUT_SUITE-REVISION-ID': id.toUpperCase() });
  assert.equal(uppercase.bindingId, id);
  assert.equal(uppercase.suiteRevisionId, id);
  assert.equal(options.assessment, join(root, 'augmentworks.assessment.yaml'));
  const child = childEnvironment({ ...env, AUGMENTWORKS_API_URL: 'https://other.example' }, options);
  assert.equal(child.AUGMENTWORKS_API_URL, 'https://staging.augmentworks.ai');
  const manifest = await readInputs({ ...env, INPUT_MANIFEST: 'selection.json', 'INPUT_PLATFORM-ENVIRONMENT': 'production' });
  assert.equal(manifest.assessment, undefined);
  assert.equal(manifest.manifest, join(root, 'selection.json'));
  assert.equal(manifest.apiOrigin, 'https://augmentworks.ai');
  for (const overrides of [
    { INPUT_ASSESSMENT: 'augmentworks.assessment.yaml', INPUT_MANIFEST: 'selection.json' },
    { INPUT_MODE: 'demo' }, { 'INPUT_GITHUB-LINK': 'off' }, { 'INPUT_GITHUB-LINK': 'optional' },
    { 'INPUT_PLATFORM-ENVIRONMENT': 'https://foo.example' }, { 'INPUT_BINDING-ID': '' },
    { 'INPUT_SUITE-REVISION-ID': 'latest' }, { INPUT_SHARD: '' }, { INPUT_SHARD: '--all-shards' },
    { 'INPUT_MATRIX-LEG': 'node24' }, { 'INPUT_EVALUATION-SLOT': '2' }, { 'INPUT_OPERATION-ID': id },
    { 'INPUT_DEPLOYMENT-ID': 'dpl_test' }, { 'INPUT_BASELINE-ID': id }, { AUGMENTWORKS_BASELINE_ID: id },
    { 'INPUT_TESTED-REVISION': 'a'.repeat(40) }, { 'INPUT_JOB-KEY': 'multi job' },
  ]) await assert.rejects(readInputs({ ...env, ...overrides }), { name: 'Error' });
});

test('linked mode rejects unprotected refs, unsupported events and missing run context', async () => {
  const env = { GITHUB_REPOSITORY: 'acme/repo', GITHUB_REPOSITORY_OWNER_ID: '12', GITHUB_REPOSITORY_ID: '123',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_REF_PROTECTED: 'true', GITHUB_REF: 'refs/heads/release', GITHUB_EVENT_NAME: 'push' };
  assert.equal((await readEvent(env, 'hosted', 'required')).workflow_attempt, '2');
  for (const override of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_REF_PROTECTED: 'false' }, { GITHUB_REF: 'refs/tags/v1' },
    { GITHUB_SHA: 'abc' }, { GITHUB_REPOSITORY_ID: '' }, { GITHUB_RUN_ATTEMPT: '0' }]) {
    await assert.rejects(readEvent({ ...env, ...override }, 'hosted', 'required'));
  }
});

test('fixed-target provenance reports the GitHub event commit and unknown deployed revision separately', async t => {
  const dir = await directory(t);
  const env = { RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') };
  const event = { event_sha: 'a'.repeat(40) };
  const options = { mode: 'hosted', githubLink: 'required' };
  const result = { runId: '11111111-1111-4111-8111-111111111111', linkStatus: 'linked', revisionVerification: 'unknown', exitCode: 11, outcome: 'incomplete' };
  const path = await writeProvenance(env, event, options, result);
  const doc = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(doc.link_status, 'linked');
  assert.equal(doc.event_sha, event.event_sha);
  assert.equal(doc.tested_revision, null);
  assert.equal(doc.revision_verification, 'unknown');
  await publishResult(env, result, path);
  assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /link-status=linked\nrevision-verification=unknown/);
});
