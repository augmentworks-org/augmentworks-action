import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isUuid = value => typeof value === 'string' && uuid.test(value);
const sameId = (left, right) => isUuid(left) && isUuid(right) && left.toLowerCase() === right.toLowerCase();
const graded = code => code === 0 || code === 10;
const requiredActions = ['run:execute', 'suite:read', 'run:read', 'evaluation:read', 'criterion_detail:read', 'billing:read'];

function result(exitCode, detail, failedChecks = []) {
  const outcome = { 0: 'passed', 10: 'failed', 11: 'incomplete' }[exitCode] ?? 'error';
  return { exitCode, outcome, runId: '', reportPath: '', reportUrl: '', failedChecks, detail };
}

function json(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

// Only identifiers from required criteria are eligible for GitHub outputs. Transcripts,
// upstream messages, and evidence URLs can contain credentials or customer data.
function failedChecks(document) {
  const criteria = Array.isArray(document.criteria) ? document.criteria : [];
  const aggregate = document.report.aggregate?.knownRequiredFailures;
  const keys = criteria
    .filter(row => row?.required === true && row.verdict === 'fail')
    .map(row => row.criterionKey ?? row.criterionId);
  if (Array.isArray(aggregate)) for (const key of aggregate) keys.push(key);
  return [...new Set(keys.filter(key => typeof key === 'string' &&
    /^[\w][\w./:-]{0,159}$/.test(key) && !/(aw_(?:api|connector|refresh)_|gh[pousr]_|github_pat_|sk-)/i.test(key)))].slice(0, 30);
}

async function inspectRun(call, runId, workspaceId, baselineId) {
  const waited = await call(['run', 'wait', runId, '--timeout-ms', '60000']);
  if (!graded(waited.code)) return result(waited.code, 'Waiting for this run did not produce a graded result. Re-query the same run ID.');
  const state = waited.data;
  if (state?.ok !== true || !sameId(state.originalRunId, runId) ||
      !sameId(state.runId, runId) || !sameId(state.workspaceId, workspaceId) || state.exit_code !== waited.code) {
    return result(4, 'The wait response did not identify the expected run, workspace and outcome.');
  }

  const read = await call(['run', 'report', runId]);
  if (!graded(read.code)) return result(read.code, 'The full hosted report could not be verified. Inspect the original run.');
  const doc = read.data;
  const report = doc?.report;
  if (doc?.schemaVersion !== 'aw-run-report-export/1' || doc.retrieved !== true || doc.complete !== true ||
      report?.schemaVersion !== 'aw-run-report/1' || !sameId(report.runId, runId) ||
      !sameId(report.workspaceId, workspaceId) || report.createsBillableRun !== false) {
    return result(4, 'The hosted report was incomplete or did not match this run and workspace.');
  }
  const checks = failedChecks(doc);
  if (report.reportReady !== true || ['pending', 'partial'].includes(report.evaluationStatus)) {
    return result(11, 'Grading is incomplete. Re-query this run before making a release decision.', checks);
  }
  const candidatePassed = waited.code === 0 && read.code === 0 && state.assessment === 'passed' &&
    report.executionStatus === 'completed' && ['complete', 'absent'].includes(report.evaluationStatus) &&
    report.outcome === 'passed' && checks.length === 0;
  if (!candidatePassed && waited.code === 0 && read.code === 0) {
    return result(4, 'The reported assessment and evidence disagree. Inspect the original run.', checks);
  }

  if (baselineId) {
    const gate = await call(['gate', '--run', runId, '--baseline', baselineId]);
    if (!graded(gate.code)) return result(gate.code, 'The pinned baseline did not produce a complete, comparable release decision.', checks);
    const decision = gate.data;
    if (decision?.ok !== true || decision.schemaVersion !== 'aw-release-policy/1' ||
        decision.command !== 'gate' || decision.createsBillableRun !== false ||
        !sameId(decision.candidateRunId, runId) || !sameId(decision.baselineId, baselineId) ||
        decision.exit_code !== gate.code || decision.decision !== (gate.code === 0 ? 'pass' : 'block') ||
        (gate.code === 0 && (decision.comparability !== 'compatible' || decision.evaluationStatus !== 'complete'))) {
      return result(4, 'The release gate response did not match this candidate and baseline.', checks);
    }
    if (gate.code === 10) return result(10, 'The selected baseline blocked this release.', checks);
  }
  return candidatePassed
    ? result(0, baselineId ? 'The candidate passed its checks and the pinned baseline gate.' : 'The candidate passed its hosted checks.')
    : result(10, 'The candidate did not pass its hosted checks. Inspect the saved assessment.', checks);
}

// Authentication, an estimate, and all reads are non-billable. This action issues at most
// one admission command per invocation; an interrupted one must be recovered separately.
export async function runHosted({ config, assessment, baselineId, maxCredits, workspaceId, cli, outputDir }) {
  const cap = String(maxCredits ?? '');
  if (!isUuid(workspaceId) || (baselineId && !isUuid(baselineId))) return result(2, 'Set a workspace UUID and, when used, a baseline UUID.');
  if (!/^\d+$/.test(cap) || !Number.isSafeInteger(Number(cap))) return result(2, 'Set a finite, nonnegative integer max-credits ceiling.');
  if (!config || !assessment) return result(2, 'Hosted mode requires a config and a saved-suite assessment file.');
  try {
    await mkdir(dirname(outputDir), { recursive: true, mode: 0o700 });
    await mkdir(outputDir, { mode: 0o700 });
  } catch {
    return result(2, 'Hosted output-dir must be a fresh writable directory.');
  }

  const call = async args => {
    const execution = await cli([...args, '--workspace', workspaceId, '--json']);
    return { code: execution.code, data: json(execution.stdout) };
  };
  const who = await call(['whoami']);
  if (who.code !== 0) return result(who.code, 'Workspace authentication failed. Check the scoped CI key.');
  const identity = who.data?.identity;
  if (who.data?.source !== 'api_key' || identity?.principal_kind !== 'machine' || !sameId(identity.workspace_id, workspaceId)) {
    return result(3, 'The credential must be a machine API key for the specified workspace.');
  }

  const granted = new Set(Array.isArray(identity.actions) ? identity.actions : []);
  const missing = requiredActions.filter(action => !granted.has(action));
  if (missing.length) return result(3, 'The CI key needs these workspace actions: ' + missing.join(', ') + '.');

  const testArgs = ['test', '--headless', '--config', config, '--assessment', assessment];
  const estimate = await call([...testArgs, '--estimate']);
  if (estimate.code !== 0) return result(estimate.code, 'Unable to quote this assessment. No admission was requested.');
  const quote = estimate.data;
  if (quote?.ok !== true || quote.schemaVersion !== 'aw-billing/1' || quote.estimateOnly !== true ||
      !sameId(quote.workspaceId, workspaceId) || !Number.isSafeInteger(quote.executionUnits) || quote.executionUnits < 0) {
    return result(4, 'The estimate did not return a valid quote for the expected workspace.');
  }
  if (quote.executionUnits > Number(cap)) {
    return result(13, `The quote of ${quote.executionUnits} credits exceeds the ${Number(cap)}-credit ceiling. No run was started.`);
  }

  let admitted;
  try {
    admitted = await call([...testArgs, '--max-credits', cap, '--yes']);
  } catch {
    return result(4, 'Admission could not be confirmed. Inspect CLI recovery state before retrying.');
  }
  const runId = admitted.data?.run_id;
  if (!isUuid(runId)) return result(admitted.code || 4, 'No valid hosted run ID was returned. Inspect CLI recovery state before retrying.');
  let outcome;
  try {
    if (![0, 10, 11].includes(admitted.code) || (admitted.data.ok === false && admitted.code !== 11)) {
      outcome = result(admitted.code || 4, 'Hosted execution stopped. Inspect the original run and CLI recovery state before retrying.');
    } else {
      outcome = await inspectRun(call, runId, workspaceId, baselineId);
    }
  } catch {
    outcome = result(4, 'Could not finish inspecting the original run. Re-query its ID before starting new work.');
  }
  outcome.runId = runId;
  outcome.reportUrl = `https://augmentworks.ai/portal/runs/${runId}`;
  const path = join(outputDir, 'hosted-summary.json');
  try {
    await writeFile(path, JSON.stringify({ ...outcome, reportPath: undefined, quotedCredits: quote.executionUnits }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    outcome.reportPath = path;
  } catch {
    return { ...outcome, exitCode: outcome.exitCode || 1, outcome: 'error', detail: 'The hosted result is available, but the local summary could not be written.' };
  }
  return outcome;
}
