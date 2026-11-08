import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const sha = /^(?:[\da-f]{40}|[\da-f]{64})$/i;
export class InputError extends Error {}

function requireInput(condition, message) {
  if (!condition) throw new InputError(message);
}

function assertInside(root, path) {
  const subpath = relative(root, path);
  requireInput(subpath !== '..' && !subpath.startsWith('..' + sep) && !isAbsolute(subpath), 'Project inputs must stay inside the checked-out workspace.');
}

async function existingPath(root, base, value, label, allowedTypes) {
  const path = resolve(base, value);
  assertInside(root, path);
  let actual, info;
  try {
    actual = await realpath(path);
    info = await stat(actual);
  } catch {
    throw new InputError('Could not open ' + label + '. Check the caller checkout and working-directory.');
  }
  assertInside(root, actual);
  requireInput(allowedTypes.some(method => info[method]()), 'Invalid ' + label + ' path.');
  return actual;
}

export async function readInputs(env) {
  const input = name => {
    const value = env['INPUT_' + name.toUpperCase()] ?? '';
    requireInput(!/[\r\n\0]/.test(value), 'Action inputs must be single-line values.');
    return value.trim();
  };
  const mode = input('mode') || 'local';
  requireInput(['local', 'hosted', 'demo'].includes(mode), 'mode must be local, hosted, or demo.');
  const githubLink = input('github-link') || 'off';
  requireInput(['off', 'required'].includes(githubLink), 'github-link must be off or required.');
  const linked = githubLink === 'required';
  requireInput(!linked || mode === 'hosted', 'github-link: required needs hosted mode.');
  const linkedInputs = ['binding-id', 'suite-revision-id', 'shard', 'manifest', 'job-key', 'platform-environment', 'matrix-leg', 'evaluation-slot'];
  requireInput(linked || !linkedInputs.some(name => input(name)), 'Linked CI inputs require github-link: required and hosted mode.');
  requireInput(!input('operation-id') && !input('deployment-id'), 'Operation dispatch and preview deployments are unavailable in this Action.');
  const root = await realpath(env.GITHUB_WORKSPACE || process.cwd());
  const cwd = await existingPath(root, root, input('working-directory') || '.', 'working-directory', ['isDirectory']);
  const outputDir = resolve(cwd, input('output-dir') || join('.augmentworks', 'action-' + randomUUID()));
  assertInside(cwd, outputDir);
  const testedRevision = input('tested-revision');
  requireInput(!testedRevision || sha.test(testedRevision), 'tested-revision must be a full commit SHA of the target that will receive test requests.');
  const options = { mode, cwd, outputDir, testedRevision };
  if (mode === 'demo') return options;
  options.config = await existingPath(root, cwd, input('config') || 'augmentworks.yaml', 'config', ['isFile']);
  if (mode === 'local') {
    const value = input('packet');
    requireInput(value, 'Local mode needs the packet input. Select demo mode to try the built-in agent.');
    options.packet = value;
    if (value !== 'support-refunds-starter@0.1.0') {
      const path = await existingPath(root, cwd, value, 'packet', ['isDirectory', 'isFile']);
      options.packet = (await stat(path)).isDirectory()
        ? await existingPath(root, path, 'packet.json', 'packet.json', ['isFile']) : path;
    }
    return options;
  }
  options.githubLink = githubLink;
  if (linked) {
    requireInput(!testedRevision, 'A fixed target cannot attest a tested-revision in linked mode.');
    requireInput(!input('baseline-id') && !env.AUGMENTWORKS_BASELINE_ID, 'Linked fixed-target admission does not support baseline-id.');
    options.bindingId = input('binding-id').toLowerCase();
    options.suiteRevisionId = input('suite-revision-id').toLowerCase();
    requireInput(uuid.test(options.bindingId) && uuid.test(options.suiteRevisionId), 'Linked CI requires binding-id and suite-revision-id UUIDs.');
    options.jobKey = input('job-key') || env.GITHUB_JOB || '';
    requireInput(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(options.jobKey), 'Linked CI requires the enrolled job key.');
    options.shard = input('shard');
    requireInput(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/.test(options.shard), 'Linked CI requires one explicit saved-suite shard ID.');
    requireInput(['', 'default'].includes(input('matrix-leg')) && ['', 'default'].includes(input('evaluation-slot')), 'Linked CI supports only the default matrix leg and evaluation slot.');
    const environment = input('platform-environment') || 'staging';
    requireInput(['staging', 'production'].includes(environment), 'platform-environment must be staging or production.');
    options.apiOrigin = environment === 'production' ? 'https://augmentworks.ai' : 'https://staging.augmentworks.ai';
  }
  const manifest = input('manifest');
  if (manifest) {
    requireInput(!input('assessment'), 'Choose either a manifest or an assessment.');
    options.manifest = await existingPath(root, cwd, manifest, 'manifest', ['isFile']);
  } else {
    options.assessment = await existingPath(root, cwd, input('assessment') || 'augmentworks.assessment.yaml', 'assessment', ['isFile']);
  }
  const ceiling = input('max-credits');
  requireInput(/^\d+$/.test(ceiling) && Number.isSafeInteger(Number(ceiling)), 'Hosted mode requires an explicit nonnegative whole-number max-credits input.');
  options.maxCredits = Number(ceiling);
  options.apiKey = input('api-key') || env.AUGMENTWORKS_API_KEY;
  requireInput(typeof options.apiKey === 'string' && /^aw_api_[A-Za-z0-9_-]{32,256}$/.test(options.apiKey), 'Hosted mode requires a scoped AugmentWorks machine API key.');
  options.workspaceId = input('workspace-id') || env.AUGMENTWORKS_WORKSPACE_ID;
  requireInput(uuid.test(options.workspaceId), 'Hosted mode requires the expected workspace UUID.');
  options.baselineId = input('baseline-id') || env.AUGMENTWORKS_BASELINE_ID;
  requireInput(!options.baselineId || uuid.test(options.baselineId), 'baseline-id must be a pinned baseline UUID.');
  return options;
}

export async function readEvent(env, mode, githubLink = 'off') {
  const event = env.GITHUB_EVENT_NAME || '';
  const isPR = event === 'pull_request' || event === 'pull_request_target';
  let payload;
  if (mode !== 'demo' && event === 'pull_request_target') {
    throw new InputError('Use pull_request for assessments. Privileged pull_request_target workflows may not execute a customer test.');
  }
  if (githubLink === 'required') {
    requireInput(event === 'push' && env.GITHUB_REF_PROTECTED === 'true' && /^refs\/heads\/.+/.test(env.GITHUB_REF ?? ''),
      'Linked CI requires a push to an enrolled protected branch.');
    requireInput(/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') &&
      [env.GITHUB_REPOSITORY_ID, env.GITHUB_REPOSITORY_OWNER_ID, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].every(value => /^[1-9]\d{0,18}$/.test(value ?? '')),
      'Linked CI requires GitHub repository, commit, run and attempt identifiers.');
  }
  if (mode === 'hosted') {
    requireInput(['push', 'workflow_dispatch', 'pull_request', 'schedule', 'merge_group'].includes(event), 'Hosted mode requires a trusted push, dispatch, schedule, merge group, or same-repository pull request.');
  }
  if (isPR) {
    try {
      payload = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    } catch {
      if (mode === 'hosted') throw new InputError('Cannot verify pull request origin. Hosted execution was skipped.');
    }
    if (mode === 'hosted') {
      const pr = payload?.pull_request;
      const repository = env.GITHUB_REPOSITORY?.toLowerCase();
      requireInput(repository && pr?.head?.repo?.full_name?.toLowerCase() === repository &&
        pr?.base?.repo?.full_name?.toLowerCase() === repository,
        'Hosted mode skips fork or unverifiable pull requests.');
    }
  }
  return {
    repository: /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ? env.GITHUB_REPOSITORY : null,
    repository_id: /^\d+$/.test(env.GITHUB_REPOSITORY_ID ?? '') ? env.GITHUB_REPOSITORY_ID : null,
    event: /^[a-z_]+$/.test(event) ? event : null,
    event_sha: sha.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null,
    pr_number: Number.isSafeInteger(payload?.number) && payload.number > 0 ? payload.number : null,
    pr_head_sha: sha.test(payload?.pull_request?.head?.sha ?? '') ? payload.pull_request.head.sha : null,
    workflow_run_id: /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : null,
    workflow_attempt: /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ? env.GITHUB_RUN_ATTEMPT : null,
  };
}

export function childEnvironment(env, options) {
  const child = { ...env };
  for (const key of Object.keys(child)) {
    if (/^AUGMENTWORKS_(?:API_KEY|TOKEN|API_URL|WORKSPACE_ID|BASELINE_ID)$/i.test(key)) delete child[key];
  }
  if (options.mode === 'hosted') {
    Object.assign(child, {
      AUGMENTWORKS_API_URL: options.apiOrigin || 'https://augmentworks.ai',
      AUGMENTWORKS_API_KEY: options.apiKey,
      AUGMENTWORKS_WORKSPACE_ID: options.workspaceId,
    });
  }
  return child;
}
