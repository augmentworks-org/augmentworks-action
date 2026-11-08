import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinkedApiError } from './linked-api.mjs';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isUuid = value => typeof value === 'string' && uuid.test(value);
const sameId = (left, right) => isUuid(left) && isUuid(right) && left.toLowerCase() === right.toLowerCase();
const digest = /^[a-f0-9]{64}$/;
const schemaVersion = 'aw-github-integration/1';

// The handoff contains the platform's exact response. A private, per-invocation
// directory keeps it outside the checkout and normal reports and artifacts.
async function executeAdmission({ call, testArgs }, admission, tempDir) {
  const directory = await mkdtemp(join(tempDir || tmpdir(), 'augmentworks-admission-'));
  try {
    const file = join(directory, 'admission.json');
    await writeFile(file, JSON.stringify(admission), { flag: 'wx', mode: 0o600 });
    return await call([...testArgs, '--ci-admission', file, '--max-credits', String(admission.maxCredits), '--yes']);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

// Only linked-api builds errors from allowlisted platform codes. Never publish an
// arbitrary transport error (it could include a credential, URL or response body).
function apiDetail(error, fallback) {
  return error instanceof LinkedApiError ? error.message : fallback;
}

export async function startLinkedRun(options, start, result) {
  const { bindingId, suiteRevisionId, jobKey, cli, linked } = options;
  if (!linked?.api || !isUuid(bindingId) || !isUuid(suiteRevisionId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(jobKey ?? '')) {
    return { error: result(2, 'Linked mode requires a binding, immutable suite revision, verified job key and platform recovery support.') };
  }
  const help = await cli(['test', '--help']);
  if (help.code !== 0 || !/\s--ci-admission\b/.test(help.stdout)) {
    return { error: result(2, 'The pinned CLI must support test --ci-admission to execute this linked job.') };
  }

  // The platform keys this lookup by the verified GitHub invocation. An exact
  // retry can recover a committed issue even if the original HTTP response was lost.
  const selector = {
    schemaVersion, bindingId: bindingId.toLowerCase(), suiteRevisionId: suiteRevisionId.toLowerCase(), maxCredits: Number(start.cap),
    jobKey, matrixLeg: 'default', evaluationSlot: 'default',
  };
  let recovered;
  try {
    recovered = await linked.api.recover(selector);
  } catch (error) {
    return { error: result(4, apiDetail(error, 'Could not recover the original GitHub admission. Retry this job.')) };
  }
  let request = recovered?.request;
  if (recovered?.schemaVersion !== schemaVersion || request === undefined) {
    return { error: result(4, 'The platform did not confirm whether this job already has an admission.') };
  }
  let quotedCredits;
  if (request === null) {
    const { quote, error } = await start.estimate();
    if (error) return { error };
    if (!isUuid(quote.quoteId) || !digest.test(quote.execution_plan_digest)) {
      return { error: result(4, 'Expected a quote ID and execution-plan digest for one saved suite shard.') };
    }
    quotedCredits = quote.executionUnits;
    request = { ...selector, quoteId: quote.quoteId, executionPlanDigest: quote.execution_plan_digest };
  } else if (!Object.entries(selector).every(([key, value]) => request[key] === value)) {
    return { error: result(4, 'The original admission request differs from the selected job, suite or ceiling.') };
  }

  let admission;
  try {
    admission = await linked.api.issue(request);
  } catch (error) {
    const detail = apiDetail(error, 'The platform could not confirm this admission. Recover the original request by rerunning the same job.');
    return { error: { ...result(4, detail), linkStatus: 'unconfirmed', revisionVerification: '' } };
  }
  const link = { admissionId: admission.admissionId, linkStatus: 'unconfirmed', revisionVerification: '' };
  const fail = (code, message, runId = '') => ({ error: { ...result(code, message), ...link, runId } });
  if (quotedCredits !== undefined && quotedCredits > admission.maxCredits) {
    return fail(13, 'The saved quote exceeds the ceiling approved by the platform. No run was requested.');
  }

  let admitted;
  try {
    admitted = await executeAdmission(start, admission, linked.tempDir);
  } catch {
    return fail(4, 'The CLI result is uncertain. Recover the original admission by rerunning this job.', admission.runId ?? '');
  }
  const runId = admitted.data?.run_id;
  if (!isUuid(runId)) {
    const code = [0, 10, 11].includes(admitted.code) ? 4 : admitted.code;
    return fail(code, 'The CLI did not identify the original run. Recover by rerunning the same job.', admission.runId ?? '');
  }
  if (admission.runId && !sameId(admission.runId, runId)) {
    return fail(4, 'The CLI returned a different run from the original admission.', admission.runId);
  }
  try {
    // Confirms provenance even when the CLI exited during grading or observed
    // an active run owned by a previous attempt. It cannot create another run.
    const receipt = await linked.api.attach(admission.admissionId, runId);
    if (receipt?.schemaVersion !== schemaVersion || !sameId(receipt.admissionId, admission.admissionId) ||
        !sameId(receipt.runId, runId)) {
      return fail(4, 'The platform returned a different admission or run.', runId);
    }
  } catch (error) {
    return fail(4, apiDetail(error, 'The platform could not confirm the run link. Rerun the same job.'), runId);
  }
  // This release binds a fixed target origin. Its deployed revision is unknown.
  return { admitted, quotedCredits, link: { admissionId: admission.admissionId, linkStatus: 'linked', revisionVerification: 'unknown' } };
}
